import React, { useState, useEffect, useMemo, useRef, useCallback, useContext, createContext, Suspense, lazy } from "react";
import {
  Bell, Camera, CheckCircle2, AlertTriangle, Clock, LogOut, Mail,
  BarChart3, MapPin, KeyRound, Radio, ChevronRight, X, Copy, Send,
  ShieldAlert, ArrowLeft, Building2, Settings, Lock, Eye, EyeOff,
  Users, UserPlus, Power, Trash2, RotateCcw, Upload, Phone, CalendarDays, Ban,
  FileText, Download, Archive, Pencil, MessageSquare, Navigation
} from "lucide-react";
import {
  STATUS_META, fmtTime, fmtDateTime, isoDateOnly, isoTimeOnly,
  reportStatusLabel, REPORT_COLUMNS_BRIEF, REPORT_COLUMNS_DETAILED,
  reportRow, patrolmanRunSummary,
} from "./reportUtils.js";
import { restoreSession, login as apiLogin, logout as apiLogout, setOnUnauthorized } from "./auth.js";
import {
  listAccounts, createAccount as apiCreateAccount, updateAccount as apiUpdateAccount,
  resetPassword as apiResetPassword, changeOwnPassword as apiChangeOwnPassword,
  deleteAccount as apiDeleteAccount, bulkUpdateAccounts as apiBulkUpdateAccounts,
} from "./accountsApi.js";
import { getPushStatus, enableJobAlerts, disableJobAlerts, resyncJobAlertsIfEnabled, notifyJobDispatch, notifyStandDown } from "./push.js";
import { reverseGeocode, fetchStaticMap } from "./geocode.js";
import { reportLiveLocation, stopSharingLiveLocation } from "./liveLocation.js";
import { fetchJobPhotos, persistJobPhotos } from "./jobPhotos.js";
import { fetchJobChat, sendJobChatMessage } from "./jobChat.js";
import { searchArchivedJobs, fetchArchivedJobsInRange, resetArchiveAndPhotos } from "./jobArchive.js";

const LiveLocationMap = lazy(() => import("./LiveLocationMap.jsx"));

/* ---------------------------------------------------------------
   SEED / REFERENCE DATA
---------------------------------------------------------------- */

// Sites are no longer seeded with sample data — the board starts with an
// empty site list. Add sites as jobs come in (Control Room, from the New
// Job screen) or in bulk via Manager > Sites & runs > Import from Excel.
const DEFAULT_SITES = [];

// Zones/runs are named by you — this is only the starting list a fresh
// board is seeded with. Rename, add, or delete these from the Manager
// screen ("Sites & runs"); renaming cascades to any site or patrolman
// currently assigned to that run.
const DEFAULT_ZONES = ["North Run", "South Run", "CBD Run", "East Run", "West Run"];

// Default accounts are seeded server-side (api/_lib/defaultAccounts.js,
// hashed before ever reaching Supabase) the first time /api/accounts is
// called against an empty database — nothing password-shaped lives in
// the client bundle anymore.

const JOBS_KEY = "ops:jobs";
const ZONES_KEY = "ops:zones";
const SITES_KEY = "ops:sites";
const ROSTER_KEY = "ops:roster";
const LOGO_KEY = "ops:logo";
const COMPANY_NAME_KEY = "ops:companyName";
const DEFAULT_COMPANY_NAME = "Ausgroup";
const OUTCOME_PHRASES_KEY = "ops:outcomePhrases";

// Each phrase has a short `name` (what patrolmen see on the tappable
// chip — easy to scan/judge at a glance) and the full `text` that's
// actually inserted into the outcome field. Seed list is editable
// afterwards from Manager > Standard Phrases.
const DEFAULT_OUTCOME_PHRASES = [
  { id: "p1", name: "All secure", text: "All secure, nothing to report." },
  { id: "p2", name: "False alarm — sensor fault", text: "Premises secure, false alarm — sensor fault suspected." },
  { id: "p3", name: "No forced entry", text: "No sign of forced entry, premises secure on departure." },
  { id: "p4", name: "Door/window open — secured", text: "Door/window found open — secured on departure." },
  { id: "p5", name: "Alarm reset", text: "Alarm reset, premises secure on departure." },
  { id: "p6", name: "Keyholder attended", text: "Client/keyholder attended and secured premises." },
  { id: "p7", name: "No access — keyholder unreachable", text: "Unable to gain access — keyholder not contactable." },
  { id: "p8", name: "Police attended", text: "Police attended — no further action required." },
];

function makePhraseId() {
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Loaded phrases might still be in the old plain-string format from
// before names existed — upgrade them on the fly rather than losing them.
function normalizePhrase(p) {
  if (typeof p === "string") return { id: makePhraseId(), name: p.length > 40 ? `${p.slice(0, 40)}…` : p, text: p };
  return p;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Night Patrol runs 1800-0600, spanning midnight — a roster entry for an
// overnight shift is stored under the date it starts (the evening it's
// rostered from), so looking it up by the literal calendar date would
// stop finding that patrolman the moment the clock ticks past midnight,
// even though their shift still has hours left to run — leaving a job
// dispatched to them after midnight with no run recorded. Rolling the
// "roster day" over at 6am instead of midnight, matching the night
// shift's own end time, keeps every roster lookup resolving to the
// right entry for as long as a shift that started the previous evening
// is still active. Day Patrol is unaffected either way, since it only
// runs during hours already past this rollover.
const ROSTER_DAY_ROLLOVER_HOUR = 6;

function rosterDateISO() {
  const d = new Date();
  if (d.getHours() < ROSTER_DAY_ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------
   HELPERS
---------------------------------------------------------------- */

function slaWindowMinutes(date) {
  const h = date.getHours();
  return h >= 6 && h < 18 ? 90 : 60;
}

function minutesSince(iso, now) {
  return Math.floor((now - new Date(iso).getTime()) / 60000);
}

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function mapsUrlLatLon(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

// Chrome (and most other browsers) silently block a plain <a> or
// window.open() navigation straight to a data: URL — a security measure
// against phishing via disguised data URLs — so a normal link/click to a
// base64 photo just does nothing. Opening a blank tab first and writing
// the image into that document as an <img> src sidesteps the restriction
// entirely, since it's no longer a top-level navigation to a data: URL.
function openDataUrlImage(dataUrl) {
  const win = window.open();
  if (!win) return; // popup blocked — nothing more we can do
  win.document.write(
    `<title>Attendance photo</title><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="${dataUrl}" style="max-width:100%;max-height:100vh;object-fit:contain;"></body>`
  );
  win.document.close();
}

// Free, key-less embedded map snapshot (OpenStreetMap's own official
// embed endpoint) showing a pin at the given point — used for the
// onsite/offsite "map snap" in Control Room. The Google Maps link next
// to it is still there for turn-by-turn / satellite view.
function osmEmbedUrl(lat, lon, delta = 0.006) {
  const bbox = [lon - delta, lat - delta, lon + delta, lat + delta].join("%2C");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}`;
}

function MapSnap({ lat, lon }) {
  return (
    <iframe
      title="Location map"
      src={osmEmbedUrl(lat, lon)}
      style={{ width: 260, height: 150, border: "1px solid var(--border)", borderRadius: 6 }}
      loading="lazy"
    />
  );
}

// Appended to job.activityLog by every Control Room action so there's a
// full audit trail of who did what and when.
function logEntry(session, action, detail = "") {
  return { ts: new Date().toISOString(), actorLoginName: session.loginName, actorName: session.displayName, action, detail };
}

// <input type="datetime-local"> takes/returns a naive "local time" string
// with no timezone info — these convert to/from the ISO strings jobs
// store, using the browser's own local timezone both ways.
function toLocalInputValue(iso) {
  if (!iso) return "";
  return `${isoDateOnly(iso)}T${isoTimeOnly(iso)}`;
}
function fromLocalInputValue(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function jobTiming(job, now) {
  const dispatched = new Date(job.dispatchTime);
  const slaMin = slaWindowMinutes(dispatched);
  const elapsed = job.onsiteTime
    ? Math.floor((new Date(job.onsiteTime) - dispatched) / 60000)
    : minutesSince(job.dispatchTime, now);
  const remaining = slaMin - elapsed;
  let level = "ok";
  if (remaining <= 0) level = "breach";
  else if (remaining <= 15) level = "warn";
  return { slaMin, elapsed, remaining, level };
}

// The ETA field is free text (see EtaModal) — this pulls out the first
// number in it and treats it as minutes, e.g. "60 minutes" or "90mins —
// stuck in traffic" both give 90. Returns null when nothing parses (a
// patrolman who typed "on my way now" with no number, for instance),
// since there's nothing to count down to in that case.
function parseEtaMinutes(eta) {
  if (!eta?.label) return null;
  const m = /(\d+)/.exec(eta.label);
  return m ? parseInt(m[1], 10) : null;
}

// Minutes remaining until the patrolman's stated ETA, counted from the
// moment they acknowledged — negative once that ETA has passed. Distinct
// from jobTiming's SLA countdown: this tracks what the patrolman actually
// told Control Room to expect, not the site's contracted response window.
function etaCountdown(job, now) {
  const etaMinutes = parseEtaMinutes(job.eta);
  if (etaMinutes === null || !job.acknowledgedAt) return null;
  const deadline = new Date(job.acknowledgedAt).getTime() + etaMinutes * 60000;
  return Math.round((deadline - now) / 60000);
}

function beep(pattern = [880]) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    let t = ctx.currentTime;
    pattern.forEach((freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
      gain.gain.linearRampToValueAtTime(0.001, t + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.24);
      t += 0.28;
    });
  } catch (e) {
    /* audio not available */
  }
}

function getCurrentLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
}

function formatLocation(loc) {
  if (!loc) return "";
  return `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`;
}

// Each photo is already resized to 480px wide and compressed to a ~72%
// quality JPEG below (see watermarkPhoto) before it's stored — typically
// 60-130KB once base64-encoded — so this cap exists only to stay clear of
// Vercel's 4.5MB request/response ceiling on the job photos save, not
// because a handful of photos is expensive on its own.
const MAX_ATTENDANCE_PHOTOS = 20;

function watermarkPhoto(file, label, location, locationName) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxW = 480;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const locationText = locationName || formatLocation(location);
        const lines = [
          `${label}  ·  ${new Date().toLocaleString("en-AU", { hour12: false })}`,
          locationText ? `📍 ${locationText}` : "📍 Location unavailable",
        ];
        ctx.font = "12px ui-monospace, monospace";
        const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
        const boxH = lines.length * 16 + 8;
        ctx.fillStyle = "rgba(0,0,0,0.62)";
        ctx.fillRect(0, h - boxH, textW + 16, boxH);
        ctx.fillStyle = "#F5A623";
        lines.forEach((line, i) => ctx.fillText(line, 8, h - boxH + 16 * (i + 1)));
        resolve({
          dataUrl: canvas.toDataURL("image/jpeg", 0.72),
          ts: new Date().toISOString(),
          location: location ? { lat: location.lat, lon: location.lon } : null,
          locationName: locationName || null,
        });
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function resizeLogo(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 240;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------------
   ROOT COMPONENT
---------------------------------------------------------------- */

export default function SentrylinePrototype() {
  const [session, setSession] = useState(() => restoreSession());
  const [jobs, setJobs] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [zones, setZones] = useState([]);
  const [sites, setSites] = useState([]);
  const [sitesLoaded, setSitesLoaded] = useState(false);
  const [roster, setRoster] = useState([]);
  const [outcomePhrases, setOutcomePhrases] = useState([]);
  const [logoUrl, setLogoUrl] = useState("");
  const [companyName, setCompanyName] = useState(DEFAULT_COMPANY_NAME);
  const [now, setNow] = useState(Date.now());
  const [banner, setBanner] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  // null | "inactivity" | "superseded" | "expired" — why the Login screen
  // is showing a "you were signed out" banner, if at all.
  const [logoutReason, setLogoutReason] = useState(null);
  const [toast, setToast] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const prevJobsRef = useRef([]);
  const lastActivityRef = useRef(Date.now());
  const toastTimerRef = useRef(null);

  const showToast = useCallback((text, type = "success") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  const showConfirm = useCallback((message, onConfirm, opts = {}) => {
    setConfirmState({ message, onConfirm, ...opts });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  // Auto sign out Control Room after 30 minutes with no activity in the window
  useEffect(() => {
    if (!session || session.role !== "operator") return;
    const markActivity = () => { lastActivityRef.current = Date.now(); };
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((e) => window.addEventListener(e, markActivity));
    markActivity();

    const INACTIVITY_LIMIT_MS = 30 * 60 * 1000;
    const check = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= INACTIVITY_LIMIT_MS) {
        disableJobAlerts();
        apiLogout();
        setSession(null);
        setLogoutReason("inactivity");
      }
    }, 30000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, markActivity));
      clearInterval(check);
    };
  }, [session]);

  // Live location sharing for Control Room's Live Location tab — only
  // while signed in and only on days a patrolman is actually rostered,
  // matching "active only during shift". Nothing is kept beyond the
  // current position: each report overwrites the last one, and the
  // location is deleted the moment this stops (sign-out, tab closed,
  // or rostered day ends and this effect re-evaluates).
  const isPatrolmanRosteredToday = session?.role === "patrolman" && roster.some((r) => r.date === rosterDateISO() && r.patrolmanLoginName === session.loginName);
  useEffect(() => {
    if (!isPatrolmanRosteredToday || !navigator.geolocation) return;
    const loginName = session.loginName;
    let lastReport = 0;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastReport < 20000) return;
        lastReport = now;
        reportLiveLocation(loginName, pos.coords.latitude, pos.coords.longitude);
      },
      () => { /* best-effort — Control Room just won't see a dot for this patrolman */ },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
    return () => {
      navigator.geolocation.clearWatch(watchId);
      stopSharingLiveLocation(loginName);
    };
  }, [isPatrolmanRosteredToday, session?.loginName]);

  const handleSignOut = useCallback(() => {
    // Fired before apiLogout() clears the auth token — the effect
    // cleanup above would otherwise run after the token's already gone
    // and silently fail to delete the location (it's still there as a
    // fallback for other exits, e.g. just closing the tab). Same reason
    // disableJobAlerts() runs here too: signing out should stop job
    // alerts landing on this device immediately, not just once someone
    // else eventually logs in on this same account elsewhere.
    if (session?.role === "patrolman") stopSharingLiveLocation(session.loginName);
    disableJobAlerts();
    apiLogout();
    setSession(null);
  }, [session]);

  // Wire up forced sign-out if any authenticated request ever comes back
  // 401 — auth.js already clears the stored token. `reason` is "superseded"
  // when this same account has since logged in elsewhere — the server's
  // already cleared this account's push subscriptions at that point (see
  // claimActiveSession), so disableJobAlerts() here is just tidying up this
  // device's own local registration for a device that's genuinely been
  // replaced. A plain expired token is different: the board polls every 8s
  // regardless of whether the session is still valid, so an ordinary
  // 24-hour token expiry fires this constantly for a patrolman who's simply
  // left the app open across a shift — disableJobAlerts() must NOT run for
  // that case, or their phone silently stops getting job alerts the moment
  // the token times out, with no indication anything's wrong, until they
  // happen to explicitly sign back in. The still-possessed device should
  // keep getting alerts right up until it's actually superseded or signed
  // out on purpose.
  useEffect(() => {
    setOnUnauthorized((reason) => {
      if (reason === "superseded") disableJobAlerts();
      setSession(null);
      setLogoutReason(reason === "superseded" ? "superseded" : "expired");
    });
  }, []);

  // Load jobs, accounts, zones, sites, roster — all require a session now,
  // so these wait for one instead of loading unconditionally at mount.
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const res = await window.storage.get(JOBS_KEY, true);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          setJobs(parsed);
          prevJobsRef.current = parsed;
        }
      } catch (e) { /* nothing stored yet */ }
    })();
  }, [session]);

  // Load accounts (server seeds default accounts on a genuinely empty
  // database the first time this is called — see api/accounts.js).
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const existing = await listAccounts();
        setAccounts(existing);
      } catch (e) { console.error(e); }
      setAccountsLoaded(true);
    })();
  }, [session]);

  // Load or seed zones & sites (runs are named by the manager; sites are
  // demo data on first run, editable afterwards from Manager > Sites & runs)
  useEffect(() => {
    if (!session) return;
    (async () => {
      let z = [];
      try {
        const res = await window.storage.get(ZONES_KEY, true);
        if (res && res.value) z = JSON.parse(res.value);
      } catch (e) { /* nothing stored yet */ }
      if (z.length === 0) {
        z = DEFAULT_ZONES;
        try { await window.storage.set(ZONES_KEY, JSON.stringify(z), true); } catch (e) { /* ignore */ }
      }
      setZones(z);

      let s = [];
      try {
        const res = await window.storage.get(SITES_KEY, true);
        if (res && res.value) s = JSON.parse(res.value);
      } catch (e) { /* nothing stored yet */ }
      if (s.length === 0) {
        s = DEFAULT_SITES;
        try { await window.storage.set(SITES_KEY, JSON.stringify(s), true); } catch (e) { /* ignore */ }
      }
      setSites(s);
      setSitesLoaded(true);
    })();
  }, [session]);

  // Load roster (dated run assignments — separate from a login's "current" run)
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const res = await window.storage.get(ROSTER_KEY, true);
        if (res && res.value) setRoster(JSON.parse(res.value));
      } catch (e) { /* nothing stored yet */ }
    })();
  }, [session]);

  // Load or seed the outcome quick-phrases patrolmen pick from when
  // submitting a job outcome (editable afterwards from Manager > Standard Phrases)
  useEffect(() => {
    if (!session) return;
    (async () => {
      let p = [];
      let needsResave = false;
      try {
        const res = await window.storage.get(OUTCOME_PHRASES_KEY, true);
        if (res && res.value) {
          const raw = JSON.parse(res.value);
          needsResave = raw.some((x) => typeof x === "string");
          p = raw.map(normalizePhrase);
        }
      } catch (e) { /* nothing stored yet */ }
      if (p.length === 0) {
        p = DEFAULT_OUTCOME_PHRASES;
        needsResave = true;
      }
      if (needsResave) {
        try { await window.storage.set(OUTCOME_PHRASES_KEY, JSON.stringify(p), true); } catch (e) { /* ignore — will retry migrating next load */ }
      }
      setOutcomePhrases(p);
    })();
  }, [session]);

  // Load company logo (uploaded by a Manager, shown on every login type —
  // stays public/unauthenticated so it renders before anyone signs in)
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(LOGO_KEY, true);
        if (res && res.value) setLogoUrl(res.value);
      } catch (e) { /* nothing stored yet */ }
    })();
  }, []);

  // Load company name (used in the header alongside the logo — also public)
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(COMPANY_NAME_KEY, true);
        if (res && res.value) setCompanyName(res.value);
      } catch (e) { /* nothing stored yet — keep the default */ }
    })();
  }, []);

  const persistJobs = useCallback(async (updated) => {
    setJobs(updated);
    prevJobsRef.current = updated;
    // Photos never belong in this blob — every signed-in device polls it,
    // and photos are stored separately (jobPhotos.js) for exactly that
    // reason. Stripped here too as a backstop in case a future call site
    // ever passes one through by accident.
    const slim = updated.map(({ photos, ...rest }) => rest);
    try {
      const result = await window.storage.set(JOBS_KEY, JSON.stringify(slim), true);
      // The server merges in any job this device's write didn't even
      // mention, on the assumption it was added concurrently by another
      // device since this one's last poll (see mergeJobsWrite in
      // api/kv.js) — adopt that result immediately so this tab doesn't
      // have to wait out a poll cycle to see a job it would otherwise
      // have no idea exists.
      const merged = JSON.parse(result.value);
      if (merged.length !== slim.length) {
        setJobs(merged);
        prevJobsRef.current = merged;
      }
    } catch (e) { console.error(e); }
  }, []);

  const persistZones = useCallback(async (updated) => {
    setZones(updated);
    try { await window.storage.set(ZONES_KEY, JSON.stringify(updated), true); } catch (e) { console.error(e); }
  }, []);

  const persistSites = useCallback(async (updated) => {
    setSites(updated);
    try { await window.storage.set(SITES_KEY, JSON.stringify(updated), true); } catch (e) { console.error(e); }
  }, []);

  const persistRoster = useCallback(async (updated) => {
    setRoster(updated);
    try { await window.storage.set(ROSTER_KEY, JSON.stringify(updated), true); } catch (e) { console.error(e); }
  }, []);

  const persistOutcomePhrases = useCallback(async (updated) => {
    setOutcomePhrases(updated);
    try { await window.storage.set(OUTCOME_PHRASES_KEY, JSON.stringify(updated), true); } catch (e) { console.error(e); }
  }, []);

  const persistLogo = useCallback(async (dataUrl) => {
    setLogoUrl(dataUrl);
    try { await window.storage.set(LOGO_KEY, dataUrl, true); } catch (e) { console.error(e); }
  }, []);

  const persistCompanyName = useCallback(async (name) => {
    setCompanyName(name);
    try { await window.storage.set(COMPANY_NAME_KEY, name, true); } catch (e) { console.error(e); }
  }, []);

  // Poll shared storage + fire notifications
  useEffect(() => {
    if (!session) return;
    const t = setInterval(async () => {
      try {
        const res = await window.storage.get(JOBS_KEY, true);
        if (!res || !res.value) return;
        const fresh = JSON.parse(res.value);
        const prev = prevJobsRef.current;

        if (session.role === "patrolman") {
          const newlyAssigned = fresh.filter(
            (j) => j.assigneeId === session.id && !prev.find((p) => p.id === j.id)
          );
          if (newlyAssigned.length) {
            beep([1046, 1046, 1046]);
            setBanner({ type: "job", text: `New job dispatched: ${newlyAssigned[0].jobNumber} — ${newlyAssigned[0].siteName}` });
          }

          const newlyCancelled = fresh.filter((j) => {
            if (j.assigneeId !== session.id || j.status !== "cancelled") return false;
            const wasPrev = prev.find((p) => p.id === j.id);
            return wasPrev && wasPrev.status !== "cancelled";
          });
          if (newlyCancelled.length) {
            beep([440, 330]);
            setBanner({ type: "cancel", text: `Job cancelled — stand down: ${newlyCancelled[0].jobNumber} — ${newlyCancelled[0].siteName}` });
          }
        }
        if (session.role === "operator") {
          const nowBreaching = fresh.filter((j) => {
            const wasOk = prev.find((p) => p.id === j.id);
            const t1 = jobTiming(j, Date.now());
            const t0 = wasOk ? jobTiming(wasOk, Date.now()) : null;
            return j.status === "dispatched" && t1.level === "breach" && (!t0 || t0.level !== "breach");
          });
          if (nowBreaching.length) {
            beep([440, 440]);
            setBanner({ type: "breach", text: `SLA exceeded on ${nowBreaching[0].jobNumber} — ${nowBreaching[0].siteName}. Log a delay reason.` });
          }

          const newlyAcknowledged = fresh.filter((j) => {
            if (!j.acknowledgedAt) return false;
            const wasPrev = prev.find((p) => p.id === j.id);
            return wasPrev && !wasPrev.acknowledgedAt;
          });
          if (newlyAcknowledged.length) {
            beep([880]);
            setBanner({ type: "ack", text: `${newlyAcknowledged[0].assigneeName} acknowledged ${newlyAcknowledged[0].jobNumber} — ${newlyAcknowledged[0].siteName}` });
          }
        }
        setJobs(fresh);
        prevJobsRef.current = fresh;
      } catch (e) { /* ignore poll errors */ }
      // Every signed-in device polls this on its own timer, all day — this
      // interval is the single biggest driver of Supabase egress usage, so
      // it's kept as long as dispatch/cancel/SLA-breach alerts can tolerate.
    }, 8000);
    return () => clearInterval(t);
  }, [session]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 6000);
    return () => clearTimeout(t);
  }, [banner]);

  if (!session) {
    return (
      <ToastContext.Provider value={showToast}>
        <ConfirmContext.Provider value={showConfirm}>
          <Shell>
            <Login
              logoutReason={logoutReason}
              logoUrl={logoUrl}
              companyName={companyName}
              onLogin={(s) => { setSession(s); setLogoutReason(null); resyncJobAlertsIfEnabled(); }}
            />
            <ToastOverlay toast={toast} />
            <ConfirmDialog confirmState={confirmState} onClose={() => setConfirmState(null)} />
          </Shell>
        </ConfirmContext.Provider>
      </ToastContext.Provider>
    );
  }

  return (
    <ToastContext.Provider value={showToast}>
      <ConfirmContext.Provider value={showConfirm}>
        <Shell>
          <TopBar session={session} roster={roster} onSignOut={handleSignOut} onOpenSettings={() => setShowSettings(true)} now={now} logoUrl={logoUrl} companyName={companyName} />
          {banner && <NotifBanner banner={banner} onDismiss={() => setBanner(null)} />}
          {showSettings && (
            <SettingsModal session={session} onClose={() => setShowSettings(false)} />
          )}
          {!accountsLoaded || !sitesLoaded ? (
            <div style={{ padding: 40, color: "var(--text-dim)" }}>Loading dispatch board…</div>
          ) : session.role === "manager" ? (
            <ManagerView session={session} accounts={accounts} setAccounts={setAccounts} zones={zones} persistZones={persistZones} sites={sites} persistSites={persistSites} roster={roster} persistRoster={persistRoster} outcomePhrases={outcomePhrases} persistOutcomePhrases={persistOutcomePhrases} logoUrl={logoUrl} persistLogo={persistLogo} companyName={companyName} persistCompanyName={persistCompanyName} jobs={jobs} persistJobs={persistJobs} now={now} />
          ) : session.role === "operator" ? (
            <OperatorView session={session} jobs={jobs} accounts={accounts} sites={sites} persistSites={persistSites} zones={zones} roster={roster} persistRoster={persistRoster} persist={persistJobs} now={now} companyName={companyName} />
          ) : (
            <PatrolmanView session={session} roster={roster} jobs={jobs} persist={persistJobs} outcomePhrases={outcomePhrases} now={now} />
          )}
          <ToastOverlay toast={toast} />
          <ConfirmDialog confirmState={confirmState} onClose={() => setConfirmState(null)} />
        </Shell>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}

/* ---------------------------------------------------------------
   TOAST — a brief confirmation popup, centered in the window, for
   "saved / removed / created" style actions across the app.
---------------------------------------------------------------- */

const ToastContext = createContext(() => {});
function useToast() {
  return useContext(ToastContext);
}

function ToastOverlay({ toast }) {
  if (!toast) return null;
  const isError = toast.type === "error";
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, pointerEvents: "none" }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 10, padding: "14px 24px", borderRadius: 10,
          background: isError ? "#FEF2F2" : "#FFFFFF",
          border: `1px solid ${isError ? "var(--breach)" : "var(--ok)"}`,
          boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
          fontSize: 13.5, fontWeight: 600,
          color: isError ? "#B91C1C" : "var(--text)",
          maxWidth: 360, textAlign: "center",
        }}
      >
        {isError ? <AlertTriangle size={17} color="var(--breach)" /> : <CheckCircle2 size={17} color="var(--ok)" />}
        {toast.text}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   CONFIRM — an in-app "Delete this?" popup, centered in the window,
   replacing the browser's native window.confirm() dialog.
---------------------------------------------------------------- */

const ConfirmContext = createContext(() => {});
function useConfirm() {
  return useContext(ConfirmContext);
}

function ConfirmDialog({ confirmState, onClose }) {
  if (!confirmState) return null;
  const { message, onConfirm, confirmLabel = "Delete", danger = true } = confirmState;
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, width: 360, maxWidth: "90vw", padding: 20, boxShadow: "0 12px 32px rgba(0,0,0,0.28)" }}>
        <div style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 18 }}>{message}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button
            onClick={() => { const cb = onConfirm; onClose(); cb(); }}
            style={{ ...primaryBtn, background: danger ? "var(--breach)" : "var(--accent)" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   SHELL / THEME
---------------------------------------------------------------- */

function Shell({ children }) {
  return (
    <div
      style={{
        "--bg": "#FFFFFF",
"--panel": "#FFFFFF",
"--panel-alt": "#F1F3F5",
"--border": "#D6DBE1",
"--text": "#000000",
"--text-dim": "#4B5563",
"--accent": "#FFB020",
"--accent-dim": "#FFF1D6",
"--ok": "#15803D",
"--warn": "#B45309",
"--breach": "#DC2626",
"--info": "#2563EB",
        "--mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        "--sans": "'Segoe UI', system-ui, -apple-system, sans-serif",
      background: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--sans)",
        minHeight: "100vh",
      }}
    >
      {children}
    </div>
  );
}

function Logo({ src }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {src ? (
        <img src={src} alt="Company logo" style={{ width: 48, height: 48, borderRadius: 6, objectFit: "contain" }} />
      ) : (
        <div style={{ width: 26, height: 26, borderRadius: 6, background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Radio size={15} color="#0B0E11" strokeWidth={2.5} />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   LOGIN — role select, then Login Name / Password only
---------------------------------------------------------------- */

function Login({ logoutReason, logoUrl, companyName, onLogin }) {
  const [role, setRole] = useState(null);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loginNameRef = useRef(null);
  const passwordRef = useRef(null);

  async function submit() {
    setError("");
    const loginName = (loginNameRef.current?.value || "").trim();
    const password = passwordRef.current?.value || "";
    if (!loginName || !password) { setError("Enter a login name and password."); return; }
    setBusy(true);
    try {
      const account = await apiLogin(loginName, password, role);
      onLogin(account);
    } catch (err) {
      setError(err.message || "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") submit();
  }

  if (!role) {
    return (
      <div style={{ padding: "48px 32px", maxWidth: 380, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><Logo src={logoUrl} /></div>
        <div style={{ fontSize: 16, fontWeight: 700, textAlign: "center", marginBottom: 4 }}>
          {companyName} Alarm Response Dispatch
        </div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", textAlign: "center", marginBottom: 32 }}>
          Choose your sign-in
        </div>
        {logoutReason && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, borderRadius: 7, background: "#FFFBEB", border: "1px solid var(--warn)", color: "#92400E", fontSize: 12.5, marginBottom: 20 }}>
            {logoutReason === "superseded" ? (
              <><ShieldAlert size={14} /> Signed out — this login was opened in another window or device.</>
            ) : logoutReason === "inactivity" ? (
              <><Clock size={14} /> Signed out after 30 minutes of inactivity — please sign in again.</>
            ) : (
              <><Clock size={14} /> Your session expired — please sign in again.</>
            )}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button onClick={() => setRole("manager")} style={roleCardStyle}>
            <Users size={18} color="var(--accent)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Manager</div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>Create and manage logins</div>
            </div>
            <ChevronRight size={16} color="var(--text-dim)" style={{ marginLeft: "auto" }} />
          </button>
          <button onClick={() => setRole("operator")} style={roleCardStyle}>
            <ShieldAlert size={18} color="var(--accent)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Control Room</div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>Dispatch, review, and report</div>
            </div>
            <ChevronRight size={16} color="var(--text-dim)" style={{ marginLeft: "auto" }} />
          </button>
          <button onClick={() => setRole("patrolman")} style={roleCardStyle}>
            <Radio size={18} color="var(--accent)" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>Patrolman</div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>View and attend jobs on your run</div>
            </div>
            <ChevronRight size={16} color="var(--text-dim)" style={{ marginLeft: "auto" }} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "48px 32px", maxWidth: 340, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}><Logo src={logoUrl} /></div>
      <div style={{ fontSize: 15, fontWeight: 700, textAlign: "center", marginBottom: 20 }}>
        {companyName} Alarm Response Dispatch
      </div>
      <button onClick={() => { setRole(null); setError(""); }} style={backBtn}>
        <ArrowLeft size={13} /> Change sign-in type
      </button>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 16, marginTop: 8 }}>
        {role === "operator" ? "Control Room sign-in" : role === "manager" ? "Manager sign-in" : "Patrolman sign-in"}
      </div>

      <div>
        <Field label="Login Name">
          <input
            ref={loginNameRef}
            autoFocus
            name="loginName"
            defaultValue=""
            onKeyDown={handleKeyDown}
            placeholder={role === "operator" ? "e.g. ControlRoom1" : role === "manager" ? "e.g. Manager1" : "e.g. T13"}
            style={selectStyle}
          />
        </Field>
        <Field label="Password">
          <div style={{ position: "relative" }}>
            <input
              ref={passwordRef}
              name="password"
              type={showPw ? "text" : "password"}
              defaultValue=""
              onKeyDown={handleKeyDown}
              style={{ ...selectStyle, paddingRight: 34 }}
            />
            <button type="button" onClick={() => setShowPw((v) => !v)} style={{ position: "absolute", right: 6, top: 6, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}>
              {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </Field>

        {error && <div style={{ color: "var(--breach)", fontSize: 12, marginBottom: 12 }}>{error}</div>}

        <button type="button" disabled={busy} onClick={submit} style={{ width: "100%", padding: "12px 0", borderRadius: 7, border: "none", background: "var(--accent)", color: "#0B0E11", fontWeight: 700, cursor: "pointer", fontSize: 13.5, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>

      <div style={{ marginTop: 16, padding: 12, borderRadius: 7, background: "var(--panel)", border: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        Forgotten your password? Ask your Manager to reset it from Manage logins — they'll send you a new one.
      </div>
    </div>
  );
}

const roleCardStyle = {
  display: "flex", alignItems: "center", gap: 12, padding: "14px 14px", borderRadius: 9,
  border: "1px solid var(--border)", background: "var(--panel)", cursor: "pointer", textAlign: "left",
  color: "var(--text)", font: "inherit",
};

/* ---------------------------------------------------------------
   TOP BAR / NOTIF BANNER / SETTINGS
---------------------------------------------------------------- */

function TopBar({ session, roster, onSignOut, onOpenSettings, now, logoUrl, companyName }) {
  // The session's own "run" is a snapshot of the account's default run
  // taken at login — if today's roster puts this patrolman on a
  // different run, show that instead so it matches what's on their jobs.
  const todaysRun = roster?.find((r) => r.date === rosterDateISO() && r.patrolmanLoginName === session.loginName)?.run || session.run;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", rowGap: 10, padding: "12px 20px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <Logo src={logoUrl} />
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>{companyName} Alarm Response Dispatch</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--text-dim)" }}>
          {new Date(now).toLocaleTimeString("en-AU", { hour12: false })}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{session.displayName} <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({session.loginName})</span></div>
          <div style={{ fontSize: 10.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {session.role === "operator" ? "Control Room" : session.role === "manager" ? "Manager" : `Patrolman · ${todaysRun}`}
          </div>
        </div>
        <button onClick={onOpenSettings} title="Change password" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: 7, cursor: "pointer", color: "var(--text-dim)" }}>
          <Settings size={14} />
        </button>
        <button onClick={onSignOut} title="Sign out" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", cursor: "pointer", color: "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600 }}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </div>
  );
}

function NotifBanner({ banner, onDismiss }) {
  const style = banner.type === "breach"
    ? { background: "#FEF2F2", border: "var(--breach)", color: "#B91C1C", Icon: AlertTriangle }
    : banner.type === "cancel"
    ? { background: "#FFFBEB", border: "var(--warn)", color: "#92400E", Icon: Ban }
    : { background: "#F0FDF4", border: "var(--ok)", color: "#166534", Icon: Bell };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px", background: style.background, borderBottom: `1px solid ${style.border}`, color: style.color, fontSize: 12.5 }}>
      <style.Icon size={15} />
      <span style={{ flex: 1 }}>{banner.text}</span>
      <button onClick={onDismiss} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}><X size={14} /></button>
    </div>
  );
}

function SettingsModal({ session, onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const showToast = useToast();

  async function submit() {
    setError("");
    if (!current) { setError("Current password is required."); return; }
    if (next.length < 4) { setError("New password must be at least 4 characters."); return; }
    if (next !== confirm) { setError("New passwords don't match."); return; }
    setBusy(true);
    try {
      await apiChangeOwnPassword(current, next);
      onClose();
      showToast("Password updated.");
    } catch (err) {
      setError(err.message || "Couldn't update password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, width: 340, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <SectionTitle icon={Lock} title="Change password" small />
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div>
          <Field label="Current password"><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} style={selectStyle} /></Field>
          <Field label="New password"><input type="password" value={next} onChange={(e) => setNext(e.target.value)} style={selectStyle} /></Field>
          <Field label="Confirm new password"><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={selectStyle} /></Field>
          {error && <div style={{ color: "var(--breach)", fontSize: 12, marginBottom: 10 }}>{error}</div>}
          <button type="button" disabled={busy} onClick={submit} style={{ ...primaryBtn, width: "100%", justifyContent: "center", opacity: busy ? 0.6 : 1 }}>{busy ? "Updating…" : "Update password"}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   STATUS BADGES
---------------------------------------------------------------- */

function StatusBadge({ status }) {
  const m = STATUS_META[status];
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: m.color, border: `1px solid ${m.color}55`, background: `${m.color}18`, padding: "3px 8px", borderRadius: 20 }}>
      {m.label}
    </span>
  );
}

function SlaChip({ job, now }) {
  if (job.status !== "dispatched") return null;
  const t = jobTiming(job, now);
  const color = t.level === "breach" ? "var(--breach)" : t.level === "warn" ? "var(--warn)" : "var(--ok)";
  const label = t.remaining >= 0 ? `${t.remaining}m left` : `${Math.abs(t.remaining)}m over`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}66`, padding: "3px 8px", borderRadius: 20 }}>
      <Clock size={11} /> {label}
    </span>
  );
}

// Separate from SlaChip on purpose — this counts down to what the
// patrolman actually said, not the site's SLA, so Control Room can watch
// both side by side and see immediately if one is running out while the
// other still has runway.
function EtaChip({ job, now }) {
  if (job.status !== "dispatched" || job.onsiteTime) return null;
  const remaining = etaCountdown(job, now);
  if (remaining === null) return null;
  const color = remaining < 0 ? "var(--breach)" : remaining <= 10 ? "var(--warn)" : "var(--info)";
  const label = remaining >= 0 ? `ETA ${remaining}m left` : `ETA ${Math.abs(remaining)}m over`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}66`, padding: "3px 8px", borderRadius: 20 }}>
      <Navigation size={11} /> {label}
    </span>
  );
}

// Six-step lifecycle used by JobProgressBar. Returns null for cancelled
// jobs (they don't have a meaningful "next milestone" to show progress
// toward — the cancelled banner shown elsewhere covers that case).
function jobMilestones(job) {
  if (job.status === "cancelled") return null;
  const submitted = job.status !== "dispatched";
  const resultDone = job.status === "reviewed" || job.status === "emailed";
  const resultLabel = job.status === "emailed" ? "Sent" : job.status === "reviewed" ? "Closed" : "Result";
  const etaText = job.eta ? (job.eta.label === "Other" ? job.eta.detail : job.eta.label) : null;
  return [
    { key: "dispatched", label: "Dispatched", done: true, ts: job.dispatchTime },
    { key: "acknowledged", label: "Acknowledged", done: !!job.acknowledgedAt, ts: job.acknowledgedAt, sub: etaText ? `ETA ${etaText}` : null },
    { key: "onsite", label: "Onsite", done: !!job.onsiteTime, ts: job.onsiteTime },
    { key: "submitted", label: "Submitted", done: submitted, ts: job.offsiteTime },
    { key: "offsite", label: "Offsite", done: !!job.offsiteTime, ts: job.offsiteTime },
    { key: "result", label: resultLabel, done: resultDone, ts: job.status === "emailed" ? job.emailedAt : null },
  ];
}

function JobProgressBar({ job, compact }) {
  const milestones = jobMilestones(job);
  if (!milestones) {
    return compact ? null : (
      <div style={{ fontSize: 11.5, color: "var(--breach)", fontWeight: 600 }}>Cancelled</div>
    );
  }
  const dotSize = compact ? 7 : 20;
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {milestones.map((m, i) => (
        <React.Fragment key={m.key}>
          {i > 0 && <div style={{ width: compact ? 8 : 18, height: 2, background: m.done ? "var(--ok)" : "var(--border)", flexShrink: 0 }} />}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }} title={`${m.label}${m.ts ? ` — ${fmtDateTime(m.ts)}` : ""}${m.sub ? ` (${m.sub})` : ""}`}>
            <div style={{
              width: dotSize, height: dotSize, borderRadius: "50%", flexShrink: 0,
              background: m.done ? "var(--ok)" : "var(--panel)",
              border: `1px solid ${m.done ? "var(--ok)" : "var(--border)"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {!compact && m.done && <CheckCircle2 size={13} color="#fff" />}
            </div>
            {!compact && <div style={{ fontSize: 9.5, color: m.done ? "var(--text)" : "var(--text-dim)", marginTop: 4, whiteSpace: "nowrap" }}>{m.label}</div>}
            {!compact && m.sub && <div style={{ fontSize: 8.5, color: "var(--accent)", fontWeight: 600, whiteSpace: "nowrap" }}>{m.sub}</div>}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------
   OPERATOR VIEW
---------------------------------------------------------------- */

function OperatorView({ session, jobs, accounts, sites, persistSites, zones, roster, persistRoster, persist, now, companyName }) {
  const [tab, setTab] = useState("board");
  const [selectedId, setSelectedId] = useState(null);
  // Jobs closed/cancelled 48h+ ago live off the board (see jobArchive.js).
  // Board fetches archived matches itself as the user searches (never all
  // of them at once — see jobArchive.js) and hands the full object back
  // here alongside its id, since it won't be in `jobs` for the lookup below.
  const [selectedArchivedJob, setSelectedArchivedJob] = useState(null);
  const selected = jobs.find((j) => j.id === selectedId) || (selectedArchivedJob?.id === selectedId ? selectedArchivedJob : null);
  function selectJob(id, archivedJob) {
    setSelectedId(id);
    setSelectedArchivedJob(archivedJob || null);
  }
  const patrolmen = accounts.filter((a) => a.role === "patrolman");

  return (
    <div style={{ display: "flex", minHeight: 560 }}>
      <div style={{ width: 168, borderRight: "1px solid var(--border)", background: "var(--panel)", padding: "16px 10px" }}>
        {[
          { id: "board", label: "Dispatch board", icon: ShieldAlert },
          { id: "new", label: "New job", icon: Send },
          { id: "cancelled", label: "Cancelled jobs", icon: Ban },
          { id: "closed", label: "Closed jobs", icon: CheckCircle2 },
          { id: "roster", label: "Roster", icon: CalendarDays },
          { id: "live", label: "Live Location", icon: MapPin },
          { id: "logs", label: "Logs & analysis", icon: BarChart3 },
        ].map((t) => (
          <button key={t.id} onClick={() => { setTab(t.id); selectJob(null); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", marginBottom: 4, borderRadius: 7, border: "none", cursor: "pointer", textAlign: "left", fontSize: 12.5, fontWeight: 600, background: tab === t.id ? "var(--accent-dim)" : "transparent", color: tab === t.id ? "var(--accent)" : "var(--text-dim)" }}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, padding: 20, overflowY: "auto" }}>
        {tab === "board" && !selected && <Board jobs={jobs} now={now} onSelect={selectJob} />}
        {tab === "cancelled" && !selected && <Board jobs={jobs} now={now} onSelect={selectJob} lockedStatus="cancelled" />}
        {tab === "closed" && !selected && <Board jobs={jobs} now={now} onSelect={selectJob} lockedStatus="emailed" />}
        {(tab === "board" || tab === "cancelled" || tab === "closed") && selected && (
          <JobDetailOperator job={selected} jobs={jobs} patrolmen={patrolmen} roster={roster} persist={persist} now={now} session={session} companyName={companyName} onBack={() => selectJob(null)} />
        )}
        {tab === "new" && <NewJobForm jobs={jobs} sites={sites} persistSites={persistSites} zones={zones} patrolmen={patrolmen} roster={roster} session={session} persist={persist} onCreated={(id) => { setTab("board"); selectJob(id); }} />}
        {tab === "roster" && <RosterView zones={zones} accounts={accounts} roster={roster} persistRoster={persistRoster} />}
        {tab === "live" && (
          <div>
            <JobAlertsBanner
              title="Get notified if a patrolman stays in one spot for 30+ minutes"
              subtitle="A welfare check nudge — works even with this tab in the background."
              buttonLabel="Turn on stationary alerts"
              toastText="Stationary alerts turned on for this device."
            />
            <Suspense fallback={<div style={{ padding: 20, color: "var(--text-dim)", fontSize: 13 }}>Loading map…</div>}>
              <LiveLocationMap roster={roster} accounts={accounts} jobs={jobs} sites={sites} persistSites={persistSites} />
            </Suspense>
          </div>
        )}
        {tab === "logs" && <Logs jobs={jobs} now={now} role="operator" />}
      </div>
    </div>
  );
}

const BOARD_GROUPS = [
  { key: "dispatched", title: "Out with patrolmen" },
  { key: "submitted", title: "Awaiting your review" },
  { key: "reviewed", title: "Reviewed — ready to send" },
  { key: "emailed", title: "Closed out" },
  { key: "cancelled", title: "Cancelled / stood down" },
];
const BOARD_ACTIVE_KEYS = new Set(["dispatched", "submitted", "reviewed"]);
const BOARD_STATUS_OPTIONS = [
  { value: "active", label: "Active jobs" },
  { value: "cancelled", label: "Cancelled / stood down" },
  { value: "emailed", label: "Closed out" },
  { value: "all", label: "All statuses" },
];

// lockedStatus pins the board to one status with no picker — used by the
// dedicated "Cancelled jobs" / "Closed jobs" tabs. Left unset on the main
// Dispatch board, which defaults to active jobs only and lets Control
// Room widen the view (or search for anything by number/site/date).
function Board({ jobs, now, onSelect, lockedStatus }) {
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [statusFilter, setStatusFilter] = useState(lockedStatus || "active");
  const [archiveMatches, setArchiveMatches] = useState([]);

  const groups = statusFilter === "all"
    ? BOARD_GROUPS
    : statusFilter === "active"
    ? BOARD_GROUPS.filter((g) => BOARD_ACTIVE_KEYS.has(g.key))
    : BOARD_GROUPS.filter((g) => g.key === statusFilter);
  const groupKeys = new Set(groups.map((g) => g.key));

  const q = search.trim().toLowerCase();
  const hasFilter = q || dateFrom || dateTo || timeFrom || timeTo || (!lockedStatus && statusFilter !== "active");
  const filtered = jobs.filter((j) => {
    if (q && !j.jobNumber.toLowerCase().includes(q) && !j.siteName.toLowerCase().includes(q)) return false;
    if (dateFrom || dateTo) {
      const d = isoDateOnly(j.dispatchTime);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
    }
    if (timeFrom || timeTo) {
      const t = isoTimeOnly(j.dispatchTime);
      if (timeFrom && t < timeFrom) return false;
      if (timeTo && t > timeTo) return false;
    }
    return true;
  });
  const visible = filtered.filter((j) => groupKeys.has(j.status));

  // A typed search also reaches jobs the daily archive sweep has already
  // moved off this board (closed/cancelled 48h+ ago) — queried server-side
  // (see jobArchive.js) so this stays fast and bounded no matter how much
  // history has piled up; debounced so it doesn't fire on every keystroke.
  useEffect(() => {
    if (!q) { setArchiveMatches([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      searchArchivedJobs(q).then((results) => { if (!cancelled) setArchiveMatches(results); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  function clearFilters() {
    setSearch(""); setDateFrom(""); setDateTo(""); setTimeFrom(""); setTimeTo("");
    if (!lockedStatus) setStatusFilter("active");
  }

  if (jobs.length === 0 && !q) return <Empty text="No jobs dispatched yet. Use “New job” to send the first alarm response." />;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap", marginBottom: 20, padding: 12, borderRadius: 8, background: "var(--panel-alt)", border: "1px solid var(--border)" }}>
        <Field label="Job number or site" style={{ marginBottom: 0, flex: "1 1 200px" }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. JB-0002 or Northgate" style={{ ...selectStyle, background: "var(--panel)" }} />
        </Field>
        {!lockedStatus && (
          <Field label="Status" style={{ marginBottom: 0 }}>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 180 }}>
              {BOARD_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Date from" style={{ marginBottom: 0 }}>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 160 }} />
        </Field>
        <Field label="Date to" style={{ marginBottom: 0 }}>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 160 }} />
        </Field>
        <Field label="From time" style={{ marginBottom: 0 }}>
          <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 120 }} />
        </Field>
        <Field label="To time" style={{ marginBottom: 0 }}>
          <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 120 }} />
        </Field>
        {hasFilter && <button onClick={clearFilters} style={{ ...secondaryBtn, marginBottom: 0 }}><X size={13} /> Clear filters</button>}
      </div>

      {visible.length === 0 && archiveMatches.length === 0 && (
        <Empty text={
          hasFilter ? "No jobs match these filters."
          : lockedStatus ? "Nothing here yet."
          : "No active jobs right now — check Cancelled jobs or Closed jobs for past activity."
        } />
      )}

      {groups.map((g) => {
        const meta = STATUS_META[g.key];
        const list = filtered.filter((j) => j.status === g.key).sort((a, b) => new Date(b.dispatchTime) - new Date(a.dispatchTime));
        if (!list.length) return null;
        return (
          <div key={g.key} style={{ marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: meta.color, marginBottom: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color }} />
              {g.title} ({list.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {list.map((j) => <JobCard key={j.id} job={j} now={now} onClick={() => onSelect(j.id)} />)}
            </div>
          </div>
        );
      })}

      {archiveMatches.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)", marginBottom: 8 }}>
            <Archive size={13} />
            Archived — closed 48h+ ago ({archiveMatches.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, opacity: 0.75 }}>
            {archiveMatches.sort((a, b) => new Date(b.dispatchTime) - new Date(a.dispatchTime)).map((j) => <JobCard key={j.id} job={j} now={now} onClick={() => onSelect(j.id, j)} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function JobCard({ job, now, onClick }) {
  const t = jobTiming(job, now);
  const borderColor = job.status === "dispatched" ? (t.level === "breach" ? "var(--breach)" : t.level === "warn" ? "var(--warn)" : "var(--border)") : "var(--border)";
  return (
    <div onClick={onClick} style={{ padding: "12px 14px", borderRadius: 8, background: "var(--panel)", border: `1px solid ${borderColor}`, cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)", width: 96, flexShrink: 0 }}>
          <div>{job.jobNumber}</div>
          <div style={{ fontSize: 10, marginTop: 2 }}>{fmtDateTime(job.dispatchTime)}</div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.siteName}</div>
        </div>
        <StatusBadge status={job.status} />
        <ChevronRight size={15} color="var(--text-dim)" style={{ flexShrink: 0 }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
        <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{job.run} · {job.monitoringCo} · assigned {job.assigneeName}{job.handlingName ? ` · handled by ${job.handlingName}` : ""}</span>
        {job.delayReason && <span title={job.delayReason}><AlertTriangle size={14} color="var(--warn)" /></span>}
        {job.status === "dispatched" && !job.onsiteTime && (
          job.acknowledgedAt
            ? <span title={`Acknowledged by ${job.assigneeName} at ${fmtTime(job.acknowledgedAt)}`}><CheckCircle2 size={14} color="var(--ok)" /></span>
            : <span title="Not yet acknowledged by the patrolman"><Bell size={14} color="var(--warn)" /></span>
        )}
        <SlaChip job={job} now={now} />
      </div>
      <div style={{ marginTop: 8 }}>
        <JobProgressBar job={job} compact />
      </div>
    </div>
  );
}

function Empty({ text }) {
  return <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)", fontSize: 13, border: "1px dashed var(--border)", borderRadius: 10 }}>{text}</div>;
}

/* ---------------------- New job form ---------------------- */

function NewJobForm({ jobs, sites, persistSites, zones, patrolmen, roster, session, persist, onCreated }) {
  const showToast = useToast();
  const [siteId, setSiteId] = useState("");
  const [siteQuery, setSiteQuery] = useState("");
  const [jobNumber, setJobNumber] = useState(() => `JB-${String(jobs.length + 1).padStart(4, "0")}`);
  const [orderNo, setOrderNo] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [keyInfo, setKeyInfo] = useState("");
  const [alarmCode, setAlarmCode] = useState("");
  const [addingSite, setAddingSite] = useState(false);
  const [dispatching, setDispatching] = useState(false);

  const site = sites.find((s) => s.id === siteId);

  const todaysEntries = roster.filter((r) => r.date === rosterDateISO());
  function rosteredPatrolmenFor(run) {
    const seen = new Set();
    return todaysEntries
      .filter((r) => r.run === run)
      .map((r) => patrolmen.find((p) => p.loginName === r.patrolmanLoginName))
      .filter((p) => p && !seen.has(p.loginName) && seen.add(p.loginName));
  }

  const rosteredOnThisRun = site ? rosteredPatrolmenFor(site.run) : [];
  const fallbackOnThisRun = site && rosteredOnThisRun.length === 0 ? patrolmen.filter((p) => p.run === site.run) : [];
  const rosteredElsewhereToday = (() => {
    const seen = new Set(rosteredOnThisRun.map((p) => p.loginName));
    return todaysEntries
      .filter((r) => !site || r.run !== site.run)
      .map((r) => {
        const p = patrolmen.find((p) => p.loginName === r.patrolmanLoginName);
        return p ? { ...p, run: r.run } : null;
      })
      .filter((p) => p && !seen.has(p.loginName) && seen.add(p.loginName));
  })();

  const recommended = rosteredOnThisRun.length ? rosteredOnThisRun : fallbackOnThisRun;
  // Same order as the "Dispatch to" dropdown below — roster-corrected
  // entries (today's actual run) take priority over the raw account, so
  // dispatch() resolves the same run the dropdown actually showed.
  const assigneeCandidates = [...rosteredOnThisRun, ...fallbackOnThisRun, ...rosteredElsewhereToday, ...patrolmen];

  const siteLabel = (s) => `${s.name} — ${s.address}`;

  useEffect(() => {
    if (site) {
      setKeyInfo(site.keyInfo || "");
      setAlarmCode(site.alarmCode || "");
      setAssigneeId(recommended[0]?.loginName || "");
    }
    // eslint-disable-next-line
  }, [siteId]);

  function handleSiteQueryChange(value) {
    setSiteQuery(value);
    const match = sites.find((s) => siteLabel(s) === value);
    setSiteId(match ? match.id : "");
    if (match) setAddingSite(false);
  }

  function handleSiteAdded(newSite) {
    persistSites([...sites, newSite]);
    setSiteId(newSite.id);
    setSiteQuery(siteLabel(newSite));
    setAddingSite(false);
  }

  function clearSite() {
    setSiteId("");
    setSiteQuery("");
    setKeyInfo("");
    setAlarmCode("");
    setAssigneeId("");
    setAddingSite(false);
  }

  const canDispatch = site && description.trim() && assigneeId && jobNumber.trim();

  // Guards against a double-click (or a slow network making someone tap
  // "Dispatch" again, thinking the first tap didn't register) creating
  // two separate job records for the same alarm — canDispatch alone only
  // checks the form is filled in, not whether a dispatch is already in
  // flight, and the form fields it's built from don't clear until this
  // whole function (including the await) finishes.
  async function dispatch() {
    if (dispatching) return;
    setDispatching(true);
    try {
      await doDispatch();
    } finally {
      setDispatching(false);
    }
  }

  async function doDispatch() {
    const assignee = assigneeCandidates.find((r) => r.loginName === assigneeId);
    const job = {
      id: `job_${Date.now()}`,
      jobNumber: jobNumber.trim(),
      orderNo: orderNo.trim(),
      siteId: site.id,
      siteName: site.name,
      address: site.address,
      run: assignee.run || site.run,
      monitoringCo: site.monitoringCo,
      monitoringEmail: site.monitoringEmail || "",
      bureau: site.bureau || "",
      poNumber: site.poNumber || "",
      description: description.trim(),
      keyInfo,
      alarmCode,
      assigneeId: assignee.loginName,
      assigneeName: assignee.displayName,
      dispatchedByLoginName: session.loginName,
      dispatchedByName: session.displayName,
      handlingLoginName: session.loginName,
      handlingName: session.displayName,
      dispatchTime: new Date().toISOString(),
      status: "dispatched",
      outcomeNotes: "",
      docketNo: "",
      photos: [],
      onsiteTime: null,
      offsiteTime: null,
      delayReason: null,
      reviewNotes: "",
      emailedAt: null,
      clientEmail: "",
      emailSentByApp: false,
      onsiteLocation: null,
      onsiteLocationName: null,
      offsiteLocation: null,
      offsiteLocationName: null,
      activityLog: [logEntry(session, "Dispatched", `Assigned to ${assignee.displayName}`)],
      standDowns: [],
    };
    await persist([...jobs, job]);
    notifyJobDispatch({
      jobId: job.id,
      loginName: assignee.loginName,
      role: "patrolman",
      title: `New job — ${job.jobNumber}`,
      body: `${job.siteName} — tap Acknowledge to confirm receipt.`,
    }).then((result) => {
      if (result.total === 0) {
        showToast("Job dispatched, but that patrolman hasn't turned on job alerts.", "error");
      } else if (result.sent === 0) {
        showToast("Job dispatched, but the push alert failed to deliver.", "error");
      }
    });
    setSiteId(""); setSiteQuery(""); setDescription(""); setAssigneeId(""); setKeyInfo(""); setAlarmCode(""); setOrderNo("");
    setJobNumber(`JB-${String(jobs.length + 2).padStart(4, "0")}`);
    onCreated(job.id);
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <SectionTitle icon={Send} title="Dispatch a new alarm response" />
      <Field label="Site">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            list="new-job-site-options"
            value={siteQuery}
            onChange={(e) => handleSiteQueryChange(e.target.value)}
            placeholder="Start typing a site name…"
            style={{ ...selectStyle, flex: 1 }}
          />
          <datalist id="new-job-site-options">
            {sites.map((s) => <option key={s.id} value={siteLabel(s)} />)}
          </datalist>
          <button
            type="button"
            onClick={() => { setAddingSite(true); setSiteId(""); }}
            style={{ ...secondaryBtn, whiteSpace: "nowrap" }}
          >
            <MapPin size={13} /> New site
          </button>
          {(siteQuery || addingSite) && (
            <button type="button" onClick={clearSite} title="Clear site" style={{ ...iconBtn, flexShrink: 0 }}>
              <X size={13} />
            </button>
          )}
        </div>
        {siteQuery && !site && !addingSite && (
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 6 }}>
            No matching site yet — click "New site" to add "{siteQuery}".
          </div>
        )}
      </Field>

      {addingSite && (
        <AddSiteInline zones={zones} initialName={site ? "" : siteQuery} onCancel={() => setAddingSite(false)} onAdded={handleSiteAdded} />
      )}

      {site && !addingSite && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14, display: "flex", gap: 14, flexWrap: "wrap" }}>
          <a href={mapsUrl(site.address)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", textDecoration: "none" }}>
            <MapPin size={11} style={{ verticalAlign: -1 }} /> {site.address}
          </a>
          <span><Building2 size={11} style={{ verticalAlign: -1 }} /> {site.monitoringCo}</span>
          {site.bureau && <span>Bureau: {site.bureau}</span>}
          <span>{site.run}</span>
        </div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <Field label="Job number" style={{ flex: 1 }}>
          <input value={jobNumber} onChange={(e) => setJobNumber(e.target.value)} placeholder="Our own job reference" style={selectStyle} />
        </Field>
        <Field label="Order number (optional)" style={{ flex: 1 }}>
          <input value={orderNo} onChange={(e) => setOrderNo(e.target.value)} placeholder="Client / monitoring company's reference" style={selectStyle} />
        </Field>
      </div>

      <Field label="Alarm description / area(s) in alarm">
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value.toUpperCase())} placeholder="e.g. Zone 4 motion sensor — loading dock" style={{ ...selectStyle, resize: "vertical", fontFamily: "var(--sans)" }} />
      </Field>

      <div style={{ display: "flex", gap: 12 }}>
        <Field label="Key number / code" style={{ flex: 1 }}><input value={keyInfo} onChange={(e) => setKeyInfo(e.target.value)} style={selectStyle} /></Field>
        <Field label="Alarm code" style={{ width: 130 }}><input value={alarmCode} onChange={(e) => setAlarmCode(e.target.value)} style={selectStyle} /></Field>
      </div>

      <Field label="Dispatch to">
        <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} style={selectStyle}>
          <option value="">Select patrolman…</option>
          {rosteredOnThisRun.length > 0 && <optgroup label="Rostered on this run today">{rosteredOnThisRun.map((r) => <option key={r.loginName} value={r.loginName}>{r.displayName} · {r.loginName}</option>)}</optgroup>}
          {fallbackOnThisRun.length > 0 && <optgroup label="On this run">{fallbackOnThisRun.map((r) => <option key={r.loginName} value={r.loginName}>{r.displayName} · {r.loginName}</option>)}</optgroup>}
          {rosteredElsewhereToday.length > 0 && <optgroup label="Rostered today (other runs)">{rosteredElsewhereToday.map((r) => <option key={r.loginName} value={r.loginName}>{r.displayName} · {r.run} · {r.loginName}</option>)}</optgroup>}
          <optgroup label="All patrolmen">{patrolmen.map((r) => <option key={r.loginName} value={r.loginName}>{r.displayName} · {r.run} · {r.loginName}</option>)}</optgroup>
        </select>
      </Field>

      <button disabled={!canDispatch || dispatching} onClick={dispatch} style={{ ...primaryBtn, width: "100%", marginTop: 6, opacity: canDispatch && !dispatching ? 1 : 0.4, cursor: canDispatch && !dispatching ? "pointer" : "not-allowed" }}>
        <Send size={14} /> {dispatching ? "Dispatching…" : "Dispatch job"}
      </button>
    </div>
  );
}

/* ---------------------- Inline "add a new site" (Control Room) ---------------------- */

function AddSiteInline({ zones, initialName = "", onCancel, onAdded }) {
  const blank = { name: initialName, address: "", poNumber: "", monitoringCo: "", monitoringEmail: "", bureau: "", run: zones[0] || "Unassigned" };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState("");

  function set(field, value) { setForm((f) => ({ ...f, [field]: value })); }

  function save() {
    if (!form.name.trim() || !form.address.trim()) { setError("Site name and address are required."); return; }
    onAdded({
      id: `site_${Date.now()}`,
      name: form.name.trim(),
      address: form.address.trim(),
      poNumber: form.poNumber.trim(),
      monitoringCo: form.monitoringCo.trim(),
      monitoringEmail: form.monitoringEmail.trim(),
      bureau: form.bureau.trim(),
      run: form.run,
      keyInfo: "",
      alarmCode: "",
    });
  }

  return (
    <div style={{ padding: 14, borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-alt)", marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>New site</div>
      <Field label="Site name"><input value={form.name} onChange={(e) => set("name", e.target.value)} style={selectStyle} /></Field>
      <Field label="Address"><input value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Street, suburb, state" style={selectStyle} /></Field>
      <div style={{ display: "flex", gap: 12 }}>
        <Field label="PO number" style={{ flex: 1 }}><input value={form.poNumber} onChange={(e) => set("poNumber", e.target.value)} style={selectStyle} /></Field>
        <Field label="Run / zone" style={{ width: 160 }}>
          <select value={form.run} onChange={(e) => set("run", e.target.value)} style={selectStyle}>
            <option value="Unassigned">Unassigned</option>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <Field label="Monitoring" style={{ flex: 1 }}><input value={form.monitoringCo} onChange={(e) => set("monitoringCo", e.target.value)} placeholder="Who dispatches the alarm to us" style={selectStyle} /></Field>
        <Field label="Bureau" style={{ flex: 1 }}><input value={form.bureau} onChange={(e) => set("bureau", e.target.value)} placeholder="Who we invoice, if different" style={selectStyle} /></Field>
      </div>
      <Field label="Monitoring email (optional)"><input type="email" value={form.monitoringEmail} onChange={(e) => set("monitoringEmail", e.target.value)} placeholder="Where to send the outcome report" style={selectStyle} /></Field>
      {error && <div style={{ color: "var(--breach)", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={save} style={secondaryBtn}><MapPin size={13} /> Save site</button>
        <button onClick={onCancel} style={iconBtn}><X size={13} /></button>
      </div>
    </div>
  );
}

// Prompted the moment Control Room opens a job whose patrolman has given
// an ETA longer than the site's SLA, and not already advised — a
// proactive heads-up (the patrolman said 90 minutes, the SLA is 60)
// rather than waiting for the SLA to actually lapse. "Not yet" just
// closes this viewing; it reappears next time the job is reopened until
// someone actually confirms monitoring's been told, since that's the
// one outcome worth recording.
function EtaDelayModal({ etaMinutes, slaMin, onAcknowledge, onDismiss }) {
  const [advisedTo, setAdvisedTo] = useState("");
  const canConfirm = advisedTo.trim();

  function confirm() {
    if (!canConfirm) return;
    onAcknowledge(advisedTo.trim());
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, width: 400, maxWidth: "90%", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <SectionTitle icon={AlertTriangle} title="Delay exceeds SLA" small />
          <button onClick={onDismiss} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 14, lineHeight: 1.5 }}>
          The patrolman's ETA (<b style={{ color: "var(--text)" }}>{etaMinutes} min</b>) is longer than this site's <b style={{ color: "var(--text)" }}>{slaMin}-minute</b> SLA. Have you advised monitoring about this delay?
        </div>
        <Field label="Who did you advise? (name)">
          <input
            value={advisedTo}
            onChange={(e) => setAdvisedTo(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirm(); }}
            placeholder="e.g. Sarah at SECOM"
            style={selectStyle}
            autoFocus
          />
        </Field>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button onClick={onDismiss} style={secondaryBtn}>Not yet</button>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            style={{ ...primaryBtn, flex: 1, justifyContent: "center", opacity: canConfirm ? 1 : 0.5, cursor: canConfirm ? "pointer" : "not-allowed" }}
          >
            <CheckCircle2 size={14} /> Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------- Operator job detail ---------------------- */

function JobDetailOperator({ job, jobs, patrolmen, roster, session, persist, now, onBack, companyName }) {
  const [notes, setNotes] = useState(job.reviewNotes || job.outcomeNotes);
  const [delayText, setDelayText] = useState("");
  const [showEmail, setShowEmail] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [onsiteEdit, setOnsiteEdit] = useState(toLocalInputValue(job.onsiteTime));
  const [offsiteEdit, setOffsiteEdit] = useState(toLocalInputValue(job.offsiteTime));
  const [photos, setPhotos] = useState([]);
  const [photosLoaded, setPhotosLoaded] = useState(false);
  const [showEtaDelayModal, setShowEtaDelayModal] = useState(false);
  const [showEditJob, setShowEditJob] = useState(false);
  const [editJobNumber, setEditJobNumber] = useState(job.jobNumber || "");
  const [editOrderNo, setEditOrderNo] = useState(job.orderNo || "");
  const [editDocketNo, setEditDocketNo] = useState(job.docketNo || "");
  const [editSiteName, setEditSiteName] = useState(job.siteName || "");
  const [editAddress, setEditAddress] = useState(job.address || "");
  const [editMonitoringCo, setEditMonitoringCo] = useState(job.monitoringCo || "");
  const [editBureau, setEditBureau] = useState(job.bureau || "");
  const [editDescription, setEditDescription] = useState(job.description || "");
  const showToast = useToast();

  useEffect(() => setNotes(job.reviewNotes || job.outcomeNotes), [job.id]);
  useEffect(() => {
    setOnsiteEdit(toLocalInputValue(job.onsiteTime));
    setOffsiteEdit(toLocalInputValue(job.offsiteTime));
  }, [job.id, job.onsiteTime, job.offsiteTime]);
  // Reset the edit form to the job's current values whenever a different
  // job is opened, so stale edits from a previous job can't be saved onto
  // this one.
  useEffect(() => {
    setShowEditJob(false);
    setEditJobNumber(job.jobNumber || "");
    setEditOrderNo(job.orderNo || "");
    setEditDocketNo(job.docketNo || "");
    setEditSiteName(job.siteName || "");
    setEditAddress(job.address || "");
    setEditMonitoringCo(job.monitoringCo || "");
    setEditBureau(job.bureau || "");
    setEditDescription(job.description || "");
  }, [job.id]);

  // Fetched on demand, not part of the polled `jobs` prop — see jobPhotos.js.
  useEffect(() => {
    setPhotos([]);
    setPhotosLoaded(false);
    if (job.photoCount > 0) {
      fetchJobPhotos(job.id).then((p) => { setPhotos(p); setPhotosLoaded(true); });
    } else {
      setPhotosLoaded(true);
    }
  }, [job.id, job.photoCount]);

  const jobWithPhotos = { ...job, photos };

  async function downloadPdf() {
    setPdfBusy(true);
    try {
      await downloadJobAttendancePdf(jobWithPhotos, companyName, now);
    } catch (e) {
      showToast("Couldn't generate the PDF — try again.", "error");
    }
    setPdfBusy(false);
  }

  const t = jobTiming(job, now);

  function update(patch) {
    const updated = jobs.map((j) => (j.id === job.id ? { ...j, ...patch } : j));
    return persist(updated);
  }

  // Merges a new entry into the job's activity log alongside whatever
  // else the patch is changing, so every operator action lands in one
  // persisted update rather than a separate round trip.
  function logAction(action, detail, patch = {}) {
    return update({ ...patch, activityLog: [...(job.activityLog || []), logEntry(session, action, detail)] });
  }

  // A job with status "dispatched" is never an archived one (only
  // terminal jobs move to the archive — see jobArchive.js), so no extra
  // isArchived check is needed here.
  const etaMinutes = parseEtaMinutes(job.eta);
  const etaExceedsSla = job.status === "dispatched" && !!job.acknowledgedAt && etaMinutes !== null && etaMinutes > t.slaMin;

  // Prompts once per fresh view of a job whose stated ETA already exceeds
  // the SLA — proactive, ahead of the SLA actually lapsing, since by then
  // the delay is already known from what the patrolman said. "Not yet"
  // only closes this viewing (job.etaDelayAdvisedAt stays unset), so it
  // comes back next time the job is reopened until someone actually
  // confirms monitoring's been told.
  useEffect(() => {
    if (etaExceedsSla && !job.etaDelayAdvisedAt) setShowEtaDelayModal(true);
    // eslint-disable-next-line
  }, [job.id, job.eta, job.acknowledgedAt, job.etaDelayAdvisedAt]);

  function acknowledgeEtaDelay(advisedTo) {
    logAction(
      "Monitoring advised of ETA delay",
      `Advised ${advisedTo} — patrolman ETA ${etaMinutes}m exceeds ${t.slaMin}m SLA`,
      { etaDelayAdvisedAt: new Date().toISOString(), etaDelayAdvisedTo: advisedTo }
    );
    setShowEtaDelayModal(false);
  }

  const onsiteChanged = toLocalInputValue(job.onsiteTime) !== onsiteEdit;
  const offsiteChanged = toLocalInputValue(job.offsiteTime) !== offsiteEdit;

  function saveTimes() {
    const newOnsite = fromLocalInputValue(onsiteEdit);
    const newOffsite = fromLocalInputValue(offsiteEdit);
    const changes = [];
    if (onsiteChanged) changes.push(`Onsite ${fmtDateTime(job.onsiteTime)} → ${fmtDateTime(newOnsite)}`);
    if (offsiteChanged) changes.push(`Offsite ${fmtDateTime(job.offsiteTime)} → ${fmtDateTime(newOffsite)}`);
    if (!changes.length) return;
    logAction("Onsite/offsite time corrected", changes.join(" · "), { onsiteTime: newOnsite, offsiteTime: newOffsite });
  }

  const canSaveJobEdit = editJobNumber.trim() && editSiteName.trim() && editAddress.trim() && editDescription.trim();

  // Every field stays editable after dispatch, including the job number —
  // control room may need to correct any of it once more details come in.
  // Each changed field is logged individually so the activity log stays a
  // readable audit trail rather than one opaque "job edited" line.
  function saveJobDetails() {
    if (!canSaveJobEdit) return;
    const patch = {};
    const changes = [];
    function diff(label, key, newVal) {
      const oldVal = job[key] || "";
      const cleaned = newVal.trim();
      if (cleaned !== oldVal) {
        changes.push(`${label} "${oldVal || "—"}" → "${cleaned || "—"}"`);
        patch[key] = cleaned;
      }
    }
    diff("Job number", "jobNumber", editJobNumber);
    diff("Order No", "orderNo", editOrderNo);
    diff("Docket No", "docketNo", editDocketNo);
    diff("Site name", "siteName", editSiteName);
    diff("Address", "address", editAddress);
    diff("Monitoring company", "monitoringCo", editMonitoringCo);
    diff("Bureau", "bureau", editBureau);
    diff("Alarm / area", "description", editDescription);
    setShowEditJob(false);
    if (!changes.length) return;
    logAction("Job details edited", changes.join(" · "), patch);
    showToast("Job details updated.");
  }

  // Sequenced deliberately, each one awaited before the next starts.
  // notifyJobDispatch and notifyStandDown both do a server-side
  // read-modify-write on the same ops:jobs blob (to stamp an ackToken /
  // standDowns entry) — firing them concurrently with the reassignment
  // persist let a stale read from one silently overwrite the others'
  // change, sometimes reverting the reassignment entirely.
  async function reassign(loginName) {
    const p = patrolmen.find((a) => a.loginName === loginName);
    if (!p || p.loginName === job.assigneeId) return;
    const previousLoginName = job.assigneeId;
    const previousName = job.assigneeName;
    const todaysEntry = roster.find((r) => r.date === rosterDateISO() && r.patrolmanLoginName === loginName);
    await logAction(
      "Reassigned",
      previousName ? `From ${previousName} to ${p.displayName}` : `To ${p.displayName}`,
      { assigneeId: p.loginName, assigneeName: p.displayName, run: (todaysEntry ? todaysEntry.run : p.run) || job.run }
    );
    const dispatchResult = await notifyJobDispatch({
      jobId: job.id,
      loginName: p.loginName,
      role: "patrolman",
      title: `Job reassigned to you — ${job.jobNumber}`,
      body: `${job.siteName} — tap Acknowledge to confirm receipt.`,
    });
    if (dispatchResult.total === 0) {
      showToast("Reassigned, but that patrolman hasn't turned on job alerts.", "error");
    } else if (dispatchResult.sent === 0) {
      showToast("Reassigned, but the push alert failed to deliver.", "error");
    }
    if (previousLoginName) {
      const standDownResult = await notifyStandDown({
        jobId: job.id,
        loginName: previousLoginName,
        patrolmanName: previousName,
        reassignedToName: p.displayName,
      });
      if (standDownResult.total === 0) {
        showToast(`${previousName} wasn't notified — they haven't turned on job alerts.`, "error");
      } else if (standDownResult.sent === 0) {
        showToast(`${previousName} wasn't notified — the push alert failed to deliver.`, "error");
      }
    }
  }

  async function confirmCancel() {
    setCancelBusy(true);
    const patch = { status: "cancelled", cancelReason: cancelReason.trim(), cancelledAt: new Date().toISOString() };
    const backup = await sendPhotoBackupEmail({ ...jobWithPhotos, ...patch });
    if (backup.sent) patch.photosBackedUpAt = new Date().toISOString();
    await logAction("Cancelled", cancelReason.trim(), patch);
    setCancelBusy(false);
    setShowCancelForm(false);
    showToast("Job cancelled.");
  }

  function takeJob() {
    logAction("Took handling of job", "", { handlingLoginName: session.loginName, handlingName: session.displayName });
    showToast("You're now handling this job.");
  }

  const isHandling = job.handlingLoginName === session.loginName;
  // Not in the live `jobs` array means the daily archive sweep already
  // moved it off the board (see jobArchive.js) — still viewable with its
  // photos, but every mutation here writes back to `ops:jobs`, which no
  // longer has a matching entry, so edits would silently go nowhere.
  const isArchived = !jobs.some((j) => j.id === job.id);

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <button onClick={onBack} style={backBtn}><ArrowLeft size={13} /> Back to board</button>
        <div style={{ display: "flex", gap: 8 }}>
          {!isArchived && (
            <button onClick={() => setShowEditJob((v) => !v)} style={secondaryBtn}>
              <Pencil size={13} /> {showEditJob ? "Close edit" : "Edit details"}
            </button>
          )}
          <button onClick={downloadPdf} disabled={pdfBusy || !photosLoaded} style={{ ...secondaryBtn, opacity: pdfBusy || !photosLoaded ? 0.6 : 1 }}>
            <Download size={13} /> {pdfBusy ? "Generating…" : !photosLoaded ? "Loading…" : "Download attendance PDF"}
          </button>
        </div>
      </div>
      <JobHeader job={job} />

      {showEditJob && !isArchived && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-alt)" }}>
          <SectionTitle icon={Pencil} title="Edit job details" small />
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
            <Field label="Job number" style={{ flex: "1 1 140px" }}>
              <input value={editJobNumber} onChange={(e) => setEditJobNumber(e.target.value)} style={selectStyle} />
            </Field>
            <Field label="Order No" style={{ flex: "1 1 140px" }}>
              <input value={editOrderNo} onChange={(e) => setEditOrderNo(e.target.value)} style={selectStyle} />
            </Field>
            <Field label="Docket No" style={{ flex: "1 1 140px" }}>
              <input value={editDocketNo} onChange={(e) => setEditDocketNo(e.target.value)} style={selectStyle} />
            </Field>
          </div>
          <Field label="Site name">
            <input value={editSiteName} onChange={(e) => setEditSiteName(e.target.value)} style={selectStyle} />
          </Field>
          <Field label="Address">
            <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} style={selectStyle} />
          </Field>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Field label="Monitoring company" style={{ flex: "1 1 160px" }}>
              <input value={editMonitoringCo} onChange={(e) => setEditMonitoringCo(e.target.value)} style={selectStyle} />
            </Field>
            <Field label="Bureau" style={{ flex: "1 1 160px" }}>
              <input value={editBureau} onChange={(e) => setEditBureau(e.target.value)} style={selectStyle} />
            </Field>
          </div>
          <Field label="Alarm description / area(s) in alarm">
            <textarea rows={2} value={editDescription} onChange={(e) => setEditDescription(e.target.value.toUpperCase())} style={{ ...selectStyle, resize: "vertical", fontFamily: "var(--sans)" }} />
          </Field>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveJobDetails} disabled={!canSaveJobEdit} style={{ ...primaryBtn, opacity: canSaveJobEdit ? 1 : 0.5, cursor: canSaveJobEdit ? "pointer" : "not-allowed" }}>
              <CheckCircle2 size={14} /> Save changes
            </button>
            <button onClick={() => setShowEditJob(false)} style={secondaryBtn}>Cancel</button>
          </div>
        </div>
      )}

      {isArchived && (
        <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-alt)", fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 7 }}>
          <Archive size={13} /> Archived — closed 48h+ ago and off the live board. View only; details and photos are still here, but changes on this screen won't be saved.
        </div>
      )}

      <div style={{ marginTop: 16, overflowX: "auto", paddingBottom: 4 }}>
        <JobProgressBar job={job} />
      </div>

      {job.dispatchedByName && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)" }}>
          <span>Dispatched by <b style={{ color: "var(--text)" }}>{job.dispatchedByName}</b></span>
          <span>·</span>
          <span>Handling: <b style={{ color: isHandling ? "var(--ok)" : "var(--text)" }}>{job.handlingName}</b>{isHandling ? " (you)" : ""}</span>
          {!isHandling && !isArchived && (
            <button onClick={takeJob} style={{ ...secondaryBtn, padding: "4px 10px", fontSize: 11.5 }}>Take this job</button>
          )}
        </div>
      )}

      {!job.onsiteTime && job.status !== "cancelled" && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          {job.acknowledgedAt ? (
            <span style={{ color: "var(--ok)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <CheckCircle2 size={13} /> Acknowledged by {job.assigneeName} at {fmtTime(job.acknowledgedAt)}
              {job.eta && <> — ETA <b>{job.eta.label === "Other" ? job.eta.detail : job.eta.label}</b></>}
              <EtaChip job={job} now={now} />
            </span>
          ) : (
            <span style={{ color: "var(--warn)", display: "flex", alignItems: "center", gap: 6 }}>
              <Bell size={13} /> Not yet acknowledged by {job.assigneeName}
            </span>
          )}
        </div>
      )}

      <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>Attending patrolman</span>
        {isArchived ? (
          <span style={{ fontSize: 12.5 }}>{job.assigneeName}</span>
        ) : (
          <select value={job.assigneeId} onChange={(e) => reassign(e.target.value)} style={{ ...selectStyle, width: "auto", padding: "6px 10px", fontSize: 12.5 }}>
            {patrolmen.map((p) => <option key={p.loginName} value={p.loginName}>{p.displayName} · {p.loginName}</option>)}
          </select>
        )}
        {job.status === "dispatched" && !isArchived && (
          <button onClick={() => setShowCancelForm((v) => !v)} style={{ ...iconBtn, width: "auto", padding: "6px 10px", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--breach)", marginLeft: "auto" }}>
            <Ban size={13} /> Cancel job
          </button>
        )}
      </div>

      {job.standDowns?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          {job.standDowns[job.standDowns.length - 1].acknowledgedAt ? (
            <span style={{ color: "var(--ok)", display: "flex", alignItems: "center", gap: 6 }}>
              <CheckCircle2 size={13} /> {job.standDowns[job.standDowns.length - 1].patrolmanName} acknowledged the reassignment at {fmtTime(job.standDowns[job.standDowns.length - 1].acknowledgedAt)}
            </span>
          ) : (
            <span style={{ color: "var(--warn)", display: "flex", alignItems: "center", gap: 6 }}>
              <Bell size={13} /> Waiting on {job.standDowns[job.standDowns.length - 1].patrolmanName} to acknowledge being taken off this job
            </span>
          )}
        </div>
      )}

      {showCancelForm && (
        <div style={{ marginTop: 12, padding: 14, borderRadius: 8, border: "1px solid var(--breach)", background: "#FEF2F2" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: "#B91C1C", fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>
            <Ban size={14} /> Cancel this job — the patrolman will be notified to stand down
          </div>
          <textarea rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="e.g. Monitoring advised stand down — client cancelled the alarm" style={{ ...selectStyle, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={confirmCancel} disabled={cancelBusy} style={{ ...primaryBtn, background: "var(--breach)", opacity: cancelBusy ? 0.6 : 1, cursor: cancelBusy ? "not-allowed" : "pointer" }}>
              <Ban size={14} /> {cancelBusy ? "Cancelling…" : "Confirm cancel"}
            </button>
            <button onClick={() => setShowCancelForm(false)} disabled={cancelBusy} style={secondaryBtn}>Never mind</button>
          </div>
        </div>
      )}

      {job.status === "cancelled" && (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)", fontSize: 12.5 }}>
          <b style={{ color: "var(--text-dim)" }}>Cancelled</b> · {fmtDateTime(job.cancelledAt)}{job.cancelReason ? ` — ${job.cancelReason}` : ""}
        </div>
      )}

      {job.status === "dispatched" && t.level === "breach" && !job.delayReason && (
        <div style={{ marginTop: 16, padding: 14, borderRadius: 8, border: "1px solid var(--breach)", background: "#FEF2F2" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: "#B91C1C", fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>
            <AlertTriangle size={14} /> Response time exceeded — log a reason and advise the client
          </div>
          <textarea rows={2} value={delayText} onChange={(e) => setDelayText(e.target.value)} placeholder="e.g. Traffic incident on route, ETA 15 min — client notified by phone at 21:42" style={{ ...selectStyle, resize: "vertical" }} />
          <button disabled={!delayText.trim()} onClick={() => logAction("Delay logged", delayText.trim(), { delayReason: delayText.trim(), delayLoggedAt: new Date().toISOString() })} style={{ ...primaryBtn, marginTop: 8, opacity: delayText.trim() ? 1 : 0.4 }}>
            Save delay reason
          </button>
        </div>
      )}

      {job.delayReason && (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 8, border: "1px solid var(--warn)55", background: "#FFFBEB", fontSize: 12.5 }}>
          <b style={{ color: "var(--warn)" }}>Delay logged</b> · {fmtTime(job.delayLoggedAt)} — {job.delayReason}
        </div>
      )}

      {job.status === "dispatched" && !job.onsiteTime && <div style={{ marginTop: 18, color: "var(--text-dim)", fontSize: 13 }}>Waiting on patrolman to arrive onsite.</div>}
      {job.status === "dispatched" && job.onsiteTime && <div style={{ marginTop: 18, color: "var(--text-dim)", fontSize: 13 }}>Patrolman marked onsite at {fmtTime(job.onsiteTime)} — awaiting outcome submission.</div>}

      {(job.onsiteLocation || job.offsiteLocation) && (
        <div style={{ marginTop: 18 }}>
          <SectionTitle icon={MapPin} title="Patrolman location" small />
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
            {job.onsiteLocation && (
              <div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Onsite</div>
                <MapSnap lat={job.onsiteLocation.lat} lon={job.onsiteLocation.lon} />
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  <a href={mapsUrlLatLon(job.onsiteLocation.lat, job.onsiteLocation.lon)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", textDecoration: "none" }}>
                    {job.onsiteLocationName || formatLocation(job.onsiteLocation)} ↗
                  </a>
                </div>
              </div>
            )}
            {job.offsiteLocation && (
              <div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Offsite</div>
                <MapSnap lat={job.offsiteLocation.lat} lon={job.offsiteLocation.lon} />
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  <a href={mapsUrlLatLon(job.offsiteLocation.lat, job.offsiteLocation.lon)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", textDecoration: "none" }}>
                    {job.offsiteLocationName || formatLocation(job.offsiteLocation)} ↗
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {job.status !== "dispatched" && job.status !== "cancelled" && (
        <div style={{ marginTop: 18 }}>
          <SectionTitle icon={CheckCircle2} title="Outcome" small />
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 6 }}>
            {isArchived ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                Onsite {fmtDateTime(job.onsiteTime)} · Offsite {fmtDateTime(job.offsiteTime)}
              </div>
            ) : (
              <>
                <div>
                  <div style={{ fontSize: 10.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>Onsite</div>
                  <input type="datetime-local" value={onsiteEdit} onChange={(e) => setOnsiteEdit(e.target.value)} style={{ ...selectStyle, width: "auto", padding: "5px 8px", fontSize: 12 }} />
                </div>
                <div>
                  <div style={{ fontSize: 10.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>Offsite</div>
                  <input type="datetime-local" value={offsiteEdit} onChange={(e) => setOffsiteEdit(e.target.value)} style={{ ...selectStyle, width: "auto", padding: "5px 8px", fontSize: 12 }} />
                </div>
                {(onsiteChanged || offsiteChanged) && (
                  <button onClick={saveTimes} style={{ ...primaryBtn, padding: "6px 12px", fontSize: 12 }}><CheckCircle2 size={13} /> Save times</button>
                )}
              </>
            )}
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              response time {jobTiming(job, now).elapsed}m (SLA {jobTiming(job, now).slaMin}m)
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 10 }}>
            Docket No: <b style={{ color: "var(--text)" }}>{job.docketNo || "—"}</b>
          </div>
          {isArchived ? (
            <div style={{ ...selectStyle, minHeight: 84, whiteSpace: "pre-wrap", color: "var(--text)" }}>{notes || "—"}</div>
          ) : (
            <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...selectStyle, resize: "vertical" }} />
          )}
          {isArchived && photosLoaded && photos.length === 0 && job.photoCount > 0 && (
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8 }}>
              <Camera size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
              {job.photoCount} attendance photo{job.photoCount !== 1 ? "s" : ""} — emailed as a backup and removed once this job was archived.
            </div>
          )}
          {photos.length > 0 && (
            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              {photos.map((p, i) => (
                <div key={i} style={{ width: 100 }}>
                  <img
                    src={p.dataUrl}
                    alt="attendance evidence"
                    onClick={() => openDataUrlImage(p.dataUrl)}
                    title="Click to open full size in a new tab"
                    style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", cursor: "pointer" }}
                  />
                  <div style={{ fontSize: 9.5, color: "var(--text-dim)", marginTop: 3, lineHeight: 1.3 }}>
                    {p.ts ? fmtDateTime(p.ts) : ""}
                    {p.location && (
                      <>
                        {" · "}
                        <a href={mapsUrlLatLon(p.location.lat, p.location.lon)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", textDecoration: "none" }}>
                          {p.locationName || formatLocation(p.location)}
                        </a>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            {!isArchived && notes !== (job.reviewNotes || job.outcomeNotes) && (
              <button onClick={() => logAction("Results updated", notes.trim(), { reviewNotes: notes })} style={primaryBtn}><CheckCircle2 size={14} /> Save changes</button>
            )}
            {!isArchived && job.status === "submitted" && <button onClick={() => logAction("Marked reviewed", "", { status: "reviewed", reviewNotes: notes })} style={secondaryBtn}><CheckCircle2 size={14} /> Mark reviewed</button>}
            {!isArchived && (job.status === "reviewed" || job.status === "submitted") && <button onClick={() => { logAction("Prepared client email", "", { reviewNotes: notes }); setShowEmail(true); }} style={primaryBtn}><Mail size={14} /> Prepare client email</button>}
            {job.status === "emailed" && (
              <span style={{ color: "var(--ok)", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
                <CheckCircle2 size={14} /> {job.emailSentByApp ? `Emailed to client ${fmtDateTime(job.emailedAt)}` : `Marked sent ${fmtDateTime(job.emailedAt)}`}
              </span>
            )}
          </div>
        </div>
      )}

      <JobChatPanel
        jobId={job.id}
        session={session}
        closed={isArchived || job.status === "emailed" || job.status === "cancelled"}
        embeddedChat={isArchived ? (job.chat || []) : undefined}
      />

      <ActivityLogSection log={job.activityLog} />

      {showEtaDelayModal && (
        <EtaDelayModal
          etaMinutes={etaMinutes}
          slaMin={t.slaMin}
          onAcknowledge={acknowledgeEtaDelay}
          onDismiss={() => setShowEtaDelayModal(false)}
        />
      )}

      {showEmail && (
        <EmailModal
          job={{ ...jobWithPhotos, reviewNotes: notes }}
          companyName={companyName}
          onClose={() => setShowEmail(false)}
          onSent={({ clientEmail, emailSentByApp, photosBackedUp }) => {
            logAction(emailSentByApp ? "Client email sent" : "Client email marked sent", clientEmail, {
              status: "emailed", emailedAt: new Date().toISOString(), reviewNotes: notes, clientEmail, emailSentByApp,
              ...(photosBackedUp ? { photosBackedUpAt: new Date().toISOString() } : {}),
            });
            setShowEmail(false);
          }}
        />
      )}
    </div>
  );
}

// Per-job chat between Control Room and the assigned patrolman — see
// jobChat.js. Polls only while this job's detail view is open (like
// photos), never in the background across the whole board. Read-only
// once the job is closed; an archived job's chat is already folded into
// the job record itself (see jobArchive.js) and passed in as
// `embeddedChat` — its live key is gone by then, so nothing to fetch or
// poll.
const JOB_CHAT_POLL_MS = 6000;

function JobChatPanel({ jobId, session, closed, embeddedChat }) {
  const [messages, setMessages] = useState(embeddedChat || []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!!embeddedChat);
  const showToast = useToast();
  const bodyRef = useRef(null);

  useEffect(() => {
    if (embeddedChat) return;
    let cancelled = false;
    async function load() {
      const chat = await fetchJobChat(jobId);
      if (!cancelled) { setMessages(chat); setLoaded(true); }
    }
    load();
    const interval = setInterval(load, JOB_CHAT_POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [jobId, embeddedChat]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages]);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const updated = await sendJobChatMessage(jobId, trimmed);
      setMessages(updated);
      setText("");
    } catch (e) {
      showToast(e.message || "Couldn't send the message.", "error");
    }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 18, border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 12px", background: "var(--panel-alt)", borderBottom: "1px solid var(--border)", fontSize: 12.5, fontWeight: 700 }}>
        <MessageSquare size={14} color="var(--accent)" /> Job Chat
      </div>
      <div style={{ fontSize: 10.5, color: "var(--text-dim)", padding: "8px 12px 0" }}>
        Messages here become part of this job's permanent record.
      </div>
      <div ref={bodyRef} style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, maxHeight: 280, overflowY: "auto" }}>
        {!loaded && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Loading…</div>}
        {loaded && messages.length === 0 && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No messages yet.</div>}
        {messages.map((m, i) => {
          const mine = m.fromLoginName === session.loginName;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", maxWidth: "80%", alignSelf: mine ? "flex-end" : "flex-start", alignItems: mine ? "flex-end" : "flex-start" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", marginBottom: 2 }}>{mine ? "You" : m.fromName}</div>
              <div style={{
                padding: "7px 10px", borderRadius: 11, fontSize: 12.5, lineHeight: 1.45, color: "var(--text)",
                background: mine ? "var(--accent-dim)" : "var(--panel-alt)",
                ...(mine ? { borderBottomRightRadius: 3 } : { borderBottomLeftRadius: 3 }),
              }}>
                {m.text}
              </div>
              <div style={{ fontSize: 9.5, color: "var(--text-dim)", marginTop: 2 }}>{fmtDateTime(m.ts)}</div>
            </div>
          );
        })}
      </div>
      {closed ? (
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 12px", fontSize: 11.5, color: "var(--text-dim)", borderTop: "1px solid var(--border)", background: "var(--panel)" }}>
          <Lock size={12} /> This job is closed — chat is read-only.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--border)" }}>
          <textarea
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={session.role === "patrolman" ? "Message control room about this job…" : "Message the patrolman about this job…"}
            style={{ ...selectStyle, flex: 1, resize: "none" }}
          />
          <button onClick={send} disabled={!text.trim() || busy} style={{ ...primaryBtn, opacity: text.trim() && !busy ? 1 : 0.5, cursor: text.trim() && !busy ? "pointer" : "not-allowed" }}>
            <Send size={13} /> Send
          </button>
        </div>
      )}
    </div>
  );
}

function ActivityLogSection({ log }) {
  const [open, setOpen] = useState(false);
  if (!log || log.length === 0) return null;
  const entries = [...log].reverse();
  return (
    <div style={{ marginTop: 18 }}>
      <button onClick={() => setOpen((v) => !v)} style={{ ...secondaryBtn, fontSize: 12 }}>
        <FileText size={13} /> {open ? "Hide" : "Show"} activity log ({log.length})
      </button>
      {open && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflowY: "auto", padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)" }}>
          {entries.map((e, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--text-dim)" }}>
              <span style={{ color: "var(--text)", fontWeight: 600 }}>{fmtDateTime(e.ts)}</span> — <b style={{ color: "var(--text)" }}>{e.action}</b> by {e.actorName}
              {e.detail ? <div style={{ marginTop: 2 }}>{e.detail}</div> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobHeader({ job }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginTop: 14 }}>
      <div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 19, fontWeight: 700 }}>Job# {job.jobNumber}</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-dim)", marginTop: 2 }}>{job.siteName}</div>
        <a href={mapsUrl(job.address)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5, color: "var(--info)", marginTop: 3, display: "inline-block", textDecoration: "none" }}>
          {job.address} ↗
        </a>
      </div>
      <StatusBadge status={job.status} />
    </div>
  );
}

const ADVICE_ROW_STYLE = "border:1px solid #999;padding:6px 10px;";
const ADVICE_LABEL_STYLE = `${ADVICE_ROW_STYLE}text-align:right;font-weight:bold;white-space:nowrap;vertical-align:top;width:110px;`;
const ADVICE_VALUE_STYLE = `${ADVICE_ROW_STYLE}text-align:left;vertical-align:top;`;

function adviceRow(label, value) {
  return `<tr><td style="${ADVICE_LABEL_STYLE}">${label}</td><td style="${ADVICE_VALUE_STYLE}">${value}</td></tr>`;
}

function buildAdviceEmail(job, companyName) {
  const provider = [job.assigneeName, job.run].filter(Boolean).join(" — ") || "—";
  const status = job.status === "cancelled" ? "Cancelled" : "Complete";
  const times = `Dispatched ${fmtTime(job.dispatchTime)} On site ${fmtTime(job.onsiteTime)} Off site ${fmtTime(job.offsiteTime)} Advised ${fmtTime(new Date().toISOString())}`;
  const location = [job.siteName, job.address].filter(Boolean).join("<br>");
  const outcome = (job.reviewNotes || job.cancelReason || "").replace(/\n/g, "<br>");

  const rows = [
    adviceRow("Advice From:", (companyName || "Ausgroup").toUpperCase() + " SECURITY"),
    adviceRow("Customer:", job.bureau || "—"),
    adviceRow("Monitoring:", job.monitoringCo || "—"),
    adviceRow("Job Ref:", job.jobNumber),
    adviceRow("Order No:", job.orderNo || "—"),
    adviceRow("Docket No:", job.docketNo || "—"),
    adviceRow("Received:", fmtDateTime(job.dispatchTime)),
    adviceRow("Location:", location),
    adviceRow("Request:", job.description || "—"),
    adviceRow("Status:", status),
    adviceRow("Outcome:", outcome || "—"),
    adviceRow("Provider:", provider),
    adviceRow("Times:", times),
  ].join("");

  const html = `<table style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111;">${rows}</table>`;

  const textLines = [
    ["Advice From", (companyName || "Ausgroup").toUpperCase() + " SECURITY"],
    ["Customer", job.bureau || "—"],
    ["Monitoring", job.monitoringCo || "—"],
    ["Job Ref", job.jobNumber],
    ["Order No", job.orderNo || "—"],
    ["Docket No", job.docketNo || "—"],
    ["Received", fmtDateTime(job.dispatchTime)],
    ["Location", [job.siteName, job.address].filter(Boolean).join(", ")],
    ["Request", job.description || "—"],
    ["Status", status],
    ["Outcome", job.reviewNotes || job.cancelReason || "—"],
    ["Provider", provider],
    ["Times", times],
  ];
  const text = textLines.map(([k, v]) => `${k}: ${v}`).join("\n");

  return { html, text };
}

function photoAttachments(job) {
  return (job.photos || []).map((p, i) => {
    const match = /^data:([^;]+);base64,(.*)$/.exec(p.dataUrl || "");
    if (!match) return null;
    const [, contentType, content] = match;
    const ext = contentType.split("/")[1] || "jpg";
    return { filename: `${job.jobNumber}-photo-${i + 1}.${ext}`, content, contentType };
  }).filter(Boolean);
}

// Fired the moment a job closes or cancels (confirmCancel, EmailModal's
// sendNow, and "Mark as sent/closed") so the backup photo email goes out
// right away instead of waiting for the 48h archive sweep. Best-effort —
// on any failure the archive sweep still catches it later (see
// backupAndDeletePhotos in api/_lib/jobArchive.js), so a network blip here
// never loses a photo, just delays its backup. `to` is deliberately never
// passed: the server fills in REPORT_RECIPIENTS itself so that address
// never has to reach the browser.
async function sendPhotoBackupEmail(job) {
  const attachments = photoAttachments(job);
  if (!attachments.length) return { sent: false };
  const subject = `Attendance photo backup — ${job.jobNumber}${job.siteName ? ` — ${job.siteName}` : ""}`;
  const text = [
    `Job ${job.jobNumber} — ${job.siteName || "—"}`,
    `Address: ${job.address || "—"}`,
    `Status: ${job.status === "cancelled" ? "Cancelled" : "Closed"}`,
    `Patrolman: ${job.assigneeName || "—"}`,
    `Dispatched: ${fmtDateTime(job.dispatchTime)}`,
    `Onsite: ${fmtDateTime(job.onsiteTime)}`,
    `Offsite: ${fmtDateTime(job.offsiteTime)}`,
    `Outcome: ${job.reviewNotes || job.cancelReason || "—"}`,
    ``,
    `${attachments.length} attendance photo${attachments.length !== 1 ? "s" : ""} attached.`,
  ].join("\n");
  try {
    const res = await fetch("/api/send-client-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Secret": import.meta.env.VITE_APP_MAIL_SECRET || "" },
      body: JSON.stringify({ internalBackup: true, subject, text, attachments }),
    });
    return { sent: res.ok };
  } catch (e) {
    return { sent: false };
  }
}

function loadImageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 480, height: img.naturalHeight || 360 });
    img.onerror = () => resolve({ width: 480, height: 360 });
    img.src = dataUrl;
  });
}

async function downloadJobAttendancePdf(job, companyName, now) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = 40;
  let y = 44;

  const name = companyName || "Ausgroup";
  doc.setFontSize(14);
  doc.setTextColor(20);
  doc.text(`${name} Security — Alarm Response Attendance Report`, marginX, y);
  y += 18;
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`Generated ${fmtDateTime(new Date().toISOString())}`, marginX, y);
  y += 22;

  const t = jobTiming(job, now || new Date());
  const fields = [
    ["Job Ref", job.jobNumber],
    ["Site", job.siteName],
    ["Address", job.address || "—"],
    ["Customer", job.bureau || "—"],
    ["Monitoring company", job.monitoringCo || "—"],
    ["Order No", job.orderNo || "—"],
    ["Docket No", job.docketNo || "—"],
    ["Alarm / area", job.description || "—"],
    ["Status", STATUS_META[job.status]?.label || job.status],
    ["Attending patrolman", [job.assigneeName, job.run].filter(Boolean).join(" — ") || "—"],
    ["Dispatched", fmtDateTime(job.dispatchTime)],
    ["Acknowledged", job.acknowledgedAt ? fmtDateTime(job.acknowledgedAt) : "—"],
    ["ETA given", job.eta ? (job.eta.label === "Other" ? job.eta.detail : job.eta.label) : "—"],
    ["Onsite", job.onsiteTime ? fmtDateTime(job.onsiteTime) : "—"],
    ["Onsite location", job.onsiteLocation ? (job.onsiteLocationName || formatLocation(job.onsiteLocation)) : "—"],
    ["Offsite", job.offsiteTime ? fmtDateTime(job.offsiteTime) : "—"],
    ["Offsite location", job.offsiteLocation ? (job.offsiteLocationName || formatLocation(job.offsiteLocation)) : "—"],
    ["Response time", job.onsiteTime ? `${t.elapsed}m (SLA ${t.slaMin}m)` : "—"],
    ["Outcome / notes", job.reviewNotes || job.outcomeNotes || job.cancelReason || "—"],
  ];

  doc.setFontSize(10);
  fields.forEach(([label, value]) => {
    doc.setTextColor(110);
    doc.text(`${label}:`, marginX, y);
    doc.setTextColor(20);
    const lines = doc.splitTextToSize(String(value), pageW - marginX * 2 - 130);
    doc.text(lines, marginX + 130, y);
    y += Math.max(14, lines.length * 12) + 4;
    if (y > pageH - 60) { doc.addPage(); y = 44; }
  });

  const locationEntries = [
    job.onsiteLocation ? { label: "Onsite", loc: job.onsiteLocation, name: job.onsiteLocationName } : null,
    job.offsiteLocation ? { label: "Offsite", loc: job.offsiteLocation, name: job.offsiteLocationName } : null,
  ].filter(Boolean);

  if (locationEntries.length) {
    y += 12;
    if (y > pageH - 200) { doc.addPage(); y = 44; }
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text("Patrolman location", marginX, y);
    y += 16;

    const mapMaps = await Promise.all(locationEntries.map((e) => fetchStaticMap(e.loc.lat, e.loc.lon)));
    // api/static-map.js returns a single 256x256 OSM tile — keep it square.
    const mapW = 150;
    const mapH = 150;
    const colGap = 30;
    if (y + mapH + 40 > pageH - 40) { doc.addPage(); y = 44; }

    doc.setFontSize(9);
    const captions = locationEntries.map((e) => doc.splitTextToSize(`${e.label} — ${e.name || formatLocation(e.loc)}`, mapW));
    const captionLines = Math.max(...captions.map((c) => c.length));

    let x = marginX;
    locationEntries.forEach((e, i) => {
      const dataUrl = mapMaps[i];
      if (dataUrl) {
        try { doc.addImage(dataUrl, "PNG", x, y, mapW, mapH); } catch (err) { /* skip if the fetched image is malformed */ }
      }
      doc.setFontSize(9);
      doc.setTextColor(110);
      doc.text(captions[i], x, y + mapH + 12);
      x += mapW + colGap;
    });
    y += mapH + 16 + captionLines * 11;
  }

  if (job.photos?.length) {
    y += 12;
    if (y > pageH - 200) { doc.addPage(); y = 44; }
    doc.setFontSize(12);
    doc.setTextColor(20);
    doc.text(`Attendance photos (${job.photos.length})`, marginX, y);
    y += 16;

    const imgW = 220;
    for (let i = 0; i < job.photos.length; i++) {
      const p = job.photos[i];
      const size = await loadImageSize(p.dataUrl);
      const imgH = imgW * (size.height / size.width);
      if (y + imgH + 26 > pageH - 40) { doc.addPage(); y = 44; }
      doc.addImage(p.dataUrl, "JPEG", marginX, y, imgW, imgH);
      doc.setFontSize(9);
      doc.setTextColor(110);
      const caption = `Photo ${i + 1} — ${p.ts ? fmtDateTime(p.ts) : "time unknown"}${p.location ? ` — ${p.locationName || formatLocation(p.location)}` : ""}`;
      doc.text(caption, marginX, y + imgH + 14);
      y += imgH + 28;
    }
  }

  doc.save(`${job.jobNumber}-attendance.pdf`);
}

function EmailModal({ job, companyName, onClose, onSent }) {
  const [clientEmail, setClientEmail] = useState(job.clientEmail || job.monitoringEmail || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const showToast = useToast();

  const subject = `Alarm Response Advice — Job Ref ${job.jobNumber} — ${job.siteName}`;
  const { html, text } = buildAdviceEmail(job, companyName);
  const emailLooksValid = /\S+@\S+\.\S+/.test(clientEmail.trim());

  async function sendNow() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/send-client-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Secret": import.meta.env.VITE_APP_MAIL_SECRET || "" },
        body: JSON.stringify({ to: clientEmail.trim(), subject, text, html, attachments: photoAttachments(job) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Send failed (${res.status})`);
      showToast("Email sent to client.");
      const backup = await sendPhotoBackupEmail(job);
      onSent({ clientEmail: clientEmail.trim(), emailSentByApp: true, photosBackedUp: backup.sent });
    } catch (e) {
      setError(e.message || "Couldn't send — try again, or copy the text and send it yourself.");
    }
    setBusy(false);
  }

  // The client email is skipped here, but the internal backup isn't — this
  // is exactly the path that used to leave photos with no email at all.
  async function markSentWithoutEmail() {
    setBusy(true);
    const backup = await sendPhotoBackupEmail(job);
    setBusy(false);
    onSent({ clientEmail: clientEmail.trim(), emailSentByApp: false, photosBackedUp: backup.sent });
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, width: 560, maxWidth: "90%", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <SectionTitle icon={Mail} title="Client email" small />
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}><X size={16} /></button>
        </div>
        <Field label="Client email">
          <input type="email" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} placeholder="e.g. monitoring@client.com" style={selectStyle} />
        </Field>
        <div
          style={{ background: "#fff", padding: 12, borderRadius: 7, maxHeight: 260, overflow: "auto", border: "1px solid var(--border)" }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {job.photos?.length > 0 && (
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 8 }}>
            <Camera size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
            {job.photos.length} attendance photo{job.photos.length !== 1 ? "s" : ""} will be attached.
          </div>
        )}
        {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button onClick={() => navigator.clipboard?.writeText(text)} style={secondaryBtn}><Copy size={13} /> Copy</button>
          <button onClick={markSentWithoutEmail} disabled={busy} style={{ ...secondaryBtn, opacity: busy ? 0.6 : 1, cursor: busy ? "not-allowed" : "pointer" }}>
            <CheckCircle2 size={13} /> {busy ? "Working…" : "Mark as sent / closed"}
          </button>
          <button
            onClick={sendNow}
            disabled={busy || !emailLooksValid}
            style={{ ...primaryBtn, flex: 1, justifyContent: "center", opacity: busy || !emailLooksValid ? 0.5 : 1, cursor: busy || !emailLooksValid ? "not-allowed" : "pointer" }}
          >
            <Send size={13} /> {busy ? "Sending…" : "Send email now"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------- Logs ---------------------- */

function Logs({ jobs, now, role, companyName }) {
  const [subTab, setSubTab] = useState("overview");
  const showReports = role === "manager";

  // LogsOverview and Reports each pull in their own slice of the archive
  // below (a fixed recent window, and whatever date range is picked,
  // respectively) rather than one shared "fetch everything" here — see
  // jobArchive.js for why that's no longer how archived jobs are read.
  if (!showReports) return <LogsOverview jobs={jobs} now={now} />;

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 20, borderBottom: "1px solid var(--border)" }}>
        {[
          { id: "overview", label: "Overview", icon: BarChart3 },
          { id: "reports", label: "Reports", icon: FileText },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "9px 14px", border: "none", borderBottom: `2px solid ${subTab === t.id ? "var(--accent)" : "transparent"}`,
              background: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: subTab === t.id ? "var(--accent)" : "var(--text-dim)",
            }}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>
      {subTab === "overview" && <LogsOverview jobs={jobs} now={now} />}
      {subTab === "reports" && <Reports jobs={jobs} companyName={companyName} />}
    </div>
  );
}

const LOGS_OVERVIEW_WINDOW_DAYS = 30;

function LogsOverview({ jobs, now }) {
  // Fixed recent window from the archive, merged with whatever's still on
  // the live board — an unbounded "since forever" fetch is exactly what
  // made ops:jobs (and then the archive itself) risk Vercel's response
  // size cap; see jobArchive.js.
  const [archived, setArchived] = useState([]);
  useEffect(() => {
    const to = new Date(now).toISOString().slice(0, 10);
    const from = new Date(now - LOGS_OVERVIEW_WINDOW_DAYS * 24 * 3600000).toISOString().slice(0, 10);
    fetchArchivedJobsInRange(from, to).then(setArchived);
  }, [now]);
  const jobsInWindow = useMemo(() => [...jobs, ...archived], [jobs, archived]);
  const attended = jobsInWindow.filter((j) => j.onsiteTime);
  const avgResp = attended.length ? Math.round(attended.reduce((s, j) => s + jobTiming(j, now).elapsed, 0) / attended.length) : 0;
  const cancelled = jobsInWindow.filter((j) => j.status === "cancelled");
  const breaches = jobsInWindow.filter((j) => j.status !== "cancelled" && (j.onsiteTime ? jobTiming(j, now).elapsed > jobTiming(j, now).slaMin : jobTiming(j, now).level === "breach")).length;

  const byCompany = {};
  jobsInWindow.forEach((j) => {
    const key = j.bureau || "—";
    byCompany[key] = byCompany[key] || { count: 0, respSum: 0, respN: 0, cancelled: 0 };
    byCompany[key].count++;
    if (j.status === "cancelled") byCompany[key].cancelled++;
    if (j.onsiteTime) { byCompany[key].respSum += jobTiming(j, now).elapsed; byCompany[key].respN++; }
  });

  return (
    <div>
      <SectionTitle icon={BarChart3} title="Shift log & analysis" />
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 14 }}>
        Covers the live board plus the last {LOGS_OVERVIEW_WINDOW_DAYS} days of closed-out history — see Reports for any other date range.
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 22, flexWrap: "wrap" }}>
        <Stat label="Jobs dispatched" value={jobsInWindow.length} />
        <Stat label="Attended" value={attended.length} />
        <Stat label="Avg. response time" value={`${avgResp}m`} />
        <Stat label="SLA breaches" value={breaches} accent={breaches > 0 ? "var(--breach)" : "var(--ok)"} />
        <Stat label="Cancelled / stood down" value={cancelled.length} />
      </div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)", marginBottom: 8 }}>By bureau</div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
        {Object.entries(byCompany).sort((a, b) => b[1].count - a[1].count).map(([name, d], i) => (
          <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", fontSize: 12.5, borderTop: i ? "1px solid var(--border)" : "none", background: "var(--panel)" }}>
            <span>{name}</span>
            <span style={{ color: "var(--text-dim)", fontFamily: "var(--mono)" }}>{d.count} job{d.count !== 1 ? "s" : ""} · avg {d.respN ? Math.round(d.respSum / d.respN) : "—"}m{d.cancelled ? ` · ${d.cancelled} cancelled` : ""}</span>
          </div>
        ))}
        {Object.keys(byCompany).length === 0 && <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12.5 }}>No jobs logged yet.</div>}
      </div>

      {cancelled.length > 0 && (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)", margin: "22px 0 8px" }}>Cancelled / stood down</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {cancelled.sort((a, b) => new Date(b.cancelledAt || b.dispatchTime) - new Date(a.cancelledAt || a.dispatchTime)).map((j) => (
              <div key={j.id} style={{ padding: "10px 14px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span><b>{j.jobNumber}</b> — {j.siteName}</span>
                  <span style={{ color: "var(--text-dim)", fontFamily: "var(--mono)" }}>{fmtDateTime(j.cancelledAt)}</span>
                </div>
                {j.cancelReason && <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 4 }}>{j.cancelReason}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Reports({ jobs, companyName }) {
  const [reportType, setReportType] = useState("brief");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [archived, setArchived] = useState([]);
  const showToast = useToast();

  // Only reaches into the archive once a "from" date bounds it below —
  // otherwise this would be the same unbounded "everything ever" fetch
  // that made ops:jobs (and then the archive itself) risk Vercel's
  // response size cap; see jobArchive.js. With no filter at all, a
  // report covers just what's still on the live board.
  useEffect(() => {
    if (!dateFrom) { setArchived([]); return; }
    fetchArchivedJobsInRange(dateFrom, dateTo || todayISO()).then(setArchived);
  }, [dateFrom, dateTo]);
  const allJobs = useMemo(() => [...jobs, ...archived], [jobs, archived]);

  const filtered = allJobs
    .filter((j) => {
      const d = isoDateOnly(j.dispatchTime);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      if (timeFrom || timeTo) {
        const t = isoTimeOnly(j.dispatchTime);
        if (timeFrom && t < timeFrom) return false;
        if (timeTo && t > timeTo) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(a.dispatchTime) - new Date(b.dispatchTime));

  const columns = reportType === "brief" ? REPORT_COLUMNS_BRIEF : REPORT_COLUMNS_DETAILED;
  const rows = filtered.map((j) => reportRow(j, reportType));
  const summary = patrolmanRunSummary(filtered);
  const hasFilter = dateFrom || dateTo || timeFrom || timeTo;

  function clearFilters() { setDateFrom(""); setDateTo(""); setTimeFrom(""); setTimeTo(""); }

  async function downloadPdf() {
    setBusy(true);
    try {
      const [{ jsPDF }, autoTableModule] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const autoTable = autoTableModule.default;
      const doc = new jsPDF({ orientation: reportType === "detailed" ? "landscape" : "portrait", unit: "pt" });
      const name = companyName || "Ausgroup";
      doc.setFontSize(14);
      doc.text(`${name} Alarm Response Dispatch — ${reportType === "brief" ? "Brief" : "Detailed"} Report`, 40, 40);
      doc.setFontSize(9);
      doc.setTextColor(90);
      doc.text(`Date range: ${dateFrom || "any"} to ${dateTo || "any"}${timeFrom || timeTo ? `  ·  Time: ${timeFrom || "any"} to ${timeTo || "any"}` : ""}`, 40, 58);
      doc.text(`Generated ${fmtDateTime(new Date().toISOString())}`, 40, 72);
      autoTable(doc, {
        startY: 86,
        head: [columns],
        body: rows,
        styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
        headStyles: { fillColor: [255, 176, 32], textColor: [20, 20, 20] },
        columnStyles: reportType === "detailed" ? { 11: { cellWidth: 160 }, 12: { cellWidth: 160 } } : undefined,
      });

      const summaryStartY = (doc.lastAutoTable?.finalY || 86) + 26;
      doc.setFontSize(11);
      doc.setTextColor(20);
      doc.text("Patrolman response summary", 40, summaryStartY);
      autoTable(doc, {
        startY: summaryStartY + 8,
        head: [["Patrolman", "Run", "Responses"]],
        body: summary.map((s) => [s.patrolman, s.run, String(s.count)]),
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [255, 176, 32], textColor: [20, 20, 20] },
        tableWidth: 300,
      });

      doc.save(`${reportType}-report-${todayISO()}.pdf`);
      showToast("Report downloaded.");
    } catch (e) {
      showToast("Couldn't generate the PDF — try again.", "error");
    }
    setBusy(false);
  }

  return (
    <div>
      <SectionTitle icon={FileText} title="Reports" small />

      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {["brief", "detailed"].map((t) => (
          <button
            key={t}
            onClick={() => setReportType(t)}
            style={{ padding: "8px 16px", borderRadius: 7, cursor: "pointer", border: `1px solid ${reportType === t ? "var(--accent)" : "var(--border)"}`, background: reportType === t ? "var(--accent-dim)" : "var(--panel)", color: reportType === t ? "var(--accent)" : "var(--text-dim)", fontWeight: 600, fontSize: 12.5, textTransform: "capitalize" }}
          >
            {t} report
          </button>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap", marginBottom: 18, padding: 12, borderRadius: 8, background: "var(--panel-alt)", border: "1px solid var(--border)" }}>
        <Field label="Date from" style={{ marginBottom: 0 }}>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 160 }} />
        </Field>
        <Field label="Date to" style={{ marginBottom: 0 }}>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 160 }} />
        </Field>
        <Field label="From time" style={{ marginBottom: 0 }}>
          <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 120 }} />
        </Field>
        <Field label="To time" style={{ marginBottom: 0 }}>
          <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 120 }} />
        </Field>
        {hasFilter && <button onClick={clearFilters} style={{ ...secondaryBtn, marginBottom: 0 }}><X size={13} /> Clear filters</button>}
        <button
          onClick={downloadPdf}
          disabled={busy || rows.length === 0}
          style={{ ...primaryBtn, marginBottom: 0, marginLeft: "auto", opacity: rows.length === 0 || busy ? 0.5 : 1, cursor: rows.length === 0 || busy ? "not-allowed" : "pointer" }}
        >
          <Download size={14} /> {busy ? "Generating…" : "Download PDF"}
        </button>
      </div>

      {!dateFrom && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: -10, marginBottom: 18 }}>
          Showing only what's still on the live board. Set a "Date from" to also pull in matching closed-out history from the archive.
        </div>
      )}

      {summary.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)", marginBottom: 8 }}>Patrolman response summary</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {summary.map((s) => (
              <div key={`${s.patrolman}||${s.run}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 7, background: "var(--panel)", border: "1px solid var(--border)", fontSize: 12.5 }}>
                <span><b>{s.patrolman}</b> on <b>{s.run}</b></span>
                <span style={{ color: "var(--text-dim)" }}>—</span>
                <span style={{ fontFamily: "var(--mono)", fontWeight: 700, color: "var(--accent)" }}>{s.count}</span>
                <span style={{ color: "var(--text-dim)" }}>response{s.count !== 1 ? "s" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8 }}>{rows.length} job{rows.length !== 1 ? "s" : ""} in this report</div>

      {rows.length === 0 ? (
        <Empty text="No jobs match this date/time range." />
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
            <thead>
              <tr style={{ background: "var(--panel-alt)" }}>
                {columns.map((c) => <th key={c} style={{ textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ background: "var(--panel)" }}>
                  {r.map((cell, ci) => <td key={ci} style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={{ flex: "1 1 120px", padding: "14px 16px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)" }}>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)", color: accent || "var(--text)" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{label}</div>
    </div>
  );
}

/* ---------------------------------------------------------------
   PATROLMAN VIEW
---------------------------------------------------------------- */

function JobAlertsBanner({
  title = "Get notified the moment a job is dispatched to you",
  subtitle = "Even with your phone locked — open the notification to confirm your ETA and acknowledge.",
  buttonLabel = "Turn on job alerts",
  toastText = "Job alerts turned on for this phone.",
}) {
  const [status, setStatus] = useState({ supported: true, permission: "default", subscribed: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const showToast = useToast();

  useEffect(() => { getPushStatus().then(setStatus); }, []);

  async function enable() {
    setBusy(true);
    setError("");
    try {
      await enableJobAlerts();
      setStatus(await getPushStatus());
      showToast(toastText);
    } catch (e) {
      setError(e.message || "Couldn't turn on alerts.");
    }
    setBusy(false);
  }

  if (!status.supported || status.subscribed) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--border)", marginBottom: 16, flexWrap: "wrap" }}>
      <Bell size={15} color="var(--accent)" style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {status.permission === "denied"
            ? "Notifications are blocked for this site — enable them in your phone/browser settings, then reload this page."
            : subtitle}
        </div>
        {error && <div style={{ fontSize: 11, color: "var(--breach)", marginTop: 4 }}>{error}</div>}
      </div>
      {status.permission !== "denied" && (
        <button onClick={enable} disabled={busy} style={{ ...primaryBtn, flexShrink: 0, opacity: busy ? 0.6 : 1 }}>
          {busy ? "Turning on…" : buttonLabel}
        </button>
      )}
    </div>
  );
}

function StandDownNotices({ jobs, session, persist }) {
  const pending = [];
  jobs.forEach((job) => {
    (job.standDowns || []).forEach((sd) => {
      if (sd.patrolmanLoginName === session.loginName && !sd.acknowledgedAt) pending.push({ job, sd });
    });
  });
  if (!pending.length) return null;

  function acknowledge(job, sd) {
    const logEntry = {
      ts: new Date().toISOString(),
      actorLoginName: session.loginName,
      actorName: session.displayName,
      action: "Stand-down acknowledged",
      detail: `Confirmed job given to ${sd.reassignedTo}`,
    };
    const updatedJobs = jobs.map((j) => (j.id === job.id
      ? { ...j, standDowns: j.standDowns.map((x) => (x.id === sd.id ? { ...x, acknowledgedAt: new Date().toISOString() } : x)), activityLog: [...(j.activityLog || []), logEntry] }
      : j));
    persist(updatedJobs);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
      {pending.map(({ job, sd }) => (
        <div key={sd.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, background: "#FFFBEB", border: "1px solid var(--warn)55", flexWrap: "wrap" }}>
          <Bell size={15} color="var(--warn)" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 200, fontSize: 12.5 }}>
            <b>{job.jobNumber} — {job.siteName}</b> has been given to {sd.reassignedTo}.
          </div>
          <button onClick={() => acknowledge(job, sd)} style={primaryBtn}><CheckCircle2 size={14} /> Acknowledge</button>
        </div>
      ))}
    </div>
  );
}

function PatrolmanView({ session, roster, jobs, persist, outcomePhrases, now }) {
  const [selectedId, setSelectedId] = useState(null);
  const mine = jobs.filter((j) => j.assigneeId === session.id).sort((a, b) => new Date(b.dispatchTime) - new Date(a.dispatchTime));
  const selected = mine.find((j) => j.id === selectedId);
  const todaysRun = roster?.find((r) => r.date === rosterDateISO() && r.patrolmanLoginName === session.loginName)?.run || session.run;
  const isRosteredToday = roster?.some((r) => r.date === rosterDateISO() && r.patrolmanLoginName === session.loginName);

  if (selected) {
    return <div style={{ padding: 20, maxWidth: 520 }}><JobDetailPatrolman job={selected} jobs={jobs} session={session} persist={persist} outcomePhrases={outcomePhrases} now={now} onBack={() => setSelectedId(null)} /></div>;
  }

  return (
    <div style={{ padding: 20 }}>
      {isRosteredToday && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--border)", marginBottom: 12, fontSize: 11.5, color: "var(--text-dim)" }}>
          <MapPin size={13} color="var(--ok)" /> Live location sharing is on for your shift — Control Room can see where you are to route jobs faster. Stops the moment you sign out.
        </div>
      )}
      <StandDownNotices jobs={jobs} session={session} persist={persist} />
      <JobAlertsBanner />
      <SectionTitle icon={ShieldAlert} title={`My jobs — ${todaysRun}`} />
      {mine.length === 0 ? (
        <Empty text="No jobs dispatched to you yet. New jobs will alert this device the moment control room sends one." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 520 }}>
          {mine.map((j) => <JobCard key={j.id} job={j} now={now} onClick={() => setSelectedId(j.id)} />)}
        </div>
      )}
    </div>
  );
}

// Blocks acknowledgement until an ETA is actually entered — onConfirm only
// ever fires with a non-empty one, so callers never need to re-check.
function EtaModal({ onConfirm, onClose }) {
  const [text, setText] = useState("");
  const canConfirm = text.trim();

  function confirm() {
    if (!canConfirm) return;
    onConfirm({ label: text.trim() });
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, width: 380, maxWidth: "90%", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <SectionTitle icon={Clock} title="Confirm your ETA" small />
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 14 }}>
          Let control room know your ETA and a brief reason before acknowledging this job.
        </div>
        <textarea
          rows={3}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. 60 minutes — heavy traffic on the highway"
          style={{ ...selectStyle, resize: "vertical", marginBottom: 12 }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            style={{ ...primaryBtn, flex: 1, justifyContent: "center", opacity: canConfirm ? 1 : 0.5, cursor: canConfirm ? "pointer" : "not-allowed" }}
          >
            <CheckCircle2 size={14} /> Confirm & acknowledge
          </button>
        </div>
      </div>
    </div>
  );
}

function JobDetailPatrolman({ job, jobs, session, persist, outcomePhrases, now, onBack }) {
  const [outcome, setOutcome] = useState(job.outcomeNotes || "");
  const [docketNo, setDocketNo] = useState(job.docketNo || "");
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [showEtaModal, setShowEtaModal] = useState(false);
  const fileRef = useRef(null);
  const showToast = useToast();
  const isCancelled = job.status === "cancelled";
  const submitted = job.status !== "dispatched" && !isCancelled;
  const isOnsite = !!job.onsiteTime;

  // Already-submitted jobs have their photos in their own key, not on
  // `job` — see jobPhotos.js. A job still being worked has none to fetch yet.
  useEffect(() => {
    if (job.photoCount > 0) fetchJobPhotos(job.id).then(setPhotos);
  }, [job.id, job.photoCount]);

  // Quick-phrases just fill in a starting point — always appended (not
  // replacing anything already typed) so the field stays fully editable.
  function applyPhrase(text) {
    setOutcome((prev) => (prev.trim() ? `${prev.trim()} ${text}`.toUpperCase() : text.toUpperCase()));
  }

  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    setBusy(true);
    const location = await getCurrentLocation();
    const locationName = location ? await reverseGeocode(location.lat, location.lon) : null;
    const results = [];
    for (const f of files.slice(0, MAX_ATTENDANCE_PHOTOS - photos.length)) {
      try { results.push(await watermarkPhoto(f, job.jobNumber, location, locationName)); } catch (err) { /* skip bad file */ }
    }
    setPhotos((p) => [...p, ...results]);
    setBusy(false);
    e.target.value = "";
  }

  // Acknowledging always requires an ETA first (see EtaModal) — this is
  // only ever called with one already confirmed.
  async function acknowledgeJob(eta) {
    const etaText = eta.label === "Other" ? eta.detail : eta.label;
    const updated = jobs.map((j) => (j.id === job.id ? {
      ...j,
      acknowledgedAt: new Date().toISOString(),
      eta,
      activityLog: [...(j.activityLog || []), logEntry(session, "Acknowledged", `ETA: ${etaText}`)],
    } : j));
    await persist(updated);
    setShowEtaModal(false);
    showToast(`Job acknowledged — ETA ${etaText} sent to control room.`);
  }

  async function markOnsite() {
    setActionBusy(true);
    const location = await getCurrentLocation();
    const locationName = location ? await reverseGeocode(location.lat, location.lon) : null;
    const updated = jobs.map((j) => (j.id === job.id ? {
      ...j,
      acknowledgedAt: j.acknowledgedAt || new Date().toISOString(),
      onsiteTime: new Date().toISOString(),
      onsiteLocation: location ? { lat: location.lat, lon: location.lon } : null,
      onsiteLocationName: locationName,
    } : j));
    await persist(updated);
    setActionBusy(false);
  }

  async function submit() {
    setActionBusy(true);
    const location = await getCurrentLocation();
    const locationName = location ? await reverseGeocode(location.lat, location.lon) : null;
    // Photos are saved to their own key first (see jobPhotos.js) — the job
    // record itself only carries the count, so the board's poll never has
    // to move photo bytes. Sequenced so a job is never marked submitted
    // with a photoCount pointing at photos that failed to save.
    if (photos.length > 0) await persistJobPhotos(job.id, photos);
    const updated = jobs.map((j) => (j.id === job.id ? {
      ...j,
      status: "submitted",
      outcomeNotes: outcome.trim(),
      docketNo: docketNo.trim(),
      photoCount: photos.length,
      offsiteTime: new Date().toISOString(),
      offsiteLocation: location ? { lat: location.lat, lon: location.lon } : null,
      offsiteLocationName: locationName,
    } : j));
    await persist(updated);
    onBack();
  }

  return (
    <div>
      <button onClick={onBack} style={backBtn}><ArrowLeft size={13} /> Back to my jobs</button>
      <JobHeader job={job} />
      {job.status === "dispatched" && <div style={{ margin: "10px 0 4px" }}><SlaChip job={job} now={now} /></div>}

      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
        <AddressRow address={job.address} />
        <DetailRow icon={AlertTriangle} label="Alarm / area" value={job.description} />
        <DetailRow icon={KeyRound} label="Key info" value={job.keyInfo} />
        <DetailRow icon={KeyRound} label="Alarm code" value={job.alarmCode} />
      </div>

      {isCancelled && (
        <div style={{ marginTop: 20, padding: 14, borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--breach)", fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}><Ban size={14} /> Job cancelled — stand down</div>
          {job.cancelReason && <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>{job.cancelReason}</div>}
        </div>
      )}

      {!submitted && !isOnsite && !isCancelled && !job.acknowledgedAt && (
        <div style={{ marginTop: 20 }}>
          <SectionTitle icon={Bell} title="Acknowledge this job" small />
          <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 12 }}>
            Confirm your ETA to let control room know you've received this job and when you'll arrive.
          </div>
          <button onClick={() => setShowEtaModal(true)} style={{ ...primaryBtn, width: "100%", justifyContent: "center" }}>
            <CheckCircle2 size={14} /> Acknowledge — I've received this job
          </button>
        </div>
      )}

      {showEtaModal && <EtaModal onConfirm={acknowledgeJob} onClose={() => setShowEtaModal(false)} />}

      {!submitted && !isOnsite && !isCancelled && job.acknowledgedAt && (
        <div style={{ fontSize: 11.5, color: "var(--ok)", marginTop: 20, display: "flex", alignItems: "center", gap: 6 }}>
          <CheckCircle2 size={13} /> Acknowledged at {fmtTime(job.acknowledgedAt)}
          {job.eta && <> — ETA {job.eta.label === "Other" ? job.eta.detail : job.eta.label}</>}
        </div>
      )}

      {!submitted && !isOnsite && !isCancelled && (
        <div style={{ marginTop: 20 }}>
          <SectionTitle icon={MapPin} title="Arrived at site?" small />
          <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 12 }}>
            Mark onsite the moment you arrive — this records your response time and unlocks the outcome form.
          </div>
          <button onClick={markOnsite} disabled={actionBusy} style={{ ...primaryBtn, width: "100%", justifyContent: "center", opacity: actionBusy ? 0.6 : 1 }}>
            <MapPin size={14} /> {actionBusy ? "Getting your location…" : "Mark onsite"}
          </button>
        </div>
      )}

      {!submitted && isOnsite && !isCancelled && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 11.5, color: "var(--ok)", marginBottom: 10 }}>Onsite at {fmtTime(job.onsiteTime)}</div>
          <SectionTitle icon={CheckCircle2} title="Submit outcome" small />
          {outcomePhrases?.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {outcomePhrases.map((p) => (
                <button key={p.id} onClick={() => applyPhrase(p.text)} title={p.text} style={{ padding: "5px 10px", borderRadius: 14, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text-dim)", fontSize: 11.5, cursor: "pointer", textAlign: "left" }}>
                  {p.name}
                </button>
              ))}
            </div>
          )}
          <textarea rows={4} value={outcome} onChange={(e) => setOutcome(e.target.value.toUpperCase())} placeholder="What did you find on attendance? e.g. Premises secure, false alarm — sensor fault suspected." style={{ ...selectStyle, resize: "vertical" }} />
          <Field label="Docket number (optional)">
            <input value={docketNo} onChange={(e) => setDocketNo(e.target.value)} placeholder="Your patrol docket / report number" style={selectStyle} />
          </Field>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            {photos.map((p, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img src={p.dataUrl} alt="" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
                <button onClick={() => setPhotos(photos.filter((_, idx) => idx !== i))} style={{ position: "absolute", top: -6, right: -6, background: "var(--breach)", border: "none", borderRadius: "50%", width: 18, height: 18, color: "#fff", cursor: "pointer" }}><X size={11} /></button>
              </div>
            ))}
            {photos.length < MAX_ATTENDANCE_PHOTOS && (
              <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ width: 84, height: 84, borderRadius: 6, border: "1px dashed var(--border)", background: "var(--panel)", color: "var(--text-dim)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: "pointer" }}>
                <Camera size={17} /><span style={{ fontSize: 10 }}>{busy ? "…" : "Add photo"}</span>
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={handleFiles} />
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>Photos are timestamped automatically on capture.</div>
          <button disabled={!outcome.trim() || actionBusy} onClick={submit} style={{ ...primaryBtn, width: "100%", marginTop: 16, justifyContent: "center", opacity: outcome.trim() && !actionBusy ? 1 : 0.4 }}>
            <Send size={14} /> {actionBusy ? "Getting your location…" : "Mark offsite & submit"}
          </button>
        </div>
      )}

      {submitted && (
        <div style={{ marginTop: 20, padding: 14, borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--ok)", fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}><CheckCircle2 size={14} /> Submitted — onsite {fmtTime(job.onsiteTime)}, offsite {fmtTime(job.offsiteTime)}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>{job.outcomeNotes}</div>
        </div>
      )}

      <JobChatPanel jobId={job.id} session={session} closed={job.status === "emailed" || isCancelled} />
    </div>
  );
}

function AddressRow({ address }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <MapPin size={14} color="var(--text-dim)" style={{ marginTop: 2, flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 10.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>Address</div>
        <a href={mapsUrl(address)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--info)", textDecoration: "none" }}>
          {address} — open in Google Maps ↗
        </a>
      </div>
    </div>
  );
}

function DetailRow({ icon: Icon, label, value }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <Icon size={14} color="var(--text-dim)" style={{ marginTop: 2, flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 10.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
        <div>{value}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   MANAGER VIEW — create & manage logins
---------------------------------------------------------------- */

function ManagerView({ session, accounts, setAccounts, zones, persistZones, sites, persistSites, roster, persistRoster, outcomePhrases, persistOutcomePhrases, logoUrl, persistLogo, companyName, persistCompanyName, jobs, persistJobs, now }) {
  const [tab, setTab] = useState("accounts");
  const showConfirm = useConfirm();
  const showToast = useToast();
  const isDan = session.loginName.trim().toLowerCase() === "dan";

  function handleResetJobs() {
    showConfirm(
      `Delete all ${jobs.length} job${jobs.length === 1 ? "" : "s"} on the live board, plus the entire closed-job archive and every attendance photo? This clears job history for every login — Control Room and patrolmen start from scratch. This can't be undone.`,
      async () => {
        // Bulk delete-by-prefix on the server — no enumeration needed
        // first, so this stays safe regardless of how large the archive
        // has grown (see jobArchive.js / resetArchiveAndPhotos).
        await resetArchiveAndPhotos();
        await persistJobs([]);
        showToast("All jobs cleared — starting fresh.");
      }
    );
  }

  return (
    <div style={{ display: "flex", minHeight: 560 }}>
      <div style={{ width: 168, borderRight: "1px solid var(--border)", background: "var(--panel)", padding: "16px 10px", display: "flex", flexDirection: "column" }}>
        {[
          { id: "accounts", label: "Manage logins", icon: Users },
          { id: "sites", label: "Sites & runs", icon: MapPin },
          { id: "roster", label: "Roster", icon: CalendarDays },
          { id: "phrases", label: "Standard Phrases", icon: FileText },
          { id: "logs", label: "Logs & analysis", icon: BarChart3 },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", marginBottom: 4, borderRadius: 7, border: "none", cursor: "pointer", textAlign: "left", fontSize: 12.5, fontWeight: 600, background: tab === t.id ? "var(--accent-dim)" : "transparent", color: tab === t.id ? "var(--accent)" : "var(--text-dim)" }}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
        {isDan && (
          <button onClick={handleResetJobs} title="Delete every job so the app starts fresh — visible only to this login" style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", marginTop: "auto", borderRadius: 7, border: "1px solid var(--breach)", cursor: "pointer", textAlign: "left", fontSize: 12.5, fontWeight: 600, background: "transparent", color: "var(--breach)" }}>
            <Trash2 size={15} /> Reset test data
          </button>
        )}
      </div>
      <div style={{ flex: 1, padding: 20, overflowY: "auto" }}>
        {tab === "accounts" && <AccountsManager accounts={accounts} setAccounts={setAccounts} zones={zones} session={session} logoUrl={logoUrl} persistLogo={persistLogo} companyName={companyName} persistCompanyName={persistCompanyName} />}
        {tab === "phrases" && <OutcomePhrasesEditor outcomePhrases={outcomePhrases} persistOutcomePhrases={persistOutcomePhrases} />}
        {tab === "sites" && <SitesManager zones={zones} persistZones={persistZones} sites={sites} persistSites={persistSites} accounts={accounts} setAccounts={setAccounts} />}
        {tab === "roster" && <RosterView zones={zones} accounts={accounts} roster={roster} persistRoster={persistRoster} />}
        {tab === "logs" && <Logs jobs={jobs} now={now} role="manager" companyName={companyName} />}
      </div>
    </div>
  );
}

/* ---------------------- Patrolman roster import (Excel/CSV) ---------------------- */

const PATROLMAN_IMPORT_FIELDS = [
  { key: "name", match: (h) => h.includes("name") },
  { key: "run", match: (h) => h === "run" || h === "zone" || h.includes("run") || h.includes("zone") },
  { key: "contactNumber", match: (h) => h.includes("contact") || h.includes("phone") || h.includes("mobile") || h.includes("number") },
];

function PatrolmanRosterImport({ accounts, setAccounts, zones }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (!rows.length) { setError("That file has no rows to import."); setBusy(false); return; }

      const headers = Object.keys(rows[0]);
      const fieldToHeader = {};
      PATROLMAN_IMPORT_FIELDS.forEach(({ key, match }) => {
        const h = headers.find((h) => match(normalizeHeader(h)));
        if (h) fieldToHeader[key] = h;
      });

      const working = accounts.slice();
      const existingLoginNames = new Set(working.map((a) => a.loginName.toLowerCase()));
      const apiUpdates = [];
      const apiCreates = [];

      let updated = 0;
      let created = 0;
      let skippedMissing = 0;
      let runNotRecognized = 0;

      rows.forEach((row) => {
        const get = (key) => (fieldToHeader[key] ? String(row[fieldToHeader[key]] ?? "").trim() : "");
        const name = get("name");
        if (!name) { skippedMissing++; return; }
        const contactNumber = get("contactNumber");
        const rawRun = get("run");
        let run = "";
        if (rawRun) {
          const zoneMatch = zones.find((z) => z.toLowerCase() === rawRun.toLowerCase());
          if (zoneMatch) run = zoneMatch;
          else runNotRecognized++;
        }

        const existingIdx = working.findIndex(
          (a) => a.role === "patrolman" && (a.displayName.toLowerCase() === name.toLowerCase() || a.loginName.toLowerCase() === name.toLowerCase())
        );

        if (existingIdx >= 0) {
          const patch = {};
          if (contactNumber) patch.contactNumber = contactNumber;
          if (run) patch.run = run;
          if (Object.keys(patch).length) {
            working[existingIdx] = { ...working[existingIdx], ...patch };
            apiUpdates.push({ loginName: working[existingIdx].loginName, role: "patrolman", patch });
            updated++;
          }
        } else {
          const slug = name.replace(/[^a-zA-Z0-9]/g, "") || "Patrolman";
          let loginName = slug;
          let n = 2;
          while (existingLoginNames.has(loginName.toLowerCase())) { loginName = `${slug}${n}`; n++; }
          existingLoginNames.add(loginName.toLowerCase());
          const newAccount = {
            loginName,
            role: "patrolman",
            displayName: name,
            run: run || "Unassigned",
            shift: "",
            contactNumber,
            active: true,
          };
          working.push(newAccount);
          apiCreates.push({ ...newAccount, password: "patrol123" });
          created++;
        }
      });

      if (updated || created) {
        await apiBulkUpdateAccounts({ creates: apiCreates, updates: apiUpdates });
        setAccounts(working);
      }
      setResult({ updated, created, runNotRecognized, skippedMissing, total: rows.length });
    } catch (err) {
      setError(err?.message && err.message !== "Failed to fetch"
        ? err.message
        : "Couldn't read that file — make sure it's a valid .xlsx, .xls, or .csv export.");
    }
    setBusy(false);
  }

  return (
    <div style={{ padding: 14, borderRadius: 8, border: "1px dashed var(--border)", background: "var(--panel-alt)", marginBottom: 24, maxWidth: 560 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>Import patrolman roster from Excel</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            Columns: Patrolmen Name, Run/Zone, Patrolmen contact number. Matches existing patrolmen by name and updates their run + contact number; a name that isn't found gets a new login created automatically (default password "patrol123" — reset it from their row below). Run/Zone must match a run you've already added above, or it's left unchanged.
          </div>
        </div>
        <button onClick={() => fileRef.current?.click()} disabled={busy} style={secondaryBtn}>
          <Upload size={13} /> {busy ? "Importing…" : "Choose file"}
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={handleFile} />
      </div>
      {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 10 }}>{error}</div>}
      {result && (
        <div style={{ color: "var(--ok)", fontSize: 12, marginTop: 10 }}>
          {result.updated} existing patrolman{result.updated !== 1 ? "s" : ""} updated, {result.created} new login{result.created !== 1 ? "s" : ""} created (default password "patrol123").
          {result.runNotRecognized > 0 && ` ${result.runNotRecognized} row(s) had a run/zone that doesn't match any existing run — left unchanged.`}
          {result.skippedMissing > 0 && ` ${result.skippedMissing} row(s) skipped (missing name).`}
        </div>
      )}
    </div>
  );
}

function OutcomePhrasesEditor({ outcomePhrases, persistOutcomePhrases }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const showToast = useToast();
  const showConfirm = useConfirm();

  function addPhrase() {
    setError("");
    const phraseText = text.trim().replace(/\s*\n\s*/g, " ");
    if (!phraseText) { setError("Enter the full phrase text."); return; }
    const phraseName = (name.trim() || (phraseText.length > 40 ? `${phraseText.slice(0, 40)}…` : phraseText));
    if (outcomePhrases.some((p) => p.name.toLowerCase() === phraseName.toLowerCase())) { setError("A phrase with that name already exists."); return; }
    persistOutcomePhrases([...outcomePhrases, { id: makePhraseId(), name: phraseName, text: phraseText }]);
    setName(""); setText("");
    showToast("Standard phrase added.");
  }

  function removePhrase(p) {
    showConfirm(`Remove this standard phrase?\n\n"${p.name}"`, () => {
      persistOutcomePhrases(outcomePhrases.filter((x) => x.id !== p.id));
      showToast("Standard phrase removed.");
    });
  }

  function startEdit(p) {
    setEditingId(p.id);
    setEditName(p.name);
    setEditText(p.text);
  }

  function saveEdit() {
    const newName = editName.trim();
    const newText = editText.trim().replace(/\s*\n\s*/g, " ");
    if (!newName || !newText) return;
    persistOutcomePhrases(outcomePhrases.map((p) => (p.id === editingId ? { ...p, name: newName, text: newText } : p)));
    setEditingId(null);
    showToast("Standard phrase updated.");
  }

  return (
    <div style={{ marginBottom: 30 }}>
      <SectionTitle icon={CheckCircle2} title="Standard Phrases" />
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12, maxWidth: 560 }}>
        Patrolmen see the short name as a tappable chip — tapping it fills in the full phrase, which they can then edit or add to before submitting.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12, maxWidth: 560 }}>
        {outcomePhrases.map((p) => (
          <div key={p.id} style={{ padding: "8px 12px", borderRadius: 7, background: "var(--panel)", border: "1px solid var(--border)" }}>
            {editingId === p.id ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Short name" style={{ ...selectStyle, padding: "5px 8px", fontSize: 12.5 }} autoFocus />
                <textarea rows={2} value={editText} onChange={(e) => setEditText(e.target.value)} placeholder="Full phrase" style={{ ...selectStyle, resize: "vertical", fontSize: 12.5 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={saveEdit} style={secondaryBtn}>Save</button>
                  <button onClick={() => setEditingId(null)} style={iconBtn}><X size={13} /></button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 2 }}>{p.text}</div>
                </div>
                <button onClick={() => startEdit(p)} title="Edit" style={iconBtn}><RotateCcw size={13} /></button>
                <button onClick={() => removePhrase(p)} title="Delete" style={iconBtn}><Trash2 size={13} color="var(--breach)" /></button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 560 }}>
        <Field label="Short name (shown to patrolmen as the tappable chip)">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alarm reset" style={selectStyle} />
        </Field>
        <Field label="Full phrase (inserted into the outcome field)">
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Alarm reset, premises secure on departure." style={{ ...selectStyle, resize: "vertical" }} />
        </Field>
        <button onClick={addPhrase} style={{ ...secondaryBtn, alignSelf: "flex-start" }}>Add phrase</button>
      </div>
      {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function LogoUploader({ logoUrl, persistLogo, companyName, persistCompanyName }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nameInput, setNameInput] = useState(companyName || "");
  const showToast = useToast();

  useEffect(() => { setNameInput(companyName || ""); }, [companyName]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const dataUrl = await resizeLogo(file);
      await persistLogo(dataUrl);
      showToast("Logo updated.");
    } catch (err) {
      setError("Couldn't read that image — try a different file.");
    }
    setBusy(false);
  }

  function saveName() {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== companyName) { persistCompanyName(trimmed); showToast("Company name saved."); }
  }

  return (
    <div style={{ padding: 14, borderRadius: 8, border: "1px dashed var(--border)", background: "var(--panel-alt)", marginBottom: 24, maxWidth: 560 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ width: 48, height: 48, borderRadius: 8, border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--panel)", flexShrink: 0, overflow: "hidden" }}>
          {logoUrl ? <img src={logoUrl} alt="Current logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <Radio size={20} color="var(--text-dim)" />}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>Company logo</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>Shown at the top of every screen, for all three sign-in types.</div>
        </div>
        <button onClick={() => fileRef.current?.click()} disabled={busy} style={secondaryBtn}>
          <Upload size={13} /> {busy ? "Uploading…" : logoUrl ? "Replace" : "Upload"}
        </button>
        {logoUrl && <button onClick={() => { persistLogo(""); showToast("Logo removed."); }} title="Remove logo" style={iconBtn}><X size={13} /></button>}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
      </div>
      {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 8 }}>{error}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>Company name</div>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.key === "Enter") { saveName(); e.currentTarget.blur(); } }}
            placeholder="e.g. Ausgroup"
            style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 12.5, background: "var(--panel)", color: "var(--text)" }}
          />
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>Shown next to the logo as "{nameInput.trim() || companyName} Alarm Response Dispatch".</div>
        </div>
      </div>
    </div>
  );
}

function AccountsManager({ accounts, setAccounts, zones, session, logoUrl, persistLogo, companyName, persistCompanyName }) {
  const [role, setRole] = useState("patrolman");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [shift, setShift] = useState("");
  const [run, setRun] = useState("Unassigned");
  const [contactNumber, setContactNumber] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Passwords are hashed server-side and never sent back to the client, so
  // the only moment we ever know a plaintext password is right after we
  // set it ourselves (creation or reset) — keyed by "role:loginName" and
  // used by AccountRow's "Send login details" panel.
  const [lastKnownPasswords, setLastKnownPasswords] = useState({});
  const showToast = useToast();

  async function createAccount() {
    setError("");
    const name = loginName.trim();
    if (!name || !password) { setError("Login name and password are required."); return; }
    if (accounts.some((a) => a.loginName.toLowerCase() === name.toLowerCase())) { setError("That login name is already in use — pick a unique one."); return; }
    setBusy(true);
    try {
      const fields = { loginName: name, password, role, displayName: displayName.trim() || name, contactNumber: contactNumber.trim() };
      if (role === "patrolman") { fields.shift = shift.trim(); fields.run = run; }
      const newAccount = await apiCreateAccount(fields);
      setAccounts((prev) => [...prev, newAccount]);
      setLastKnownPasswords((prev) => ({ ...prev, [`${newAccount.role}:${newAccount.loginName}`]: password }));
      showToast(`Login "${name}" created.`);
      setLoginName(""); setPassword(""); setDisplayName(""); setShift(""); setRun("Unassigned"); setContactNumber("");
    } catch (err) {
      setError(err.message || "Couldn't create that login.");
    } finally {
      setBusy(false);
    }
  }

  const groups = [
    { key: "manager", title: "Managers" },
    { key: "operator", title: "Control Room" },
    { key: "patrolman", title: "Patrolmen" },
  ];

  return (
    <div>
      <LogoUploader logoUrl={logoUrl} persistLogo={persistLogo} companyName={companyName} persistCompanyName={persistCompanyName} />

      <SectionTitle icon={UserPlus} title="Create a login" />
      <div style={{ maxWidth: 560, marginBottom: 30 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {["patrolman", "operator", "manager"].map((r) => (
            <button key={r} onClick={() => setRole(r)} style={{ flex: 1, padding: "8px 0", borderRadius: 7, cursor: "pointer", border: `1px solid ${role === r ? "var(--accent)" : "var(--border)"}`, background: role === r ? "var(--accent-dim)" : "var(--panel)", color: role === r ? "var(--accent)" : "var(--text-dim)", fontWeight: 600, fontSize: 12, textTransform: "capitalize" }}>
              {r === "operator" ? "Control Room" : r}
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <Field label="Login name" style={{ flex: 1 }}>
            <input value={loginName} onChange={(e) => setLoginName(e.target.value)} placeholder={role === "patrolman" ? "e.g. T13" : "e.g. ControlRoom3"} style={selectStyle} />
          </Field>
          <Field label="Password" style={{ flex: 1 }}>
            <input value={password} onChange={(e) => setPassword(e.target.value)} style={selectStyle} />
          </Field>
        </div>

        <Field label="Display name (optional)">
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Defaults to the login name" style={selectStyle} />
        </Field>

        {role === "patrolman" && (
          <div style={{ display: "flex", gap: 12 }}>
            <Field label="Shift hours" style={{ flex: 1 }}>
              <input value={shift} onChange={(e) => setShift(e.target.value)} placeholder="e.g. 1800-0600" style={selectStyle} />
            </Field>
            <Field label="Run / zone (for job routing)" style={{ flex: 1 }}>
              <select value={run} onChange={(e) => setRun(e.target.value)} style={selectStyle}>
                <option value="Unassigned">Unassigned</option>
                {zones.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
          </div>
        )}

        <Field label="Contact number (optional)">
          <input value={contactNumber} onChange={(e) => setContactNumber(e.target.value)} placeholder="e.g. 0412 345 678" style={selectStyle} />
        </Field>

        {error && <div style={{ color: "var(--breach)", fontSize: 12, marginBottom: 10 }}>{error}</div>}

        <button onClick={createAccount} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}><UserPlus size={14} /> {busy ? "Creating…" : "Create login"}</button>
      </div>

      <PatrolmanRosterImport accounts={accounts} setAccounts={setAccounts} zones={zones} />

      <SectionTitle icon={Users} title="Existing logins" />
      {groups.map((g) => {
        const list = accounts.filter((a) => a.role === g.key);
        if (!list.length) return null;
        return (
          <div key={g.key} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)", marginBottom: 8 }}>{g.title} ({list.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {list.map((a) => (
                <AccountRow key={a.role + a.loginName} account={a} setAccounts={setAccounts} zones={zones} isSelf={a.loginName === session.loginName && a.role === session.role} lastKnownPassword={lastKnownPasswords[`${a.role}:${a.loginName}`]} onKnowPassword={(pw) => setLastKnownPasswords((prev) => ({ ...prev, [`${a.role}:${a.loginName}`]: pw }))} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AccountRow({ account, setAccounts, zones, isSelf, lastKnownPassword, onKnowPassword }) {
  const [editingPw, setEditingPw] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [editingContact, setEditingContact] = useState(false);
  const [newContact, setNewContact] = useState(account.contactNumber || "");
  const [showSendLogin, setShowSendLogin] = useState(false);
  const [copied, setCopied] = useState(false);
  const showToast = useToast();
  const showConfirm = useConfirm();

  async function update(patch) {
    try {
      const updated = await apiUpdateAccount(account.loginName, account.role, patch);
      setAccounts((prev) => prev.map((a) => (a.loginName === account.loginName && a.role === account.role ? updated : a)));
    } catch (err) {
      showToast(err.message || "Couldn't save that change.", "error");
    }
  }

  function remove() {
    if (isSelf) { showToast("You can't delete the login you're currently signed in with.", "error"); return; }
    showConfirm(`Delete login "${account.loginName}"? This can't be undone.`, async () => {
      try {
        await apiDeleteAccount(account.loginName, account.role);
        setAccounts((prev) => prev.filter((a) => !(a.loginName === account.loginName && a.role === account.role)));
        showToast(`Login "${account.loginName}" removed.`);
      } catch (err) {
        showToast(err.message || "Couldn't delete that login.", "error");
      }
    });
  }

  async function resetPassword() {
    if (newPw.length < 4) return;
    setPwBusy(true);
    try {
      await apiResetPassword(account.loginName, account.role, newPw);
      onKnowPassword(newPw);
      setEditingPw(false);
      setNewPw("");
      showToast("Password reset.");
    } catch (err) {
      showToast(err.message || "Couldn't reset password.", "error");
    } finally {
      setPwBusy(false);
    }
  }

  const inactive = account.active === false;

  const loginMessage = lastKnownPassword
    ? `Your Alarm Response Dispatch login\n\nLogin name: ${account.loginName}\nPassword: ${lastKnownPassword}\n\nSign in at: ${window.location.origin}`
    : `Your Alarm Response Dispatch login\n\nLogin name: ${account.loginName}\n\nSign in at: ${window.location.origin}\n\n(Password not shown — reset it below to set a new one.)`;
  const smsHref = `sms:${encodeURIComponent(account.contactNumber || "")}?body=${encodeURIComponent(loginMessage)}`;

  return (
    <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--border)", opacity: inactive ? 0.55 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--mono)" }}>
            {account.loginName} {isSelf && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>(you)</span>}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            {account.displayName}{account.run ? ` · ${account.run}` : ""}{account.shift ? ` · ${account.shift}` : ""}{account.contactNumber ? ` · ${account.contactNumber}` : ""}{inactive ? " · deactivated" : ""}
          </div>
        </div>
        {account.role === "patrolman" && (
          <select value={account.run || "Unassigned"} onChange={(e) => update({ run: e.target.value })} style={{ ...selectStyle, width: 150, padding: "6px 8px", fontSize: 11.5 }}>
            <option value="Unassigned">Unassigned</option>
            {zones.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}
        <button onClick={() => { setCopied(false); setShowSendLogin((v) => !v); }} title="Send login details" style={iconBtn}><Send size={13} /></button>
        <button onClick={() => { setNewContact(account.contactNumber || ""); setEditingContact((v) => !v); }} title="Edit contact number" style={iconBtn}><Phone size={13} /></button>
        <button onClick={() => { update({ active: inactive ? true : false }); showToast(inactive ? "Login reactivated." : "Login deactivated."); }} title={inactive ? "Reactivate login" : "Deactivate login"} style={iconBtn}>
          <Power size={13} color={inactive ? "var(--ok)" : "var(--text-dim)"} />
        </button>
        <button onClick={() => { setNewPw(""); setShowPw(false); setEditingPw((v) => !v); }} title="Reset password" style={iconBtn}><RotateCcw size={13} /></button>
        <button onClick={remove} title="Delete login" style={iconBtn}><Trash2 size={13} color="var(--breach)" /></button>
      </div>
      {showSendLogin && (
        <div style={{ marginTop: 8, padding: 10, borderRadius: 7, background: "var(--panel-alt)", border: "1px solid var(--border)" }}>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: 11, margin: 0, marginBottom: 8 }}>{loginMessage}</pre>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => { navigator.clipboard?.writeText(loginMessage); setCopied(true); }}
              style={secondaryBtn}
            >
              <Copy size={13} /> {copied ? "Copied!" : "Copy message"}
            </button>
            {account.contactNumber ? (
              <a href={smsHref} style={{ ...secondaryBtn, textDecoration: "none" }}>
                <Phone size={13} /> Text via SMS
              </a>
            ) : (
              <span style={{ fontSize: 11.5, color: "var(--text-dim)", alignSelf: "center" }}>Add a contact number to text this directly.</span>
            )}
          </div>
        </div>
      )}
      {editingContact && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input value={newContact} onChange={(e) => setNewContact(e.target.value)} placeholder="Contact number" style={{ ...selectStyle, fontSize: 12 }} />
          <button
            onClick={() => { update({ contactNumber: newContact.trim() }); setEditingContact(false); showToast("Contact number saved."); }}
            style={secondaryBtn}
          >
            Save
          </button>
        </div>
      )}
      {editingPw && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>Existing passwords can't be viewed — set a new one and share it now via "Send login details".</div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <input
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                type={showPw ? "text" : "password"}
                placeholder="New password (min 4 chars)"
                style={{ ...selectStyle, fontSize: 12, paddingRight: 30 }}
              />
              <button type="button" onClick={() => setShowPw((v) => !v)} title={showPw ? "Hide password" : "Show password"} style={{ position: "absolute", right: 6, top: 6, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}>
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <button onClick={resetPassword} disabled={pwBusy || newPw.length < 4} style={{ ...secondaryBtn, opacity: pwBusy || newPw.length < 4 ? 0.6 : 1 }}>
              {pwBusy ? "Saving…" : "Reset"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   SITES & RUNS MANAGER
---------------------------------------------------------------- */

function SitesManager({ zones, persistZones, sites, persistSites, accounts, setAccounts }) {
  return (
    <div>
      <ZonesEditor zones={zones} persistZones={persistZones} sites={sites} persistSites={persistSites} accounts={accounts} setAccounts={setAccounts} />
      <div style={{ height: 30 }} />
      <SitesEditor zones={zones} sites={sites} persistSites={persistSites} />
    </div>
  );
}

function ZonesEditor({ zones, persistZones, sites, persistSites, accounts, setAccounts }) {
  const [newZone, setNewZone] = useState("");
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(null); // zone name currently being renamed
  const [renameValue, setRenameValue] = useState("");
  const showToast = useToast();
  const showConfirm = useConfirm();

  function addZone() {
    setError("");
    const name = newZone.trim();
    if (!name) return;
    if (zones.some((z) => z.toLowerCase() === name.toLowerCase())) { setError("That run name already exists."); return; }
    persistZones([...zones, name]);
    setNewZone("");
    showToast(`Run "${name}" added.`);
  }

  function startRename(z) { setRenaming(z); setRenameValue(z); }

  async function saveRename() {
    const oldName = renaming;
    const newName = renameValue.trim();
    if (!newName || newName === oldName) { setRenaming(null); return; }
    if (zones.some((z) => z.toLowerCase() === newName.toLowerCase() && z !== oldName)) { setError("That run name already exists."); return; }
    const affected = accounts.filter((a) => a.role === "patrolman" && a.run === oldName);
    persistZones(zones.map((z) => (z === oldName ? newName : z)));
    persistSites(sites.map((s) => (s.run === oldName ? { ...s, run: newName } : s)));
    setRenaming(null);
    setError("");
    try {
      if (affected.length) {
        await apiBulkUpdateAccounts({ updates: affected.map((a) => ({ loginName: a.loginName, role: a.role, patch: { run: newName } })) });
        setAccounts((prev) => prev.map((a) => (a.role === "patrolman" && a.run === oldName ? { ...a, run: newName } : a)));
      }
      showToast(`Run renamed to "${newName}".`);
    } catch (err) {
      showToast(err.message || "Run renamed, but patrolman logins may not have updated — refresh to check.", "error");
    }
  }

  function removeZone(z) {
    const siteCount = sites.filter((s) => s.run === z).length;
    const patrolAffected = accounts.filter((a) => a.role === "patrolman" && a.run === z);
    const msg = siteCount || patrolAffected.length
      ? `"${z}" is used by ${siteCount} site(s) and ${patrolAffected.length} patrolman login(s). Delete anyway? They'll be set to Unassigned.`
      : `Delete run "${z}"?`;
    showConfirm(msg, async () => {
      persistZones(zones.filter((r) => r !== z));
      if (siteCount) persistSites(sites.map((s) => (s.run === z ? { ...s, run: "Unassigned" } : s)));
      try {
        if (patrolAffected.length) {
          await apiBulkUpdateAccounts({ updates: patrolAffected.map((a) => ({ loginName: a.loginName, role: a.role, patch: { run: "Unassigned" } })) });
          setAccounts((prev) => prev.map((a) => (a.role === "patrolman" && a.run === z ? { ...a, run: "Unassigned" } : a)));
        }
        showToast(`Run "${z}" removed.`);
      } catch (err) {
        showToast(err.message || "Run removed, but patrolman logins may not have updated — refresh to check.", "error");
      }
    });
  }

  return (
    <div>
      <SectionTitle icon={MapPin} title="Runs / zones" small />
      <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }}>
        Name these however your team already refers to them. Renaming a run updates every site and patrolman assigned to it automatically.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12, maxWidth: 420 }}>
        {zones.map((z) => (
          <div key={z} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 7, background: "var(--panel)", border: "1px solid var(--border)" }}>
            {renaming === z ? (
              <>
                <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} style={{ ...selectStyle, flex: 1, padding: "5px 8px", fontSize: 12.5 }} autoFocus />
                <button onClick={saveRename} style={secondaryBtn}>Save</button>
                <button onClick={() => setRenaming(null)} style={iconBtn}><X size={13} /></button>
              </>
            ) : (
              <>
                <span style={{ flex: 1, fontSize: 13 }}>{z}</span>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {sites.filter((s) => s.run === z).length} site(s) · {accounts.filter((a) => a.role === "patrolman" && a.run === z).length} patrolman(s)
                </span>
                <button onClick={() => startRename(z)} title="Rename" style={iconBtn}><RotateCcw size={13} /></button>
                <button onClick={() => removeZone(z)} title="Delete" style={iconBtn}><Trash2 size={13} color="var(--breach)" /></button>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, maxWidth: 420 }}>
        <input value={newZone} onChange={(e) => setNewZone(e.target.value)} placeholder="e.g. Bayside Run" style={selectStyle} />
        <button onClick={addZone} style={secondaryBtn}><UserPlus size={13} /> Add run</button>
      </div>
      {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/* ---------------------- Sites import (Excel/CSV) ---------------------- */

const SITE_IMPORT_FIELDS = [
  { key: "name", match: (h) => h === "sitename" || h === "name" },
  { key: "address", match: (h) => h === "address" },
  { key: "keyInfo", match: (h) => h.includes("key") || h.includes("swipe") },
  { key: "siteNotes", match: (h) => h.includes("note") },
  { key: "monitoringCo", match: (h) => h.includes("monitoring") },
  { key: "bureau", match: (h) => h === "bureau" },
  { key: "siteContact", match: (h) => h.includes("contact") },
  { key: "poNumber", match: (h) => h === "ponumber" || h === "po" || (h.includes("po") && h.includes("number")) },
  { key: "run", match: (h) => h === "run" || h === "zone" || h.includes("run") || h.includes("zone") },
];

function normalizeHeader(h) {
  return String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function SitesImport({ zones, sites, persistSites }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (!rows.length) { setError("That file has no rows to import."); setBusy(false); return; }

      const headers = Object.keys(rows[0]);
      const fieldToHeader = {};
      SITE_IMPORT_FIELDS.forEach(({ key, match }) => {
        const h = headers.find((h) => match(normalizeHeader(h)));
        if (h) fieldToHeader[key] = h;
      });

      const existingKeys = new Set(sites.map((s) => `${(s.name || "").trim().toLowerCase()}|${(s.address || "").trim().toLowerCase()}`));
      const seen = new Set();
      let skippedMissing = 0;
      let skippedDupe = 0;
      const imported = [];

      rows.forEach((row, i) => {
        const get = (key) => (fieldToHeader[key] ? String(row[fieldToHeader[key]] ?? "").trim() : "");
        const name = get("name");
        const address = get("address");
        if (!name || !address) { skippedMissing++; return; }
        const dedupeKey = `${name.toLowerCase()}|${address.toLowerCase()}`;
        if (existingKeys.has(dedupeKey) || seen.has(dedupeKey)) { skippedDupe++; return; }
        seen.add(dedupeKey);
        imported.push({
          id: `site_import_${Date.now()}_${i}`,
          name,
          address,
          run: get("run") || zones[0] || "Unassigned",
          monitoringCo: get("monitoringCo"),
          bureau: get("bureau"),
          poNumber: get("poNumber"),
          keyInfo: get("keyInfo"),
          siteNotes: get("siteNotes"),
          siteContact: get("siteContact"),
          alarmCode: "",
        });
      });

      if (imported.length) persistSites([...sites, ...imported]);
      setResult({ imported: imported.length, skippedMissing, skippedDupe, total: rows.length });
    } catch (err) {
      setError("Couldn't read that file — make sure it's a valid .xlsx, .xls, or .csv export.");
    }
    setBusy(false);
  }

  return (
    <div style={{ padding: 14, borderRadius: 8, border: "1px dashed var(--border)", background: "var(--panel-alt)", marginBottom: 24, maxWidth: 560 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>Import sites from Excel</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            Columns recognized: Site name, Address, Key/swipe card, Site notes, Monitoring, Bureau, Site contact (PO number and Run/zone also picked up if present). Site name and Address are required per row.
          </div>
        </div>
        <button onClick={() => fileRef.current?.click()} disabled={busy} style={secondaryBtn}>
          <Upload size={13} /> {busy ? "Importing…" : "Choose file"}
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={handleFile} />
      </div>
      {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 10 }}>{error}</div>}
      {result && (
        <div style={{ color: "var(--ok)", fontSize: 12, marginTop: 10 }}>
          Imported {result.imported} of {result.total} row(s).
          {result.skippedDupe > 0 && ` ${result.skippedDupe} skipped as duplicates of existing sites.`}
          {result.skippedMissing > 0 && ` ${result.skippedMissing} skipped (missing site name or address).`}
        </div>
      )}
    </div>
  );
}

function SitesEditor({ zones, sites, persistSites }) {
  const blank = { name: "", address: "", run: zones[0] || "Unassigned", monitoringCo: "", monitoringEmail: "", bureau: "", poNumber: "", keyInfo: "", siteNotes: "", siteContact: "", alarmCode: "" };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const showToast = useToast();
  const showConfirm = useConfirm();

  function set(field, value) { setForm((f) => ({ ...f, [field]: value })); }

  function startEdit(site) { setEditingId(site.id); setForm({ ...blank, ...site }); }
  function cancelEdit() { setEditingId(null); setForm(blank); setError(""); }

  function save() {
    setError("");
    if (!form.name.trim() || !form.address.trim()) { setError("Site name and address are required."); return; }
    if (editingId) {
      persistSites(sites.map((s) => (s.id === editingId ? { ...form, id: editingId } : s)));
      showToast("Site changes saved.");
    } else {
      persistSites([...sites, { ...form, id: `site_${Date.now()}` }]);
      showToast(`Site "${form.name.trim()}" added.`);
    }
    cancelEdit();
  }

  function remove(id) {
    showConfirm("Delete this site? Past jobs already dispatched to it keep their own record.", () => {
      persistSites(sites.filter((s) => s.id !== id));
      if (editingId === id) cancelEdit();
      showToast("Site removed.");
    });
  }

  function clearAll() {
    showConfirm(
      `Delete all ${sites.length} site(s)? This can't be undone — past jobs already dispatched keep their own record, but the site list will be empty.`,
      () => {
        persistSites([]);
        cancelEdit();
        showToast("All sites removed.");
      },
      { confirmLabel: "Delete all" }
    );
  }

  const q = filter.trim().toLowerCase();
  const filteredSites = q
    ? sites.filter((s) => [s.name, s.address, s.monitoringCo, s.bureau, s.poNumber].some((v) => (v || "").toLowerCase().includes(q)))
    : sites;

  return (
    <div>
      <SectionTitle icon={Building2} title={editingId ? "Edit site" : "Add a site"} small />
      <div style={{ maxWidth: 560, marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <Field label="Site name" style={{ flex: 1 }}><input value={form.name} onChange={(e) => set("name", e.target.value)} style={selectStyle} /></Field>
          <Field label="Run / zone" style={{ width: 170 }}>
            <select value={form.run} onChange={(e) => set("run", e.target.value)} style={selectStyle}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Field label="Address" style={{ flex: 1 }}><input value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Street, suburb, state" style={selectStyle} /></Field>
          <Field label="PO number" style={{ width: 150 }}><input value={form.poNumber} onChange={(e) => set("poNumber", e.target.value)} style={selectStyle} /></Field>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Field label="Monitoring" style={{ flex: 1 }}><input value={form.monitoringCo} onChange={(e) => set("monitoringCo", e.target.value)} placeholder="Who dispatches the alarm to us" style={selectStyle} /></Field>
          <Field label="Bureau" style={{ flex: 1 }}><input value={form.bureau} onChange={(e) => set("bureau", e.target.value)} placeholder="Who we invoice, if different" style={selectStyle} /></Field>
        </div>
        <Field label="Monitoring email (optional)"><input type="email" value={form.monitoringEmail} onChange={(e) => set("monitoringEmail", e.target.value)} placeholder="Where to send the outcome report" style={selectStyle} /></Field>
        <Field label="Site contact (optional)"><input value={form.siteContact} onChange={(e) => set("siteContact", e.target.value)} style={selectStyle} /></Field>
        <div style={{ display: "flex", gap: 12 }}>
          <Field label="Key / swipe card (optional)" style={{ flex: 1 }}><input value={form.keyInfo} onChange={(e) => set("keyInfo", e.target.value)} style={selectStyle} /></Field>
          <Field label="Alarm code" style={{ width: 130 }}><input value={form.alarmCode} onChange={(e) => set("alarmCode", e.target.value)} style={selectStyle} /></Field>
        </div>
        <Field label="Site notes (optional)"><textarea rows={2} value={form.siteNotes} onChange={(e) => set("siteNotes", e.target.value)} style={{ ...selectStyle, resize: "vertical" }} /></Field>
        {error && <div style={{ color: "var(--breach)", fontSize: 12, marginBottom: 10 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} style={primaryBtn}><UserPlus size={14} /> {editingId ? "Save changes" : "Add site"}</button>
          {editingId && <button onClick={cancelEdit} style={secondaryBtn}>Cancel</button>}
        </div>
      </div>

      <SitesImport zones={zones} sites={sites} persistSites={persistSites} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <SectionTitle icon={MapPin} title={`Sites (${sites.length})`} small />
        {sites.length > 0 && (
          <button onClick={clearAll} style={{ ...iconBtn, width: "auto", padding: "6px 10px", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--breach)" }}>
            <Trash2 size={13} /> Clear all sites
          </button>
        )}
      </div>
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search by name, address, monitoring, bureau, PO number…" style={{ ...selectStyle, marginBottom: 10 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 480, overflowY: "auto" }}>
        {filteredSites.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--border)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                {s.address} · {s.run}{s.monitoringCo ? ` · Mon: ${s.monitoringCo}` : ""}{s.bureau ? ` · Bureau: ${s.bureau}` : ""}{s.poNumber ? ` · PO ${s.poNumber}` : ""}
              </div>
            </div>
            <button onClick={() => startEdit(s)} title="Edit" style={iconBtn}><RotateCcw size={13} /></button>
            <button onClick={() => remove(s.id)} title="Delete" style={iconBtn}><Trash2 size={13} color="var(--breach)" /></button>
          </div>
        ))}
        {sites.length === 0 && <Empty text="No sites yet — add your first one above, or import from Excel." />}
        {sites.length > 0 && filteredSites.length === 0 && <Empty text="No sites match that search." />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   ROSTER — date-wise / shift-wise who's working which run
---------------------------------------------------------------- */

function parseRosterDate(value) {
  if (value instanceof Date && !isNaN(value)) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const s = String(value || "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const parsed = new Date(s);
  if (!isNaN(parsed)) return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  return "";
}

function fmtRosterDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

const ROSTER_IMPORT_FIELDS = [
  { key: "date", match: (h) => h === "date" || h.includes("date") },
  { key: "run", match: (h) => h === "run" || h === "zone" || h === "site" || h.includes("run") || h.includes("zone") },
  { key: "name", match: (h) => h.includes("name") },
  { key: "shift", match: (h) => h.includes("shift") || h.includes("time") || h.includes("schedul") },
  { key: "contactNumber", match: (h) => h.includes("contact") || h.includes("phone") || h.includes("mobile") },
];

function RosterImport({ zones, accounts, roster, persistRoster }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const XLSX = await import("xlsx");
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: "array", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (!rows.length) { setError("That file has no rows to import."); setBusy(false); return; }

      const headers = Object.keys(rows[0]);
      const fieldToHeader = {};
      ROSTER_IMPORT_FIELDS.forEach(({ key, match }) => {
        const h = headers.find((h) => match(normalizeHeader(h)));
        if (h) fieldToHeader[key] = h;
      });

      const working = roster.slice();
      const existingKeys = new Set(working.map((r) => `${r.date}|${r.run.toLowerCase()}|${r.patrolmanName.toLowerCase()}`));

      let created = 0;
      let skippedMissing = 0;
      let skippedDupe = 0;
      let runNotRecognized = 0;
      let badDate = 0;

      rows.forEach((row, i) => {
        const get = (key) => (fieldToHeader[key] ? row[fieldToHeader[key]] : "");
        const date = parseRosterDate(get("date"));
        const name = String(get("name") ?? "").trim();
        const rawRun = String(get("run") ?? "").trim();
        const shift = String(get("shift") ?? "").trim();
        const contactNumber = String(get("contactNumber") ?? "").trim();

        if (!name || !rawRun) { skippedMissing++; return; }
        if (!date) { badDate++; return; }

        const zoneMatch = zones.find((z) => z.toLowerCase() === rawRun.toLowerCase());
        if (!zoneMatch) runNotRecognized++;
        const run = zoneMatch || rawRun;

        const dedupeKey = `${date}|${run.toLowerCase()}|${name.toLowerCase()}`;
        if (existingKeys.has(dedupeKey)) { skippedDupe++; return; }
        existingKeys.add(dedupeKey);

        const account = accounts.find((a) => a.role === "patrolman" && (a.displayName.toLowerCase() === name.toLowerCase() || a.loginName.toLowerCase() === name.toLowerCase()));

        working.push({
          id: `roster_${Date.now()}_${i}`,
          date,
          run,
          patrolmanLoginName: account ? account.loginName : "",
          patrolmanName: name,
          shift: shift || (account?.shift || ""),
          contactNumber: contactNumber || (account?.contactNumber || ""),
        });
        created++;
      });

      if (created) persistRoster(working);
      setResult({ created, skippedMissing, skippedDupe, runNotRecognized, badDate, total: rows.length });
    } catch (err) {
      setError("Couldn't read that file — make sure it's a valid .xlsx, .xls, or .csv export.");
    }
    setBusy(false);
  }

  return (
    <div style={{ padding: 14, borderRadius: 8, border: "1px dashed var(--border)", background: "var(--panel-alt)", marginBottom: 24, maxWidth: 620 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>Import roster from Excel</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            Columns: Date, Run/Zone (or "Site"), Full Name, Shift (or "Scheduled"), Contact/Mobile number (optional). One row per patrolman per date — a whole fortnight is just every date/run/name combination in one sheet. Names matching an existing login pick up that login's contact/shift as a fallback. Run must match a run you've already added, or it's kept as typed and flagged.
          </div>
        </div>
        <button onClick={() => fileRef.current?.click()} disabled={busy} style={secondaryBtn}>
          <Upload size={13} /> {busy ? "Importing…" : "Choose file"}
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={handleFile} />
      </div>
      {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 10 }}>{error}</div>}
      {result && (
        <div style={{ color: "var(--ok)", fontSize: 12, marginTop: 10 }}>
          {result.created} entr{result.created !== 1 ? "ies" : "y"} added.
          {result.skippedDupe > 0 && ` ${result.skippedDupe} skipped as duplicates.`}
          {result.runNotRecognized > 0 && ` ${result.runNotRecognized} row(s) had a run/zone that doesn't match any existing run — kept as typed.`}
          {result.badDate > 0 && ` ${result.badDate} row(s) skipped (date couldn't be read).`}
          {result.skippedMissing > 0 && ` ${result.skippedMissing} row(s) skipped (missing name or run).`}
        </div>
      )}
    </div>
  );
}

function RosterView({ zones, accounts, roster, persistRoster }) {
  const [selectedDate, setSelectedDate] = useState(todayISO());
  const blank = { date: selectedDate, run: zones[0] || "Unassigned", patrolmanLoginName: "", patrolmanName: "", shift: "", contactNumber: "" };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");
  const showToast = useToast();
  const showConfirm = useConfirm();

  const patrolmen = accounts.filter((a) => a.role === "patrolman");

  function set(field, value) { setForm((f) => ({ ...f, [field]: value })); }

  function pickPatrolman(loginName) {
    if (loginName === "__custom__") { set("patrolmanLoginName", ""); return; }
    const a = patrolmen.find((p) => p.loginName === loginName);
    setForm((f) => ({
      ...f,
      patrolmanLoginName: loginName,
      patrolmanName: a?.displayName || "",
      shift: a?.shift || f.shift,
      contactNumber: a?.contactNumber || f.contactNumber,
    }));
  }

  function startAdd() { setEditingId(null); setForm({ ...blank, date: selectedDate }); setError(""); }
  function startEdit(entry) { setEditingId(entry.id); setForm({ ...entry }); setError(""); }
  function cancelEdit() { setEditingId(null); setForm({ ...blank, date: selectedDate }); setError(""); }

  function save() {
    setError("");
    if (!form.date || !form.run || !form.patrolmanName.trim()) { setError("Date, run, and patrolman name are required."); return; }
    const entry = { ...form, patrolmanName: form.patrolmanName.trim() };
    if (editingId) {
      persistRoster(roster.map((r) => (r.id === editingId ? { ...entry, id: editingId } : r)));
      showToast("Roster entry updated.");
    } else {
      persistRoster([...roster, { ...entry, id: `roster_${Date.now()}` }]);
      showToast("Roster entry added.");
    }
    cancelEdit();
  }

  function remove(id) {
    showConfirm("Remove this roster entry?", () => {
      persistRoster(roster.filter((r) => r.id !== id));
      if (editingId === id) cancelEdit();
      showToast("Roster entry removed.");
    });
  }

  const forDate = roster.filter((r) => r.date === selectedDate);
  const runsToShow = Array.from(new Set([...zones, ...forDate.map((r) => r.run)]));

  return (
    <div>
      <SectionTitle icon={CalendarDays} title="Roster" />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <Field label="Date" style={{ marginBottom: 0 }}>
          <input type="date" value={selectedDate} onChange={(e) => { setSelectedDate(e.target.value); if (!editingId) setForm((f) => ({ ...f, date: e.target.value })); }} style={{ ...selectStyle, width: 180 }} />
        </Field>
        <button onClick={() => setSelectedDate(todayISO())} style={{ ...secondaryBtn, marginTop: 19 }}>Today</button>
      </div>

      <SectionTitle icon={UserPlus} title={editingId ? "Edit roster entry" : "Add roster entry"} small />
      <div style={{ maxWidth: 620, marginBottom: 24 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <Field label="Date" style={{ width: 160 }}>
            <input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} style={selectStyle} />
          </Field>
          <Field label="Run / zone" style={{ flex: 1 }}>
            <select value={form.run} onChange={(e) => set("run", e.target.value)} style={selectStyle}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              {!zones.includes(form.run) && form.run && <option value={form.run}>{form.run}</option>}
            </select>
          </Field>
        </div>
        <Field label="Patrolman">
          <select value={form.patrolmanLoginName || "__custom__"} onChange={(e) => pickPatrolman(e.target.value)} style={selectStyle}>
            <option value="__custom__">Type a name not on this list…</option>
            {patrolmen.map((p) => <option key={p.loginName} value={p.loginName}>{p.displayName} · {p.loginName}</option>)}
          </select>
        </Field>
        {!form.patrolmanLoginName && (
          <Field label="Patrolman name">
            <input value={form.patrolmanName} onChange={(e) => set("patrolmanName", e.target.value)} placeholder="e.g. relief patrolman name" style={selectStyle} />
          </Field>
        )}
        <div style={{ display: "flex", gap: 12 }}>
          <Field label="Shift" style={{ flex: 1 }}>
            <input value={form.shift} onChange={(e) => set("shift", e.target.value)} placeholder="e.g. 1800-0600" style={selectStyle} />
          </Field>
          <Field label="Contact number" style={{ flex: 1 }}>
            <input value={form.contactNumber} onChange={(e) => set("contactNumber", e.target.value)} style={selectStyle} />
          </Field>
        </div>
        {error && <div style={{ color: "var(--breach)", fontSize: 12, marginBottom: 10 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} style={primaryBtn}><UserPlus size={14} /> {editingId ? "Save changes" : "Add to roster"}</button>
          {editingId && <button onClick={cancelEdit} style={secondaryBtn}>Cancel</button>}
        </div>
      </div>

      <RosterImport zones={zones} accounts={accounts} roster={roster} persistRoster={persistRoster} />

      <SectionTitle icon={CalendarDays} title={fmtRosterDate(selectedDate)} small />
      {forDate.length === 0 ? (
        <Empty text="No one rostered for this date yet — add an entry above, or import a sheet." />
      ) : (
        runsToShow.map((run) => {
          const entries = forDate.filter((r) => r.run === run);
          if (!entries.length) return null;
          return (
            <div key={run} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)", marginBottom: 8 }}>{run} ({entries.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {entries.map((r) => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, background: "var(--panel)", border: "1px solid var(--border)" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{r.patrolmanName}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                        {r.shift || "No shift set"}{r.contactNumber ? ` · ${r.contactNumber}` : ""}
                      </div>
                    </div>
                    <button onClick={() => startEdit(r)} title="Edit" style={iconBtn}><RotateCcw size={13} /></button>
                    <button onClick={() => remove(r.id)} title="Delete" style={iconBtn}><Trash2 size={13} color="var(--breach)" /></button>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   SHARED UI BITS
---------------------------------------------------------------- */

function SectionTitle({ icon: Icon, title, small }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: small ? 10 : 16 }}>
      <Icon size={small ? 14 : 16} color="var(--accent)" />
      <div style={{ fontSize: small ? 13 : 15, fontWeight: 700 }}>{title}</div>
    </div>
  );
}

function Field({ label, children, style }) {
  return (
    <div style={{ marginBottom: 14, ...style }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}

const selectStyle = {
  width: "100%", padding: "9px 10px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--panel-alt)", color: "var(--text)", fontSize: 13, outline: "none",
};

const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 7,
  border: "none", background: "var(--accent)", color: "#0B0E11", fontWeight: 700, fontSize: 12.5, cursor: "pointer",
};

const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px", borderRadius: 7,
  border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)", fontWeight: 600, fontSize: 12.5, cursor: "pointer",
};

const backBtn = {
  display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "none",
  color: "var(--text-dim)", fontSize: 12, cursor: "pointer", padding: 0, marginBottom: 6,
};

const iconBtn = {
  background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: 6, cursor: "pointer",
  display: "inline-flex", alignItems: "center", justifyContent: "center",
};

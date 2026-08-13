import React, { useState, useEffect, useRef, useCallback, useContext, createContext } from "react";
import {
  Bell, Camera, CheckCircle2, AlertTriangle, Clock, LogOut, Mail,
  BarChart3, MapPin, KeyRound, Radio, ChevronRight, X, Copy, Send,
  ShieldAlert, ArrowLeft, Building2, Settings, Lock, Eye, EyeOff,
  Users, UserPlus, Power, Trash2, RotateCcw, Upload, Phone, CalendarDays, Ban,
  FileText, Download
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

function todayISO() {
  const d = new Date();
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

function watermarkPhoto(file, label) {
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
        const stamp = `${label}  ·  ${new Date().toLocaleString("en-AU", { hour12: false })}`;
        ctx.font = "12px ui-monospace, monospace";
        const textW = ctx.measureText(stamp).width;
        ctx.fillStyle = "rgba(0,0,0,0.62)";
        ctx.fillRect(0, h - 24, textW + 16, 24);
        ctx.fillStyle = "#F5A623";
        ctx.fillText(stamp, 8, h - 8);
        resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.72), ts: new Date().toISOString() });
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
  const [logoUrl, setLogoUrl] = useState("");
  const [companyName, setCompanyName] = useState(DEFAULT_COMPANY_NAME);
  const [now, setNow] = useState(Date.now());
  const [banner, setBanner] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [autoLoggedOut, setAutoLoggedOut] = useState(false);
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
        apiLogout();
        setSession(null);
        setAutoLoggedOut(true);
      }
    }, 30000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, markActivity));
      clearInterval(check);
    };
  }, [session]);

  const handleSignOut = useCallback(() => {
    apiLogout();
    setSession(null);
  }, []);

  // Wire up forced sign-out if any authenticated request ever comes back
  // 401 (expired/invalid token) — auth.js already clears the stored token.
  useEffect(() => {
    setOnUnauthorized(() => { setSession(null); setAutoLoggedOut(true); });
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
    try { await window.storage.set(JOBS_KEY, JSON.stringify(updated), true); } catch (e) { console.error(e); }
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
    }, 4000);
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
              autoLoggedOut={autoLoggedOut}
              logoUrl={logoUrl}
              companyName={companyName}
              onLogin={(s) => { setSession(s); setAutoLoggedOut(false); }}
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
          <TopBar session={session} onSignOut={handleSignOut} onOpenSettings={() => setShowSettings(true)} now={now} logoUrl={logoUrl} companyName={companyName} />
          {banner && <NotifBanner banner={banner} onDismiss={() => setBanner(null)} />}
          {showSettings && (
            <SettingsModal session={session} onClose={() => setShowSettings(false)} />
          )}
          {!accountsLoaded || !sitesLoaded ? (
            <div style={{ padding: 40, color: "var(--text-dim)" }}>Loading dispatch board…</div>
          ) : session.role === "manager" ? (
            <ManagerView session={session} accounts={accounts} setAccounts={setAccounts} zones={zones} persistZones={persistZones} sites={sites} persistSites={persistSites} roster={roster} persistRoster={persistRoster} logoUrl={logoUrl} persistLogo={persistLogo} companyName={companyName} persistCompanyName={persistCompanyName} jobs={jobs} now={now} />
          ) : session.role === "operator" ? (
            <OperatorView session={session} jobs={jobs} accounts={accounts} sites={sites} persistSites={persistSites} zones={zones} roster={roster} persistRoster={persistRoster} persist={persistJobs} now={now} companyName={companyName} />
          ) : (
            <PatrolmanView session={session} jobs={jobs} persist={persistJobs} now={now} />
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

function Login({ autoLoggedOut, logoUrl, companyName, onLogin }) {
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
        {autoLoggedOut && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 12, borderRadius: 7, background: "#FFFBEB", border: "1px solid var(--warn)", color: "#92400E", fontSize: 12.5, marginBottom: 20 }}>
            <Clock size={14} /> Signed out after 30 minutes of inactivity — please sign in again.
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

function TopBar({ session, onSignOut, onOpenSettings, now, logoUrl, companyName }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Logo src={logoUrl} />
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>{companyName} Alarm Response Dispatch</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--text-dim)" }}>
          {new Date(now).toLocaleTimeString("en-AU", { hour12: false })}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{session.displayName} <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({session.loginName})</span></div>
          <div style={{ fontSize: 10.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {session.role === "operator" ? "Control Room" : session.role === "manager" ? "Manager" : `Patrolman · ${session.run}`}
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

/* ---------------------------------------------------------------
   OPERATOR VIEW
---------------------------------------------------------------- */

function OperatorView({ session, jobs, accounts, sites, persistSites, zones, roster, persistRoster, persist, now, companyName }) {
  const [tab, setTab] = useState("board");
  const [selectedId, setSelectedId] = useState(null);
  const selected = jobs.find((j) => j.id === selectedId);
  const patrolmen = accounts.filter((a) => a.role === "patrolman");

  return (
    <div style={{ display: "flex", minHeight: 560 }}>
      <div style={{ width: 168, borderRight: "1px solid var(--border)", background: "var(--panel)", padding: "16px 10px" }}>
        {[
          { id: "board", label: "Dispatch board", icon: ShieldAlert },
          { id: "new", label: "New job", icon: Send },
          { id: "roster", label: "Roster", icon: CalendarDays },
          { id: "logs", label: "Logs & analysis", icon: BarChart3 },
        ].map((t) => (
          <button key={t.id} onClick={() => { setTab(t.id); setSelectedId(null); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", marginBottom: 4, borderRadius: 7, border: "none", cursor: "pointer", textAlign: "left", fontSize: 12.5, fontWeight: 600, background: tab === t.id ? "var(--accent-dim)" : "transparent", color: tab === t.id ? "var(--accent)" : "var(--text-dim)" }}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, padding: 20, overflowY: "auto" }}>
        {tab === "board" && !selected && <Board jobs={jobs} now={now} onSelect={setSelectedId} />}
        {tab === "board" && selected && (
          <JobDetailOperator job={selected} jobs={jobs} patrolmen={patrolmen} persist={persist} now={now} session={session} companyName={companyName} onBack={() => setSelectedId(null)} />
        )}
        {tab === "new" && <NewJobForm jobs={jobs} sites={sites} persistSites={persistSites} zones={zones} patrolmen={patrolmen} roster={roster} session={session} persist={persist} onCreated={(id) => { setTab("board"); setSelectedId(id); }} />}
        {tab === "roster" && <RosterView zones={zones} accounts={accounts} roster={roster} persistRoster={persistRoster} />}
        {tab === "logs" && <Logs jobs={jobs} now={now} role="operator" />}
      </div>
    </div>
  );
}

function Board({ jobs, now, onSelect }) {
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");

  const groups = [
    { key: "dispatched", title: "Out with patrolmen" },
    { key: "submitted", title: "Awaiting your review" },
    { key: "reviewed", title: "Reviewed — ready to send" },
    { key: "emailed", title: "Closed out" },
    { key: "cancelled", title: "Cancelled / stood down" },
  ];

  if (jobs.length === 0) return <Empty text="No jobs dispatched yet. Use “New job” to send the first alarm response." />;

  const q = search.trim().toLowerCase();
  const hasFilter = q || dateFilter || timeFrom || timeTo;
  const filtered = jobs.filter((j) => {
    if (q && !j.jobNumber.toLowerCase().includes(q) && !j.siteName.toLowerCase().includes(q)) return false;
    if (dateFilter && isoDateOnly(j.dispatchTime) !== dateFilter) return false;
    if (timeFrom || timeTo) {
      const t = isoTimeOnly(j.dispatchTime);
      if (timeFrom && t < timeFrom) return false;
      if (timeTo && t > timeTo) return false;
    }
    return true;
  });

  function clearFilters() { setSearch(""); setDateFilter(""); setTimeFrom(""); setTimeTo(""); }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap", marginBottom: 20, padding: 12, borderRadius: 8, background: "var(--panel-alt)", border: "1px solid var(--border)" }}>
        <Field label="Job number or site" style={{ marginBottom: 0, flex: "1 1 200px" }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. JB-0002 or Northgate" style={{ ...selectStyle, background: "var(--panel)" }} />
        </Field>
        <Field label="Date" style={{ marginBottom: 0 }}>
          <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 160 }} />
        </Field>
        <Field label="From time" style={{ marginBottom: 0 }}>
          <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 120 }} />
        </Field>
        <Field label="To time" style={{ marginBottom: 0 }}>
          <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} style={{ ...selectStyle, background: "var(--panel)", width: 120 }} />
        </Field>
        {hasFilter && <button onClick={clearFilters} style={{ ...secondaryBtn, marginBottom: 0 }}><X size={13} /> Clear filters</button>}
      </div>

      {hasFilter && filtered.length === 0 && <Empty text="No jobs match these filters." />}

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
    </div>
  );
}

function JobCard({ job, now, onClick }) {
  const t = jobTiming(job, now);
  const borderColor = job.status === "dispatched" ? (t.level === "breach" ? "var(--breach)" : t.level === "warn" ? "var(--warn)" : "var(--border)") : "var(--border)";
  return (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", borderRadius: 8, background: "var(--panel)", border: `1px solid ${borderColor}`, cursor: "pointer" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)", width: 96 }}>
        <div>{job.jobNumber}</div>
        <div style={{ fontSize: 10, marginTop: 2 }}>{fmtDateTime(job.dispatchTime)}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.siteName}</div>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{job.run} · {job.monitoringCo} · assigned {job.assigneeName}{job.handlingName ? ` · handled by ${job.handlingName}` : ""}</div>
      </div>
      {job.delayReason && <span title={job.delayReason}><AlertTriangle size={14} color="var(--warn)" /></span>}
      {job.status === "dispatched" && !job.onsiteTime && (
        job.acknowledgedAt
          ? <span title={`Acknowledged by ${job.assigneeName} at ${fmtTime(job.acknowledgedAt)}`}><CheckCircle2 size={14} color="var(--ok)" /></span>
          : <span title="Not yet acknowledged by the patrolman"><Bell size={14} color="var(--warn)" /></span>
      )}
      <SlaChip job={job} now={now} />
      <StatusBadge status={job.status} />
      <ChevronRight size={15} color="var(--text-dim)" />
    </div>
  );
}

function Empty({ text }) {
  return <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)", fontSize: 13, border: "1px dashed var(--border)", borderRadius: 10 }}>{text}</div>;
}

/* ---------------------- New job form ---------------------- */

function NewJobForm({ jobs, sites, persistSites, zones, patrolmen, roster, session, persist, onCreated }) {
  const [siteId, setSiteId] = useState("");
  const [siteQuery, setSiteQuery] = useState("");
  const [jobNumber, setJobNumber] = useState(() => `JB-${String(jobs.length + 1).padStart(4, "0")}`);
  const [orderNo, setOrderNo] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [keyInfo, setKeyInfo] = useState("");
  const [alarmCode, setAlarmCode] = useState("");
  const [addingSite, setAddingSite] = useState(false);

  const site = sites.find((s) => s.id === siteId);

  const todaysEntries = roster.filter((r) => r.date === todayISO());
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

  async function dispatch() {
    const assignee = patrolmen.find((r) => r.loginName === assigneeId);
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
    };
    await persist([...jobs, job]);
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
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Zone 4 motion sensor — loading dock" style={{ ...selectStyle, resize: "vertical", fontFamily: "var(--sans)" }} />
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

      <button disabled={!canDispatch} onClick={dispatch} style={{ ...primaryBtn, width: "100%", marginTop: 6, opacity: canDispatch ? 1 : 0.4, cursor: canDispatch ? "pointer" : "not-allowed" }}>
        <Send size={14} /> Dispatch job
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

/* ---------------------- Operator job detail ---------------------- */

function JobDetailOperator({ job, jobs, patrolmen, session, persist, now, onBack, companyName }) {
  const [notes, setNotes] = useState(job.reviewNotes || job.outcomeNotes);
  const [delayText, setDelayText] = useState("");
  const [showEmail, setShowEmail] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const showToast = useToast();

  useEffect(() => setNotes(job.reviewNotes || job.outcomeNotes), [job.id]);

  const t = jobTiming(job, now);

  function update(patch) {
    const updated = jobs.map((j) => (j.id === job.id ? { ...j, ...patch } : j));
    persist(updated);
  }

  function reassign(loginName) {
    const p = patrolmen.find((a) => a.loginName === loginName);
    if (!p) return;
    update({ assigneeId: p.loginName, assigneeName: p.displayName, run: p.run || job.run });
  }

  function confirmCancel() {
    update({ status: "cancelled", cancelReason: cancelReason.trim(), cancelledAt: new Date().toISOString() });
    setShowCancelForm(false);
    showToast("Job cancelled.");
  }

  function takeJob() {
    update({ handlingLoginName: session.loginName, handlingName: session.displayName });
    showToast("You're now handling this job.");
  }

  const isHandling = job.handlingLoginName === session.loginName;

  return (
    <div style={{ maxWidth: 640 }}>
      <button onClick={onBack} style={backBtn}><ArrowLeft size={13} /> Back to board</button>
      <JobHeader job={job} />

      {job.dispatchedByName && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)" }}>
          <span>Dispatched by <b style={{ color: "var(--text)" }}>{job.dispatchedByName}</b></span>
          <span>·</span>
          <span>Handling: <b style={{ color: isHandling ? "var(--ok)" : "var(--text)" }}>{job.handlingName}</b>{isHandling ? " (you)" : ""}</span>
          {!isHandling && (
            <button onClick={takeJob} style={{ ...secondaryBtn, padding: "4px 10px", fontSize: 11.5 }}>Take this job</button>
          )}
        </div>
      )}

      {!job.onsiteTime && job.status !== "cancelled" && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          {job.acknowledgedAt ? (
            <span style={{ color: "var(--ok)", display: "flex", alignItems: "center", gap: 6 }}>
              <CheckCircle2 size={13} /> Acknowledged by {job.assigneeName} at {fmtTime(job.acknowledgedAt)}
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
        <select value={job.assigneeId} onChange={(e) => reassign(e.target.value)} style={{ ...selectStyle, width: "auto", padding: "6px 10px", fontSize: 12.5 }}>
          {patrolmen.map((p) => <option key={p.loginName} value={p.loginName}>{p.displayName} · {p.loginName}</option>)}
        </select>
        {job.status === "dispatched" && (
          <button onClick={() => setShowCancelForm((v) => !v)} style={{ ...iconBtn, width: "auto", padding: "6px 10px", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--breach)", marginLeft: "auto" }}>
            <Ban size={13} /> Cancel job
          </button>
        )}
      </div>

      {showCancelForm && (
        <div style={{ marginTop: 12, padding: 14, borderRadius: 8, border: "1px solid var(--breach)", background: "#FEF2F2" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: "#B91C1C", fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>
            <Ban size={14} /> Cancel this job — the patrolman will be notified to stand down
          </div>
          <textarea rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="e.g. Monitoring advised stand down — client cancelled the alarm" style={{ ...selectStyle, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={confirmCancel} style={{ ...primaryBtn, background: "var(--breach)" }}><Ban size={14} /> Confirm cancel</button>
            <button onClick={() => setShowCancelForm(false)} style={secondaryBtn}>Never mind</button>
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
          <button disabled={!delayText.trim()} onClick={() => update({ delayReason: delayText.trim(), delayLoggedAt: new Date().toISOString() })} style={{ ...primaryBtn, marginTop: 8, opacity: delayText.trim() ? 1 : 0.4 }}>
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

      {job.status !== "dispatched" && job.status !== "cancelled" && (
        <div style={{ marginTop: 18 }}>
          <SectionTitle icon={CheckCircle2} title="Outcome" small />
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 6 }}>
            Onsite {fmtDateTime(job.onsiteTime)} · Offsite {fmtDateTime(job.offsiteTime)} · response time {jobTiming(job, now).elapsed}m (SLA {jobTiming(job, now).slaMin}m)
          </div>
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...selectStyle, resize: "vertical" }} />
          {job.photos?.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {job.photos.map((p, i) => <img key={i} src={p.dataUrl} alt="attendance evidence" style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />)}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            {job.status === "submitted" && <button onClick={() => update({ status: "reviewed", reviewNotes: notes })} style={secondaryBtn}><CheckCircle2 size={14} /> Mark reviewed</button>}
            {(job.status === "reviewed" || job.status === "submitted") && <button onClick={() => { update({ reviewNotes: notes }); setShowEmail(true); }} style={primaryBtn}><Mail size={14} /> Prepare client email</button>}
            {job.status === "emailed" && (
              <span style={{ color: "var(--ok)", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
                <CheckCircle2 size={14} /> {job.emailSentByApp ? `Emailed to client ${fmtDateTime(job.emailedAt)}` : `Marked sent ${fmtDateTime(job.emailedAt)}`}
              </span>
            )}
          </div>
        </div>
      )}

      {showEmail && (
        <EmailModal
          job={{ ...job, reviewNotes: notes }}
          companyName={companyName}
          onClose={() => setShowEmail(false)}
          onSent={({ clientEmail, emailSentByApp }) => {
            update({ status: "emailed", emailedAt: new Date().toISOString(), reviewNotes: notes, clientEmail, emailSentByApp });
            setShowEmail(false);
          }}
        />
      )}
    </div>
  );
}

function JobHeader({ job }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginTop: 14 }}>
      <div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 19, fontWeight: 700 }}>{job.jobNumber}</div>
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
  const outcome = (job.reviewNotes || "").replace(/\n/g, "<br>");

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
    ["Outcome", job.reviewNotes || "—"],
    ["Provider", provider],
    ["Times", times],
  ];
  const text = textLines.map(([k, v]) => `${k}: ${v}`).join("\n");

  return { html, text };
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
        body: JSON.stringify({ to: clientEmail.trim(), subject, text, html }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Send failed (${res.status})`);
      showToast("Email sent to client.");
      onSent({ clientEmail: clientEmail.trim(), emailSentByApp: true });
    } catch (e) {
      setError(e.message || "Couldn't send — try again, or copy the text and send it yourself.");
    }
    setBusy(false);
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
        {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button onClick={() => navigator.clipboard?.writeText(text)} style={secondaryBtn}><Copy size={13} /> Copy</button>
          <button onClick={() => onSent({ clientEmail: clientEmail.trim(), emailSentByApp: false })} style={secondaryBtn}><CheckCircle2 size={13} /> Mark as sent / closed</button>
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

function LogsOverview({ jobs, now }) {
  const attended = jobs.filter((j) => j.onsiteTime);
  const avgResp = attended.length ? Math.round(attended.reduce((s, j) => s + jobTiming(j, now).elapsed, 0) / attended.length) : 0;
  const cancelled = jobs.filter((j) => j.status === "cancelled");
  const breaches = jobs.filter((j) => j.status !== "cancelled" && (j.onsiteTime ? jobTiming(j, now).elapsed > jobTiming(j, now).slaMin : jobTiming(j, now).level === "breach")).length;

  const byCompany = {};
  jobs.forEach((j) => {
    byCompany[j.monitoringCo] = byCompany[j.monitoringCo] || { count: 0, respSum: 0, respN: 0, cancelled: 0 };
    byCompany[j.monitoringCo].count++;
    if (j.status === "cancelled") byCompany[j.monitoringCo].cancelled++;
    if (j.onsiteTime) { byCompany[j.monitoringCo].respSum += jobTiming(j, now).elapsed; byCompany[j.monitoringCo].respN++; }
  });

  return (
    <div>
      <SectionTitle icon={BarChart3} title="Shift log & analysis" />
      <div style={{ display: "flex", gap: 12, marginBottom: 22, flexWrap: "wrap" }}>
        <Stat label="Jobs dispatched" value={jobs.length} />
        <Stat label="Attended" value={attended.length} />
        <Stat label="Avg. response time" value={`${avgResp}m`} />
        <Stat label="SLA breaches" value={breaches} accent={breaches > 0 ? "var(--breach)" : "var(--ok)"} />
        <Stat label="Cancelled / stood down" value={cancelled.length} />
      </div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)", marginBottom: 8 }}>By monitoring company</div>
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
  const showToast = useToast();

  const filtered = jobs
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

function PatrolmanView({ session, jobs, persist, now }) {
  const [selectedId, setSelectedId] = useState(null);
  const mine = jobs.filter((j) => j.assigneeId === session.id).sort((a, b) => new Date(b.dispatchTime) - new Date(a.dispatchTime));
  const selected = mine.find((j) => j.id === selectedId);

  if (selected) {
    return <div style={{ padding: 20, maxWidth: 520 }}><JobDetailPatrolman job={selected} jobs={jobs} persist={persist} now={now} onBack={() => setSelectedId(null)} /></div>;
  }

  return (
    <div style={{ padding: 20 }}>
      <SectionTitle icon={ShieldAlert} title={`My jobs — ${session.run}`} />
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

function JobDetailPatrolman({ job, jobs, persist, now, onBack }) {
  const [outcome, setOutcome] = useState(job.outcomeNotes || "");
  const [docketNo, setDocketNo] = useState(job.docketNo || "");
  const [photos, setPhotos] = useState(job.photos || []);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const showToast = useToast();
  const isCancelled = job.status === "cancelled";
  const submitted = job.status !== "dispatched" && !isCancelled;
  const isOnsite = !!job.onsiteTime;

  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    setBusy(true);
    const results = [];
    for (const f of files.slice(0, 4 - photos.length)) {
      try { results.push(await watermarkPhoto(f, job.jobNumber)); } catch (err) { /* skip bad file */ }
    }
    setPhotos((p) => [...p, ...results]);
    setBusy(false);
    e.target.value = "";
  }

  async function acknowledgeJob() {
    const updated = jobs.map((j) => (j.id === job.id ? { ...j, acknowledgedAt: new Date().toISOString() } : j));
    await persist(updated);
    showToast("Job acknowledged — control room can see you've received it.");
  }

  async function markOnsite() {
    const updated = jobs.map((j) => (j.id === job.id ? { ...j, acknowledgedAt: j.acknowledgedAt || new Date().toISOString(), onsiteTime: new Date().toISOString() } : j));
    await persist(updated);
  }

  async function submit() {
    const updated = jobs.map((j) => (j.id === job.id ? { ...j, status: "submitted", outcomeNotes: outcome.trim(), docketNo: docketNo.trim(), photos, offsiteTime: new Date().toISOString() } : j));
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
            Let control room know you've received this job and are on your way.
          </div>
          <button onClick={acknowledgeJob} style={{ ...primaryBtn, width: "100%", justifyContent: "center" }}>
            <CheckCircle2 size={14} /> Acknowledge — I've received this job
          </button>
        </div>
      )}

      {!submitted && !isOnsite && !isCancelled && job.acknowledgedAt && (
        <div style={{ fontSize: 11.5, color: "var(--ok)", marginTop: 20, display: "flex", alignItems: "center", gap: 6 }}>
          <CheckCircle2 size={13} /> Acknowledged at {fmtTime(job.acknowledgedAt)}
        </div>
      )}

      {!submitted && !isOnsite && !isCancelled && (
        <div style={{ marginTop: 20 }}>
          <SectionTitle icon={MapPin} title="Arrived at site?" small />
          <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 12 }}>
            Mark onsite the moment you arrive — this records your response time and unlocks the outcome form.
          </div>
          <button onClick={markOnsite} style={{ ...primaryBtn, width: "100%", justifyContent: "center" }}>
            <MapPin size={14} /> Mark onsite
          </button>
        </div>
      )}

      {!submitted && isOnsite && !isCancelled && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 11.5, color: "var(--ok)", marginBottom: 10 }}>Onsite at {fmtTime(job.onsiteTime)}</div>
          <SectionTitle icon={CheckCircle2} title="Submit outcome" small />
          <textarea rows={4} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="What did you find on attendance? e.g. Premises secure, false alarm — sensor fault suspected." style={{ ...selectStyle, resize: "vertical" }} />
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
            {photos.length < 4 && (
              <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ width: 84, height: 84, borderRadius: 6, border: "1px dashed var(--border)", background: "var(--panel)", color: "var(--text-dim)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: "pointer" }}>
                <Camera size={17} /><span style={{ fontSize: 10 }}>{busy ? "…" : "Add photo"}</span>
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={handleFiles} />
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>Photos are timestamped automatically on capture.</div>
          <button disabled={!outcome.trim()} onClick={submit} style={{ ...primaryBtn, width: "100%", marginTop: 16, justifyContent: "center", opacity: outcome.trim() ? 1 : 0.4 }}>
            <Send size={14} /> Mark offsite &amp; submit
          </button>
        </div>
      )}

      {submitted && (
        <div style={{ marginTop: 20, padding: 14, borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--ok)", fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}><CheckCircle2 size={14} /> Submitted — onsite {fmtTime(job.onsiteTime)}, offsite {fmtTime(job.offsiteTime)}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>{job.outcomeNotes}</div>
        </div>
      )}
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

function ManagerView({ session, accounts, setAccounts, zones, persistZones, sites, persistSites, roster, persistRoster, logoUrl, persistLogo, companyName, persistCompanyName, jobs, now }) {
  const [tab, setTab] = useState("accounts");
  return (
    <div style={{ display: "flex", minHeight: 560 }}>
      <div style={{ width: 168, borderRight: "1px solid var(--border)", background: "var(--panel)", padding: "16px 10px" }}>
        {[
          { id: "accounts", label: "Manage logins", icon: Users },
          { id: "sites", label: "Sites & runs", icon: MapPin },
          { id: "roster", label: "Roster", icon: CalendarDays },
          { id: "logs", label: "Logs & analysis", icon: BarChart3 },
        ].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", marginBottom: 4, borderRadius: 7, border: "none", cursor: "pointer", textAlign: "left", fontSize: 12.5, fontWeight: 600, background: tab === t.id ? "var(--accent-dim)" : "transparent", color: tab === t.id ? "var(--accent)" : "var(--text-dim)" }}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, padding: 20, overflowY: "auto" }}>
        {tab === "accounts" && <AccountsManager accounts={accounts} setAccounts={setAccounts} zones={zones} session={session} logoUrl={logoUrl} persistLogo={persistLogo} companyName={companyName} persistCompanyName={persistCompanyName} />}
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

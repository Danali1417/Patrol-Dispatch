import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Bell, Camera, CheckCircle2, AlertTriangle, Clock, LogOut, Mail,
  BarChart3, MapPin, KeyRound, Radio, ChevronRight, X, Copy, Send,
  ShieldAlert, ArrowLeft, Building2, Settings, Lock, Eye, EyeOff,
  Users, UserPlus, Power, Trash2, RotateCcw, Upload, Phone, CalendarDays, Ban
} from "lucide-react";

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

// Seeded only if no accounts exist yet in storage. From here on, only a Manager
// login can create/edit/deactivate logins via the "Manage logins" screen.
// NOTE: T99, T55 and T22 each appeared twice in the supplied run list (once
// as a night run, once as a day run) — the day versions were given a "Day"
// suffix below so login names stay unique. Rename any of these from the
// Manager screen if that's not what was intended.
const DEFAULT_ACCOUNTS = [
  { loginName: "Manager1", password: "manager123", role: "manager", displayName: "Duty Manager", active: true },
  { loginName: "ControlRoom1", password: "ops123", role: "operator", displayName: "Control Room 1", active: true },
  { loginName: "ControlRoom2", password: "ops123", role: "operator", displayName: "Control Room 2", active: true },
  { loginName: "T13", password: "patrol123", role: "patrolman", displayName: "T13", shift: "1800–0700", run: "Unassigned", active: true },
  { loginName: "T15", password: "patrol123", role: "patrolman", displayName: "T15", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T22", password: "patrol123", role: "patrolman", displayName: "T22", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T33", password: "patrol123", role: "patrolman", displayName: "T33", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T44", password: "patrol123", role: "patrolman", displayName: "T44", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T55", password: "patrol123", role: "patrolman", displayName: "T55", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T66", password: "patrol123", role: "patrolman", displayName: "T66", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T77", password: "patrol123", role: "patrolman", displayName: "T77", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T88", password: "patrol123", role: "patrolman", displayName: "T88", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T99", password: "patrol123", role: "patrolman", displayName: "T99", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "PST33", password: "patrol123", role: "patrolman", displayName: "PST33", shift: "1800–0600", run: "Unassigned", active: true },
  { loginName: "T77 Day", password: "patrol123", role: "patrolman", displayName: "T77 Day", shift: "0600–1700", run: "Unassigned", active: true },
  { loginName: "T88 Day", password: "patrol123", role: "patrolman", displayName: "T88 Day", shift: "0600–1700", run: "Unassigned", active: true },
  { loginName: "T99 Day", password: "patrol123", role: "patrolman", displayName: "T99 Day", shift: "0600–1700", run: "Unassigned", active: true },
  { loginName: "T55 Day", password: "patrol123", role: "patrolman", displayName: "T55 Day", shift: "0600–1600", run: "Unassigned", active: true },
  { loginName: "T22 Day", password: "patrol123", role: "patrolman", displayName: "T22 Day", shift: "0600–1700", run: "Unassigned", active: true },
];

const JOBS_KEY = "ops:jobs";
const ACCOUNTS_KEY = "ops:accounts";
const ZONES_KEY = "ops:zones";
const SITES_KEY = "ops:sites";
const ROSTER_KEY = "ops:roster";
const LOGO_KEY = "ops:logo";

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

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
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
  const [session, setSession] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [zones, setZones] = useState([]);
  const [sites, setSites] = useState([]);
  const [sitesLoaded, setSitesLoaded] = useState(false);
  const [roster, setRoster] = useState([]);
  const [logoUrl, setLogoUrl] = useState("");
  const [now, setNow] = useState(Date.now());
  const [banner, setBanner] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [autoLoggedOut, setAutoLoggedOut] = useState(false);
  const prevJobsRef = useRef([]);
  const lastActivityRef = useRef(Date.now());

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
        setSession(null);
        setAutoLoggedOut(true);
      }
    }, 30000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, markActivity));
      clearInterval(check);
    };
  }, [session]);

  // Load jobs
  useEffect(() => {
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
  }, []);

  // Load accounts, seeding DEFAULT_ACCOUNTS only on a genuinely empty store
  // (first-ever run). Once real data exists, it's authoritative — a login
  // a Manager deletes must stay deleted, even if it happens to share a name
  // with one of the built-in demo accounts.
  useEffect(() => {
    (async () => {
      let existing = [];
      try {
        const res = await window.storage.get(ACCOUNTS_KEY, true);
        if (res && res.value) existing = JSON.parse(res.value);
      } catch (e) { /* nothing stored yet */ }

      if (existing.length === 0) {
        existing = DEFAULT_ACCOUNTS;
        try { await window.storage.set(ACCOUNTS_KEY, JSON.stringify(existing), true); } catch (e) { /* ignore */ }
      }

      setAccounts(existing);
      setAccountsLoaded(true);
    })();
  }, []);

  // Load or seed zones & sites (runs are named by the manager; sites are
  // demo data on first run, editable afterwards from Manager > Sites & runs)
  useEffect(() => {
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
  }, []);

  // Load roster (dated run assignments — separate from a login's "current" run)
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(ROSTER_KEY, true);
        if (res && res.value) setRoster(JSON.parse(res.value));
      } catch (e) { /* nothing stored yet */ }
    })();
  }, []);

  // Load company logo (uploaded by a Manager, shown on every login type)
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(LOGO_KEY, true);
        if (res && res.value) setLogoUrl(res.value);
      } catch (e) { /* nothing stored yet */ }
    })();
  }, []);

  const persistJobs = useCallback(async (updated) => {
    setJobs(updated);
    prevJobsRef.current = updated;
    try { await window.storage.set(JOBS_KEY, JSON.stringify(updated), true); } catch (e) { console.error(e); }
  }, []);

  const persistAccounts = useCallback(async (updated) => {
    setAccounts(updated);
    try { await window.storage.set(ACCOUNTS_KEY, JSON.stringify(updated), true); } catch (e) { console.error(e); }
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
      <Shell>
        <Login
          accounts={accounts}
          accountsLoaded={accountsLoaded}
          autoLoggedOut={autoLoggedOut}
          logoUrl={logoUrl}
          onLogin={(s) => { setSession(s); setAutoLoggedOut(false); }}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <TopBar session={session} onSignOut={() => setSession(null)} onOpenSettings={() => setShowSettings(true)} now={now} logoUrl={logoUrl} />
      {banner && <NotifBanner banner={banner} onDismiss={() => setBanner(null)} />}
      {showSettings && (
        <SettingsModal session={session} accounts={accounts} persistAccounts={persistAccounts} onClose={() => setShowSettings(false)} />
      )}
      {!accountsLoaded || !sitesLoaded ? (
        <div style={{ padding: 40, color: "var(--text-dim)" }}>Loading dispatch board…</div>
      ) : session.role === "manager" ? (
        <ManagerView session={session} accounts={accounts} persistAccounts={persistAccounts} zones={zones} persistZones={persistZones} sites={sites} persistSites={persistSites} roster={roster} persistRoster={persistRoster} logoUrl={logoUrl} persistLogo={persistLogo} jobs={jobs} now={now} />
      ) : session.role === "operator" ? (
        <OperatorView session={session} jobs={jobs} accounts={accounts} sites={sites} persistSites={persistSites} zones={zones} roster={roster} persistRoster={persistRoster} persist={persistJobs} now={now} />
      ) : (
        <PatrolmanView session={session} jobs={jobs} persist={persistJobs} now={now} />
      )}
    </Shell>
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

function Login({ accounts, accountsLoaded, autoLoggedOut, logoUrl, onLogin }) {
  const [role, setRole] = useState(null);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const loginNameRef = useRef(null);
  const passwordRef = useRef(null);

  function submit() {
    setError("");
    const loginName = (loginNameRef.current?.value || "").trim();
    const password = passwordRef.current?.value || "";
    if (!loginName || !password) { setError("Enter a login name and password."); return; }
    if (!accountsLoaded) { setError("Still loading accounts — wait a moment and try again."); return; }
    const byName = accounts.find(
      (a) => a.role === role && a.loginName.toLowerCase() === loginName.toLowerCase()
    );
    if (!byName) { setError(`No ${role} login named "${loginName}" was found.`); return; }
    if (byName.password !== password) { setError("Password doesn't match that login name."); return; }
    if (byName.active === false) { setError("This login has been deactivated. See your manager."); return; }
    onLogin({ ...byName, id: byName.loginName });
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") submit();
  }

  if (!role) {
    return (
      <div style={{ padding: "48px 32px", maxWidth: 380, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}><Logo src={logoUrl} /></div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", textAlign: "center", marginBottom: 32 }}>
          Alarm response dispatch — choose your sign-in
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
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}><Logo src={logoUrl} /></div>
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

        <button type="button" onClick={submit} style={{ width: "100%", padding: "12px 0", borderRadius: 7, border: "none", background: "var(--accent)", color: "#0B0E11", fontWeight: 700, cursor: "pointer", fontSize: 13.5 }}>
          Sign in
        </button>
      </div>

      <div style={{ marginTop: 16, padding: 12, borderRadius: 7, background: "var(--panel)", border: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        Forgotten your password? Ask your Manager to look it up or reset it from Manage logins. Use the settings icon (top right) after signing in to change it yourself.
      </div>

      <div style={{ marginTop: 10, fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--mono)", textAlign: "center" }}>
        {accountsLoaded
          ? `${accounts.length} account(s) loaded · ${accounts.filter((a) => a.role === "manager").length} manager, ${accounts.filter((a) => a.role === "operator").length} control room, ${accounts.filter((a) => a.role === "patrolman").length} patrolman`
          : "Loading accounts…"}
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

function TopBar({ session, onSignOut, onOpenSettings, now, logoUrl }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
      <Logo src={logoUrl} />
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

function SettingsModal({ session, accounts, persistAccounts, onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  function submit() {
    setError("");
    const account = accounts.find((a) => a.loginName === session.loginName && a.role === session.role);
    if (!account || account.password !== current) { setError("Current password is incorrect."); return; }
    if (next.length < 4) { setError("New password must be at least 4 characters."); return; }
    if (next !== confirm) { setError("New passwords don't match."); return; }
    const updated = accounts.map((a) => (a.loginName === session.loginName && a.role === session.role ? { ...a, password: next } : a));
    persistAccounts(updated);
    setDone(true);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, width: 340, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <SectionTitle icon={Lock} title="Change password" small />
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}><X size={16} /></button>
        </div>
        {done ? (
          <div style={{ color: "var(--ok)", fontSize: 13, display: "flex", alignItems: "center", gap: 7 }}>
            <CheckCircle2 size={15} /> Password updated.
          </div>
        ) : (
          <div>
            <Field label="Current password"><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} style={selectStyle} /></Field>
            <Field label="New password"><input type="password" value={next} onChange={(e) => setNext(e.target.value)} style={selectStyle} /></Field>
            <Field label="Confirm new password"><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={selectStyle} /></Field>
            {error && <div style={{ color: "var(--breach)", fontSize: 12, marginBottom: 10 }}>{error}</div>}
            <button type="button" onClick={submit} style={{ ...primaryBtn, width: "100%", justifyContent: "center" }}>Update password</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   STATUS BADGES
---------------------------------------------------------------- */

const STATUS_META = {
  dispatched: { label: "Dispatched", color: "var(--info)" },
  submitted: { label: "Awaiting review", color: "var(--warn)" },
  reviewed: { label: "Reviewed", color: "#7C3AED" },
  emailed: { label: "Sent to client", color: "var(--ok)" },
  cancelled: { label: "Cancelled", color: "var(--text-dim)" },
};

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

function OperatorView({ session, jobs, accounts, sites, persistSites, zones, roster, persistRoster, persist, now }) {
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
          <JobDetailOperator job={selected} jobs={jobs} patrolmen={patrolmen} persist={persist} now={now} session={session} onBack={() => setSelectedId(null)} />
        )}
        {tab === "new" && <NewJobForm jobs={jobs} sites={sites} persistSites={persistSites} zones={zones} patrolmen={patrolmen} roster={roster} session={session} persist={persist} onCreated={(id) => { setTab("board"); setSelectedId(id); }} />}
        {tab === "roster" && <RosterView zones={zones} accounts={accounts} roster={roster} persistRoster={persistRoster} />}
        {tab === "logs" && <Logs jobs={jobs} now={now} />}
      </div>
    </div>
  );
}

function Board({ jobs, now, onSelect }) {
  const groups = [
    { key: "dispatched", title: "Out with patrolmen" },
    { key: "submitted", title: "Awaiting your review" },
    { key: "reviewed", title: "Reviewed — ready to send" },
    { key: "emailed", title: "Closed out" },
    { key: "cancelled", title: "Cancelled / stood down" },
  ];
  if (jobs.length === 0) return <Empty text="No jobs dispatched yet. Use “New job” to send the first alarm response." />;
  return (
    <div>
      {groups.map((g) => {
        const list = jobs.filter((j) => j.status === g.key).sort((a, b) => new Date(b.dispatchTime) - new Date(a.dispatchTime));
        if (!list.length) return null;
        return (
          <div key={g.key} style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)", marginBottom: 8 }}>{g.title} ({list.length})</div>
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
      <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)", width: 76 }}>{job.jobNumber}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.siteName}</div>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>{job.run} · {job.monitoringCo} · assigned {job.assigneeName}{job.handlingName ? ` · handled by ${job.handlingName}` : ""}</div>
      </div>
      {job.delayReason && <span title={job.delayReason}><AlertTriangle size={14} color="var(--warn)" /></span>}
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

  const canDispatch = site && description.trim() && assigneeId && jobNumber.trim();

  async function dispatch() {
    const assignee = patrolmen.find((r) => r.loginName === assigneeId);
    const job = {
      id: `job_${Date.now()}`,
      jobNumber: jobNumber.trim(),
      siteId: site.id,
      siteName: site.name,
      address: site.address,
      run: site.run,
      monitoringCo: site.monitoringCo,
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
      photos: [],
      onsiteTime: null,
      offsiteTime: null,
      delayReason: null,
      reviewNotes: "",
      emailedAt: null,
    };
    await persist([...jobs, job]);
    setSiteId(""); setSiteQuery(""); setDescription(""); setAssigneeId(""); setKeyInfo(""); setAlarmCode("");
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

      <Field label="Job number">
        <input value={jobNumber} onChange={(e) => setJobNumber(e.target.value)} placeholder="e.g. the monitoring company's reference number" style={selectStyle} />
      </Field>

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
  const blank = { name: initialName, address: "", poNumber: "", monitoringCo: "", bureau: "", run: zones[0] || "Unassigned" };
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
      {error && <div style={{ color: "var(--breach)", fontSize: 12, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={save} style={secondaryBtn}><MapPin size={13} /> Save site</button>
        <button onClick={onCancel} style={iconBtn}><X size={13} /></button>
      </div>
    </div>
  );
}

/* ---------------------- Operator job detail ---------------------- */

function JobDetailOperator({ job, jobs, patrolmen, session, persist, now, onBack }) {
  const [notes, setNotes] = useState(job.reviewNotes || job.outcomeNotes);
  const [delayText, setDelayText] = useState("");
  const [showEmail, setShowEmail] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  useEffect(() => setNotes(job.reviewNotes || job.outcomeNotes), [job.id]);

  const t = jobTiming(job, now);

  function update(patch) {
    const updated = jobs.map((j) => (j.id === job.id ? { ...j, ...patch } : j));
    persist(updated);
  }

  function reassign(loginName) {
    const p = patrolmen.find((a) => a.loginName === loginName);
    if (!p) return;
    update({ assigneeId: p.loginName, assigneeName: p.displayName });
  }

  function confirmCancel() {
    update({ status: "cancelled", cancelReason: cancelReason.trim(), cancelledAt: new Date().toISOString() });
    setShowCancelForm(false);
  }

  function takeJob() {
    update({ handlingLoginName: session.loginName, handlingName: session.displayName });
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
            {job.status === "emailed" && <span style={{ color: "var(--ok)", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}><CheckCircle2 size={14} /> Sent to client {fmtDateTime(job.emailedAt)}</span>}
          </div>
        </div>
      )}

      {showEmail && (
        <EmailModal job={{ ...job, reviewNotes: notes }} onClose={() => setShowEmail(false)} onSent={() => { update({ status: "emailed", emailedAt: new Date().toISOString(), reviewNotes: notes }); setShowEmail(false); }} />
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

function EmailModal({ job, onClose, onSent }) {
  const text = `To: ${job.monitoringCo}
Subject: Alarm Response Outcome — ${job.jobNumber} — ${job.siteName}

Job number: ${job.jobNumber}
Site: ${job.siteName}
Address: ${job.address}
Alarm description: ${job.description}
Patrolman: ${job.assigneeName}
Dispatched: ${fmtDateTime(job.dispatchTime)}
Onsite: ${fmtDateTime(job.onsiteTime)}
Offsite: ${fmtDateTime(job.offsiteTime)}
${job.delayReason ? `Delay advised: ${job.delayReason}\n` : ""}
Outcome:
${job.reviewNotes}

${job.photos?.length ? `${job.photos.length} time-stamped photo(s) attached.` : "No photos attached."}
`;
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, width: 480, maxWidth: "90%", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <SectionTitle icon={Mail} title="Client email preview" small />
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}><X size={16} /></button>
        </div>
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: 11.5, background: "var(--panel-alt)", padding: 12, borderRadius: 7, maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)" }}>{text}</pre>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button onClick={() => navigator.clipboard?.writeText(text)} style={secondaryBtn}><Copy size={13} /> Copy</button>
          <button onClick={onSent} style={{ ...primaryBtn, flex: 1, justifyContent: "center" }}><Send size={13} /> Mark as sent to client</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------- Logs ---------------------- */

function Logs({ jobs, now }) {
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
  const [photos, setPhotos] = useState(job.photos || []);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
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

  async function markOnsite() {
    const updated = jobs.map((j) => (j.id === job.id ? { ...j, onsiteTime: new Date().toISOString() } : j));
    await persist(updated);
  }

  async function submit() {
    const updated = jobs.map((j) => (j.id === job.id ? { ...j, status: "submitted", outcomeNotes: outcome.trim(), photos, offsiteTime: new Date().toISOString() } : j));
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

function ManagerView({ session, accounts, persistAccounts, zones, persistZones, sites, persistSites, roster, persistRoster, logoUrl, persistLogo, jobs, now }) {
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
        {tab === "accounts" && <AccountsManager accounts={accounts} persistAccounts={persistAccounts} zones={zones} session={session} logoUrl={logoUrl} persistLogo={persistLogo} />}
        {tab === "sites" && <SitesManager zones={zones} persistZones={persistZones} sites={sites} persistSites={persistSites} accounts={accounts} persistAccounts={persistAccounts} />}
        {tab === "roster" && <RosterView zones={zones} accounts={accounts} roster={roster} persistRoster={persistRoster} />}
        {tab === "logs" && <Logs jobs={jobs} now={now} />}
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

function PatrolmanRosterImport({ accounts, persistAccounts, zones }) {
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
          if (Object.keys(patch).length) { working[existingIdx] = { ...working[existingIdx], ...patch }; updated++; }
        } else {
          const slug = name.replace(/[^a-zA-Z0-9]/g, "") || "Patrolman";
          let loginName = slug;
          let n = 2;
          while (existingLoginNames.has(loginName.toLowerCase())) { loginName = `${slug}${n}`; n++; }
          existingLoginNames.add(loginName.toLowerCase());
          working.push({
            loginName,
            password: "patrol123",
            role: "patrolman",
            displayName: name,
            run: run || "Unassigned",
            shift: "",
            contactNumber,
            active: true,
          });
          created++;
        }
      });

      if (updated || created) persistAccounts(working);
      setResult({ updated, created, runNotRecognized, skippedMissing, total: rows.length });
    } catch (err) {
      setError("Couldn't read that file — make sure it's a valid .xlsx, .xls, or .csv export.");
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

function LogoUploader({ logoUrl, persistLogo }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const dataUrl = await resizeLogo(file);
      await persistLogo(dataUrl);
    } catch (err) {
      setError("Couldn't read that image — try a different file.");
    }
    setBusy(false);
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
        {logoUrl && <button onClick={() => persistLogo("")} title="Remove logo" style={iconBtn}><X size={13} /></button>}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
      </div>
      {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function AccountsManager({ accounts, persistAccounts, zones, session, logoUrl, persistLogo }) {
  const [role, setRole] = useState("patrolman");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [shift, setShift] = useState("");
  const [run, setRun] = useState("Unassigned");
  const [contactNumber, setContactNumber] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  function createAccount() {
    setError(""); setSuccess("");
    const name = loginName.trim();
    if (!name || !password) { setError("Login name and password are required."); return; }
    if (accounts.some((a) => a.loginName.toLowerCase() === name.toLowerCase())) { setError("That login name is already in use — pick a unique one."); return; }
    const acct = { loginName: name, password, role, displayName: displayName.trim() || name, active: true, contactNumber: contactNumber.trim() };
    if (role === "patrolman") { acct.shift = shift.trim(); acct.run = run; }
    persistAccounts([...accounts, acct]);
    setSuccess(`Login "${name}" created.`);
    setLoginName(""); setPassword(""); setDisplayName(""); setShift(""); setRun("Unassigned"); setContactNumber("");
  }

  const groups = [
    { key: "manager", title: "Managers" },
    { key: "operator", title: "Control Room" },
    { key: "patrolman", title: "Patrolmen" },
  ];

  return (
    <div>
      <LogoUploader logoUrl={logoUrl} persistLogo={persistLogo} />

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
        {success && <div style={{ color: "var(--ok)", fontSize: 12, marginBottom: 10 }}>{success}</div>}

        <button onClick={createAccount} style={primaryBtn}><UserPlus size={14} /> Create login</button>
      </div>

      <PatrolmanRosterImport accounts={accounts} persistAccounts={persistAccounts} zones={zones} />

      <SectionTitle icon={Users} title="Existing logins" />
      {groups.map((g) => {
        const list = accounts.filter((a) => a.role === g.key);
        if (!list.length) return null;
        return (
          <div key={g.key} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)", marginBottom: 8 }}>{g.title} ({list.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {list.map((a) => (
                <AccountRow key={a.role + a.loginName} account={a} accounts={accounts} persistAccounts={persistAccounts} zones={zones} isSelf={a.loginName === session.loginName && a.role === session.role} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AccountRow({ account, accounts, persistAccounts, zones, isSelf }) {
  const [editingPw, setEditingPw] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [editingContact, setEditingContact] = useState(false);
  const [newContact, setNewContact] = useState(account.contactNumber || "");
  const [showSendLogin, setShowSendLogin] = useState(false);
  const [copied, setCopied] = useState(false);

  function update(patch) {
    persistAccounts(accounts.map((a) => (a.loginName === account.loginName && a.role === account.role ? { ...a, ...patch } : a)));
  }

  function remove() {
    if (isSelf) { window.alert("You can't delete the login you're currently signed in with."); return; }
    if (window.confirm(`Delete login "${account.loginName}"? This can't be undone.`)) {
      persistAccounts(accounts.filter((a) => !(a.loginName === account.loginName && a.role === account.role)));
    }
  }

  const inactive = account.active === false;

  const loginMessage = `Your Alarm Response Dispatch login\n\nLogin name: ${account.loginName}\nPassword: ${account.password}\n\nSign in at: ${window.location.origin}`;
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
        <button onClick={() => update({ active: inactive ? true : false })} title={inactive ? "Reactivate login" : "Deactivate login"} style={iconBtn}>
          <Power size={13} color={inactive ? "var(--ok)" : "var(--text-dim)"} />
        </button>
        <button onClick={() => { setNewPw(account.password || ""); setShowPw(false); setEditingPw((v) => !v); }} title="View / change password" style={iconBtn}><RotateCcw size={13} /></button>
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
            onClick={() => { update({ contactNumber: newContact.trim() }); setEditingContact(false); }}
            style={secondaryBtn}
          >
            Save
          </button>
        </div>
      )}
      {editingPw && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <div style={{ position: "relative", flex: 1 }}>
            <input
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              type={showPw ? "text" : "password"}
              placeholder="Password (min 4 chars)"
              style={{ ...selectStyle, fontSize: 12, paddingRight: 30 }}
            />
            <button type="button" onClick={() => setShowPw((v) => !v)} title={showPw ? "Hide password" : "Show password"} style={{ position: "absolute", right: 6, top: 6, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}>
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            onClick={() => { if (newPw.length >= 4) { update({ password: newPw }); setEditingPw(false); } }}
            style={secondaryBtn}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   SITES & RUNS MANAGER
---------------------------------------------------------------- */

function SitesManager({ zones, persistZones, sites, persistSites, accounts, persistAccounts }) {
  return (
    <div>
      <ZonesEditor zones={zones} persistZones={persistZones} sites={sites} persistSites={persistSites} accounts={accounts} persistAccounts={persistAccounts} />
      <div style={{ height: 30 }} />
      <SitesEditor zones={zones} sites={sites} persistSites={persistSites} />
    </div>
  );
}

function ZonesEditor({ zones, persistZones, sites, persistSites, accounts, persistAccounts }) {
  const [newZone, setNewZone] = useState("");
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState(null); // zone name currently being renamed
  const [renameValue, setRenameValue] = useState("");

  function addZone() {
    setError("");
    const name = newZone.trim();
    if (!name) return;
    if (zones.some((z) => z.toLowerCase() === name.toLowerCase())) { setError("That run name already exists."); return; }
    persistZones([...zones, name]);
    setNewZone("");
  }

  function startRename(z) { setRenaming(z); setRenameValue(z); }

  function saveRename() {
    const oldName = renaming;
    const newName = renameValue.trim();
    if (!newName || newName === oldName) { setRenaming(null); return; }
    if (zones.some((z) => z.toLowerCase() === newName.toLowerCase() && z !== oldName)) { setError("That run name already exists."); return; }
    persistZones(zones.map((z) => (z === oldName ? newName : z)));
    persistSites(sites.map((s) => (s.run === oldName ? { ...s, run: newName } : s)));
    persistAccounts(accounts.map((a) => (a.role === "patrolman" && a.run === oldName ? { ...a, run: newName } : a)));
    setRenaming(null);
    setError("");
  }

  function removeZone(z) {
    const siteCount = sites.filter((s) => s.run === z).length;
    const patrolCount = accounts.filter((a) => a.role === "patrolman" && a.run === z).length;
    const msg = siteCount || patrolCount
      ? `"${z}" is used by ${siteCount} site(s) and ${patrolCount} patrolman login(s). Delete anyway? They'll be set to Unassigned.`
      : `Delete run "${z}"?`;
    if (!window.confirm(msg)) return;
    persistZones(zones.filter((r) => r !== z));
    if (siteCount) persistSites(sites.map((s) => (s.run === z ? { ...s, run: "Unassigned" } : s)));
    if (patrolCount) persistAccounts(accounts.map((a) => (a.role === "patrolman" && a.run === z ? { ...a, run: "Unassigned" } : a)));
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
  const blank = { name: "", address: "", run: zones[0] || "Unassigned", monitoringCo: "", bureau: "", poNumber: "", keyInfo: "", siteNotes: "", siteContact: "", alarmCode: "" };
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  function set(field, value) { setForm((f) => ({ ...f, [field]: value })); }

  function startEdit(site) { setEditingId(site.id); setForm({ ...blank, ...site }); }
  function cancelEdit() { setEditingId(null); setForm(blank); setError(""); }

  function save() {
    setError("");
    if (!form.name.trim() || !form.address.trim()) { setError("Site name and address are required."); return; }
    if (editingId) {
      persistSites(sites.map((s) => (s.id === editingId ? { ...form, id: editingId } : s)));
    } else {
      persistSites([...sites, { ...form, id: `site_${Date.now()}` }]);
    }
    cancelEdit();
  }

  function remove(id) {
    if (window.confirm("Delete this site? Past jobs already dispatched to it keep their own record.")) {
      persistSites(sites.filter((s) => s.id !== id));
      if (editingId === id) cancelEdit();
    }
  }

  function clearAll() {
    if (window.confirm(`Delete all ${sites.length} site(s)? This can't be undone — past jobs already dispatched keep their own record, but the site list will be empty.`)) {
      persistSites([]);
      cancelEdit();
    }
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
    } else {
      persistRoster([...roster, { ...entry, id: `roster_${Date.now()}` }]);
    }
    cancelEdit();
  }

  function remove(id) {
    if (window.confirm("Remove this roster entry?")) {
      persistRoster(roster.filter((r) => r.id !== id));
      if (editingId === id) cancelEdit();
    }
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

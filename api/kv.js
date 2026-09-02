// Authenticated proxy for the app's general-purpose data (jobs, sites,
// zones, roster, logo, company name). Replaces the client's former direct
// access to Supabase — every read and write now requires a valid session,
// except the two keys shown on the sign-in screen before anyone has
// logged in (logo, company name), which are readable by anyone but only
// writable by a Manager.
//
// Also handles live patrolman-location keys (ops:liveloc:<loginName>) as
// a special case: each patrolman gets their own key, upserted every time
// they report a new position, and DELETEd when they stop sharing — kept
// separate from the single-JSON-blob keys above so many patrolmen
// reporting concurrently never race each other's writes the way one
// shared array would (see the reassignment race fixed earlier). A
// patrolman may only read/write/delete their own key; Control Room and
// Manager can bulk-read all of them via ?prefix=ops:liveloc:.

import { requireRole, requireSession } from "./_lib/auth.js";
import { kvGet, kvSet, kvGetPrefix, kvQueryPrefix, kvDelete, kvDeletePrefix } from "./_lib/supabase.js";
import { sendPushToRole, sendPushToPatrolman } from "./_lib/push.js";
import { JOB_ARCHIVE_PREFIX, JOB_PHOTOS_PREFIX, JOB_CHAT_PREFIX } from "./_lib/jobArchive.js";

const PUBLIC_READ_KEYS = new Set(["ops:logo", "ops:companyName"]);
// Only a manager edits the Monitoring/Bureau master lists (Manager >
// Monitoring & Bureau) — Control Room only reads them (for the New Site
// dropdown) and never writes, so these sit alongside ops:outcomePhrases,
// not ops:sites.
const MANAGER_ONLY_WRITE_KEYS = new Set(["ops:logo", "ops:companyName", "ops:outcomePhrases", "ops:monitoringCompanies", "ops:bureaus"]);
const OPERATOR_UP_WRITE_KEYS = new Set(["ops:sites", "ops:zones", "ops:roster", "ops:operatorSessions"]);
// ops:operatorSessions (Manager > Operator Activity) needs read-modify-write
// from an operator's own session (to log its own presence) as well as read
// access from a manager (to view the report), so it sits at the same
// any-authenticated-session read tier as ops:sites/ops:roster rather than
// being manager-only-read — the UI only surfaces it on the Manager tab.
const KNOWN_KEYS = new Set(["ops:jobs", "ops:sites", "ops:zones", "ops:roster", "ops:logo", "ops:companyName", "ops:outcomePhrases", "ops:monitoringCompanies", "ops:bureaus", "ops:operatorSessions"]);

const LIVELOC_PREFIX = "ops:liveloc:";
const STATIONARY_RADIUS_M = 50; // GPS jitter tolerance — "hasn't left this spot"
const STATIONARY_ALERT_MS = 30 * 60 * 1000;

const JOBS_KEY = "ops:jobs";
const OPERATOR_SESSIONS_KEY = "ops:operatorSessions";

// Best-effort "how recently was this job touched" — the max timestamp
// found anywhere on it (every ISO-ish string field, plus activityLog and
// standDowns entries). Not every mutation logs an activity entry (e.g.
// the patrolman's markOnsite/submit actions don't), so this can't just
// use activityLog length; scanning every timestamp-shaped field instead
// means any current or future timestamp field is picked up automatically.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
function latestTouch(job) {
  let latest = 0;
  for (const [k, v] of Object.entries(job)) {
    if (k === "activityLog" || k === "standDowns") continue;
    if (typeof v === "string" && ISO_DATE_RE.test(v)) {
      const t = Date.parse(v);
      if (t > latest) latest = t;
    }
  }
  for (const entry of job.activityLog || []) {
    const t = entry?.ts ? Date.parse(entry.ts) : NaN;
    if (t > latest) latest = t;
  }
  for (const sd of job.standDowns || []) {
    const t = Math.max(Date.parse(sd?.notifiedAt || 0) || 0, Date.parse(sd?.acknowledgedAt || 0) || 0);
    if (t > latest) latest = t;
  }
  return latest;
}

// Every write to ops:jobs is computed client-side from whatever that
// device last polled (up to 8s stale) and sent as a full replacement
// array — a plain overwrite here would let two concurrent writes (two
// operators, or the same operator in two tabs) race: whichever's stale
// snapshot omitted the other's very recent change wins and silently
// erases it. This is the same class of bug already fixed for live
// patrolman locations by splitting them into per-patrolman keys (see the
// module comment above) — ops:jobs can't be split the same way since the
// board needs it as one list, so instead:
//   - any job id the incoming write doesn't even mention is assumed to
//     belong to a concurrent write that landed since this client's last
//     poll, and is carried forward rather than dropped;
//   - for a job id present on BOTH sides, whichever copy was touched more
//     recently wins — almost always the incoming one (this write's own
//     change just stamped a fresh timestamp), unless incoming is only
//     carrying that job along unchanged from a stale base, in which case
//     blindly taking it would silently revert a more recent change made
//     elsewhere (e.g. a job a patrolman just closed reverting back to
//     "dispatched" because an unrelated, slightly-stale write elsewhere
//     still had the old pre-close copy).
// An empty array is always honored as-is — the one deliberate way this
// array is meant to shrink (see handleResetJobs in App.jsx).
async function mergeJobsWrite(incomingJson) {
  let incoming;
  try {
    incoming = JSON.parse(incomingJson);
  } catch (e) {
    throw new Error("Malformed jobs payload");
  }
  if (!Array.isArray(incoming) || incoming.length === 0) {
    await kvSet(JOBS_KEY, incomingJson);
    return incomingJson;
  }

  const currentRaw = await kvGet(JOBS_KEY);
  const current = currentRaw ? JSON.parse(currentRaw) : [];
  const currentById = new Map(current.map((j) => [j.id, j]));
  const incomingIds = new Set(incoming.map((j) => j.id));

  const reconciled = incoming.map((j) => {
    const theirs = currentById.get(j.id);
    if (!theirs) return j; // genuinely new — nothing to compare against
    return latestTouch(theirs) > latestTouch(j) ? theirs : j;
  });
  const missingFromIncoming = current.filter((j) => !incomingIds.has(j.id));
  const merged = missingFromIncoming.length ? [...reconciled, ...missingFromIncoming] : reconciled;
  const mergedJson = JSON.stringify(merged);
  await kvSet(JOBS_KEY, mergedJson);
  return mergedJson;
}

// Same concurrent-write race as ops:jobs, on a busy shift with several
// Control Room tabs all writing this one shared array at once (a session
// start on sign-in, a heartbeat every 25s per tab, an end on sign-out) —
// a plain whole-array overwrite could and did silently drop someone's
// newly-started session when two writes landed close together. Simpler
// than the jobs merge though: each record is owned by exactly one sid
// (only that browser tab's own start/heartbeat/end calls ever touch it),
// so there's no same-record conflict to resolve — a write's own sid
// always wins over whatever's currently stored for it, and any other sid
// present in current storage but missing from this write's payload
// (another tab's session, added or updated after this client's own last
// read) is kept rather than dropped. 90-day pruning happens here, once,
// on the merged result, instead of relying on every client's own local
// filter to agree.
async function mergeOperatorSessionsWrite(incomingJson) {
  let incoming;
  try {
    incoming = JSON.parse(incomingJson);
  } catch (e) {
    throw new Error("Malformed operator sessions payload");
  }
  if (!Array.isArray(incoming)) {
    await kvSet(OPERATOR_SESSIONS_KEY, incomingJson);
    return incomingJson;
  }

  const currentRaw = await kvGet(OPERATOR_SESSIONS_KEY);
  const current = currentRaw ? JSON.parse(currentRaw) : [];
  const bySid = new Map(current.map((s) => [s.sid, s]));

  // Timestamps are stamped here, with the server's own clock, rather than
  // trusted from whichever device's browser reported them — a phone or
  // tablet with a wrong clock (bad timezone, no time sync, dead CMOS
  // battery) would otherwise make a perfectly healthy session look
  // permanently stale to "Live now" (compared against the viewing
  // manager's own device clock) while its own start-to-end duration still
  // adds up fine, since that math never leaves the one skewed clock. One
  // clock for every record removes that mismatch entirely.
  const serverNowMs = Date.now();
  const serverNow = new Date(serverNowMs).toISOString();
  for (const s of incoming) {
    const existing = bySid.get(s.sid);
    // idleForMs is how long that tab's own clock says it's been since real
    // user activity — a relative duration, not an absolute timestamp, so
    // (unlike lastSeenAt above) it's safe to trust from the client: a
    // skewed device clock cancels out of a same-device delta. Anchoring it
    // to the server's own "now" here, the same way lastSeenAt is stamped,
    // keeps the derived lastActiveAt on the one clock every other
    // timestamp on this record already uses.
    const idleForMs = typeof s.idleForMs === "number" && s.idleForMs >= 0 ? s.idleForMs : 0;
    bySid.set(s.sid, {
      sid: s.sid,
      loginName: s.loginName,
      displayName: s.displayName,
      startedAt: existing ? existing.startedAt : serverNow,
      lastSeenAt: serverNow,
      endedAt: s.endedAt ? serverNow : null,
      lastActiveAt: new Date(serverNowMs - idleForMs).toISOString(),
    });
  }

  const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const merged = [...bySid.values()].filter((s) => new Date(s.startedAt).getTime() >= cutoffMs);
  const mergedJson = JSON.stringify(merged);
  await kvSet(OPERATOR_SESSIONS_KEY, mergedJson);
  return mergedJson;
}

// Attendance photos live in their own per-job key instead of embedded in
// the job record, so the board's every-4-second poll (every signed-in
// device, all day) never has to move photo bytes — only the small job
// fields it actually needs to render the list. Older jobs saved before
// this split still have photos embedded; migrateEmbeddedPhotos() moves
// them out the first time ops:jobs is read after deploy and is a no-op
// on every read after that (nothing left to migrate).
async function migrateEmbeddedPhotos(rawJobsJson) {
  let jobs;
  try { jobs = JSON.parse(rawJobsJson); } catch (e) { return rawJobsJson; }
  if (!Array.isArray(jobs)) return rawJobsJson;
  const withPhotos = jobs.filter((j) => Array.isArray(j.photos) && j.photos.length > 0);
  if (withPhotos.length === 0) return rawJobsJson;

  for (const j of withPhotos) {
    await kvSet(`${JOB_PHOTOS_PREFIX}${j.id}`, JSON.stringify(j.photos));
  }
  const slimmed = jobs.map((j) => {
    if (!Array.isArray(j.photos) || j.photos.length === 0) return j;
    const { photos, ...rest } = j;
    return { ...rest, photoCount: photos.length };
  });
  const slimmedJson = JSON.stringify(slimmed);
  await kvSet(JOBS_KEY, slimmedJson);
  return slimmedJson;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Tracks how long a patrolman has stayed within STATIONARY_RADIUS_M of an
// anchor point, carried forward on the same live-location record (still
// just current state, never a growing history) — resets the anchor the
// moment they move away from it. Pushes Control Room once when the 30-min
// mark is first crossed, then again every 30 min while still stationary.
async function applyStationaryTracking(key, incoming) {
  let prev = null;
  try {
    const prevRaw = await kvGet(key);
    prev = prevRaw ? JSON.parse(prevRaw) : null;
  } catch (e) { /* treat as no prior state */ }

  let stationaryLat = incoming.lat;
  let stationaryLon = incoming.lon;
  let stationarySince = incoming.ts;
  let lastAlertedAt = null;

  if (prev && typeof prev.stationaryLat === "number") {
    const dist = haversineMeters(prev.stationaryLat, prev.stationaryLon, incoming.lat, incoming.lon);
    if (dist <= STATIONARY_RADIUS_M) {
      stationaryLat = prev.stationaryLat;
      stationaryLon = prev.stationaryLon;
      stationarySince = prev.stationarySince;
      lastAlertedAt = prev.lastAlertedAt || null;
    }
  }

  const stationaryMs = incoming.ts - stationarySince;
  let shouldAlert = false;
  if (stationaryMs >= STATIONARY_ALERT_MS && (!lastAlertedAt || incoming.ts - lastAlertedAt >= STATIONARY_ALERT_MS)) {
    shouldAlert = true;
    lastAlertedAt = incoming.ts;
  }

  const enriched = { lat: incoming.lat, lon: incoming.lon, ts: incoming.ts, stationaryLat, stationaryLon, stationarySince, lastAlertedAt };
  await kvSet(key, JSON.stringify(enriched));

  if (shouldAlert) {
    const patrolmanLoginName = key.slice(LIVELOC_PREFIX.length);
    const minutes = Math.round(stationaryMs / 60000);
    sendPushToRole("operator", {
      title: "Patrolman stationary",
      body: `${patrolmanLoginName} hasn't moved in about ${minutes} min.`,
      url: "/",
    }).catch(() => { /* best-effort — in-app map badge covers this too */ });
  }

  return enriched;
}

// Looks up which job this message belongs to (for its jobNumber and who's
// assigned) and pushes a notification to whoever's on the other side of
// the conversation — the assigned patrolman if Control Room/a manager
// sent it, or every on-duty operator if the patrolman sent it (there's no
// single "control room" login to target, unlike a specific patrolman).
async function notifyChatMessage(jobId, session, text) {
  const jobsRaw = await kvGet(JOBS_KEY);
  const jobs = jobsRaw ? JSON.parse(jobsRaw) : [];
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;

  const preview = text.length > 120 ? `${text.slice(0, 117)}…` : text;
  const payload = {
    title: `New message — ${job.jobNumber}`,
    body: `${session.displayName}: ${preview}`,
    jobId,
    url: "/",
    kind: "chat",
  };

  if (session.role === "patrolman") {
    await sendPushToRole("operator", payload);
  } else if (job.assigneeId) {
    await sendPushToPatrolman(job.assigneeId, "patrolman", payload);
  }
}

export default async function handler(req, res) {
  // Control Room / Manager bulk-reading every patrolman's live location.
  if (req.method === "GET" && req.query?.prefix === LIVELOC_PREFIX) {
    const session = await requireRole(req, res, ["manager", "operator"]);
    if (!session) return;
    try {
      const rows = await kvGetPrefix(LIVELOC_PREFIX);
      return res.status(200).json({
        entries: rows.map((r) => ({ loginName: r.key.slice(LIVELOC_PREFIX.length), value: r.value, updatedAt: r.updated_at })),
      });
    } catch (err) {
      console.error("kv GET (liveloc prefix) failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  // Control Room / Manager searching or date-scoping what the daily
  // archive sweep (api/_lib/jobArchive.js) has moved off the live board.
  // Always filtered server-side (by term and/or date range) via the
  // `search` jsonb column, capped, never "give me the whole archive" —
  // that's what made ops:jobs itself grow unbounded before it was split
  // out, and this is the same fix applied one layer over.
  if (req.method === "GET" && req.query?.archiveQuery === "1") {
    const session = await requireRole(req, res, ["manager", "operator"]);
    if (!session) return;
    const { term, from, to } = req.query;
    try {
      const rows = await kvQueryPrefix(JOB_ARCHIVE_PREFIX, {
        term: term || undefined,
        searchFields: ["jobNumber", "siteName"],
        dateField: "dispatchDate",
        dateFrom: from || undefined,
        dateTo: to || undefined,
      });
      return res.status(200).json({ entries: rows.map((r) => ({ value: r.value, updatedAt: r.updated_at })) });
    } catch (err) {
      console.error("kv GET (jobarchive query) failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  // Manager-only: "Reset test data" wiping the whole archive / all photo
  // records in one statement each, rather than ever having to enumerate
  // every row first — a plain DELETE-by-prefix stays cheap and safe
  // regardless of how large either has grown.
  if (req.method === "DELETE" && (req.query?.resetArchive === "1" || req.query?.resetPhotos === "1")) {
    const session = await requireRole(req, res, ["manager"]);
    if (!session) return;
    try {
      if (req.query.resetArchive === "1") await kvDeletePrefix(JOB_ARCHIVE_PREFIX);
      if (req.query.resetPhotos === "1") await kvDeletePrefix(JOB_PHOTOS_PREFIX);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("kv reset (bulk delete) failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  // GET and DELETE pass the key as a query param; POST passes it in the body.
  const key = req.query?.key || req.body?.key;

  // Per-job attendance photos — same read/write trust as ops:jobs itself
  // (any signed-in role), just split into its own key per job so a photo
  // upload never touches the board's polled blob.
  if (typeof key === "string" && key.startsWith(JOB_PHOTOS_PREFIX)) {
    const session = await requireRole(req, res, ["manager", "operator", "patrolman"]);
    if (!session) return;
    try {
      if (req.method === "GET") {
        const value = await kvGet(key);
        return res.status(200).json({ key, value: value === null ? "[]" : value });
      }
      if (req.method === "POST") {
        const { value } = req.body || {};
        if (value === undefined) return res.status(400).json({ error: "value is required" });
        await kvSet(key, value);
        return res.status(200).json({ key, value });
      }
      if (req.method === "DELETE") {
        await kvDelete(key);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: "Method not allowed" });
    } catch (err) {
      console.error("kv jobphotos failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  // Per-job chat between Control Room and the assigned patrolman — same
  // read/write trust as ops:jobs itself, split into its own key per job
  // for the same reason as photos above. POST only ever appends one
  // message rather than accepting a client-computed whole array: the
  // server stamps the author/role/timestamp from the session token
  // (never trusting the client's own claim of who's speaking) and reads
  // the current list immediately before appending to it, so this can't
  // silently drop a message the way a client-side stale-snapshot
  // overwrite could (see mergeJobsWrite's comment in this same file for
  // the class of bug this sidesteps).
  if (typeof key === "string" && key.startsWith(JOB_CHAT_PREFIX)) {
    const session = await requireRole(req, res, ["manager", "operator", "patrolman"]);
    if (!session) return;
    try {
      if (req.method === "GET") {
        const value = await kvGet(key);
        return res.status(200).json({ key, value: value === null ? "[]" : value });
      }
      if (req.method === "POST") {
        const text = (req.body?.message?.text || "").trim();
        if (!text) return res.status(400).json({ error: "Message text is required." });
        if (text.length > 2000) return res.status(400).json({ error: "Message is too long (2000 characters max)." });
        const raw = await kvGet(key);
        let chat;
        try { chat = raw ? JSON.parse(raw) : []; } catch (e) { chat = []; }
        if (!Array.isArray(chat)) chat = [];
        chat.push({
          ts: new Date().toISOString(),
          fromLoginName: session.loginName,
          fromName: session.displayName,
          fromRole: session.role,
          text,
        });
        const value = JSON.stringify(chat);
        await kvSet(key, value);
        // Best-effort — a patrolman with the app in the background, or an
        // operator not currently on this job, would otherwise have no
        // idea a message is waiting until they happen to open it. Never
        // awaited: a slow or failing push must not delay or fail the
        // chat send itself.
        notifyChatMessage(key.slice(JOB_CHAT_PREFIX.length), session, text).catch(() => {});
        return res.status(200).json({ key, value });
      }
      return res.status(405).json({ error: "Method not allowed" });
    } catch (err) {
      console.error("kv jobchat failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  if (typeof key === "string" && key.startsWith(LIVELOC_PREFIX)) {
    const session = await requireSession(req, res);
    if (!session) return;
    if (key !== `${LIVELOC_PREFIX}${session.loginName}` || session.role !== "patrolman") {
      return res.status(403).json({ error: "You can only share your own location." });
    }
    try {
      if (req.method === "POST") {
        const { value } = req.body || {};
        if (value === undefined) return res.status(400).json({ error: "value is required" });
        let incoming;
        try { incoming = JSON.parse(value); } catch (e) { incoming = null; }
        if (incoming && typeof incoming.lat === "number" && typeof incoming.lon === "number" && typeof incoming.ts === "number") {
          const enriched = await applyStationaryTracking(key, incoming);
          return res.status(200).json({ key, value: JSON.stringify(enriched) });
        }
        await kvSet(key, value);
        return res.status(200).json({ key, value });
      }
      if (req.method === "DELETE") {
        await kvDelete(key);
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: "Method not allowed" });
    } catch (err) {
      console.error("kv liveloc write failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  if (!key || !KNOWN_KEYS.has(key)) {
    return res.status(400).json({ error: "Unknown or missing key" });
  }

  if (req.method === "GET") {
    if (!PUBLIC_READ_KEYS.has(key)) {
      const session = await requireSession(req, res);
      if (!session) return; // response already sent, with a reason
    }
    try {
      let value = await kvGet(key);
      if (value === null) return res.status(404).json({ error: "not found" });
      if (key === JOBS_KEY) value = await migrateEmbeddedPhotos(value);
      return res.status(200).json({ key, value });
    } catch (err) {
      console.error("kv GET failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  if (req.method === "POST") {
    const roles = MANAGER_ONLY_WRITE_KEYS.has(key)
      ? ["manager"]
      : OPERATOR_UP_WRITE_KEYS.has(key)
      ? ["manager", "operator"]
      : ["manager", "operator", "patrolman"];
    const session = await requireRole(req, res, roles);
    if (!session) return; // response already sent

    const { value } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: "value is required" });
    try {
      let finalValue = value;
      if (key === JOBS_KEY) {
        finalValue = await mergeJobsWrite(value);
      } else if (key === OPERATOR_SESSIONS_KEY) {
        finalValue = await mergeOperatorSessionsWrite(value);
      } else {
        await kvSet(key, value);
      }
      return res.status(200).json({ key, value: finalValue });
    } catch (err) {
      console.error("kv POST failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

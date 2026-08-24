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

import { getSession, requireRole, requireSession } from "./_lib/auth.js";
import { kvGet, kvSet, kvGetPrefix, kvDelete } from "./_lib/supabase.js";
import { sendPushToRole } from "./_lib/push.js";

const PUBLIC_READ_KEYS = new Set(["ops:logo", "ops:companyName"]);
const MANAGER_ONLY_WRITE_KEYS = new Set(["ops:logo", "ops:companyName", "ops:outcomePhrases"]);
const OPERATOR_UP_WRITE_KEYS = new Set(["ops:sites", "ops:zones", "ops:roster"]);
const KNOWN_KEYS = new Set(["ops:jobs", "ops:sites", "ops:zones", "ops:roster", "ops:logo", "ops:companyName", "ops:outcomePhrases"]);

const LIVELOC_PREFIX = "ops:liveloc:";
const STATIONARY_RADIUS_M = 50; // GPS jitter tolerance — "hasn't left this spot"
const STATIONARY_ALERT_MS = 30 * 60 * 1000;

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

export default async function handler(req, res) {
  // Control Room / Manager bulk-reading every patrolman's live location.
  if (req.method === "GET" && req.query?.prefix === LIVELOC_PREFIX) {
    const session = requireRole(req, res, ["manager", "operator"]);
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

  // GET and DELETE pass the key as a query param; POST passes it in the body.
  const key = req.query?.key || req.body?.key;

  if (typeof key === "string" && key.startsWith(LIVELOC_PREFIX)) {
    const session = requireSession(req, res);
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
    if (!PUBLIC_READ_KEYS.has(key) && !getSession(req)) {
      return res.status(401).json({ error: "Unauthorized — please sign in again." });
    }
    try {
      const value = await kvGet(key);
      if (value === null) return res.status(404).json({ error: "not found" });
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
    const session = requireRole(req, res, roles);
    if (!session) return; // response already sent

    const { value } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: "value is required" });
    try {
      await kvSet(key, value);
      return res.status(200).json({ key, value });
    } catch (err) {
      console.error("kv POST failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// Live patrolman location: each patrolman's browser reports their own
// position under their own KV key (ops:liveloc:<loginName>), overwritten
// every time — never a history, just "where are they right now". Control
// Room reads the whole set back at once. See api/kv.js for the
// server-side prefix/ownership rules.

import { getToken, reportUnauthorized } from "./auth.js";

const LIVELOC_PREFIX = "ops:liveloc:";

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    reportUnauthorized();
    throw new Error("Session expired — please sign in again.");
  }
  return res;
}

export async function reportLiveLocation(loginName, lat, lon) {
  try {
    await apiFetch("/api/kv", {
      method: "POST",
      body: JSON.stringify({ key: `${LIVELOC_PREFIX}${loginName}`, value: JSON.stringify({ lat, lon, ts: Date.now() }) }),
    });
  } catch (e) { /* best-effort — a missed update just means a stale dot until the next one lands */ }
}

export async function stopSharingLiveLocation(loginName) {
  try {
    await apiFetch(`/api/kv?key=${encodeURIComponent(`${LIVELOC_PREFIX}${loginName}`)}`, { method: "DELETE" });
  } catch (e) { /* best-effort — will just go stale and drop off the map on its own */ }
}

// Returns [{ loginName, lat, lon, ts, updatedAt }], silently dropping any
// row that fails to parse.
export async function fetchLiveLocations() {
  const res = await apiFetch(`/api/kv?prefix=${encodeURIComponent(LIVELOC_PREFIX)}`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return (data.entries || [])
    .map((e) => {
      try {
        const v = JSON.parse(e.value);
        return { loginName: e.loginName, lat: v.lat, lon: v.lon, ts: v.ts, updatedAt: e.updatedAt };
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean);
}

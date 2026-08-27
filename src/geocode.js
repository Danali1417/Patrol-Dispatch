// Best-effort reverse geocoding: turns {lat, lon} into a short address
// label via our /api/reverse-geocode proxy. Used to caption photo
// watermarks and onsite/offsite locations with a real place name instead
// of raw coordinates. Always resolves — callers fall back to coordinates
// on failure or timeout so a slow/no signal never blocks the flow.

import { getToken, reportUnauthorized } from "./auth.js";

export async function reverseGeocode(lat, lon, timeoutMs = 5000) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/reverse-geocode?lat=${lat}&lon=${lon}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (res.status === 401) { const body = await res.json().catch(() => ({})); reportUnauthorized(body.reason); return null; }
    if (!res.ok) return null;
    const data = await res.json();
    return data.name || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Forward geocoding: turns a street address into {lat, lon} — used to
// place a site pin on the Live Location map. Best-effort like the
// reverse direction — resolves null on failure so a bad/unmatchable
// address just means no pin, not a broken map.
export async function forwardGeocode(address, timeoutMs = 6000) {
  if (!address || !address.trim()) return null;
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/reverse-geocode?address=${encodeURIComponent(address)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (res.status === 401) { const body = await res.json().catch(() => ({})); reportUnauthorized(body.reason); return null; }
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.lat === "number" && typeof data.lon === "number" ? { lat: data.lat, lon: data.lon } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fetches a small static map image (data URL) with a pin at {lat, lon},
// for embedding in the attendance PDF. Best-effort — resolves null on
// any failure/timeout so a slow/unreachable map service never blocks a
// PDF download.
export async function fetchStaticMap(lat, lon, timeoutMs = 8000) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/static-map?lat=${lat}&lon=${lon}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (res.status === 401) { const body = await res.json().catch(() => ({})); reportUnauthorized(body.reason); return null; }
    if (!res.ok) return null;
    const data = await res.json();
    return data.dataUrl || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

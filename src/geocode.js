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
    if (res.status === 401) { reportUnauthorized(); return null; }
    if (!res.ok) return null;
    const data = await res.json();
    return data.name || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

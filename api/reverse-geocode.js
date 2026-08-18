// Turns GPS coordinates into a short, human-readable place name for photo
// watermarks and onsite/offsite location display. Proxied server-side
// (rather than called directly from the browser) because OpenStreetMap's
// Nominatim usage policy requires a descriptive User-Agent identifying the
// application, which isn't reliably controllable from client-side fetch.

import { requireSession } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const session = requireSession(req, res);
  if (!session) return;

  const lat = Number(req.query?.lat);
  const lon = Number(req.query?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "lat and lon query params are required." });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    let response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": "AusgroupSecurityPatrolDispatch/1.0 (ops contact via app admin)" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return res.status(200).json({ name: null });

    const data = await response.json();
    const a = data.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(" ");
    const locality = a.suburb || a.town || a.city || a.village || a.municipality || "";
    const state = a.state_code || a.state || "";
    const label = [street, locality, state].filter(Boolean).join(", ") || data.display_name || null;
    return res.status(200).json({ name: label });
  } catch (err) {
    // Best-effort — the caller falls back to raw coordinates on failure.
    return res.status(200).json({ name: null });
  }
}

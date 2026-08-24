// Turns GPS coordinates into a short, human-readable place name for photo
// watermarks and onsite/offsite location display (reverse mode: lat+lon),
// or a site address into coordinates for the Live Location map's site
// pins (forward mode: address) — same Nominatim service either
// direction, so kept as one endpoint rather than two to stay under
// Vercel's 12-function Hobby-plan limit. Proxied server-side because
// Nominatim's usage policy requires a descriptive User-Agent identifying
// the application, which isn't reliably controllable from client-side
// fetch.

import { requireSession } from "./_lib/auth.js";

async function nominatimFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    return await fetch(url, {
      headers: { "User-Agent": "AusgroupSecurityPatrolDispatch/1.0 (ops contact via app admin)" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const session = requireSession(req, res);
  if (!session) return;

  if (typeof req.query?.address === "string" && req.query.address.trim()) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(req.query.address.trim())}`;
      const response = await nominatimFetch(url);
      if (!response.ok) return res.status(200).json({ lat: null, lon: null });
      const results = await response.json();
      const first = results[0];
      if (!first) return res.status(200).json({ lat: null, lon: null });
      return res.status(200).json({ lat: Number(first.lat), lon: Number(first.lon) });
    } catch (err) {
      // Best-effort — the caller just skips the pin for this address.
      return res.status(200).json({ lat: null, lon: null });
    }
  }

  const lat = Number(req.query?.lat);
  const lon = Number(req.query?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "lat and lon (or address) query params are required." });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const response = await nominatimFetch(url);
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

// Fetches a small static map PNG (pin at the given coordinates) so the
// attendance PDF can embed a map image — jsPDF can only embed raster
// images, not the live iframe embed used on the Control Room screen.
// Proxied server-side for the same reason as reverse-geocode.js: a
// descriptive User-Agent is expected, and this sidesteps any CORS
// uncertainty from a third-party image host.

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
    const url = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=15&size=320x200&maptype=mapnik&markers=${lat},${lon},lightblue1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(url, {
        headers: { "User-Agent": "AusgroupSecurityPatrolDispatch/1.0 (ops contact via app admin)" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return res.status(200).json({ dataUrl: null });

    const contentType = response.headers.get("content-type") || "image/png";
    const buf = Buffer.from(await response.arrayBuffer());
    return res.status(200).json({ dataUrl: `data:${contentType};base64,${buf.toString("base64")}` });
  } catch (err) {
    // Best-effort — the caller falls back to text-only on failure.
    return res.status(200).json({ dataUrl: null });
  }
}

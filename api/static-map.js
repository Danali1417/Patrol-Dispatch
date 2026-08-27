// Builds a small static map PNG (pin at the given coordinates) so the
// attendance PDF can embed a map image — jsPDF can only embed raster
// images, not the live iframe embed used on the Control Room screen.
//
// Rather than depend on a third-party "static map" generator (tried
// staticmap.openstreetmap.de first — it wasn't reliably reachable from
// Vercel's serverless environment), this fetches a single raster tile
// directly from OpenStreetMap's own official tile server — the same
// infrastructure that backs the on-screen embedded map — and draws the
// pin on top of it server-side.

import sharp from "sharp";
import { requireSession } from "./_lib/auth.js";

const ZOOM = 15;
const TILE_SIZE = 256;

// Standard Web Mercator slippy-map tile math.
function tileCoords(lat, lon, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** zoom;
  const xFrac = ((lon + 180) / 360) * n;
  const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const xTile = Math.floor(xFrac);
  const yTile = Math.floor(yFrac);
  return {
    xTile,
    yTile,
    px: Math.round((xFrac - xTile) * TILE_SIZE),
    py: Math.round((yFrac - yTile) * TILE_SIZE),
  };
}

function pinSvg(px, py) {
  // Simple red pin dot with a white outline, centered on the coordinate.
  return Buffer.from(
    `<svg width="${TILE_SIZE}" height="${TILE_SIZE}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${px}" cy="${py}" r="9" fill="#DC2626" stroke="#ffffff" stroke-width="3" />
    </svg>`
  );
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const session = await requireSession(req, res);
  if (!session) return;

  const lat = Number(req.query?.lat);
  const lon = Number(req.query?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "lat and lon query params are required." });
  }

  try {
    const { xTile, yTile, px, py } = tileCoords(lat, lon, ZOOM);
    const url = `https://tile.openstreetmap.org/${ZOOM}/${xTile}/${yTile}.png`;
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

    const tileBuf = Buffer.from(await response.arrayBuffer());
    const composited = await sharp(tileBuf)
      .composite([{ input: pinSvg(px, py), top: 0, left: 0 }])
      .png()
      .toBuffer();

    return res.status(200).json({ dataUrl: `data:image/png;base64,${composited.toString("base64")}` });
  } catch (err) {
    // Best-effort — the caller falls back to text-only on failure.
    return res.status(200).json({ dataUrl: null });
  }
}

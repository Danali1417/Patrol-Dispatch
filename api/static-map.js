// Builds a small static map PNG (pin at the given coordinates) so the
// attendance PDF can embed a map image — jsPDF can only embed raster
// images, not the live iframe embed used on the Control Room screen.
//
// Uses Google's Maps Static API when GOOGLE_STATIC_MAPS_API_KEY is set —
// the same Maps platform the Regions/Permanent Patrol Sites pilot already
// uses, but a separate server-side key (no VITE_ prefix, so it never ships
// to the browser): VITE_GOOGLE_MAPS_API_KEY is restricted by HTTP referrer,
// which a server-to-server call never sends, so it can't be reused here.
// Falls back to fetching a raster tile straight from OpenStreetMap's own
// tile server and drawing the pin on top server-side — this app's original
// approach — if that key isn't set, or if the Google request fails for any
// reason, so this stays working either way.

import sharp from "sharp";
import { requireSession } from "./_lib/auth.js";

const ZOOM = 15;
const TILE_SIZE = 256;

async function fetchGoogleStaticMap(lat, lon, apiKey) {
  const params = new URLSearchParams({
    center: `${lat},${lon}`,
    zoom: String(ZOOM),
    size: `${TILE_SIZE}x${TILE_SIZE}`,
    scale: "2",
    maptype: "roadmap",
    markers: `color:red|${lat},${lon}`,
    key: apiKey,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://maps.googleapis.com/maps/api/staticmap?${params}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    // On a key/auth problem Google returns 200 with a JSON or text error
    // body instead of an image — treat anything non-image as a failure.
    if (!response.headers.get("content-type")?.startsWith("image/")) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

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

  const googleKey = process.env.GOOGLE_STATIC_MAPS_API_KEY;
  if (googleKey) {
    const dataUrl = await fetchGoogleStaticMap(lat, lon, googleKey);
    if (dataUrl) return res.status(200).json({ dataUrl });
    // falls through to the OpenStreetMap path below on any Google failure
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

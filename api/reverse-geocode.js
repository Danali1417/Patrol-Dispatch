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

async function geocodeOnce(address) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`;
  const response = await nominatimFetch(url);
  if (!response.ok) return null;
  const results = await response.json();
  const first = results[0];
  if (!first) return null;
  return { lat: Number(first.lat), lon: Number(first.lon) };
}

// Finds the LAST "<number> <street name> <street type>" in the string and
// returns from there onward — e.g. "LEVEL 1 SHOP 1056 WESTPOINT S/C 17
// PATRICK STREET BLACKTOWN NSW 2148" becomes "17 PATRICK STREET BLACKTOWN
// NSW 2148". Last match rather than first, since a shop/suite number
// earlier in the string ("SHOP 1056") can itself look like a street
// number — the real street address is whichever such match sits closest
// to the suburb/state/postcode at the end.
//
// The span between the number and the street type deliberately excludes
// digits (a real street name is never "<number> <words with digits in
// them> <type>"). Without that, a string like "UNIT 3 AND UNIT 4 11 WELD
// ST" lets the regex latch onto the first stray digit ("3") and run
// straight through to "ST", producing "3 AND UNIT 4 11 WELD ST" instead
// of "11 WELD ST" — since nothing forces it to skip past the other
// digits in between. Excluding digits from that middle span means the
// attempt starting at "3" fails as soon as it hits "4", so the regex
// engine moves on and only succeeds starting at the number actually
// adjacent to the street name.
const STREET_TYPES = "STREET|ST|ROAD|RD|AVENUE|AVE|DRIVE|DR|COURT|CT|PLACE|PL|LANE|LN|HIGHWAY|HWY|PARADE|PDE|CRESCENT|CRES|CLOSE|CL|WAY|BOULEVARD|BLVD|TERRACE|TCE|CIRCUIT|CCT|GROVE|GR";
const STREET_ADDRESS_RE = new RegExp(`\\d+[A-Za-z]?\\s+[A-Za-z'\\s]*?\\b(?:${STREET_TYPES})\\b`, "gi");

function simplifyToStreetAddress(address) {
  const matches = [...address.matchAll(STREET_ADDRESS_RE)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  return address.slice(last.index).trim();
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const session = await requireSession(req, res);
  if (!session) return;

  if (typeof req.query?.address === "string" && req.query.address.trim()) {
    try {
      const raw = req.query.address.trim();
      let coords = await geocodeOnce(raw);
      // A unit/shop/level prefix (e.g. "LEVEL 1 SHOP 1056 WESTPOINT S/C
      // 17 PATRICK STREET BLACKTOWN NSW 2148") routinely defeats Nominatim's
      // free-text search — it's built for "house-number + street", not a
      // shopping-centre descriptor glued in front of one. If the full
      // string comes back empty, retry with just the street-number-onward
      // portion, which is all a map pin actually needs.
      if (!coords) {
        const simplified = simplifyToStreetAddress(raw);
        if (simplified && simplified !== raw) coords = await geocodeOnce(simplified);
      }
      return res.status(200).json(coords || { lat: null, lon: null });
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

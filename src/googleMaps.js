// Loads the Google Maps JavaScript API exactly once no matter how many
// map widgets end up on the page — every caller awaits this same promise
// instead of each injecting its own <script> tag (which Google's loader
// doesn't tolerate well). Used only by the Patrol Sites & Run Sheets
// pilot (see isDanLogin in App.jsx) for drawing a zone's mapped area and
// picking a site's geofence point — nothing else in the app needs maps.
//
// Requires VITE_GOOGLE_MAPS_API_KEY (a Google Cloud API key with the
// "Maps JavaScript API" enabled) set as a Vercel environment variable.
// Vite inlines VITE_-prefixed vars at build time, so adding or changing
// this key only takes effect from the next deployment onward, not
// instantly for an already-built app.
let mapsPromise = null;

export function loadGoogleMaps() {
  if (mapsPromise) return mapsPromise;
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey) return Promise.reject(new Error("VITE_GOOGLE_MAPS_API_KEY is not set"));
  mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps) { resolve(window.google.maps); return; }
    const existing = document.querySelector("script[data-google-maps-loader]");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.google.maps));
      existing.addEventListener("error", () => reject(new Error("Couldn't load Google Maps")));
      return;
    }
    const script = document.createElement("script");
    // "geometry" is containsLocation(), used to suggest which region a
    // Permanent Patrol Site's pin falls inside. Region polygons are drawn
    // by hand (click-to-place-point — see RegionAreaEditor) rather than
    // via the Drawing library, which Google removed the DrawingManager
    // from as of Maps JS API v3.65. "places" backs the address-autocomplete
    // suggestions on the Permanent Patrol Site address field (see
    // AddressAutocompleteInput) — the classic places.Autocomplete widget
    // is deprecated as of March 2025 but, unlike Drawing, Google says it
    // keeps receiving bug fixes rather than being removed outright.
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geometry,places`;
    script.async = true;
    script.dataset.googleMapsLoader = "1";
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error("Couldn't load Google Maps"));
    document.head.appendChild(script);
  });
  return mapsPromise;
}

// Sydney CBD — just a reasonable starting point for a new map so it
// doesn't open on the Gulf of Guinea (0,0) before a real area or site
// has been picked; it's recentered the moment one has been.
export const DEFAULT_MAP_CENTER = { lat: -33.8688, lng: 151.2093 };

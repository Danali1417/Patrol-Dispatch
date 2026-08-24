import React, { useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import { fetchLiveLocations } from "./liveLocation.js";
import { forwardGeocode } from "./geocode.js";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const STALE_MS = 3 * 60 * 1000; // no update in 3 min — treat as no longer sharing
const POLL_MS = 15 * 1000;
const AUSTRALIA_CENTER = [-25.2744, 133.7751];

function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  return `${mins} min ago`;
}

function markerIcon(L, initials) {
  return L.divIcon({
    className: "",
    html: `<div style="width:32px;height:32px;border-radius:50%;background:#F5A623;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font:700 11px sans-serif;color:#1a1a1a;">${initials}</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function siteMarkerIcon(L) {
  return L.divIcon({
    className: "",
    html: `<div style="width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#DC2626;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 26],
  });
}

function initialsOf(name) {
  const parts = (name || "?").trim().split(/\s+/);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

export default function LiveLocationMap({ roster, accounts, jobs, sites, persistSites }) {
  const mapRef = useRef(null);
  const mapObjRef = useRef(null);
  const markersRef = useRef({});
  const siteMarkersRef = useRef({});
  const geocodingRef = useRef(new Set());
  const [locations, setLocations] = useState([]);
  const [error, setError] = useState("");
  const [mapReady, setMapReady] = useState(false);

  const patrolmen = accounts.filter((a) => a.role === "patrolman");
  const todaysRoster = roster.filter((r) => r.date === todayISO());
  const rosteredLoginNames = new Set(todaysRoster.map((r) => r.patrolmanLoginName));
  const rosteredToday = patrolmen.filter((p) => rosteredLoginNames.has(p.loginName));

  // One pin per site currently out on a job — so Control Room can see at
  // a glance who's nearest to respond. Coordinates are geocoded once from
  // the site's address and cached back onto the site record (persistSites)
  // so the same site never needs geocoding again.
  const activeSitePins = useMemo(() => {
    const seen = new Set();
    const pins = [];
    jobs.filter((j) => j.status === "dispatched").forEach((j) => {
      const site = sites.find((s) => s.id === j.siteId);
      const dedupeKey = site?.id || j.address;
      if (!dedupeKey || seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      pins.push({
        key: dedupeKey,
        siteId: site?.id || null,
        label: j.siteName || site?.name || "Site",
        address: site?.address || j.address,
        jobNumber: j.jobNumber,
        lat: site?.lat,
        lon: site?.lon,
      });
    });
    return pins;
  }, [jobs, sites]);

  useEffect(() => {
    activeSitePins.forEach((pin) => {
      if (typeof pin.lat === "number" && typeof pin.lon === "number") return;
      if (!pin.siteId || !pin.address || geocodingRef.current.has(pin.siteId)) return;
      geocodingRef.current.add(pin.siteId);
      (async () => {
        const coords = await forwardGeocode(pin.address);
        if (coords) persistSites(sites.map((s) => (s.id === pin.siteId ? { ...s, lat: coords.lat, lon: coords.lon } : s)));
      })();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSitePins]);

  const sitePinsWithCoords = activeSitePins.filter((p) => typeof p.lat === "number" && typeof p.lon === "number");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !mapRef.current) return;
      const map = L.map(mapRef.current).setView(AUSTRALIA_CENTER, 4);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      mapObjRef.current = map;
      setMapReady(true);
    })();
    return () => {
      cancelled = true;
      if (mapObjRef.current) { mapObjRef.current.remove(); mapObjRef.current = null; }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const rows = await fetchLiveLocations();
        if (!cancelled) { setLocations(rows); setError(""); }
      } catch (e) {
        if (!cancelled) setError(e.message || "Couldn't load live locations.");
      }
    }
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    (async () => {
      const L = (await import("leaflet")).default;
      const map = mapObjRef.current;
      if (!map) return;

      const fresh = locations.filter((l) => Date.now() - l.ts < STALE_MS);
      const freshLogins = new Set(fresh.map((l) => l.loginName));

      Object.keys(markersRef.current).forEach((loginName) => {
        if (!freshLogins.has(loginName)) {
          markersRef.current[loginName].remove();
          delete markersRef.current[loginName];
        }
      });
      fresh.forEach((loc) => {
        const p = patrolmen.find((a) => a.loginName === loc.loginName);
        const name = p?.displayName || loc.loginName;
        if (markersRef.current[loc.loginName]) {
          markersRef.current[loc.loginName].setLatLng([loc.lat, loc.lon]);
        } else {
          markersRef.current[loc.loginName] = L.marker([loc.lat, loc.lon], { icon: markerIcon(L, initialsOf(name)) })
            .addTo(map)
            .bindTooltip(name, { permanent: true, direction: "top", offset: [0, -14], className: "" });
        }
      });

      const sitePinKeys = new Set(sitePinsWithCoords.map((p) => p.key));
      Object.keys(siteMarkersRef.current).forEach((key) => {
        if (!sitePinKeys.has(key)) {
          siteMarkersRef.current[key].remove();
          delete siteMarkersRef.current[key];
        }
      });
      sitePinsWithCoords.forEach((pin) => {
        if (siteMarkersRef.current[pin.key]) {
          siteMarkersRef.current[pin.key].setLatLng([pin.lat, pin.lon]);
        } else {
          siteMarkersRef.current[pin.key] = L.marker([pin.lat, pin.lon], { icon: siteMarkerIcon(L) })
            .addTo(map)
            .bindTooltip(`🚨 ${pin.label} — ${pin.jobNumber}`, { permanent: true, direction: "top", offset: [0, -14], className: "" });
        }
      });

      const allPoints = [...fresh.map((l) => [l.lat, l.lon]), ...sitePinsWithCoords.map((p) => [p.lat, p.lon])];
      if (allPoints.length > 0) {
        const bounds = L.latLngBounds(allPoints);
        map.fitBounds(bounds.pad(0.3), { maxZoom: 15 });
      }
    })();
  }, [locations, mapReady, sitePinsWithCoords]);

  const fresh = locations.filter((l) => Date.now() - l.ts < STALE_MS);
  const onlineLogins = new Set(fresh.map((l) => l.loginName));

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div ref={mapRef} style={{ height: 520, borderRadius: 8, border: "1px solid var(--border)" }} />
        {error && <div style={{ color: "var(--breach)", fontSize: 12, marginTop: 8 }}>{error}</div>}
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 8 }}>
          Live — refreshes every 15s. Positions aren't stored; a patrolman drops off the map a few minutes after they sign out or close the app.
          {activeSitePins.length > 0 && <> Red pins mark sites currently out on a job.</>}
        </div>
      </div>
      <div style={{ width: 240, flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>
          Rostered today ({rosteredToday.length})
        </div>
        {rosteredToday.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No one's on today's roster.</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rosteredToday.map((p) => {
            const online = onlineLogins.has(p.loginName);
            const loc = fresh.find((l) => l.loginName === p.loginName);
            return (
              <div key={p.loginName} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, background: "var(--panel)", border: "1px solid var(--border)" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: online ? "var(--ok)" : "var(--border)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{p.displayName}</div>
                  <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{online ? `Online · ${timeAgo(loc.ts)}` : "Not signed on"}</div>
                </div>
              </div>
            );
          })}
        </div>

        {activeSitePins.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, margin: "16px 0 8px" }}>
              Active alarm sites ({activeSitePins.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {activeSitePins.map((pin) => (
                <div key={pin.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7, background: "var(--panel)", border: "1px solid var(--border)" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--breach)", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pin.label}</div>
                    <div style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{pin.jobNumber}{typeof pin.lat !== "number" ? " · locating…" : ""}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

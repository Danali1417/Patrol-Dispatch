// Provides window.storage (get/set), backed by /api/kv.js instead of
// talking to Supabase directly — the browser no longer holds any
// database credentials at all. Every call attaches the signed session
// token; a 401 response reports back through auth.js so the app can
// force a clean sign-out.

import { getToken, reportUnauthorized } from "./auth.js";

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    reportUnauthorized(body.reason);
    throw new Error("Session expired — please sign in again.");
  }
  return res;
}

window.storage = {
  get: async (key) => {
    const res = await apiFetch(`/api/kv?key=${encodeURIComponent(key)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `key not found: ${key}`);
    }
    const data = await res.json();
    return { key, value: data.value, shared: true };
  },
  // Same as get, but tells the server "I already have whatever was last
  // written as of `sinceIso`" — an unchanged key comes back as a tiny
  // {unchanged:true} instead of the full value. Meant for a frequent poll
  // (the board) where most ticks see no real change, so most of them cost
  // almost nothing instead of re-sending the whole thing every time.
  getIfChanged: async (key, sinceIso) => {
    const qs = sinceIso ? `&since=${encodeURIComponent(sinceIso)}` : "";
    const res = await apiFetch(`/api/kv?key=${encodeURIComponent(key)}${qs}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `key not found: ${key}`);
    }
    const data = await res.json();
    if (data.unchanged) return { key, unchanged: true, updatedAt: data.updatedAt };
    return { key, value: data.value, updatedAt: data.updatedAt, shared: true };
  },
  set: async (key, value) => {
    const res = await apiFetch("/api/kv", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Couldn't save ${key}`);
    }
    // Echo back whatever the server actually stored, not just what was
    // sent — for ops:jobs specifically, the server may have merged in a
    // job added concurrently by another device since this one's last
    // poll (see mergeJobsWrite in api/kv.js), and the caller needs that
    // merged value to keep its local state in sync.
    const data = await res.json().catch(() => ({ value }));
    return { key, value: data.value ?? value, shared: true };
  },
};

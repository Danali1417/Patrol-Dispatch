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
    reportUnauthorized();
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
  set: async (key, value) => {
    const res = await apiFetch("/api/kv", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Couldn't save ${key}`);
    }
    return { key, value, shared: true };
  },
};

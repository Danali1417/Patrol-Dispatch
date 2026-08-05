// Provides window.storage (get/set/delete/list) backed by a Supabase
// table, using the same shape the app already calls throughout App.jsx.
// Credentials come from environment variables set in Vercel's project
// settings — never hardcoded here, and never committed to GitHub.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.getElementById("root");
    if (root) {
      root.innerHTML = `
        <div style="font-family:'Segoe UI',system-ui,sans-serif;background:#0B0E11;color:#E7ECEF;min-height:100vh;padding:48px 32px;box-sizing:border-box;">
          <h2 style="color:#F5A623;">Setup needed</h2>
          <p>The environment variables <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> aren't set.</p>
          <p>If you're running this locally, copy <code>.env.example</code> to <code>.env</code> and fill in your values.
          If this is the live Vercel deployment, add both variables under
          Project Settings → Environment Variables, then redeploy.</p>
        </div>`;
    }
  });
  throw new Error("Missing Supabase environment variables — see message on page.");
}

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase request failed (${res.status}): ${body}`);
  }
  return res;
}

window.storage = {
  get: async (key) => {
    const res = await sbFetch(`kv_store?key=eq.${encodeURIComponent(key)}&select=value`);
    const rows = await res.json();
    if (!rows.length) throw new Error("key not found: " + key);
    return { key, value: rows[0].value, shared: true };
  },
  set: async (key, value) => {
    await sbFetch("kv_store", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
    });
    return { key, value, shared: true };
  },
  delete: async (key) => {
    await sbFetch(`kv_store?key=eq.${encodeURIComponent(key)}`, { method: "DELETE" });
    return { key, deleted: true, shared: true };
  },
  list: async (prefix) => {
    const q = prefix ? `key=like.${encodeURIComponent(prefix)}*&select=key` : "select=key";
    const res = await sbFetch(`kv_store?${q}`);
    const rows = await res.json();
    return { keys: rows.map((r) => r.key), prefix, shared: true };
  },
};

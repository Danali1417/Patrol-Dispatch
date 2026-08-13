// Minimal server-side counterpart to src/storageShim.js — reads/writes the
// same Supabase `kv_store` table, using the same REST calls the client
// makes, just from a Vercel serverless function instead of the browser.
// Reuses the existing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY env vars
// (the VITE_ prefix only controls client-bundle exposure — Vercel still
// makes them available to serverless functions via process.env).

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

async function sbFetch(path, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY environment variables");
  }
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

export async function kvGet(key) {
  const res = await sbFetch(`kv_store?key=eq.${encodeURIComponent(key)}&select=value`);
  const rows = await res.json();
  return rows.length ? rows[0].value : null;
}

export async function kvSet(key, value) {
  await sbFetch("kv_store", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
  });
}

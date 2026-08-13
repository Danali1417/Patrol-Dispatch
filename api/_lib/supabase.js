// Server-side Supabase access for every API function in this project.
// Uses the SERVICE ROLE key — never the anon key, and never exposed to
// the browser — so this is the only thing in the whole app with real
// read/write access to the database. The client now talks exclusively
// to our own /api endpoints, which enforce login + role checks before
// ever touching Supabase.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbFetch(path, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY environment variables");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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

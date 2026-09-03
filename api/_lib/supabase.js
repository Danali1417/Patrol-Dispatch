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

// Same lookup as kvGet, plus the row's updated_at — lets a caller (see
// the `since` handling in kv.js) tell whether a key has changed at all
// since it last fetched it, without re-sending the value when it hasn't.
export async function kvGetWithMeta(key) {
  const res = await sbFetch(`kv_store?key=eq.${encodeURIComponent(key)}&select=value,updated_at`);
  const rows = await res.json();
  return rows.length ? rows[0] : null;
}

export async function kvSet(key, value) {
  await sbFetch("kv_store", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
  });
}

// Same as kvSet, plus a small `search` jsonb payload (e.g. {jobNumber,
// siteName, dispatchDate}) stored alongside the full value — lets
// archived jobs be filtered server-side (by text or date range) via
// kvQueryPrefix instead of ever having to fetch a whole prefix's worth
// of rows just to search or scope them. Requires the `search` jsonb
// column (see README) — a plain kvSet-shaped row (search left out
// entirely) is fine for every other key in this table, which never sets it.
export async function kvSetSearchable(key, value, search) {
  await sbFetch("kv_store", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value, search, updated_at: new Date().toISOString() }]),
  });
}

// Filters rows under `prefix` by their `search` jsonb column instead of
// returning everything — a text term (matched against any of
// `searchFields`, case-insensitive substring) and/or a `search.<dateField>`
// range, always capped at `limit`. This is what keeps the job archive
// searchable/reportable without ever pulling the whole thing over the
// wire, no matter how large it grows.
export async function kvQueryPrefix(prefix, { term, searchFields = [], dateField, dateFrom, dateTo, limit = 300 } = {}) {
  const params = [`key=like.${encodeURIComponent(prefix)}*`, "select=key,value,updated_at", `limit=${limit}`, "order=updated_at.desc"];
  if (term && searchFields.length) {
    const escaped = term.replace(/[,()]/g, ""); // PostgREST's or=(...) syntax treats these as structural
    const ors = searchFields.map((f) => `search->>${f}.ilike.*${escaped}*`).join(",");
    params.push(`or=(${ors})`);
  }
  if (dateField && dateFrom) params.push(`search->>${dateField}=gte.${encodeURIComponent(dateFrom)}`);
  if (dateField && dateTo) params.push(`search->>${dateField}=lte.${encodeURIComponent(dateTo)}`);
  const res = await sbFetch(`kv_store?${params.join("&")}`);
  return res.json();
}

// Rows under `prefix` whose `search` column is still unset, capped at
// `limit` — used only to catch up rows written before the `search`
// column existed. Bounded regardless of how large the prefix's total
// row count is, and shrinks to nothing (cheap forever after) once
// every row under it has been backfilled once.
export async function kvGetPrefixMissingSearch(prefix, limit = 500) {
  const res = await sbFetch(`kv_store?key=like.${encodeURIComponent(prefix)}*&search=is.null&select=key,value&limit=${limit}`);
  return res.json();
}

export async function kvDelete(key) {
  await sbFetch(`kv_store?key=eq.${encodeURIComponent(key)}`, { method: "DELETE" });
}

// Deletes every row under `prefix` in one statement — used only for
// clearing an entire per-job side-table (photos, archive) wholesale
// during "Reset test data", never with a client-supplied prefix.
export async function kvDeletePrefix(prefix) {
  await sbFetch(`kv_store?key=like.${encodeURIComponent(prefix)}*`, { method: "DELETE" });
}

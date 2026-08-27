// Jobs closed out (emailed) or cancelled for 48+ hours are swept off the
// live board and into their own key (ops:jobarchive:<id>) by a daily cron
// — see api/_lib/jobArchive.js. The board's poll never has to
// carry that history. Always fetched by search term and/or date range
// (filtered server-side via api/kv.js's archiveQuery mode) — never "give
// me everything," which is exactly the pattern that made ops:jobs itself
// grow unbounded before photos and old jobs were split out of it.

import { getToken, reportUnauthorized } from "./auth.js";

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    reportUnauthorized(body.reason);
    throw new Error("Session expired — please sign in again.");
  }
  return res;
}

async function queryArchive(params) {
  try {
    const qs = new URLSearchParams({ archiveQuery: "1", ...params }).toString();
    const res = await apiFetch(`/api/kv?${qs}`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return (data.entries || [])
      .map((e) => { try { return JSON.parse(e.value); } catch (err) { return null; } })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// Board's "search by job number or site" reaching into the archive.
export async function searchArchivedJobs(term) {
  if (!term || !term.trim()) return [];
  return queryArchive({ term: term.trim() });
}

// Reports / Logs & analysis pulling in archived jobs for a chosen (or
// default) date range, in addition to whatever's still on the live board.
export async function fetchArchivedJobsInRange(fromDateISO, toDateISO) {
  const params = {};
  if (fromDateISO) params.from = fromDateISO;
  if (toDateISO) params.to = toDateISO;
  return queryArchive(params);
}

// "Reset test data" wiping the archive (and, separately, all job photo
// records) in one statement each — see api/kv.js. No enumeration step,
// so this stays safe no matter how large either has grown.
export async function resetArchiveAndPhotos() {
  try {
    await apiFetch("/api/kv?resetArchive=1", { method: "DELETE" });
    await apiFetch("/api/kv?resetPhotos=1", { method: "DELETE" });
  } catch (e) { /* best-effort — Reset test data already confirms the outcome via a toast */ }
}

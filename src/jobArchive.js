// Jobs closed out (emailed) or cancelled for 48+ hours are swept off the
// live board and into their own key (ops:jobarchive:<id>) by a daily cron
// — see api/_lib/jobArchive.js. The board's 4-second poll never has to
// carry that history; Logs & analysis pulls it back in on demand instead,
// via fetchArchivedJobs() below.

import { getToken, reportUnauthorized } from "./auth.js";

const JOB_ARCHIVE_PREFIX = "ops:jobarchive:";

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    reportUnauthorized();
    throw new Error("Session expired — please sign in again.");
  }
  return res;
}

export async function fetchArchivedJobs() {
  try {
    const res = await apiFetch(`/api/kv?prefix=${encodeURIComponent(JOB_ARCHIVE_PREFIX)}`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return (data.entries || [])
      .map((e) => { try { return JSON.parse(e.value); } catch (err) { return null; } })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

export async function deleteArchivedJob(jobId) {
  try {
    await apiFetch(`/api/kv?key=${encodeURIComponent(`${JOB_ARCHIVE_PREFIX}${jobId}`)}`, { method: "DELETE" });
  } catch (e) { /* best-effort — Reset test data is the only caller, and it's already best-effort throughout */ }
}

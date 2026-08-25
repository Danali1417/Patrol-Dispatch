// Attendance photos for a job, kept in their own key (ops:jobphotos:<id>)
// instead of embedded in the job record — the board polls the whole job
// list every 4 seconds on every signed-in device, and photos are by far
// the biggest thing in a job, so they're fetched only when a job's own
// detail view actually needs them (viewing it, generating its PDF,
// emailing it), never as part of that poll. See api/kv.js for the
// server-side migration that moves older embedded photos out on first read.

import { getToken, reportUnauthorized } from "./auth.js";

const JOB_PHOTOS_PREFIX = "ops:jobphotos:";

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

export async function fetchJobPhotos(jobId) {
  try {
    const res = await apiFetch(`/api/kv?key=${encodeURIComponent(`${JOB_PHOTOS_PREFIX}${jobId}`)}`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return JSON.parse(data.value || "[]");
  } catch (e) {
    return [];
  }
}

export async function persistJobPhotos(jobId, photos) {
  await apiFetch("/api/kv", {
    method: "POST",
    body: JSON.stringify({ key: `${JOB_PHOTOS_PREFIX}${jobId}`, value: JSON.stringify(photos) }),
  });
}

// Attendance photos for a job, kept in their own key (ops:jobphotos:<id>)
// instead of embedded in the job record — the board polls the whole job
// list on every signed-in device, and photos are by far the biggest thing
// in a job, so they're fetched only when a job's own detail view actually
// needs them (viewing it, generating its PDF, emailing it), never as part
// of that poll. See api/kv.js for the server-side migration that moves
// older embedded photos out on first read.

import { getToken, reportUnauthorized } from "./auth.js";

const JOB_PHOTOS_PREFIX = "ops:jobphotos:";

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

// Uploads the untouched camera file straight to Supabase Storage (see
// api/_lib/storage.js) — best-effort and never throws: the compressed
// preview built alongside it (watermarkPhoto/resizePhotoPlain in App.jsx)
// is already saved everywhere else in the app, so a flaky original upload
// should never block or fail a patrolman's photo capture, just leave that
// one photo without a "view original" link.
export async function uploadOriginalPhoto(jobId, file) {
  try {
    const ext = (file.name || "").split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const signRes = await apiFetch("/api/kv?photoUploadUrl=1", { method: "POST", body: JSON.stringify({ jobId, ext }) });
    if (!signRes.ok) return null;
    const { path, uploadUrl } = await signRes.json();
    const putRes = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type || "image/jpeg" }, body: file });
    return putRes.ok ? path : null;
  } catch (e) {
    return null;
  }
}

// A fresh signed link to view/download one original — minted on demand,
// never cached, since a saved link would eventually expire (see
// createReadUrl's own comment in api/_lib/storage.js).
export async function fetchOriginalPhotoUrl(path) {
  try {
    const res = await apiFetch(`/api/kv?photoOriginal=1&path=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.url || null;
  } catch (e) {
    return null;
  }
}

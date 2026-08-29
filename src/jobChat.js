// Per-job chat between Control Room and the assigned patrolman, kept in
// its own key (ops:jobchat:<id>) — same reasoning as jobPhotos.js, so the
// board's poll never carries chat text for jobs nobody currently has
// open. Fetched, and while a live job's detail view stays open, re-polled
// only for that one job — see JobChatPanel in App.jsx.

import { getToken, reportUnauthorized } from "./auth.js";

const JOB_CHAT_PREFIX = "ops:jobchat:";

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

export async function fetchJobChat(jobId) {
  try {
    const res = await apiFetch(`/api/kv?key=${encodeURIComponent(`${JOB_CHAT_PREFIX}${jobId}`)}`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return JSON.parse(data.value || "[]");
  } catch (e) {
    return [];
  }
}

// The server stamps the message's author/role/timestamp from the signed
// session and appends it to whatever's currently stored, reading that
// right before writing — the caller only ever sends the text itself, and
// gets the resulting full list back so it doesn't have to wait for the
// next poll to see its own message land.
export async function sendJobChatMessage(jobId, text) {
  const res = await apiFetch("/api/kv", {
    method: "POST",
    body: JSON.stringify({ key: `${JOB_CHAT_PREFIX}${jobId}`, message: { text } }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Couldn't send the message.");
  }
  const data = await res.json().catch(() => ({}));
  return JSON.parse(data.value || "[]");
}

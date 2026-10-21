// Client side of the "long attendance" manager alert — see
// api/notify-long-attendance.js for what it actually checks and sends.
// Fired once, right when a Response job reaches "reviewed" or "emailed"
// (see the update() wrapper in JobDetailOperator in src/App.jsx), if it
// spent unusually long onsite.

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

// Never throws — a failed alert should never block closing out a job.
// `sent` tells the caller whether an email actually went out (false also
// covers the ordinary case where the job didn't meet the threshold, or
// LONG_ATTENDANCE_RECIPIENTS isn't configured) — only `ok: false` is a
// genuine failure worth surfacing to the operator.
export async function notifyLongAttendance(jobId) {
  try {
    const res = await apiFetch("/api/notify-long-attendance", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, sent: false, error: data.error || `Failed (${res.status})` };
    return { ok: true, sent: !!data.sent, minutesOnsite: data.minutesOnsite };
  } catch (e) {
    console.error("notifyLongAttendance failed:", e);
    return { ok: false, sent: false, error: e.message || String(e) };
  }
}

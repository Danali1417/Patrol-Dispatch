// Deliberately NOT gated by a login session. This is called directly
// from the service worker's notificationclick handler when a patrolman
// taps "Acknowledge" on a lock-screen notification — at that moment
// there's no app open and no session token available to the worker.
// The per-job random token (only ever delivered inside that patrolman's
// own encrypted push payload, set by notify-job.js) is the credential.

import { kvGet, kvSet } from "./_lib/supabase.js";

const JOBS_KEY = "ops:jobs";

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { jobId, token } = req.query || {};
  if (!jobId || !token) {
    return res.status(400).json({ error: "jobId and token are required." });
  }

  try {
    const raw = await kvGet(JOBS_KEY);
    const jobs = raw ? JSON.parse(raw) : [];
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return res.status(404).json({ error: "Job not found." });
    if (!jobs[idx].ackToken || jobs[idx].ackToken !== token) {
      return res.status(403).json({ error: "Invalid or expired acknowledgement link." });
    }
    if (!jobs[idx].acknowledgedAt) {
      jobs[idx] = { ...jobs[idx], acknowledgedAt: new Date().toISOString() };
      await kvSet(JOBS_KEY, JSON.stringify(jobs));
    }
    return res.status(200).json({ ok: true, jobNumber: jobs[idx].jobNumber });
  } catch (err) {
    console.error("quick-ack failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

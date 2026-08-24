// Deliberately NOT gated by a login session — same reasoning as
// quick-ack.js. Called from the service worker when a patrolman taps
// "Acknowledge" on a "job reassigned away from you" push notification.
// The per-notice random token (only ever delivered inside that
// patrolman's own push payload, set by notify-standdown.js) is the
// credential; it's matched against the specific standDowns entry, not
// the job's regular dispatch ackToken.

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

    const job = jobs[idx];
    const standDowns = job.standDowns || [];
    const sdIdx = standDowns.findIndex((sd) => sd.ackToken === token);
    if (sdIdx === -1) return res.status(403).json({ error: "Invalid or expired acknowledgement link." });

    if (!standDowns[sdIdx].acknowledgedAt) {
      const updatedStandDowns = standDowns.map((sd, i) => (i === sdIdx ? { ...sd, acknowledgedAt: new Date().toISOString() } : sd));
      const logEntry = {
        ts: new Date().toISOString(),
        actorLoginName: standDowns[sdIdx].patrolmanLoginName,
        actorName: standDowns[sdIdx].patrolmanName,
        action: "Stand-down acknowledged",
        detail: `Confirmed job given to ${standDowns[sdIdx].reassignedTo}`,
      };
      jobs[idx] = { ...job, standDowns: updatedStandDowns, activityLog: [...(job.activityLog || []), logEntry] };
      await kvSet(JOBS_KEY, JSON.stringify(jobs));
    }
    return res.status(200).json({ ok: true, jobNumber: job.jobNumber });
  } catch (err) {
    console.error("quick-standdown-ack failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

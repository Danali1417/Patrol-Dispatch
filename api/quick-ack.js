// Deliberately NOT gated by a login session. This is called directly
// from the service worker's notificationclick handler when a patrolman
// taps "Acknowledge" on a lock-screen notification — at that moment
// there's no app open and no session token available to the worker.
// The per-notification random token (only ever delivered inside that
// patrolman's own encrypted push payload, set by notify-job.js) is the
// credential.
//
// Handles two kinds of acknowledgement with the same token param,
// distinguished by which one it actually matches, so a second endpoint
// isn't needed for the "reassigned away from you" notice — that keeps
// the total serverless function count under Vercel's Hobby-plan limit:
//   - the job's own ackToken (dispatch/reassign — confirms receipt)
//   - one of the job's standDowns[].ackToken (confirms a patrolman who
//     was taken off the job has seen that notice)

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

    if (job.ackToken && job.ackToken === token) {
      if (!job.acknowledgedAt) {
        jobs[idx] = { ...job, acknowledgedAt: new Date().toISOString() };
        await kvSet(JOBS_KEY, JSON.stringify(jobs));
      }
      return res.status(200).json({ ok: true, jobNumber: job.jobNumber });
    }

    const standDowns = job.standDowns || [];
    const sdIdx = standDowns.findIndex((sd) => sd.ackToken === token);
    if (sdIdx !== -1) {
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
    }

    return res.status(403).json({ error: "Invalid or expired acknowledgement link." });
  } catch (err) {
    console.error("quick-ack failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

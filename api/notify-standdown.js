// Triggered by Control Room right after reassigning a job away from a
// patrolman who already had it — sends that patrolman a push notice
// (with its own Acknowledge action, same pattern as notify-job.js /
// quick-ack.js) so they know to stand down, and stamps the job with a
// standDowns entry Control Room can see get acknowledged.

import crypto from "node:crypto";
import { requireRole } from "./_lib/auth.js";
import { kvGet, kvSet } from "./_lib/supabase.js";
import { sendPushToPatrolman } from "./_lib/push.js";

const JOBS_KEY = "ops:jobs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const session = requireRole(req, res, ["manager", "operator"]);
  if (!session) return;

  const { jobId, loginName, patrolmanName, reassignedToName } = req.body || {};
  if (!jobId || !loginName || !patrolmanName || !reassignedToName) {
    return res.status(400).json({ error: "jobId, loginName, patrolmanName, and reassignedToName are required." });
  }

  try {
    const raw = await kvGet(JOBS_KEY);
    const jobs = raw ? JSON.parse(raw) : [];
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return res.status(404).json({ error: "Job not found." });

    const ackToken = crypto.randomBytes(16).toString("hex");
    const standDown = {
      id: `sd_${Date.now()}`,
      patrolmanLoginName: loginName,
      patrolmanName,
      reassignedTo: reassignedToName,
      notifiedAt: new Date().toISOString(),
      ackToken,
      acknowledgedAt: null,
    };
    const job = jobs[idx];
    jobs[idx] = { ...job, standDowns: [...(job.standDowns || []), standDown] };
    await kvSet(JOBS_KEY, JSON.stringify(jobs));

    const result = await sendPushToPatrolman(loginName, "patrolman", {
      title: `Job reassigned — ${job.jobNumber}`,
      body: `${job.siteName} has been given to ${reassignedToName}. Tap Acknowledge to confirm you've seen this.`,
      jobId,
      ackToken,
      kind: "standdown",
      url: "/",
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("notify-standdown failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

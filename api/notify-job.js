// Triggered by Control Room right after dispatching/reassigning a job
// (sends a push to the assigned patrolman) or after reassigning a job
// away from a patrolman who already had it (sends a "stand down" push
// to that previous patrolman instead) — kept as one endpoint rather
// than a separate file per notification kind to stay under Vercel's
// Hobby-plan serverless function limit.
//
// Both kinds stamp the job with a fresh one-time random token that only
// quick-ack.js accepts, so the notification's "Acknowledge" button can
// confirm receipt without the patrolman ever opening the app.

import crypto from "node:crypto";
import { requireRole } from "./_lib/auth.js";
import { kvGet, kvSet } from "./_lib/supabase.js";
import { sendPushToPatrolman } from "./_lib/push.js";

const JOBS_KEY = "ops:jobs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const session = await requireRole(req, res, ["manager", "operator"]);
  if (!session) return;

  const body = req.body || {};

  if (body.mode === "standdown") {
    const { jobId, loginName, patrolmanName, reassignedToName } = body;
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
        url: "/",
        // Only stand-down notices still get the lock-screen one-tap
        // Acknowledge action — a new-job dispatch below doesn't set this,
        // since acknowledging that now requires confirming an ETA first
        // (see EtaModal in src/App.jsx), which a bare notification tap
        // can't do. sw.js checks this to decide whether to show the button.
        kind: "standdown",
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      console.error("notify-job (standdown) failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  const { jobId, loginName, role, title, body: pushBody } = body;
  if (!jobId || !loginName || !role) {
    return res.status(400).json({ error: "jobId, loginName, and role are required." });
  }

  try {
    const raw = await kvGet(JOBS_KEY);
    const jobs = raw ? JSON.parse(raw) : [];
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return res.status(404).json({ error: "Job not found." });

    const ackToken = crypto.randomBytes(16).toString("hex");
    jobs[idx] = { ...jobs[idx], ackToken };
    await kvSet(JOBS_KEY, JSON.stringify(jobs));

    const result = await sendPushToPatrolman(loginName, role, {
      title: title || "New job dispatched",
      body: pushBody || "",
      jobId,
      ackToken,
      url: "/",
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("notify-job failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

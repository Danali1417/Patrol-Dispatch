// Triggered by Control Room right after dispatching or reassigning a
// job — sends a push notification to the assigned patrolman and stamps
// the job with a one-time random token that only quick-ack.js accepts,
// so the notification's "Acknowledge" button can confirm receipt
// without the patrolman ever opening the app.

import crypto from "node:crypto";
import { requireRole } from "./_lib/auth.js";
import { kvGet, kvSet } from "./_lib/supabase.js";
import { sendPushToPatrolman } from "./_lib/push.js";

const JOBS_KEY = "ops:jobs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const session = requireRole(req, res, ["manager", "operator"]);
  if (!session) return;

  const { jobId, loginName, role, title, body } = req.body || {};
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
      body: body || "",
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

// Vercel Cron hits this every 5 minutes (see vercel.json) to pop any job
// Control Room scheduled for later (NewJobForm's "Schedule this for later"
// option, or ScheduledJobView's own reschedule) once its scheduled time
// arrives — see promoteScheduledJobs in jobArchive.js for what that
// actually does. Separate from daily-report.js's own cron (which only
// fires once a day) since scheduled jobs need to be checked far more
// often than that to pop on time.
//
// Required env vars: same CRON_SECRET as daily-report.js — Vercel sends
// it automatically as a Bearer token when a Cron Job calls this path.

import { promoteScheduledJobs } from "./_lib/jobArchive.js";

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — misconfigured, not "open"
  const header = req.headers.authorization;
  if (header === `Bearer ${secret}`) return true;
  const q = req.query?.secret;
  return q === secret;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: process.env.CRON_SECRET ? "Unauthorized" : "CRON_SECRET is not configured on the server" });
  }
  try {
    const result = await promoteScheduledJobs();
    return res.status(200).json(result);
  } catch (err) {
    console.error("promote-scheduled-jobs failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

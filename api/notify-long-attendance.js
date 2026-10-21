// Sends a one-off heads-up email to managers when a Response job's time
// onsite (onsiteTime to offsiteTime) comes in over LONG_ATTENDANCE_THRESHOLD_MIN
// minutes — fired client-side the moment the job reaches "reviewed" or
// "emailed" (see the update() wrapper in JobDetailOperator, src/App.jsx),
// not on a daily cron, since the point is prompt awareness while it's
// still fresh enough to actually look into. Re-derives everything from
// the live job record rather than trusting the client's own numbers, so
// a stale or tampered client call can't spam managers or report a
// duration that doesn't match what's actually on the job.
//
// Optional feature — silently does nothing without its own env var:
//   LONG_ATTENDANCE_RECIPIENTS   comma-separated manager email address(es)
// Also needs RESEND_API_KEY / MAIL_FROM (see _lib/mail.js), same as every
// other email this app sends.

import { requireRole } from "./_lib/auth.js";
import { kvGet } from "./_lib/supabase.js";
import { isMailConfigured, getMailFrom, createMailTransporter } from "./_lib/mail.js";
import { isResponseJob, fmtDateTime } from "../src/reportUtils.js";

const JOBS_KEY = "ops:jobs";
const THRESHOLD_MIN = 25;
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "Australia/Sydney";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const session = await requireRole(req, res, ["manager", "operator"]);
  if (!session) return;

  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ error: "jobId is required." });

  const to = process.env.LONG_ATTENDANCE_RECIPIENTS;
  if (!to || !isMailConfigured()) return res.status(200).json({ ok: true, sent: false, reason: "not-configured" });

  try {
    const raw = await kvGet(JOBS_KEY);
    const jobs = raw ? JSON.parse(raw) : [];
    const job = Array.isArray(jobs) ? jobs.find((j) => j.id === jobId) : null;
    if (!job) return res.status(404).json({ error: "Job not found." });

    if (!isResponseJob(job) || !job.onsiteTime || !job.offsiteTime) {
      return res.status(200).json({ ok: true, sent: false, reason: "condition not met" });
    }
    const minutesOnsite = Math.round((new Date(job.offsiteTime).getTime() - new Date(job.onsiteTime).getTime()) / 60000);
    if (minutesOnsite <= THRESHOLD_MIN) {
      return res.status(200).json({ ok: true, sent: false, reason: "under threshold" });
    }

    const transporter = createMailTransporter();
    await transporter.sendMail({
      from: getMailFrom(),
      to,
      subject: `Long attendance — ${job.jobNumber} (${minutesOnsite}m onsite)`,
      text: [
        `${job.jobNumber} — ${job.siteName || "—"}`,
        `Patrolman: ${job.assigneeName || "—"}${job.run ? ` (${job.run})` : ""}`,
        `Dispatched: ${fmtDateTime(job.dispatchTime, REPORT_TIMEZONE)}`,
        `Onsite: ${fmtDateTime(job.onsiteTime, REPORT_TIMEZONE)}`,
        `Offsite: ${fmtDateTime(job.offsiteTime, REPORT_TIMEZONE)}`,
        `Time onsite: ${minutesOnsite} minutes (flagged over ${THRESHOLD_MIN}m)`,
        ``,
        `Result: ${job.reviewNotes || job.outcomeNotes || "—"}`,
      ].join("\n"),
    });
    return res.status(200).json({ ok: true, sent: true, minutesOnsite });
  } catch (err) {
    console.error("notify-long-attendance failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

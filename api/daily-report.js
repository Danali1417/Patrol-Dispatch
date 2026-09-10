// Vercel Cron hits this once a day (see vercel.json — Vercel's free/Hobby
// plan only allows daily-frequency cron jobs, so this can't just poll every
// few minutes). The single daily UTC fire time is chosen to land within
// ~30 minutes of the target local send time on both sides of a daylight
// saving transition; the tolerance check below accepts that and skips
// itself if invoked well outside the target window for any other reason.
//
// vercel.json also raises this function's maxDuration to 60s (Hobby's
// ceiling) — archiveOldJobs() below can send one photo-backup email per
// job it archives (run with bounded concurrency, see jobArchive.js), and
// the platform default (10s) could get cut off mid-run on a day with an
// unusually large backlog. The report itself is built and sent before
// archiving runs, specifically so a slow or maxed-out archive sweep can
// never delay or block today's report email.
//
// Required env vars (set in Vercel → Project Settings → Environment Variables):
//   RESEND_API_KEY        from https://resend.com/api-keys — see api/_lib/mail.js
//   MAIL_FROM             a sender address on a domain verified in Resend
//   REPORT_RECIPIENTS     comma-separated recipient email address(es) for
//                         the daily report itself (and this function's own
//                         failure alert). Separate from JOB_BACKUP_RECIPIENTS
//                         below, which archiveOldJobs() uses instead —
//                         they can be the same addresses or different ones.
//   JOB_BACKUP_RECIPIENTS comma-separated recipient email address(es) —
//                         where closed/cancelled jobs' attendance photos
//                         get emailed before being deleted from Supabase,
//                         both the immediate send on close/cancel and the
//                         48h archive-sweep fallback (see jobArchive.js /
//                         README section 12)
//   CRON_SECRET           any random string — protects this endpoint from
//                         being triggered by anyone who finds the URL.
//                         Vercel automatically sends it as a Bearer token
//                         when a Cron Job calls this path.
// Optional:
//   REPORT_TIMEZONE               IANA zone, default "Australia/Sydney"
//   REPORT_SEND_HOUR              local hour (0-23) to send at, default 7
//   REPORT_SEND_TOLERANCE_MINUTES how far from that hour a single daily
//                                 cron fire is still accepted, default 90

import { getZonedNow } from "./_lib/time.js";
import { kvGet, kvSet } from "./_lib/supabase.js";
import { gatherReportData } from "./_lib/buildReport.js";
import { sendReportEmail } from "./_lib/mailer.js";
import { archiveOldJobs, backfillOrphanedPhotoBackups } from "./_lib/jobArchive.js";
import { isMailConfigured, getMailFrom, createMailTransporter } from "./_lib/mail.js";

const SENT_DATE_KEY = "ops:dailyReportSentDate";

// The report failing used to be visible only in Vercel's function logs —
// nobody actually watches those, so a bad day just went unnoticed. This
// sends a short heads-up to the same recipients instead, for the two ways
// a day can go by with no report and no error anyone sees: the send itself
// throwing, or the single daily cron fire landing outside the accepted
// window. Best-effort and uses the same Resend credentials as the report
// itself, so it can't help when those credentials are what's broken —
// there's no second channel configured to fall back to.
async function sendFailureAlert(req, reason, detail) {
  const to = process.env.REPORT_RECIPIENTS;
  if (!to || !isMailConfigured()) return;
  try {
    // Built from the request that's hitting this endpoint right now, rather
    // than a hardcoded placeholder — a copy-pasted "your-app.vercel.app"
    // example domain is indistinguishable from a real one and can land
    // someone on a stranger's unrelated site instead of their own app.
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    const retryUrl = host ? `${proto}://${host}/api/daily-report?test=1&secret=YOUR_CRON_SECRET` : null;

    const transporter = createMailTransporter();
    await transporter.sendMail({
      from: getMailFrom(),
      to,
      subject: `Daily alarm report did not send — ${reason}`,
      text: [
        "Today's daily alarm report did not go out.",
        "",
        `Reason: ${reason}`,
        detail ? `Details: ${detail}` : null,
        "",
        retryUrl ? "To send it now, visit (replacing YOUR_CRON_SECRET with the real one):" : null,
        retryUrl,
      ].filter((l) => l !== null).join("\n"),
    });
  } catch (err) {
    console.error("failure alert email also failed to send:", err);
  }
}

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

  // Manual, one-off trigger for recovering photo backups stranded by a
  // past mail outage (see backfillOrphanedPhotoBackups in jobArchive.js) —
  // separate from the daily report/archive flow below, and safe to re-run.
  // Visit /api/daily-report?backfillPhotos=1&secret=YOUR_CRON_SECRET once.
  if (req.query?.backfillPhotos === "1") {
    try {
      const result = await backfillOrphanedPhotoBackups();
      return res.status(200).json({ backfill: result });
    } catch (err) {
      console.error("photo backup backfill failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  const timeZone = process.env.REPORT_TIMEZONE || "Australia/Sydney";
  const sendHour = Number(process.env.REPORT_SEND_HOUR || 7);
  const toleranceMinutes = Number(process.env.REPORT_SEND_TOLERANCE_MINUTES || 90);
  const testMode = req.query?.test === "1";
  const now = new Date();
  const zonedNow = getZonedNow(timeZone, now);
  const minutesFromTarget = Math.abs(zonedNow.hour * 60 + zonedNow.minute - sendHour * 60);
  const inSendWindow = minutesFromTarget <= toleranceMinutes;

  // Builds and sends the report first — archiving (below) is a variable
  // amount of work (one email send per job needing a photo backup) that
  // used to run before this and get awaited, so a backlog of jobs to
  // archive could eat the whole 60s ceiling (vercel.json) before this
  // function ever got here, and no report went out at all. Report result
  // is captured instead of returned early so archiving still always runs.
  let reportOutcome;
  if (!testMode && !inSendWindow) {
    await sendFailureAlert(
      req,
      "cron fired outside the expected send window",
      `Ran at ${String(zonedNow.hour).padStart(2, "0")}:${String(zonedNow.minute).padStart(2, "0")} ${timeZone}, target is ${sendHour}:00 ± ${toleranceMinutes}m.`
    );
    reportOutcome = { status: 200, body: { skipped: true, reason: "outside send window", zonedNow } };
  } else {
    try {
      const data = await gatherReportData({ timeZone, now });
      const alreadySent = !testMode && (await kvGet(SENT_DATE_KEY));
      if (alreadySent === data.window.dateKey) {
        reportOutcome = { status: 200, body: { skipped: true, reason: "already sent today", dateKey: data.window.dateKey } };
      } else {
        const recipients = (process.env.REPORT_RECIPIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!recipients.length) {
          reportOutcome = { status: 500, body: { error: "REPORT_RECIPIENTS is not configured" } };
        } else if (!isMailConfigured()) {
          reportOutcome = { status: 500, body: { error: "RESEND_API_KEY / MAIL_FROM are not configured" } };
        } else {
          const transporter = createMailTransporter();
          const { subject } = await sendReportEmail({
            data, recipients, from: getMailFrom(), transporter, now,
          });
          if (!testMode) await kvSet(SENT_DATE_KEY, data.window.dateKey);
          reportOutcome = {
            status: 200,
            body: { sent: true, testMode, recipients, subject, jobCount: data.filteredJobs.length, window: data.window },
          };
        }
      }
    } catch (err) {
      console.error("daily-report failed:", err);
      await sendFailureAlert(req, "unexpected error while building or sending the report", String(err?.message || err));
      reportOutcome = { status: 500, body: { error: String(err?.message || err) } };
    }
  }

  // Runs after the report, regardless of its outcome — a deployment that
  // hasn't set up RESEND_API_KEY etc. still needs its board kept small, and a
  // slow or failing archive sweep here must never delay or block today's
  // report (a bad connection just leaves that job's backup for tomorrow's
  // run — see backupAndDeletePhotos).
  let archiveResult = null;
  try {
    archiveResult = await archiveOldJobs();
  } catch (err) {
    console.error("job archiving failed:", err);
  }

  return res.status(reportOutcome.status).json({ ...reportOutcome.body, archived: archiveResult });
}

// Vercel Cron hits this once a day (see vercel.json — Vercel's free/Hobby
// plan only allows daily-frequency cron jobs, so this can't just poll every
// few minutes). The single daily UTC fire time is chosen to land within
// ~30 minutes of the target local send time on both sides of a daylight
// saving transition; the tolerance check below accepts that and skips
// itself if invoked well outside the target window for any other reason.
//
// Required env vars (set in Vercel → Project Settings → Environment Variables):
//   GMAIL_USER            the Gmail address to send from
//   GMAIL_APP_PASSWORD    the 16-character App Password for that account
//   REPORT_RECIPIENTS     comma-separated recipient email address(es)
//   CRON_SECRET           any random string — protects this endpoint from
//                         being triggered by anyone who finds the URL.
//                         Vercel automatically sends it as a Bearer token
//                         when a Cron Job calls this path.
// Optional:
//   REPORT_TIMEZONE               IANA zone, default "Australia/Sydney"
//   REPORT_SEND_HOUR              local hour (0-23) to send at, default 7
//   REPORT_SEND_TOLERANCE_MINUTES how far from that hour a single daily
//                                 cron fire is still accepted, default 90
//   PHOTO_BACKUP_EMAIL            where archived jobs' attendance photos
//                                 get emailed before being deleted from
//                                 Supabase (see jobArchive.js / README
//                                 section 12) — defaults to
//                                 REPORT_RECIPIENTS if unset

import nodemailer from "nodemailer";
import { getZonedNow } from "./_lib/time.js";
import { kvGet, kvSet } from "./_lib/supabase.js";
import { gatherReportData } from "./_lib/buildReport.js";
import { sendReportEmail } from "./_lib/mailer.js";
import { archiveOldJobs } from "./_lib/jobArchive.js";

const SENT_DATE_KEY = "ops:dailyReportSentDate";

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

  // Runs unconditionally on every cron fire, independent of the email
  // report below — a deployment that hasn't set up GMAIL_USER etc. still
  // needs its board kept small, and a failure here shouldn't block today's
  // email from going out (or vice versa).
  let archiveResult = null;
  try {
    archiveResult = await archiveOldJobs();
  } catch (err) {
    console.error("job archiving failed:", err);
  }

  const timeZone = process.env.REPORT_TIMEZONE || "Australia/Sydney";
  const sendHour = Number(process.env.REPORT_SEND_HOUR || 7);
  const toleranceMinutes = Number(process.env.REPORT_SEND_TOLERANCE_MINUTES || 90);
  const testMode = req.query?.test === "1";
  const now = new Date();
  const zonedNow = getZonedNow(timeZone, now);
  const minutesFromTarget = Math.abs(zonedNow.hour * 60 + zonedNow.minute - sendHour * 60);
  const inSendWindow = minutesFromTarget <= toleranceMinutes;

  if (!testMode && !inSendWindow) {
    return res.status(200).json({ skipped: true, reason: "outside send window", zonedNow, archived: archiveResult });
  }

  try {
    const data = await gatherReportData({ timeZone, now });

    if (!testMode) {
      const alreadySent = await kvGet(SENT_DATE_KEY);
      if (alreadySent === data.window.dateKey) {
        return res.status(200).json({ skipped: true, reason: "already sent today", dateKey: data.window.dateKey, archived: archiveResult });
      }
    }

    const recipients = (process.env.REPORT_RECIPIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!recipients.length) {
      return res.status(500).json({ error: "REPORT_RECIPIENTS is not configured", archived: archiveResult });
    }
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      return res.status(500).json({ error: "GMAIL_USER / GMAIL_APP_PASSWORD are not configured", archived: archiveResult });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    const { subject } = await sendReportEmail({
      data, recipients, from: process.env.GMAIL_USER, transporter, now,
    });

    if (!testMode) {
      await kvSet(SENT_DATE_KEY, data.window.dateKey);
    }

    return res.status(200).json({
      sent: true, testMode, recipients, subject,
      jobCount: data.filteredJobs.length, window: data.window, archived: archiveResult,
    });
  } catch (err) {
    console.error("daily-report failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

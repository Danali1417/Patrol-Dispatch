// Vercel Cron hits this on a schedule (see vercel.json). It only actually
// sends once a day, right after the configured local send time, and skips
// itself the rest of the time it's invoked.
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
//   REPORT_TIMEZONE       IANA zone, default "Australia/Sydney"
//   REPORT_SEND_HOUR      local hour (0-23) to send at, default 7

import nodemailer from "nodemailer";
import { getZonedNow } from "./_lib/time.js";
import { kvGet, kvSet } from "./_lib/supabase.js";
import { gatherReportData } from "./_lib/buildReport.js";
import { sendReportEmail } from "./_lib/mailer.js";

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

  const timeZone = process.env.REPORT_TIMEZONE || "Australia/Sydney";
  const sendHour = Number(process.env.REPORT_SEND_HOUR || 7);
  const testMode = req.query?.test === "1";
  const now = new Date();
  const zonedNow = getZonedNow(timeZone, now);
  const inSendWindow = zonedNow.hour === sendHour && zonedNow.minute < 15;

  if (!testMode && !inSendWindow) {
    return res.status(200).json({ skipped: true, reason: "outside send window", zonedNow });
  }

  try {
    const data = await gatherReportData({ timeZone, now });

    if (!testMode) {
      const alreadySent = await kvGet(SENT_DATE_KEY);
      if (alreadySent === data.window.dateKey) {
        return res.status(200).json({ skipped: true, reason: "already sent today", dateKey: data.window.dateKey });
      }
    }

    const recipients = (process.env.REPORT_RECIPIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!recipients.length) {
      return res.status(500).json({ error: "REPORT_RECIPIENTS is not configured" });
    }
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      return res.status(500).json({ error: "GMAIL_USER / GMAIL_APP_PASSWORD are not configured" });
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
      jobCount: data.filteredJobs.length, window: data.window,
    });
  } catch (err) {
    console.error("daily-report failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

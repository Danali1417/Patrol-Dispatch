// Shared mail-sending config for every place this app sends email
// (daily-report.js, send-client-email.js, jobArchive.js) — all of it goes
// through Resend's SMTP relay instead of a Gmail account. A Gmail App
// Password login, done repeatedly and automatically from Vercel's
// serverless IPs with no browser or device behind it, is exactly the
// pattern Google's abuse detection flags as bot activity — which is what
// got the previous sending account blocked. Resend (and other
// transactional-email providers) are built for this exact use case and
// authenticate with an API key instead of impersonating a personal
// mailbox login.
//
// Required env vars (set in Vercel → Project Settings → Environment Variables):
//   RESEND_API_KEY   from https://resend.com/api-keys
//   MAIL_FROM        a sender address on a domain verified in Resend,
//                     e.g. "Ausgroup Dispatch <dispatch@yourdomain.com>".
//                     Resend's own onboarding@resend.dev sandbox address
//                     only delivers to your own Resend account email, not
//                     to real recipients — a verified domain is required
//                     for actually sending client/report emails.

import nodemailer from "nodemailer";

export function isMailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

export function getMailFrom() {
  return process.env.MAIL_FROM;
}

// Short timeouts (nodemailer defaults to up to 2 minutes) so one bad
// connection can't eat an interactive request or a big chunk of the
// daily-report cron's own time budget — same reasoning each call site
// already had for its own Gmail transporter. connectionTimeout and
// greetingTimeout only govern connection setup, so they stay tight;
// socketTimeout (idle time once the connection's up) gets more headroom
// than that so relaying the client email's full-resolution photo
// attachments — several MB each — doesn't get cut off mid-transfer.
export function createMailTransporter() {
  return nodemailer.createTransport({
    host: "smtp.resend.com",
    port: 465,
    secure: true,
    auth: { user: "resend", pass: process.env.RESEND_API_KEY },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

// Resend's own account-usage API — lets the manual ?checkEmailQuota=1
// check (see daily-report.js) report the real daily/monthly reset time
// instead of guessing. Worth having after a real incident (18 Nov 2026):
// Resend's own docs describe the free daily quota two different,
// contradictory ways — a rolling 24h window in one place, a fixed UTC
// midnight reset in another — and what actually happened that day (a
// resend batch got 4 of 12 through, then hit the wall again moments
// later, well before any single clean reset instant could explain it)
// matches the rolling-window description, not a fixed reset time. Same
// RESEND_API_KEY as the SMTP transporter above works as a Bearer token
// here — Resend's API keys aren't SMTP-only.
//
// As of writing, Resend's Usage API is in private beta and may not be
// enabled for every account — a 404 here means "not available", not a
// real failure, so callers should treat `available: false` as a normal,
// expected outcome rather than an error.
export async function fetchResendQuota() {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const res = await fetch("https://api.resend.com/usage", {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
  });
  if (res.status === 404) {
    return { available: false, reason: "Usage API isn't enabled for this Resend account (it's in private beta)." };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend usage check failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return { available: true, daily: data.daily || null, monthly: data.monthly || null };
}

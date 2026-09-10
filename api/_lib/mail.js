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
// already had for its own Gmail transporter.
export function createMailTransporter() {
  return nodemailer.createTransport({
    host: "smtp.resend.com",
    port: 465,
    secure: true,
    auth: { user: "resend", pass: process.env.RESEND_API_KEY },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
}

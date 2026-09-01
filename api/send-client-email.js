// Sends a one-off email using the same Gmail account as the daily report.
// Two callers, two shapes of request:
//   - The Control Room job screen (EmailModal in src/App.jsx) sends the
//     client-facing "alarm response outcome" advice — `to` is whatever
//     client address the operator entered.
//   - Every close/cancel action also fires an internal photo backup
//     (internalBackup: true) the moment the job closes, so REPORT_RECIPIENTS
//     doesn't wait for the 48h archive sweep — see jobArchive.js, which
//     skips re-sending a job whose backup already went out this way. `to`
//     is never accepted from the client for this one; REPORT_RECIPIENTS is
//     a server-only env var precisely so the browser never needs to know it.
//   - Picking "New Client" while adding a site (internalAlert: true) also
//     routes to REPORT_RECIPIENTS the same way — see notifyNewClient in
//     src/App.jsx.
//
// Required env vars (already set for the daily report — reused here):
//   GMAIL_USER, GMAIL_APP_PASSWORD, REPORT_RECIPIENTS (internalBackup only)
// Also required:
//   VITE_APP_MAIL_SECRET   any random string. Set it once in Vercel and the
//                          client bundle picks it up automatically (the
//                          VITE_ prefix is what exposes it to the browser).
//                          This isn't real authentication — anyone who can
//                          load the app can read it out of the JS bundle,
//                          same trust model as this app's open Supabase
//                          key — it just keeps the endpoint from being
//                          found and hit by random internet scanners.

import nodemailer from "nodemailer";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.VITE_APP_MAIL_SECRET;
  if (!secret || req.headers["x-app-secret"] !== secret) {
    return res.status(401).json({ error: secret ? "Unauthorized" : "VITE_APP_MAIL_SECRET is not configured on the server" });
  }

  const { to: requestedTo, subject, text, html, attachments, internalBackup, internalAlert } = req.body || {};

  let to;
  if (internalBackup === true || internalAlert === true) {
    to = process.env.REPORT_RECIPIENTS;
    if (!to) {
      return res.status(500).json({ error: "REPORT_RECIPIENTS is not configured" });
    }
  } else {
    to = requestedTo;
    if (!to || !/\S+@\S+\.\S+/.test(to)) {
      return res.status(400).json({ error: "A valid recipient email is required" });
    }
  }
  if (!subject || !text) {
    return res.status(400).json({ error: "subject and text are required" });
  }
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: "GMAIL_USER / GMAIL_APP_PASSWORD are not configured" });
  }

  try {
    // Both callers of this endpoint are awaited from an interactive UI
    // action (sending the client email, or the photo backup fired the
    // moment a job closes/cancels — see sendPhotoBackupEmail in
    // src/App.jsx) — nodemailer's defaults (up to 2 minutes to even give
    // up on a connection) would otherwise freeze that action's button for
    // just as long during a Gmail outage. 10s bounds the worst case.
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
    const mail = { from: process.env.GMAIL_USER, to, subject, text, ...(html ? { html } : {}) };
    if (Array.isArray(attachments) && attachments.length) {
      mail.attachments = attachments
        .filter((a) => a && a.content && a.filename)
        .map((a) => ({ filename: a.filename, content: a.content, encoding: "base64", ...(a.contentType ? { contentType: a.contentType } : {}) }));
    }
    await transporter.sendMail(mail);
    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error("send-client-email failed:", err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

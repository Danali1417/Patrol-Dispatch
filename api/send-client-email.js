// Sends a one-off "alarm response outcome" email to a client, triggered
// interactively from the Control Room job screen (EmailModal in
// src/App.jsx), using the same Gmail account as the daily report.
//
// Required env vars (already set for the daily report — reused here):
//   GMAIL_USER, GMAIL_APP_PASSWORD
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

  const { to, subject, text, html, attachments } = req.body || {};
  if (!to || !/\S+@\S+\.\S+/.test(to)) {
    return res.status(400).json({ error: "A valid recipient email is required" });
  }
  if (!subject || !text) {
    return res.status(400).json({ error: "subject and text are required" });
  }
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: "GMAIL_USER / GMAIL_APP_PASSWORD are not configured" });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
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

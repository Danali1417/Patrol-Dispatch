// Manual diagnostic tool for troubleshooting push delivery — visit with
// a browser on the device you want to test, so a successful test push
// shows up immediately on that same device. Gated by MIGRATE_SECRET
// (reused rather than adding yet another secret) since this is a
// one-off debugging aid, not part of normal app operation.
//
// Usage: /api/push-debug?loginName=X&role=patrolman&secret=...

import webpush from "web-push";
import { kvGet } from "./_lib/supabase.js";

const SUBS_KEY = "ops:pushSubscriptions";

export default async function handler(req, res) {
  const secret = process.env.MIGRATE_SECRET;
  const provided = req.query?.secret;
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: secret ? "Unauthorized" : "MIGRATE_SECRET is not configured on the server" });
  }

  const { loginName, role } = req.query || {};
  if (!loginName || !role) {
    return res.status(400).json({ error: "loginName and role query params are required." });
  }

  try {
    const raw = await kvGet(SUBS_KEY);
    const subs = raw ? JSON.parse(raw) : {};
    const key = `${role}:${loginName}`;
    const list = subs[key] || [];

    const publicKey = process.env.VITE_VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || "mailto:support@example.com";
    const vapidConfigured = !!(publicKey && privateKey);
    if (vapidConfigured) webpush.setVapidDetails(subject, publicKey, privateKey);

    const results = [];
    for (const sub of list) {
      let endpointHost = "";
      try { endpointHost = new URL(sub.endpoint).hostname; } catch (e) { /* leave blank */ }
      const entry = { endpointHost, endpointTail: sub.endpoint.slice(-16), hasKeys: !!(sub.keys && sub.keys.p256dh && sub.keys.auth) };
      if (vapidConfigured) {
        try {
          const sendResult = await webpush.sendNotification(
            sub,
            JSON.stringify({ title: "Push debug test (plain)", body: "If you can see this, delivery works.", jobId: null, ackToken: null }),
            { urgency: "high", TTL: 60 }
          );
          entry.plainTestSend = { ok: true, statusCode: sendResult.statusCode };
        } catch (err) {
          entry.plainTestSend = { ok: false, statusCode: err.statusCode, headers: err.headers, body: err.body, message: err.message };
        }
        // Same shape a real dispatch sends — job id, ack token, and the
        // Acknowledge action button — to test whether that specific
        // shape is what's actually failing to display.
        try {
          const sendResult2 = await webpush.sendNotification(
            sub,
            JSON.stringify({
              title: "Push debug test (realistic)",
              body: "Same shape as a real dispatch — action button included.",
              jobId: "debug-job-id",
              ackToken: "debug-token",
              url: "/",
            }),
            { urgency: "high", TTL: 60 }
          );
          entry.realisticTestSend = { ok: true, statusCode: sendResult2.statusCode };
        } catch (err) {
          entry.realisticTestSend = { ok: false, statusCode: err.statusCode, headers: err.headers, body: err.body, message: err.message };
        }
      }
      results.push(entry);
    }

    return res.status(200).json({
      loginName,
      role,
      vapidConfigured,
      vapidPublicKeyTail: publicKey ? publicKey.slice(-12) : null,
      subscriptionCount: list.length,
      results,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err?.message || err) });
  }
}

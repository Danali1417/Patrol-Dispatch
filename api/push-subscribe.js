// Registers (or removes) a browser's Web Push subscription for the
// signed-in login, so notify-job.js has somewhere to deliver to.

import { requireSession } from "./_lib/auth.js";
import { addSubscription, removeSubscription } from "./_lib/push.js";

export default async function handler(req, res) {
  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === "POST") {
    const { subscription } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: "A valid push subscription is required." });
    }
    try {
      await addSubscription(session.loginName, session.role, subscription);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("push-subscribe failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  if (req.method === "DELETE") {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint is required." });
    try {
      await removeSubscription(session.loginName, session.role, endpoint);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("push-unsubscribe failed:", err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

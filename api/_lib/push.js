// Web Push subscription storage + sending. Subscriptions are stored
// keyed by "role:loginName" (a patrolman can have more than one device
// subscribed — e.g. after a phone swap without ever explicitly
// unsubscribing the old one).

import webpush from "web-push";
import { kvGet, kvSet } from "./supabase.js";

const SUBS_KEY = "ops:pushSubscriptions";

function configureWebPush() {
  const publicKey = process.env.VITE_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:support@example.com";
  if (!publicKey || !privateKey) {
    throw new Error("VITE_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not configured on the server");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

async function loadSubs() {
  const raw = await kvGet(SUBS_KEY);
  return raw ? JSON.parse(raw) : {};
}

async function saveSubs(subs) {
  await kvSet(SUBS_KEY, JSON.stringify(subs));
}

export async function addSubscription(loginName, role, subscription) {
  const subs = await loadSubs();
  const key = `${role}:${loginName}`;
  const list = subs[key] || [];
  if (!list.some((s) => s.endpoint === subscription.endpoint)) {
    list.push(subscription);
  }
  subs[key] = list;
  await saveSubs(subs);
}

export async function removeSubscription(loginName, role, endpoint) {
  const subs = await loadSubs();
  const key = `${role}:${loginName}`;
  subs[key] = (subs[key] || []).filter((s) => s.endpoint !== endpoint);
  await saveSubs(subs);
}

// Sends payload to every device subscribed for this login, pruning any
// the push service reports as gone (410/404 — uninstalled or expired).
export async function sendPushToPatrolman(loginName, role, payload) {
  configureWebPush();
  const subs = await loadSubs();
  const key = `${role}:${loginName}`;
  const list = subs[key] || [];
  if (!list.length) return { sent: 0, total: 0 };

  let sent = 0;
  const survivors = [];
  await Promise.all(
    list.map(async (sub) => {
      try {
        // urgency:"high" tells the push service (FCM on Android) to
        // wake the device out of Doze/battery-saving states for timely
        // delivery — without it, Android can silently hold a "normal"
        // priority push for a long time with no visible failure.
        await webpush.sendNotification(sub, JSON.stringify(payload), { urgency: "high", TTL: 3600 });
        sent++;
        survivors.push(sub);
      } catch (err) {
        if (err.statusCode !== 404 && err.statusCode !== 410) survivors.push(sub);
      }
    })
  );
  if (survivors.length !== list.length) {
    subs[key] = survivors;
    await saveSubs(subs);
  }
  return { sent, total: list.length };
}

// Broadcasts to every subscribed device across every login of a given
// role — used for alerts (e.g. "patrolman stationary 30+ min") aimed at
// whoever's on duty in Control Room, rather than one specific login.
export async function sendPushToRole(role, payload) {
  configureWebPush();
  const subs = await loadSubs();
  const prefix = `${role}:`;
  let sent = 0;
  let total = 0;
  let changed = false;

  await Promise.all(
    Object.keys(subs).filter((k) => k.startsWith(prefix)).map(async (key) => {
      const list = subs[key] || [];
      total += list.length;
      const survivors = [];
      await Promise.all(
        list.map(async (sub) => {
          try {
            await webpush.sendNotification(sub, JSON.stringify(payload), { urgency: "high", TTL: 3600 });
            sent++;
            survivors.push(sub);
          } catch (err) {
            if (err.statusCode !== 404 && err.statusCode !== 410) survivors.push(sub);
          }
        })
      );
      if (survivors.length !== list.length) {
        subs[key] = survivors;
        changed = true;
      }
    })
  );

  if (changed) await saveSubs(subs);
  return { sent, total };
}

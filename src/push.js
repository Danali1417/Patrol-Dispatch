// Client side of job-dispatch push notifications: registering the
// service worker, subscribing/unsubscribing this device, and (for
// Control Room) firing a push after dispatching or reassigning a job.

import { getToken, reportUnauthorized } from "./auth.js";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    reportUnauthorized();
    throw new Error("Session expired — please sign in again.");
  }
  return res;
}

export async function getPushStatus() {
  if (!pushSupported()) return { supported: false, permission: "unsupported", subscribed: false };
  const permission = Notification.permission;
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      subscribed = !!sub;
    }
  } catch (e) { /* treat as not subscribed */ }
  return { supported: true, permission, subscribed };
}

export async function enableJobAlerts() {
  if (!pushSupported()) throw new Error("This browser doesn't support push notifications.");
  const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (!publicKey) throw new Error("Push notifications aren't configured yet — ask your Manager.");

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission wasn't granted.");

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const res = await apiFetch("/api/push-subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Couldn't save the subscription.");
  }
}

export async function disableJobAlerts() {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    await apiFetch("/api/push-subscribe", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => {});
    await subscription.unsubscribe();
  } catch (e) { /* best-effort */ }
}

// Best-effort — a failed push should never block dispatching a job.
// Returns a result so the caller can tell Control Room what happened
// (no subscribed device, delivery failed, or delivered) rather than
// dispatching blind — resolves rather than throws even on failure.
export async function notifyJobDispatch({ jobId, loginName, role, title, body }) {
  try {
    const res = await apiFetch("/api/notify-job", {
      method: "POST",
      body: JSON.stringify({ jobId, loginName, role, title, body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, sent: 0, total: 0, error: data.error || `Failed (${res.status})` };
    return { ok: true, sent: data.sent ?? 0, total: data.total ?? 0 };
  } catch (e) {
    console.error("notifyJobDispatch failed:", e);
    return { ok: false, sent: 0, total: 0, error: e.message || String(e) };
  }
}

// Notifies the patrolman a job is being taken away from them (reassigned
// to someone else) — same best-effort/never-throw contract as
// notifyJobDispatch.
export async function notifyStandDown({ jobId, loginName, patrolmanName, reassignedToName }) {
  try {
    const res = await apiFetch("/api/notify-job", {
      method: "POST",
      body: JSON.stringify({ mode: "standdown", jobId, loginName, patrolmanName, reassignedToName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, sent: 0, total: 0, error: data.error || `Failed (${res.status})` };
    return { ok: true, sent: data.sent ?? 0, total: data.total ?? 0 };
  } catch (e) {
    console.error("notifyStandDown failed:", e);
    return { ok: false, sent: 0, total: 0, error: e.message || String(e) };
  }
}

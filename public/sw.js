// Service worker for job-dispatch push notifications. Deliberately
// minimal — no asset caching/offline support, just push handling — so
// there's nothing here to go stale and fight the app's normal updates.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "New job dispatched";
  // Dispatch/stand-down notices share one tag per job so a re-send
  // replaces the last one instead of piling up — but a chat message is
  // meant to read like a text thread, so each one gets its own untagged
  // notification and they stack in the notification shade instead of
  // collapsing into just the latest.
  const isChat = data.kind === "chat";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: !isChat && data.jobId ? `job-${data.jobId}` : undefined,
    renotify: !isChat && !!data.jobId,
    requireInteraction: true,
    data: { jobId: data.jobId, ackToken: data.ackToken, url: data.url || "/", kind: data.kind },
    // Only stand-down notices get the lock-screen one-tap Acknowledge
    // action — acknowledging a new job dispatch now requires confirming
    // an ETA first (see EtaModal in src/App.jsx), which a bare
    // notification tap can't do.
    actions: data.jobId && data.ackToken && data.kind === "standdown" ? [{ action: "acknowledge", title: "✅ Acknowledge" }] : [],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  const { jobId, ackToken, url } = event.notification.data || {};
  event.notification.close();

  if (event.action === "acknowledge" && jobId && ackToken) {
    event.waitUntil(
      fetch(`/api/quick-ack?jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(ackToken)}`, {
        method: "POST",
      }).catch(() => {})
    );
    return;
  }

  // Plain tap (not the action button) — bring the app to the front,
  // focusing an existing tab if one's already open.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url || "/");
    })
  );
});

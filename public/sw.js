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
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.jobId ? `job-${data.jobId}` : undefined,
    renotify: !!data.jobId,
    requireInteraction: true,
    data: { jobId: data.jobId, ackToken: data.ackToken, kind: data.kind, url: data.url || "/" },
    actions: data.jobId && data.ackToken ? [{ action: "acknowledge", title: "✅ Acknowledge" }] : [],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  const { jobId, ackToken, kind, url } = event.notification.data || {};
  event.notification.close();

  if (event.action === "acknowledge" && jobId && ackToken) {
    const endpoint = kind === "standdown" ? "/api/quick-standdown-ack" : "/api/quick-ack";
    event.waitUntil(
      fetch(`${endpoint}?jobId=${encodeURIComponent(jobId)}&token=${encodeURIComponent(ackToken)}`, {
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

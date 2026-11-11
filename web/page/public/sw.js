// PiRC's service worker: makes the page installable as an app, and shows
// its notifications (docs/web.md, section 6). It caches nothing (the page
// needs the server anyway).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// A session finished its turn (server/notify.ts): {title, body, url, tag}.
// One is always shown: browsers require it of every push.
self.addEventListener("push", (e) => {
  let n = {};
  try {
    n = e.data ? e.data.json() : {};
  } catch {
    // Shown with what there is.
  }
  e.waitUntil(self.registration.showNotification(n.title || "PiRC", {
    body: n.body || "",
    tag: n.tag || "pirc",
    icon: "/icon-192.png",
    data: { url: typeof n.url === "string" && n.url.startsWith("/") ? n.url : "/" },
  }));
});

// Tapped: the app, if open, goes to the chat (App.tsx); else it opens there.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const page = open.find((c) => c.focused) ?? open.find((c) => c.visibilityState === "visible") ?? open[0];
    if (page) {
      await page.focus();
      page.postMessage({ open: url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

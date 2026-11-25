/*
 * H-Pharmacy Customer Inbox service worker: reply notifications only.
 * No fetch handler and no caching, so it never changes how pages load.
 *
 * The push payload is ignored on purpose: every notification shows the same
 * fixed sentence, with no message text, medication details or identifiers.
 * Tapping it opens (or focuses) the Inbox on this site; the chat itself is
 * still opened with the guest session already stored in this browser/app.
 */
const TITLE = "H-Pharmacy";
const BODY = "You have a new reply from H-Pharmacy.";
const INBOX_PATH = "/";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification(TITLE, {
      body: BODY,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: "hp-reply",
      renotify: true,
      data: { path: INBOX_PATH },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const target = new URL(INBOX_PATH, self.location.origin);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        const url = new URL(client.url);
        // Only the customer Inbox (never /admin), on this same site.
        if (url.origin === target.origin && url.pathname === target.pathname) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

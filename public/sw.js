/*
 * H-Pharmacy Customer Inbox service worker: notifications only.
 * No fetch handler and no caching, so it never changes how pages load.
 *
 * The push payload only says WHICH fixed notification to show ("reply" for a
 * customer, "admin" for staff). It never contains message text, names,
 * medication details or identifiers, and nothing from it is displayed.
 * Anything unexpected falls back to the customer "reply" notification, which
 * is what every subscription made before staff notifications receives.
 */
const KINDS = {
  reply: {
    title: "H-Pharmacy",
    body: "You have a new reply from H-Pharmacy.",
    tag: "hp-reply",
    // Customer Inbox only (never /admin); opens with the guest session stored on this device.
    path: "/",
    matches: (url) => url.pathname === "/",
  },
  admin: {
    title: "H-Pharmacy Inbox",
    body: "New customer message.",
    tag: "hp-admin",
    // Staff dashboard; it requires admin sign-in before any chat is shown.
    path: "/admin",
    matches: (url) => url.pathname === "/admin" || url.pathname.startsWith("/admin/"),
  },
};

function kindOf(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (data && data.kind === "admin") return "admin";
  } catch {
    // Not JSON: show the default notification.
  }
  return "reply";
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const kind = kindOf(event);
  const k = KINDS[kind];
  event.waitUntil(
    self.registration.showNotification(k.title, {
      body: k.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: k.tag,
      renotify: true,
      data: { kind },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const k = KINDS[(event.notification.data && event.notification.data.kind) === "admin" ? "admin" : "reply"];
  event.waitUntil(
    (async () => {
      const target = new URL(k.path, self.location.origin);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        const url = new URL(client.url);
        if (url.origin === target.origin && k.matches(url)) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

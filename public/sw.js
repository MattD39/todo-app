// The service worker: a small script the phone or browser keeps for this app
// and runs alongside it. For now it has one job: if you open a page with no
// internet connection, show the "You're offline" page instead of a browser error.
//
// On purpose it does NOT save copies of your task pages. They'd go out of date
// and they contain your data, so pages always come fresh from the server.
//
// Later (push-notifications phase) this file will also receive notifications.

// Change the version when offline.html changes, so phones fetch the new copy.
const CACHE = "offline-v1";
const OFFLINE_URL = "/offline.html";

// First install: save the offline page so it's ready before it's ever needed.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
  // Take over straight away instead of waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Remove copies saved by older versions of this file.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      // Lets the page request start while this worker is still waking up, so
      // pages don't load any slower because of it.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // Only whole-page loads. Everything else (data, images, scripts, form
  // submissions) goes to the network exactly as if this file didn't exist.
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(event.request);
      } catch {
        // No connection (the server can't be reached at all).
        const cache = await caches.open(CACHE);
        return (await cache.match(OFFLINE_URL)) ?? Response.error();
      }
    })(),
  );
});

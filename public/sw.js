// Intentionally does not cache anything: this dashboard's whole point is showing
// current status/visibility/auth state, so serving stale cached responses would be
// actively wrong. This SW exists only to satisfy "installable PWA" criteria in
// browsers that require one (mainly Chrome/Android) for the Add to Home Screen /
// install prompt to appear.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

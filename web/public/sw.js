// Transitional worker: the previous version here was cache-first with
// index.html precached and no cache invalidation, which meant installed
// PWAs kept serving the stale app forever — they'd never even see a fix
// shipped inside index.html itself. Replacing THIS file is the one
// reliable escape hatch (the browser refetches a registered SW script on
// navigation, bypassing the old worker's fetch handler). This version
// tears the old cache down and gets out of the way: no fetch handler at
// all, so everything goes to the network. Offline support returns in the
// upcoming build-tooling refactor as a properly versioned worker at this
// same URL — do not rename or drop sw.js while old clients may exist.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

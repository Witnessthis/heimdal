// Service-worker registration via vite-plugin-pwa (see vite.config.ts
// for the caching strategy — the worker now lives at /service-worker.js,
// not /sw.js; see that file's comment for why the rename wasn't bridged
// for already-installed clients). devOptions.enabled means this also
// registers a real worker under `vite dev` now, not just production
// builds — needed since push notifications require an actual active
// service worker to test against a real phone.
import { registerSW } from 'virtual:pwa-register';

registerSW();

// The pre-Workbox worker cached under this name with no versioning.
// Workbox's cleanupOutdatedCaches only removes caches Workbox itself
// created, so clear the legacy one explicitly — a no-op once gone (or if
// the transitional cache-clearing worker already handled it).
if ('caches' in window) {
  caches.delete('heimdal-v1').catch(() => {});
}

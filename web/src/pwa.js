// Service-worker registration via vite-plugin-pwa (see vite.config.ts for
// the caching strategy and why the sw.js URL must never change). In dev
// the virtual module resolves to a no-op — the worker only exists in
// production builds.
import { registerSW } from 'virtual:pwa-register';

registerSW();

// The pre-Workbox worker cached under this name with no versioning.
// Workbox's cleanupOutdatedCaches only removes caches Workbox itself
// created, so clear the legacy one explicitly — a no-op once gone (or if
// the transitional cache-clearing worker already handled it).
if ('caches' in window) {
  caches.delete('heimdal-v1').catch(() => {});
}

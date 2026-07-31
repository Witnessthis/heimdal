/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

// Deliberately no `fetch` listener anywhere in this file — that's what
// keeps this worker from ever intercepting /api/mail/events (the SSE
// stream) or any other API call. precacheAndRoute above only routes
// requests matching the precached asset list it was given; push/
// notificationclick below don't touch fetch at all.

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Heimdal', {
      body: data.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Same tag for a re-send of the same email collapses into one
      // notification instead of stacking duplicates.
      tag: data.emailId,
      data: { emailId: data.emailId },
    }),
  );
});

// Focuses an already-open tab rather than always opening a new one —
// most of the time the app is already open somewhere in the background.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});

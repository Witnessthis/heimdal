import webpush from 'web-push';
import { getVapidKeys } from './push-keys';
import { getAllSubscriptions, removeSubscription } from './push-subscriptions';

export interface FeedNotification {
  title: string;
  body: string;
  emailId: string;
}

// VAPID's sub claim is how a push service (Apple/Google/Mozilla) can
// identify and, in principle, reach whoever's sending pushes if
// something's wrong — same idea as a User-Agent contact string. Reused
// from DOMAIN (same env var session.ts already reads for the cookie's
// secure flag) rather than a placeholder: a fake/unresolvable subject
// like "mailto:x@localhost" is exactly what got a real deployment
// rejected with 403 BadJwtToken from Apple's push gateway specifically
// (it validates this more strictly than Chrome/Firefox's push
// services do). No DOMAIN means no real subscriptions exist to send to
// anyway — push needs a secure context, which local/plain-HTTP dev
// never has — so this fallback is never actually exercised against a
// real push service.
export function vapidSubject(): string {
  return process.env.DOMAIN ? `https://${process.env.DOMAIN}` : 'mailto:heimdal@localhost';
}

/** Fires a Web Push notification to every subscribed browser/device.
 *  VAPID identity is set fresh on every call rather than cached at
 *  module load — dataDir isn't known until a call arrives, and this
 *  runs rarely enough (once per feed-worthy email) that re-reading the
 *  key file each time costs nothing worth caching for. Same reasoning
 *  is why vapidSubject() above reads DOMAIN fresh each call too, rather
 *  than a module-level constant — trivial to test that way, and the
 *  cost of re-reading one env var is nothing. */
export async function sendFeedNotification(dataDir: string, notification: FeedNotification): Promise<void> {
  const subs = await getAllSubscriptions(dataDir);
  if (subs.length === 0) return;

  const { publicKey, privateKey } = await getVapidKeys(dataDir);
  webpush.setVapidDetails(vapidSubject(), publicKey, privateKey);

  const payload = JSON.stringify(notification);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        // 404/410: the browser dropped this subscription (uninstalled,
        // permission revoked, or the push service expired it) — the
        // endpoint is permanently dead, not a transient failure. Prune
        // it so future sends don't keep paying for it, but don't let
        // one dead subscription stop delivery to the others.
        if (err instanceof webpush.WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          await removeSubscription(dataDir, sub.endpoint);
          return;
        }
        console.error(`Push send failed for ${sub.endpoint}:`, err);
      }
    }),
  );
}

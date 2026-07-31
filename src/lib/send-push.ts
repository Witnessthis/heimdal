import webpush from 'web-push';
import { getVapidKeys } from './push-keys';
import { getAllSubscriptions, removeSubscription } from './push-subscriptions';

export interface FeedNotification {
  title: string;
  body: string;
  emailId: string;
}

/** Fires a Web Push notification to every subscribed browser/device.
 *  VAPID identity is set fresh on every call rather than cached at
 *  module load — dataDir isn't known until a call arrives, and this
 *  runs rarely enough (once per feed-worthy email) that re-reading the
 *  key file each time costs nothing worth caching for. */
export async function sendFeedNotification(dataDir: string, notification: FeedNotification): Promise<void> {
  const subs = await getAllSubscriptions(dataDir);
  if (subs.length === 0) return;

  const { publicKey, privateKey } = await getVapidKeys(dataDir);
  webpush.setVapidDetails('mailto:heimdal@localhost', publicKey, privateKey);

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

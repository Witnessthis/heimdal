// Push notifications for the AI Feed — see src/routes/push.ts /
// src/lib/send-push.ts. Unlike the local reading-prefs toggles, there's
// no separate "enabled" flag stored anywhere: the browser's own
// pushManager already knows whether a subscription exists, and the
// backend genuinely needs a real subscription to send anything, so
// subscribing IS enabling. refreshNotificationRow always asks the
// browser directly rather than tracking its own copy of that state.

const label = document.getElementById('push-action-label') as HTMLElement;
const desc = document.getElementById('push-desc') as HTMLElement;
const btn = document.getElementById('push-btn') as HTMLButtonElement;

// The VAPID public key comes back from the server as URL-safe base64;
// pushManager.subscribe's applicationServerKey needs raw bytes instead.
// The bare `Uint8Array` type aliases to `Uint8Array<ArrayBufferLike>`
// (which includes SharedArrayBuffer) — too wide for pushManager.subscribe's
// applicationServerKey (BufferSource), which needs the concrete
// ArrayBuffer-backed form. `new Uint8Array(number[])` already constructs
// one; only the declared return type needs to say so explicitly.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = `${base64}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64Safe);
  return new Uint8Array([...raw].map((char) => char.charCodeAt(0)));
}

function isSupported(): boolean {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function enableNotifications(): Promise<void> {
  btn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const { publicKey } = await fetch('/api/push/vapid-public-key').then((r) => r.json());
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
  } catch {
    // Whatever state the browser actually ended up in — refreshNotificationRow
    // below reflects that directly rather than assuming success or failure.
  } finally {
    await refreshNotificationRow();
  }
}

async function disableNotifications(): Promise<void> {
  btn.disabled = true;
  try {
    const subscription = await currentSubscription();
    if (!subscription) return;
    // Tell the server first — if unsubscribe() below succeeds but this
    // fetch is lost, the worst case is one stale row that a future push
    // attempt prunes anyway (see send-push.ts's 404/410 handling), never
    // a subscription the browser dropped but the server still has.
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  } catch {
    // Same as enableNotifications — reflect real state after, don't guess.
  } finally {
    await refreshNotificationRow();
  }
}

btn.addEventListener('click', () => {
  if (btn.dataset.state === 'subscribed') {
    void disableNotifications();
  } else {
    void enableNotifications();
  }
});

/** Reflects the browser's real notification state into the settings
 *  row — called from showView()'s settings branch, same as
 *  loadTotpStatus(), since this row only exists once Settings has ever
 *  been shown. */
export async function refreshNotificationRow(): Promise<void> {
  if (!isSupported()) {
    label.textContent = 'Notifications not supported';
    desc.textContent = "This browser doesn't support push notifications.";
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';

  if (Notification.permission === 'denied') {
    label.textContent = 'Notifications blocked';
    desc.textContent = 'Blocked in your browser settings — enable them there, then come back.';
    btn.textContent = 'Blocked';
    btn.disabled = true;
    btn.dataset.state = 'blocked';
    return;
  }

  const subscription = await currentSubscription();
  btn.disabled = false;
  label.textContent = subscription ? 'Notifications enabled' : 'Enable notifications';
  desc.textContent = 'Get a phone notification when something worth seeing lands in the AI Feed.';
  btn.textContent = subscription ? 'Disable' : 'Enable';
  btn.dataset.state = subscription ? 'subscribed' : 'unsubscribed';
}

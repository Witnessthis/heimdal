// The app-icon notification counter (Badging API) — separate from the
// push notifications themselves (settings/notifications.ts): a device can
// have push permission denied/unsupported (Firefox has no Badging API
// support at all, and neither has any of it outside an installed PWA) and
// still nothing should throw, so every call here is best-effort.
export function setBadgeCount(count: number): void {
  if (!('setAppBadge' in navigator)) return;
  const result = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  result.catch(() => {
    // Not installed as a standalone PWA, or the platform's Badging API
    // implementation rejects for its own reasons — either way, the badge
    // just doesn't update; nothing else in the app depends on it.
  });
}

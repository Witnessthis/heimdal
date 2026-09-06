// Which mail account ("profile") the whole app is currently showing —
// a single shared concept, not per-tab: switching it here is what changing
// profile means everywhere (Inbox's loaded mailbox, Settings' profile-scoped
// section, the nav tab's swatch — see profile-switcher.ts). Deliberately
// holds only the id + pub/sub, no data-fetching: the accounts list is small
// and cheap enough that each consumer (profile-switcher.ts, inbox.ts,
// settings/account-management.ts) just fetches /api/accounts itself when it
// needs the list, rather than this module owning a cache every consumer has
// to stay in sync with.
const STORAGE_KEY = 'heimdal:activeProfileId';

let currentAccountId: string | null = null;
const listeners = new Set<(accountId: string) => void>();

export function getActiveProfileId(): string | null {
  return currentAccountId;
}

/** Idempotent — setting the same id again is a no-op, so callers (e.g.
 *  inbox.ts reacting to its own change) never trigger a redundant re-render
 *  loop. */
export function setActiveProfileId(accountId: string): void {
  if (accountId === currentAccountId) return;
  currentAccountId = accountId;
  try {
    localStorage.setItem(STORAGE_KEY, accountId);
  } catch {
    // Best-effort — a private-browsing/storage-disabled failure here just
    // means the choice doesn't survive a reload, not a functional break.
  }
  for (const listener of listeners) listener(accountId);
}

export function onActiveProfileChange(listener: (accountId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Last-viewed profile, if any — read once at bootstrap (inbox.ts) to pick
 *  a sensible default before the first real account list arrives. */
export function getLastKnownProfileId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

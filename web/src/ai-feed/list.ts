import type { AiFeedListItem } from '@server/routes/ai-feed-types';
import { setBadgeCount } from '../badge';
import { buildAiFeedCard } from './card';
import { aiFeedStatus, aiFeedView } from './dom';

/** Fetches and rebuilds the whole AI Feed view — called every time the
 *  tab is shown (see settings.ts's showView()), not cached, matching the
 *  existing loadTotpStatus()/loadLanguageSettings() pattern: the
 *  classification pipeline runs entirely server-side and can change the
 *  set of pending items at any time, so there's nothing worth caching
 *  client-side. A full rebuild rather than a diff — simpler, and AI feed
 *  item counts are small by design. */
export async function loadAiFeed(): Promise<void> {
  for (const wrap of aiFeedView.querySelectorAll('.ai-feed-card-wrap')) wrap.remove();
  if (!aiFeedStatus.isConnected) aiFeedView.prepend(aiFeedStatus);
  aiFeedStatus.textContent = 'Loading…';

  let items: AiFeedListItem[];
  try {
    const res = await fetch('/api/ai-feed');
    if (!res.ok) throw new Error(`status ${res.status}`);
    ({ items } = await res.json());
  } catch {
    aiFeedStatus.textContent = 'Could not load the AI feed — check your connection and try again.';
    return;
  }

  // The server-side count (not just what pushed a notification) is the
  // source of truth for the badge — this also corrects it for anything
  // that changed the feed without a push firing (e.g. dismissing/confirming
  // on another device), same as loadAiFeed() itself does for the card list.
  setBadgeCount(items.length);

  if (items.length === 0) {
    aiFeedStatus.textContent = 'All caught up — nothing needs your attention right now.';
    return;
  }

  aiFeedStatus.remove();
  for (const item of items) aiFeedView.appendChild(buildAiFeedCard(item));
}

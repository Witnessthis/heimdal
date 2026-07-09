import type { MailEvent } from '@server/mail/provider';
import type { EmailMessage, EmailSummary, Folder, Page } from '@server/mail/types';
import { openForwardCompose, openReplyCompose } from '../compose/compose';
import { buildCard } from './card';
import { feed, feedStatus } from './dom';

// A batch is fetched over a single IMAP connection (see the backend's
// ImapProvider.listMessages()), but arrives as one burst rather than
// trickling in — the server appears to gather the whole batch before
// sending any of it back, so there's no way to make delivery *within*
// one batch feel incremental. Trade-off of a bigger PAGE_SIZE: each
// burst itself takes proportionally longer (it's all-or-nothing), so
// this is worth watching in practice, not just assuming bigger is
// better.
const PAGE_SIZE = 100;

// Buffer is measured in batches, not pixels — see the reasoning below
// at checkBatchTrigger. Load 3 batches (300 cards) up front, then
// whenever scrolling brings the reader within 1 loaded batch (~100
// cards, 10+ phone screens) of the end, load 3 more. These used to be
// 10/10/5 — a 1000-card cold start chosen to hide slow IMAP bursts,
// from back when every inserted card also cost a blurred animated
// layer and a forced reflow. Now that cards are cheap to insert,
// these are the tuning knobs if the runway ever feels short against a
// slow IMAP server: bumping them back up is safe, just start-up
// weight. (TRIGGER at 1, not 2: with 3 initial batches, a trigger of
// 2 resolves to the marker at offset ~0, which is always "reached" —
// it would cascade an extra load immediately on startup.)
const INITIAL_BATCHES = 3;
const LOAD_AHEAD_BATCHES = 3;
const TRIGGER_BATCHES_REMAINING = 1;

let batchesLoaded = 0;
let loadingAhead = false;
const batchBoundaries: HTMLElement[] = []; // batchBoundaries[i] = permanent marker at the start of batch i (0-indexed)

let nextPageToken: string | null = null;
let loadingMore = false;
let folderId: string | null = null;

async function loadInbox(): Promise<void> {
  const folders: { folders: Folder[] } = await fetch('/api/mail/folders').then((r) => r.json());
  const inbox = folders.folders.find((f) => f.kind === 'inbox') || folders.folders[0];
  if (!inbox) {
    feedStatus.textContent = 'No mail folders found.';
    return;
  }
  folderId = inbox.id;
  await loadMoreBatches(INITIAL_BATCHES);
}

// Loads up to `n` further batches back-to-back, stopping early if the
// folder runs out. Guarded against overlapping calls — scroll events
// fire repeatedly while past the trigger point, well before the first
// run has finished moving the target further away.
async function loadMoreBatches(n: number): Promise<void> {
  if (loadingAhead) return;
  loadingAhead = true;
  try {
    for (let i = 0; i < n; i++) {
      if (batchesLoaded > 0 && !nextPageToken) break; // mailbox exhausted
      await loadMore();
    }
  } finally {
    loadingAhead = false;
    // In case the next trigger point is already within view the
    // instant this finishes, rather than waiting for another scroll
    // event to notice.
    checkBatchTrigger();
  }
}

async function loadMore(): Promise<void> {
  if (loadingMore || !folderId) return;
  loadingMore = true;
  const requestedPageToken = nextPageToken;
  try {
    const url = new URL('/api/mail/messages', window.location.origin);
    url.searchParams.set('folderId', folderId);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (requestedPageToken) url.searchParams.set('pageToken', requestedPageToken);
    const page: Page<EmailSummary> = await fetch(url).then((r) => r.json());

    // Skip anything already on screen (can happen if a message arrived
    // via the live SSE stream — connectToMailEvents — in the brief
    // window before this fetch resolved); still refresh what may have
    // changed server-side for it.
    const toFetch: EmailSummary[] = [];
    for (const summary of page.items || []) {
      const existing = feed.querySelector(`[data-id="${CSS.escape(summary.id)}"]`);
      if (existing) {
        existing.classList.toggle('unread', !summary.isRead);
      } else {
        toFetch.push(summary);
      }
    }

    // Permanent (never replaced) marker at the start of this batch —
    // this is what checkBatchTrigger() reads .offsetTop from to know
    // how many loaded batches remain ahead of the reader, regardless
    // of toFetch below being empty (batchesLoaded still advances
    // either way, so this needs to stay in lockstep with it). Must be
    // a real Element, not a Comment — .offsetTop only exists on
    // HTMLElement (a Comment works fine for the per-message markers
    // below since those only ever get replaceWith()'d, nothing reads
    // a position off of them).
    // .card-wrap, not .card — the actual direct child of #feed now
    // that each card is nested inside a wrapper (see buildCard()).
    const anchor = requestedPageToken ? sentinel : feed.querySelector('.card-wrap') || sentinel;
    const boundaryMarker = document.createElement('div');
    boundaryMarker.style.cssText = 'height:1px;margin:0;padding:0;border:0;';
    boundaryMarker.dataset.batchIndex = String(batchesLoaded);
    feed.insertBefore(boundaryMarker, anchor);
    batchBoundaries.push(boundaryMarker);

    // listMessages() now returns a real, bounded preview snippet per
    // message directly (see the backend) — no separate content fetch,
    // no separate connection, no arrival-order weirdness to work
    // around. Cards are built and inserted immediately from what the
    // single list fetch above already gave us.
    if (toFetch.length) {
      for (const summary of toFetch) {
        const card = buildCard(summary, openReplyCompose, openForwardCompose);
        feed.insertBefore(card.parentElement!, anchor);
      }
      if (feedStatus.isConnected) feedStatus.remove();
    }

    nextPageToken = page.nextPageToken || null;
    batchesLoaded++;
    if (!page.items?.length && !feed.querySelector('.card')) {
      feedStatus.textContent = 'No messages in your inbox.';
    }
  } catch (_err) {
    if (!feed.querySelector('.card')) feedStatus.textContent = 'Could not load your inbox.';
  } finally {
    loadingMore = false;
  }
}

// Insertion anchor for paginated (older) batches — always the last
// child of the feed.
const sentinel = document.createElement('div');
sentinel.style.height = '1px';
feed.appendChild(sentinel);

// Triggers LOAD_AHEAD_BATCHES more batches once the reader has
// scrolled to within TRIGGER_BATCHES_REMAINING loaded batches of the
// end. A plain scroll-position check against the
// marker recorded at the start of that batch (see boundaryMarker in
// loadMore()), not IntersectionObserver — two attempts at an
// IntersectionObserver-based version of this in a row still didn't
// work in practice (likely edge cases in how it resolves intersection
// for a dynamically retargeted, near-zero-area element), and a direct
// getBoundingClientRect/offsetTop comparison on scroll is simple
// enough to reason about and verify directly rather than depend on
// observer notification timing. Recomputes the target fresh every
// call rather than tracking "which marker am I watching" as mutable
// state — simpler, and self-corrects once batchesLoaded moves on.
export function checkBatchTrigger(): void {
  const targetIndex = batchesLoaded - TRIGGER_BATCHES_REMAINING - 1;
  const marker = targetIndex >= 0 ? batchBoundaries[targetIndex] : null;
  if (!marker) return;
  const reached = marker.offsetTop <= feed.scrollTop + feed.clientHeight;
  if (reached) loadMoreBatches(LOAD_AHEAD_BATCHES);
}

// Live updates: the backend's IMAP IDLE session detects new/changed/
// deleted mail and connection-state changes and pushes them down this
// stream as they happen — this is what makes the feed update itself
// without the user having to refresh. The browser's EventSource
// reconnects automatically if the connection drops. This connection
// now stays open the whole time you're on this page, including while
// viewing Settings, since that's a view toggle rather than a real
// navigation — see showView() in settings.ts.
function connectToMailEvents(): void {
  const source = new EventSource('/api/mail/events');
  source.onmessage = async (e) => {
    let event: MailEvent;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }

    if (event.type === 'newMessage' && event.folderId === folderId) {
      if (feed.querySelector(`[data-id="${CSS.escape(event.messageId)}"]`)) return;
      try {
        const message: EmailMessage = await fetch(
          `/api/mail/messages/${encodeURIComponent(event.messageId)}`,
        ).then((r) => r.json());
        prependCard(message);
      } catch {
        // If this fails, the message still shows up next time loadMore
        // reaches it during normal pagination — not worth surfacing.
      }
      return;
    }

    if (event.type === 'messageDeleted') {
      // .closest('.card-wrap') — removing just the .card would leave
      // an empty wrapper (and its glow shadow) behind.
      feed
        .querySelector(`[data-id="${CSS.escape(event.messageId)}"]`)
        ?.closest('.card-wrap')
        ?.remove();
    }
  };
}

function prependCard(message: EmailMessage): void {
  const card = buildCard(message, openReplyCompose, openForwardCompose);
  feed.insertBefore(card.parentElement!, feed.querySelector('.card-wrap') || sentinel);
  if (feedStatus.isConnected) feedStatus.remove();
}

// Auth/provider bootstrap: 401 means not logged in (routes to setup or
// login depending on whether the app has ever been configured); an
// unconfigured mail provider routes to the connect flow. Only once past
// both does the feed actually start loading.
export async function bootstrap(): Promise<void> {
  const [meRes, statusRes] = await Promise.all([fetch('/api/me'), fetch('/api/status')]);
  if (meRes.status === 401) {
    const status = await statusRes.json();
    window.location.replace(status.configured ? '/login.html' : '/setup.html');
    return;
  }

  const providerStatus = await fetch('/api/provider/status').then((r) => r.json());
  if (!providerStatus.configured) {
    window.location.replace('/connect-provider.html');
    return;
  }

  connectToMailEvents();

  await loadInbox();
}

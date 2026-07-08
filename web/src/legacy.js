import { openForwardCompose, openReplyCompose } from './compose/compose.js';
import { closeShelf, isShelfOpen, openShelf, shelf } from './compose/shelf.js';
import { buildCard } from './feed/card.js';
import { feed, feedStatus, nav, navInbox, navSettings, settingsView } from './feed/dom.js';
import { LONG_PRESS_MOVE_TOLERANCE_PX } from './feed/gesture-constants.js';
import { clearRenderedBody, ensureFullBodyLoaded, markRead } from './feed/render-body.js';
import { selectedIds, toggleSelect } from './feed/selection.js';
import { closeSwipe, openSwipeCard, setOpenSwipeCard } from './feed/swipe-state.js';
import {
  isAutoLoadImagesEnabled,
  isRichHtmlEnabled,
  setAutoLoadImagesEnabled,
  setRichHtmlEnabled,
} from './settings/reading-prefs.js';

// One consolidated gesture recognizer for #feed, covering four
// behaviors that all start as "a pointer went down somewhere in the
// feed": tap (expand/collapse or select), long-press (enter selection
// mode), horizontal swipe on a card (reveal Reply/Forward), and a
// vertical pull while already at the top of the feed (reveal the new
// email shelf). Pointer Events unify mouse and touch behind one event
// model, so this works the same way on both without separate
// mousedown/touchstart handling.
//
// Direction is decided ONCE per gesture, the first time movement
// crosses LONG_PRESS_MOVE_TOLERANCE_PX — horizontal-dominant commits to
// 'swipe', vertical-dominant-while-pulling-down-from-the-top commits to
// 'pull', anything else vertical is left alone as plain native scroll
// (unchanged from before this gesture consolidation existed). Once
// committed to 'swipe' or 'pull', the long-press timer is cancelled and
// preventDefault() is called on further moves so native scroll doesn't
// fight the transform being driven by hand below — .card-front's
// touch-action: pan-y (see its CSS) is what lets the browser still own
// plain vertical scrolling right up until that point.
const LONG_PRESS_MS = 500;
const SWIPE_REVEAL_PX = 144; // two 72px action buttons — matches .card-swipe-actions CSS
const SWIPE_OPEN_THRESHOLD_PX = 40;
const PULL_OPEN_THRESHOLD_PX = 40;

let pressTimer = null;
let pressStartX = 0;
let pressStartY = 0;
let activeCard = null; // the card this gesture started on, for its whole duration
let longPressFired = false;
let gestureDirection = null; // null | 'swipe' | 'pull' | 'scroll'
let gestureStartedAtTop = false;

function cancelLongPress() {
  if (pressTimer !== null) clearTimeout(pressTimer);
  pressTimer = null;
}

feed.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // primary mouse button / the actual touch point only
  const card = e.target.closest('.card');
  if (!card || e.target.closest('.card-select') || e.target.closest('.card-swipe-actions')) return;
  activeCard = card;
  pressStartX = e.clientX;
  pressStartY = e.clientY;
  gestureDirection = null;
  gestureStartedAtTop = feed.scrollTop <= 0;
  pressTimer = setTimeout(() => {
    longPressFired = true;
    toggleSelect(card);
    pressTimer = null;
  }, LONG_PRESS_MS);
});

feed.addEventListener('pointermove', (e) => {
  if (!activeCard) return;
  const dx = e.clientX - pressStartX;
  const dy = e.clientY - pressStartY;

  if (gestureDirection === null) {
    if (Math.hypot(dx, dy) <= LONG_PRESS_MOVE_TOLERANCE_PX) return; // not enough movement to decide yet
    cancelLongPress();
    if (Math.abs(dx) > Math.abs(dy)) {
      gestureDirection = 'swipe';
    } else if (dy > 0 && gestureStartedAtTop) {
      gestureDirection = 'pull';
    } else {
      gestureDirection = 'scroll'; // vertical, native — nothing further for this gesture to do
    }
  }

  if (gestureDirection === 'swipe') {
    e.preventDefault();
    const front = activeCard.querySelector('.card-front');
    const openOffset = activeCard === openSwipeCard ? -SWIPE_REVEAL_PX : 0;
    const offset = Math.min(0, Math.max(-SWIPE_REVEAL_PX, openOffset + dx));
    front.style.transition = 'none';
    front.style.transform = `translateX(${offset}px)`;
  } else if (gestureDirection === 'pull') {
    e.preventDefault();
    // shelf.offsetHeight is its real layout height regardless of its
    // current transform (transforms don't affect layout box size), so
    // this stays correct without duplicating the height as a JS
    // constant that could drift from the CSS.
    const shelfHeight = shelf.offsetHeight;
    const offset = Math.min(shelfHeight, Math.max(0, dy));
    shelf.style.transition = 'none';
    shelf.style.transform = `translateY(${offset - shelfHeight}px)`;
  }
});

feed.addEventListener('pointerup', (e) => {
  cancelLongPress();
  if (gestureDirection === 'swipe' && activeCard) {
    const front = activeCard.querySelector('.card-front');
    front.style.transition = '';
    const dx = e.clientX - pressStartX;
    const wasOpen = activeCard === openSwipeCard;
    const finalOffset = (wasOpen ? -SWIPE_REVEAL_PX : 0) + dx;
    if (openSwipeCard && openSwipeCard !== activeCard) closeSwipe(openSwipeCard);
    if (finalOffset < -SWIPE_OPEN_THRESHOLD_PX) {
      activeCard.classList.add('swipe-open');
      front.style.transform = `translateX(${-SWIPE_REVEAL_PX}px)`;
      setOpenSwipeCard(activeCard);
    } else {
      closeSwipe(activeCard);
    }
  } else if (gestureDirection === 'pull') {
    shelf.style.transition = '';
    const dy = e.clientY - pressStartY;
    if (dy > PULL_OPEN_THRESHOLD_PX) openShelf();
    else closeShelf();
  }
  activeCard = null;
  gestureDirection = null;
});
feed.addEventListener('pointercancel', () => {
  cancelLongPress();
  if (gestureDirection === 'swipe' && activeCard) closeSwipe(activeCard);
  if (gestureDirection === 'pull') closeShelf();
  activeCard = null;
  gestureDirection = null;
});

feed.addEventListener('click', (e) => {
  // A tap anywhere in the feed while the shelf is open closes it
  // instead of acting on whatever was tapped — the shelf's own button
  // has its own listener and never reaches this handler, since the
  // shelf isn't a descendant of #feed.
  if (isShelfOpen()) {
    closeShelf();
    return;
  }

  // Reply/Forward buttons handle their own clicks (see buildCard) —
  // don't also run card-click logic for the card they sit behind.
  if (e.target.closest('.card-swipe-actions')) return;

  // A tap anywhere outside the currently-open swiped card closes it
  // instead of performing whatever that tap would otherwise do —
  // standard swipe-list UX (matches e.g. iOS Mail).
  if (openSwipeCard && !openSwipeCard.contains(e.target)) {
    closeSwipe(openSwipeCard);
    return;
  }

  // The click that follows a long-press's pointerup would otherwise
  // also toggle expand right after entering selection mode — consume
  // it here instead.
  if (longPressFired) {
    longPressFired = false;
    return;
  }

  const selectBtn = e.target.closest('.card-select');
  if (selectBtn) {
    toggleSelect(selectBtn.closest('.card'));
    return;
  }
  const card = e.target.closest('.card');
  if (!card) return;

  // Once selection mode is active, a plain click/tap on a card toggles
  // its selection instead of expanding it — only the Cancel button or
  // deselecting everything exits back to normal browsing.
  if (selectedIds.size > 0) {
    toggleSelect(card);
    return;
  }

  const expanded = card.classList.toggle('expanded');
  if (expanded) {
    ensureFullBodyLoaded(card);
    markRead(card);
  } else {
    // Tear the rendered body down, don't just clip it: an HTML email
    // leaves behind a live iframe (its own document, styles, decoded
    // images) plus the ResizeObserver watching it, and before this
    // teardown every message expanded during a session stayed
    // resident forever — a leak that grew with reading activity.
    // Re-expanding is cheap: the full message stays cached in
    // cardData, and clearing renderedWithSettings makes
    // ensureFullBodyLoaded fall through to that cache (no refetch)
    // and rebuild the render.
    clearRenderedBody(card);
    delete card.dataset.renderedWithSettings;
  }
});

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
const batchBoundaries = []; // batchBoundaries[i] = permanent marker at the start of batch i (0-indexed)

let nextPageToken = null;
let loadingMore = false;
let folderId = null;

async function loadInbox() {
  const folders = await fetch('/api/mail/folders').then((r) => r.json());
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
async function loadMoreBatches(n) {
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

async function loadMore() {
  if (loadingMore || !folderId) return;
  loadingMore = true;
  const requestedPageToken = nextPageToken;
  try {
    const url = new URL('/api/mail/messages', window.location.origin);
    url.searchParams.set('folderId', folderId);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (requestedPageToken) url.searchParams.set('pageToken', requestedPageToken);
    const page = await fetch(url).then((r) => r.json());

    // Skip anything already on screen (can happen if a message arrived
    // via the live SSE stream — connectToMailEvents — in the brief
    // window before this fetch resolved); still refresh what may have
    // changed server-side for it.
    const toFetch = [];
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
        feed.insertBefore(card.parentElement, anchor);
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
function checkBatchTrigger() {
  const targetIndex = batchesLoaded - TRIGGER_BATCHES_REMAINING - 1;
  const marker = targetIndex >= 0 ? batchBoundaries[targetIndex] : null;
  if (!marker) return;
  const reached = marker.offsetTop <= feed.scrollTop + feed.clientHeight;
  if (reached) loadMoreBatches(LOAD_AHEAD_BATCHES);
}

(async () => {
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
})();

// Live updates: the backend's IMAP IDLE session detects new/changed/
// deleted mail and connection-state changes and pushes them down this
// stream as they happen — this is what makes the feed update itself
// without the user having to refresh. The browser's EventSource
// reconnects automatically if the connection drops. This connection
// now stays open the whole time you're on this page, including while
// viewing Settings, since that's a view toggle rather than a real
// navigation — see showView() below.
function connectToMailEvents() {
  const source = new EventSource('/api/mail/events');
  source.onmessage = async (e) => {
    let event;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }

    if (event.type === 'newMessage' && event.folderId === folderId) {
      if (feed.querySelector(`[data-id="${CSS.escape(event.messageId)}"]`)) return;
      try {
        const message = await fetch(`/api/mail/messages/${encodeURIComponent(event.messageId)}`).then((r) =>
          r.json(),
        );
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

function prependCard(message) {
  const card = buildCard(message, openReplyCompose, openForwardCompose);
  feed.insertBefore(card.parentElement, feed.querySelector('.card-wrap') || sentinel);
  if (feedStatus.isConnected) feedStatus.remove();
}

// --- Settings view -------------------------------------------------
// Merged in as a second panel rather than a separate page: switching
// to it is just a display toggle, so the feed's state, scroll
// position, and the EventSource connection above all keep running
// untouched the whole time — nothing gets re-fetched just because you
// looked at settings and came back.

let lastScrollY = 0;

// Generic sub-setting connector: any row marked
// `data-sub-setting-of="<id of the parent row>"` gets its little
// tree-line positioned from real measured positions — the vertical
// stem runs from the bottom of the referenced parent row down to the
// vertical center of this row's own .setting-name — rather than a
// guessed em value. Works for any current or future sub-setting pair
// with no per-instance CSS tuning. Needs re-running whenever the
// layout could have changed: when Settings becomes visible (a
// display:none element measures as zero-size) and on resize (the
// description text can wrap differently at other widths).
function alignSubSettingConnectors() {
  document.querySelectorAll('[data-sub-setting-of]').forEach((row) => {
    const parent = document.getElementById(row.dataset.subSettingOf);
    const connector = row.querySelector('.sub-setting-connector');
    const title = row.querySelector('.setting-name');
    if (!parent || !connector || !title) return;

    const rowTop = row.getBoundingClientRect().top;
    const top = parent.getBoundingClientRect().bottom - rowTop;
    const titleRect = title.getBoundingClientRect();
    const bottom = titleRect.top + titleRect.height / 2 - rowTop;

    connector.style.top = `${top}px`;
    connector.style.height = `${Math.max(bottom - top, 0)}px`;
  });
}

function showView(view) {
  const isSettings = view === 'settings';
  settingsView.style.display = isSettings ? 'block' : 'none';
  feed.style.display = isSettings ? 'none' : '';
  navInbox.classList.toggle('active', !isSettings);
  navSettings.classList.toggle('active', isSettings);
  nav.classList.remove('hide');
  lastScrollY = isSettings ? settingsView.scrollTop : feed.scrollTop;
  if (isSettings) {
    loadTotpStatus();
    alignSubSettingConnectors();
  }
}
window.addEventListener('resize', () => {
  if (settingsView.style.display !== 'none') alignSubSettingConnectors();
});

navInbox.addEventListener('click', () => showView('inbox'));
navSettings.addEventListener('click', () => showView('settings'));

async function loadTotpStatus() {
  const status = await fetch('/api/totp/status').then((r) => r.json());
  const label = document.getElementById('totp-action-label');
  const btn = document.getElementById('totp-btn');
  if (status.enabled) {
    label.textContent = 'Reconfigure authenticator';
    btn.textContent = 'Reconfigure';
  } else {
    label.textContent = 'Set up authenticator';
    btn.textContent = 'Set up';
  }
}

document.getElementById('totp-btn').addEventListener('click', () => {
  window.location.href = '/totp-setup.html';
});

// Builds the theme picker grid once — the list of available themes
// never changes at runtime, so there's no need to rebuild it every
// time Settings is shown (unlike loadTotpStatus, which reflects
// server-side state that can change elsewhere).
function buildThemeGrid() {
  const grid = document.getElementById('theme-grid');
  const current = HeimdalThemes.currentTheme();
  for (const [key, theme] of Object.entries(HeimdalThemes.THEMES)) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = `theme-swatch${key === current ? ' active' : ''}`;
    swatch.dataset.theme = key;

    const dots = document.createElement('span');
    dots.className = 'theme-swatch-dots';
    for (const colorKey of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
      const dot = document.createElement('span');
      dot.style.background = theme[colorKey];
      dots.appendChild(dot);
    }

    const label = document.createElement('span');
    label.className = 'theme-swatch-label';
    label.textContent = theme.label;
    label.style.color = theme.fg;

    swatch.style.background = theme.bg;
    swatch.append(dots, label);
    swatch.addEventListener('click', () => {
      HeimdalThemes.setTheme(key);
      grid.querySelectorAll('.theme-swatch').forEach((el) => {
        el.classList.toggle('active', el === swatch);
      });
    });
    grid.appendChild(swatch);
  }
}
buildThemeGrid();

// Generic relevance: any row marked `data-relevance="<parentRowId>:on"`
// (or ":off") is "active" only while that parent row's toggle is in the
// named position. When it isn't, the row fades (.setting-inactive) and
// its own toggle is disabled — so a setting that currently can't do
// anything given the parent's state visibly steps back, and can't be
// fiddled with to no effect. Reads the parent's state straight off its
// toggle's badge-on/off class, so it works for any current or future
// pairing with no per-setting wiring. Each toggle's own on/off *display*
// stays driven by its stored preference regardless — the fade/disable
// conveys "inactive right now", not the stored value being lost.
function updateSettingRelevance() {
  document.querySelectorAll('[data-relevance]').forEach((row) => {
    const [parentId, wantState] = row.dataset.relevance.split(':');
    const parentToggle = document.getElementById(parentId)?.querySelector('.badge');
    if (!parentToggle) return;
    const parentOn = parentToggle.classList.contains('badge-on');
    const active = (wantState === 'on') === parentOn;
    row.classList.toggle('setting-inactive', !active);
    const ownToggle = row.querySelector('.badge');
    if (ownToggle) ownToggle.disabled = !active;
  });
}

// Same idea as buildThemeGrid() above — a local preference, not
// server state, so it's set up once at load rather than refreshed
// each time Settings is shown.
const richHtmlToggle = document.getElementById('rich-html-toggle');
function updateRichHtmlToggle() {
  const enabled = isRichHtmlEnabled();
  richHtmlToggle.textContent = enabled ? 'ON' : 'OFF';
  richHtmlToggle.className = `badge ${enabled ? 'badge-on' : 'badge-off'}`;
}
richHtmlToggle.addEventListener('click', () => {
  setRichHtmlEnabled(!isRichHtmlEnabled());
  updateRichHtmlToggle();
  // This is the parent of both relevance-linked rows below — re-evaluate
  // their active/faded state now that it changed.
  updateSettingRelevance();
});
updateRichHtmlToggle();

const autoLoadImagesToggle = document.getElementById('auto-load-images-toggle');
function updateAutoLoadImagesToggle() {
  const enabled = isAutoLoadImagesEnabled();
  autoLoadImagesToggle.textContent = enabled ? 'ON' : 'OFF';
  autoLoadImagesToggle.className = `badge ${enabled ? 'badge-on' : 'badge-off'}`;
}
autoLoadImagesToggle.addEventListener('click', () => {
  setAutoLoadImagesEnabled(!isAutoLoadImagesEnabled());
  updateAutoLoadImagesToggle();
});
updateAutoLoadImagesToggle();

// After every toggle's display is set from its stored value above, do a
// single relevance pass so faded/disabled state matches on first load.
updateSettingRelevance();

document.getElementById('logout-btn').addEventListener('click', async () => {
  const btn = document.getElementById('logout-btn');
  btn.disabled = true;
  btn.textContent = 'Logging out…';
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    window.location.replace('/login.html');
  }
});

// Auto-hide the bottom nav on scroll down, reveal it on scroll up —
// only in the feed. Settings is a short, static list rather than a
// long scroll a reader is trying to get out of the way of, so the nav
// (the only way back to the inbox) just stays put there instead.
function handleScroll(scrollTop) {
  if (scrollTop > lastScrollY && scrollTop > 50) {
    nav.classList.add('hide');
  } else {
    nav.classList.remove('hide');
  }
  lastScrollY = scrollTop;
}
// Scroll events fire far more often than frames render, and both
// handleScroll and checkBatchTrigger read layout (scrollTop,
// offsetTop, clientHeight) — running them per event forces redundant
// synchronous layout work between frames. Coalesce to at most one run
// per frame; only closing an open swipe stays immediate, since that's
// gesture correctness rather than layout-dependent work.
let scrollWorkScheduled = false;
feed.addEventListener(
  'scroll',
  () => {
    if (openSwipeCard) closeSwipe(openSwipeCard);
    if (scrollWorkScheduled) return;
    scrollWorkScheduled = true;
    requestAnimationFrame(() => {
      scrollWorkScheduled = false;
      handleScroll(feed.scrollTop);
      checkBatchTrigger();
    });
  },
  { passive: true },
);

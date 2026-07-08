import { cardData } from './feed/card-data.js';
import { bestPreviewText, formatFullDate, formatRelativeTime } from './feed/preview.js';
import { clearRenderedBody, ensureFullBodyLoaded, markRead } from './feed/render-body.js';
import {
  isAutoLoadImagesEnabled,
  isRichHtmlEnabled,
  setAutoLoadImagesEnabled,
  setRichHtmlEnabled,
} from './settings/reading-prefs.js';

const feed = document.getElementById('feed');
const feedStatus = document.getElementById('feed-status');
const settingsView = document.getElementById('settings-view');
const nav = document.getElementById('bottom-nav');
const navInbox = document.getElementById('nav-inbox');
const navSettings = document.getElementById('nav-settings');

// `data` is either an EmailSummary (list view, from loadMore() — no
// body content at all, see the backend's toSummary()) or a full
// EmailMessage (from a live SSE new-mail update via prependCard(),
// which does carry a body). Either way, buildCard() itself never
// shows body content — only ensureFullBodyLoaded(), on expand, does —
// so nothing about a card changes size after it first appears except
// that expand.
function buildCard(data) {
  const card = document.createElement('article');
  card.className = 'card';
  card.classList.toggle('unread', !data.isRead);
  card.dataset.id = data.id;

  // Sits behind .card-front — see the swipe gesture handling below for
  // how .card-front's transform reveals these. Icons (not text) match
  // the same stroke-based SVG set the bottom nav uses (viewBox 0 0 24
  // 24, stroke-width 1.8, round caps/joins) — the markup here is
  // static and app-authored, never derived from data, so innerHTML is
  // safe (unlike the strict never-innerHTML rule for actual email
  // content elsewhere in this file).
  const swipeActions = document.createElement('div');
  swipeActions.className = 'card-swipe-actions';
  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'card-action-reply';
  replyBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg><span>Reply</span>';
  replyBtn.addEventListener('click', () => openReplyCompose(card));
  const forwardBtn = document.createElement('button');
  forwardBtn.type = 'button';
  forwardBtn.className = 'card-action-forward';
  forwardBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg><span>Forward</span>';
  forwardBtn.addEventListener('click', () => openForwardCompose(card));
  swipeActions.append(replyBtn, forwardBtn);

  const front = document.createElement('div');
  front.className = 'card-front';

  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'card-select';
  selectBtn.setAttribute('aria-label', 'Select email');

  const content = document.createElement('div');
  content.className = 'card-content';

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const fromName = document.createElement('span');
  fromName.className = 'card-from-name';
  fromName.textContent = data.from?.name || data.from?.address || '(unknown sender)';
  meta.appendChild(fromName);

  if (data.from?.name && data.from?.address) {
    const fromAddress = document.createElement('span');
    fromAddress.className = 'card-from-address';
    fromAddress.textContent = data.from.address;
    meta.appendChild(fromAddress);
  }

  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = formatRelativeTime(data.receivedAt);
  meta.appendChild(time);

  const subject = document.createElement('h2');
  subject.className = 'card-subject';
  subject.textContent = data.subject || '(no subject)';

  // Left empty deliberately — the collapsed card only ever shows
  // sender/time/subject now, never a body preview (see the backend's
  // toSummary(), which no longer fetches any body content for the
  // list view at all, bounded or otherwise). ensureFullBodyLoaded()
  // populates this element once the card is actually expanded; the
  // element still needs to exist here so that (and the fade/overflow
  // logic below) has something to find via querySelector.
  const body = document.createElement('div');
  body.className = 'card-body';

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'card-body-wrap';
  bodyWrap.appendChild(body);

  content.append(meta, subject, bodyWrap);
  front.append(selectBtn, content);
  card.append(swipeActions, front);
  cardData.set(card, data);

  // .card-wrap (not .card itself) is what actually gets inserted into
  // #feed — see the call sites below, which insert card.parentElement
  // rather than card. Keeping buildCard() return the .card element
  // itself (unchanged) means everything else that already treats its
  // return value as the card — cardData, the click/swipe gesture
  // handling's closest('.card') — needs no change.
  const wrap = document.createElement('div');
  wrap.className = 'card-wrap';
  wrap.append(card);

  return card;
}

// Selection: a lightweight multi-select for bulk actions (currently
// just "mark as read"). Tracked by id rather than by element reference
// so it survives a card being replaced/re-synced during pagination.
// Entered via a long-press (see the pointer handling below) rather
// than always showing a checkbox on every card — selection is rare
// enough that it shouldn't cost permanent visual weight on the feed.
const selectedIds = new Set();
const selectionBar = document.getElementById('selection-bar');
const selectionCount = document.getElementById('selection-count');

function updateSelectionBar() {
  const active = selectedIds.size > 0;
  selectionBar.style.display = active ? 'flex' : 'none';
  nav.style.display = active ? 'none' : '';
  feed.classList.toggle('selecting', active);
  if (active) selectionCount.textContent = `${selectedIds.size} selected`;
}

function toggleSelect(card) {
  const id = card.dataset.id;
  const nowSelected = !card.classList.contains('selected');
  card.classList.toggle('selected', nowSelected);
  if (nowSelected) selectedIds.add(id);
  else selectedIds.delete(id);
  updateSelectionBar();
}

function clearSelection() {
  for (const id of selectedIds) {
    feed.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.remove('selected');
  }
  selectedIds.clear();
  updateSelectionBar();
}

document.getElementById('selection-cancel').addEventListener('click', clearSelection);

document.getElementById('selection-mark-read').addEventListener('click', async () => {
  const ids = [...selectedIds];
  await Promise.all(
    ids.map((id) =>
      fetch(`/api/mail/messages/${encodeURIComponent(id)}/read`, { method: 'POST' }).catch(() => {}),
    ),
  );
  for (const id of ids) {
    feed.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.remove('unread');
  }
  clearSelection();
});

// New-email shelf — revealed by pulling down while already at the top
// of the feed (see the pull-gesture handling in the recognizer below).
// openShelf()/closeShelf() set its fully-open/closed resting state;
// the drag itself live-updates the same transform directly.
const shelf = document.getElementById('new-email-shelf');
function openShelf() {
  shelf.style.transition = '';
  shelf.style.transform = 'translateY(0)';
  shelf.classList.add('open');
}
function closeShelf() {
  shelf.style.transition = '';
  shelf.style.transform = '';
  shelf.classList.remove('open');
}
document.getElementById('new-email-btn').addEventListener('click', () => {
  closeShelf();
  openCompose({ mode: 'new' });
});

// --- Compose (new/reply/forward) ------------------------------------
// One shared view for all three entry points (the shelf's New Email,
// and a card's swipe-revealed Reply/Forward). openCompose() takes a
// plain data object rather than reading anything off a card itself, so
// a future "load an AI-prepared draft" entry point can call it the
// same way without this view needing to change.
const composeView = document.getElementById('compose-view');
const composeTo = document.getElementById('compose-to');
const composeToField = document.getElementById('compose-to-field');
const composeToRow = document.getElementById('compose-to-row');
const addressWrap = document.getElementById('compose-to-wrap');
const addressFront = document.getElementById('compose-to-front');
const addressLockBar = document.getElementById('compose-to-lock');
const addressLockText = document.getElementById('compose-to-lock-text');
const addressEditBtn = document.getElementById('compose-to-edit');
const addressDiscardBtn = document.getElementById('compose-to-discard');
const addressSendBtn = document.getElementById('compose-to-send');
const composeCc = document.getElementById('compose-cc');
const composeBcc = document.getElementById('compose-bcc');
const composeExpandToggle = document.getElementById('compose-expand-toggle');
const composeExtraFields = document.getElementById('compose-extra-fields');
const composeSubject = document.getElementById('compose-subject');
const composeBody = document.getElementById('compose-body');
const composeError = document.getElementById('compose-error');

let composeThreadContext = null; // { inReplyTo, threadId } for the message currently being composed, if any

// Right-aligned inline hints (see .field-hint CSS) stand in for a
// separate label row or a native placeholder — but should stay
// visible for as long as there's room, only hiding once the typed
// text's actual rendered width would reach them. A single shared
// canvas 2D context does the width measurement (matching the input's
// own font) rather than a cruder length-based guess, which hid the
// hint the instant you typed a single character regardless of how
// short that character was.
const COMPOSE_HINTED_FIELDS = [composeTo, composeCc, composeBcc, composeSubject];
const hintMeasureCanvas = document.createElement('canvas');
const hintMeasureCtx = hintMeasureCanvas.getContext('2d');
const HINT_GAP_PX = 10; // minimum breathing room to keep between typed text and the hint

function updateFieldHint(input) {
  const hint = input.parentElement.querySelector('.field-hint');
  if (!hint) return;
  if (!input.value) {
    hint.classList.remove('hidden');
    return;
  }
  const style = getComputedStyle(input);
  hintMeasureCtx.font = `${style.fontSize} ${style.fontFamily}`;
  const textWidth = hintMeasureCtx.measureText(input.value).width;
  const availableWidth = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  hint.classList.toggle('hidden', textWidth + hint.offsetWidth + HINT_GAP_PX > availableWidth);
}
COMPOSE_HINTED_FIELDS.forEach((input) => {
  input.addEventListener('input', () => updateFieldHint(input));
});
// Field width can change (phone rotation, resizing a desktop window),
// which changes how much text fits before the hint regardless of what
// was typed — re-check rather than waiting for the next keystroke.
// Only ever measures fields that are actually visible right now — To
// always, Cc/Bcc/Subject only when the collapsible section is open —
// same reasoning as setExtraFieldsExpanded() above.
window.addEventListener('resize', () => {
  updateFieldHint(composeTo);
  if (composeExtraFields.style.display !== 'none') {
    [composeCc, composeBcc, composeSubject].forEach(updateFieldHint);
  }
});

function setExtraFieldsExpanded(expanded) {
  composeExtraFields.style.display = expanded ? 'flex' : 'none';
  composeExpandToggle.classList.toggle('expanded', expanded);
  // Cc/Bcc/Subject live inside this collapsible section, so any
  // updateFieldHint() call made while it was display:none measured
  // against a 0-width hidden box (clientWidth/offsetWidth are both 0
  // for anything inside a display:none ancestor) — that always came
  // out as "not enough room, hide the hint", regardless of how short
  // the actual text was. Recompute now that they're genuinely
  // visible and measurable.
  if (expanded) [composeCc, composeBcc, composeSubject].forEach(updateFieldHint);
}
composeExpandToggle.addEventListener('click', () => {
  setExtraFieldsExpanded(composeExtraFields.style.display === 'none');
});

// Locking swaps the raw input for a non-editable display of the same
// text; the pencil icon (never the bar itself) is the only way back
// into edit mode. This exists so the address row can be safely
// swiped — see the gesture handlers below — without ever risking a
// swipe landing back in editing.
function setAddressLocked(locked) {
  if (locked) addressLockText.textContent = composeTo.value;
  composeToField.style.display = locked ? 'none' : '';
  addressLockBar.style.display = locked ? 'flex' : 'none';
  composeToRow.classList.toggle('address-locked', locked);
}
composeTo.addEventListener('blur', () => {
  if (composeTo.value.trim()) setAddressLocked(true);
});
addressEditBtn.addEventListener('click', () => {
  setAddressLocked(false);
  updateFieldHint(composeTo);
  composeTo.focus();
  composeTo.setSelectionRange(composeTo.value.length, composeTo.value.length);
});

// Callers also pass a `mode` ('new' | 'reply' | 'forward') that nothing
// here reads yet — the view's prefilled content already distinguishes the
// three. Destructure it back in if/when the view needs to branch on it.
function openCompose({ to = '', subject = '', body = '', inReplyTo, threadId }) {
  closeAddressSwipe();
  composeTo.value = to;
  composeCc.value = '';
  composeBcc.value = '';
  composeSubject.value = subject;
  composeBody.value = body;
  // Reply/forward bodies are built as "blank space for your reply,
  // then the quoted/forwarded original" (see openReplyCompose/
  // openForwardCompose) — the cursor belongs at the very start, ready
  // to type, not wherever setting .value happens to leave it (the end,
  // by default), which would otherwise show the *bottom* of the quote
  // instead of the top.
  composeBody.setSelectionRange(0, 0);
  composeBody.scrollTop = 0;
  composeError.textContent = '';
  composeThreadContext = { inReplyTo, threadId };
  composeView.style.display = 'flex';
  nav.style.display = 'none';
  // Always starts collapsed, regardless of mode — even though reply/
  // forward come with a real (Re:/Fwd:-prefixed) subject already
  // filled in, the point of the toggle is to stay out of the way by
  // default; the subject is still there once expanded, just not
  // forced into view.
  setExtraFieldsExpanded(false);
  // Reply already knows its recipient, so it starts locked (swipeable
  // right away, nothing to blur out of first); new/forward start as a
  // plain empty input, same as before this field had a locked state.
  setAddressLocked(Boolean(to));
  // Only To is ever visible at this point — Cc/Bcc/Subject get their
  // own recompute inside setExtraFieldsExpanded() once actually shown.
  // Not needed when locked (the lock bar has no hint of its own).
  if (!to) updateFieldHint(composeTo);
  (to ? composeBody : composeTo).focus();
  // Focusing (and on mobile, the keyboard animating open) can nudge
  // scroll position again after the reset above — reassert it once
  // more on the next frame, once that's settled.
  requestAnimationFrame(() => {
    composeBody.scrollTop = 0;
  });
}

function closeCompose() {
  composeView.style.display = 'none';
  nav.style.display = '';
}

// Comma-separated plain addresses only, matching the app's existing
// "keep compose simple, no rich contact picker" scope for this pass.
function parseAddressList(text) {
  return text
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ address }));
}

let composeSending = false;
async function sendComposeMessage() {
  if (composeSending) return;
  const to = parseAddressList(composeTo.value);
  if (to.length === 0) {
    composeError.textContent = 'Add at least one recipient.';
    return;
  }
  composeSending = true;
  composeError.textContent = '';
  try {
    const res = await fetch('/api/mail/quick-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        cc: parseAddressList(composeCc.value),
        bcc: parseAddressList(composeBcc.value),
        subject: composeSubject.value,
        text: composeBody.value,
        inReplyTo: composeThreadContext?.inReplyTo,
        threadId: composeThreadContext?.threadId,
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    closeCompose();
  } catch (_err) {
    composeError.textContent = 'Could not send — check your connection and try again.';
  } finally {
    composeSending = false;
  }
}

// --- Address bar swipe-reveal (discard / send) -----------------------
// Same reveal-then-tap shape as a card's swipe-revealed Reply/Forward,
// just bidirectional and scoped to this one row instead of #feed:
// dragging the bar (never while it's an actively-focused input — see
// the activeElement checks below) live-follows the finger, snaps open
// on whichever side was dragged past a threshold or closed otherwise,
// and only a separate subsequent tap on the revealed icon commits
// anything. Send is only reachable while the address is locked (a real
// recipient is confirmed) — there's nothing to send to otherwise, so
// the swipe is clamped to the discard side only in that state.
// Deliberately a few px less than the button's own 64px width (see
// .address-swipe-actions button) rather than an exact match — the bar
// itself has rounded corners (the gradient border), so its trailing
// edge curves away right at the corners as it slides open. Matching
// the reveal distance to the button's width exactly left that curved
// notch landing right at the button's own edge, exposing whatever's
// behind through the gap. Stopping a few px short instead means the
// button's solid color always extends past where the bar's edge
// (curved corners included) ends, so the notch lands on solid button
// color with margin to spare.
const ADDRESS_REVEAL_PX = 58;
const ADDRESS_OPEN_THRESHOLD_PX = 28;
let addressGestureDirection = null; // null | 'swipe' | 'scroll'
let addressPressStartX = 0;
let addressPressStartY = 0;
let addressOpenSide = null; // 'send' | 'discard' | null

function closeAddressSwipe() {
  addressOpenSide = null;
  addressFront.style.transition = '';
  addressFront.style.transform = '';
}

addressFront.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (document.activeElement === composeTo) return; // actively typing — leave native cursor/selection alone
  addressGestureDirection = null;
  addressPressStartX = e.clientX;
  addressPressStartY = e.clientY;
});

addressFront.addEventListener('pointermove', (e) => {
  if (document.activeElement === composeTo && addressGestureDirection === null) return;
  const dx = e.clientX - addressPressStartX;
  const dy = e.clientY - addressPressStartY;
  if (addressGestureDirection === null) {
    if (Math.hypot(dx, dy) <= LONG_PRESS_MOVE_TOLERANCE_PX) return;
    addressGestureDirection = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'scroll';
    // If the raw input grabbed native focus in the instant before we
    // could tell this was a drag, drop it now — a swipe should never
    // leave the field in edit mode or pop the keyboard open mid-drag.
    if (addressGestureDirection === 'swipe' && document.activeElement === composeTo) composeTo.blur();
  }
  if (addressGestureDirection !== 'swipe') return; // vertical — let native scroll of .compose-fields proceed
  e.preventDefault();
  const locked = addressLockBar.style.display !== 'none';
  const openOffset =
    addressOpenSide === 'send' ? -ADDRESS_REVEAL_PX : addressOpenSide === 'discard' ? ADDRESS_REVEAL_PX : 0;
  const minX = locked ? -ADDRESS_REVEAL_PX : 0;
  const offset = Math.min(ADDRESS_REVEAL_PX, Math.max(minX, openOffset + dx));
  addressFront.style.transition = 'none';
  addressFront.style.transform = `translateX(${offset}px)`;
});

addressFront.addEventListener('pointerup', (e) => {
  addressFront.style.transition = '';
  if (addressGestureDirection !== 'swipe') {
    addressGestureDirection = null;
    return;
  }
  const dx = e.clientX - addressPressStartX;
  const locked = addressLockBar.style.display !== 'none';
  const openOffset =
    addressOpenSide === 'send' ? -ADDRESS_REVEAL_PX : addressOpenSide === 'discard' ? ADDRESS_REVEAL_PX : 0;
  const finalOffset = openOffset + dx;
  if (locked && finalOffset < -ADDRESS_OPEN_THRESHOLD_PX) {
    addressFront.style.transform = `translateX(${-ADDRESS_REVEAL_PX}px)`;
    addressOpenSide = 'send';
  } else if (finalOffset > ADDRESS_OPEN_THRESHOLD_PX) {
    addressFront.style.transform = `translateX(${ADDRESS_REVEAL_PX}px)`;
    addressOpenSide = 'discard';
  } else {
    closeAddressSwipe();
  }
  addressGestureDirection = null;
});
addressFront.addEventListener('pointercancel', () => {
  addressGestureDirection = null;
  closeAddressSwipe();
});

// A tap anywhere else in the compose view closes an open reveal
// instead of leaving it hanging open — matches the card swipe's
// outside-tap-closes behavior.
composeView.addEventListener('click', (e) => {
  if (addressOpenSide && !addressWrap.contains(e.target)) closeAddressSwipe();
});

addressDiscardBtn.addEventListener('click', () => {
  closeAddressSwipe();
  closeCompose();
});
addressSendBtn.addEventListener('click', () => {
  closeAddressSwipe();
  sendComposeMessage();
});

// Reply/forward both need the complete message (real Message-ID for
// threading, full body to quote/forward) — ensureFullBodyLoaded()
// already fetches and caches this on demand and is a no-op if the card
// was already expanded, so there's no separate fetch path to maintain
// here.
async function openReplyCompose(card) {
  closeSwipe(card);
  markRead(card);
  await ensureFullBodyLoaded(card);
  const msg = cardData.get(card);
  if (!msg) return;
  const subject = msg.subject?.startsWith('Re: ') ? msg.subject : `Re: ${msg.subject || ''}`;
  const quoted = (bestPreviewText(msg) || '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const senderLabel = msg.from?.name || msg.from?.address || 'them';
  openCompose({
    mode: 'reply',
    to: msg.from?.address || '',
    subject,
    body: `\n\nOn ${formatFullDate(msg.receivedAt)}, ${senderLabel} wrote:\n${quoted}`,
    inReplyTo: msg.messageId,
    threadId: msg.threadId,
  });
}

async function openForwardCompose(card) {
  closeSwipe(card);
  markRead(card);
  await ensureFullBodyLoaded(card);
  const msg = cardData.get(card);
  if (!msg) return;
  const subject = msg.subject?.startsWith('Fwd: ') ? msg.subject : `Fwd: ${msg.subject || ''}`;
  const fromLabel = msg.from?.name ? `${msg.from.name} <${msg.from.address}>` : msg.from?.address || '';
  const toLabel = (msg.to || []).map((a) => a.address).join(', ');
  const original = bestPreviewText(msg) || '';
  openCompose({
    mode: 'forward',
    to: '',
    subject,
    body:
      `\n\n---------- Forwarded message ----------\n` +
      `From: ${fromLabel}\nDate: ${formatFullDate(msg.receivedAt)}\n` +
      `Subject: ${msg.subject || ''}\nTo: ${toLabel}\n\n${original}`,
  });
}

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
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
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
let openSwipeCard = null; // the one card currently swiped open, if any

function cancelLongPress() {
  if (pressTimer !== null) clearTimeout(pressTimer);
  pressTimer = null;
}

// Snaps a card's swipe-reveal shut. Safe to call on a card that isn't
// open — used both as the deliberate "close" action and defensively
// (e.g. before opening a different card).
function closeSwipe(card) {
  if (!card) return;
  card.classList.remove('swipe-open');
  const front = card.querySelector('.card-front');
  if (front) {
    front.style.transition = '';
    front.style.transform = '';
  }
  if (openSwipeCard === card) openSwipeCard = null;
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
      openSwipeCard = activeCard;
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
  if (shelf.classList.contains('open')) {
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
        const card = buildCard(summary);
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
  const card = buildCard(message);
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

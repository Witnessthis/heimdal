import { feed } from '../feed/dom';
import { getActiveProfileId } from '../shared/active-profile';
import { openCompose } from './compose';
import { shouldSnapToBoundary } from './reveal-snap';

// The New Email button is plain, static, in-flow content at the very
// top of the feed — no JS-driven height/transform animation. #feed
// naturally scrolls between "hidden" (.feed-top-spacer at the viewport
// top, scrollTop == this strip's own height) and "revealed" (the strip
// itself at the top, scrollTop 0).
//
// CSS scroll-snap (scroll-snap-type/-align) was tried for the decisive
// open/closed behavior and dropped: a scroll container's "proximity"
// closeness — how far away a resting scroll position can be and still
// get pulled to a snap point — isn't something CSS lets an author tune,
// it's a browser heuristic, and in practice it reached several cards
// deep into the mail list, well past the ~70-90px hidden/revealed gap
// it was meant to cover. The snap-to-nearest-end logic below does the
// same job but against a real, exact number (hiddenScrollTop()), not a
// heuristic, so it can never reach beyond that one boundary into
// ordinary list scrolling.
const hiddenMarker = document.querySelector('.feed-top-spacer') as HTMLElement;
const newEmailBg = document.getElementById('new-email-bg') as HTMLElement;

// #feed's own base bottom padding (nav clearance + safe area), resolved to
// a real px number once up front, before --feed-min-scroll-fill has ever
// been set (it defaults to 0 via the var()'s own fallback) — see
// ensureEnoughScrollRoom's own comment for why this has to be subtracted
// back out rather than left as extra, unaccounted-for filler.
const BASE_PADDING_BOTTOM_PX = Number.parseFloat(getComputedStyle(feed).paddingBottom) || 0;

// How close to fully revealed (as a fraction of hiddenScrollTop()) a
// settled pull needs to land to commit to opening — see the settle
// logic below.
const OPEN_FRACTION = 0.1;

// Exported for settings.ts's handleScroll: the New Email strip's own
// height is the *resting* top of the inbox from the user's perspective
// (see the comment above ensureNewEmailBgPinned) — the bottom nav's
// "at the top" check needs to measure against this, not a guessed
// pixel constant, or being pinned here at rest reads as already
// scrolled past it.
export function hiddenScrollTop(): number {
  return hiddenMarker.offsetTop;
}

// Start hidden — and stay invisible (not just unscrolled-to) until
// that's actually confirmed: visibility: hidden (preserves the strip's
// layout box, so hiddenScrollTop() keeps measuring correctly) until
// feed.scrollTop is verified to actually equal hiddenScrollTop(). Since
// it's already scrolled out of the viewport by the time that's true,
// revealing it then is invisible to the user either way.
//
// A scrollTop assignment can fail to "stick" for three different
// reasons, handled three different ways below:
//  - #feed isn't the visible view yet. AI Feed is the default landing
//    tab (see showView() in settings.ts), so #feed can be display:none
//    at load — a hidden element's scrollTop always reads back 0, and so
//    does hiddenScrollTop() (offsetTop is 0 for anything inside a
//    display:none subtree), so an unguarded tryPin() would read that as
//    a false-positive "pinned" the instant it's called. tryPin() bails
//    out first if #feed has no layout box at all; ensureNewEmailBgPinned
//    is re-invoked once the reader actually switches to Inbox.
//  - Layout genuinely isn't ready yet (first paint hasn't happened, a
//    custom font is still swapping in and changing the button's own
//    height). One requestAnimationFrame is enough for this — it fires
//    after layout has settled.
//  - There isn't enough content to be scrollable that far YET, because
//    the inbox is still loading (this is also, not incidentally, why
//    the button must not show while loading: there's nowhere for it to
//    be scrolled out of view to). This isn't a "wait one more frame"
//    problem — it can take as long as the IMAP fetch does — so instead
//    of guessing a frame count, a MutationObserver re-attempts the pin
//    every time #feed's content changes (loadMore() in inbox.ts inserts
//    each batch of cards as direct children), which resolves the
//    instant there's enough content, however long that takes.
newEmailBg.style.visibility = 'hidden';
let pinned = false;
let pinAttemptInFlight = false;
// Hoisted (rather than local to one ensureNewEmailBgPinned() call) so
// resetNewEmailBgPin() can tear down a still-in-flight attempt before
// starting a new one — otherwise switching profile twice in quick
// succession (the profile switcher deliberately stays open for exactly
// this — see chat history) would leave an earlier attempt's rAF/observer/
// timer alive, running its own tryPin() (and so its own
// ensureEnoughScrollRoom() measurement) against stale content, racing
// whichever one runs last against the new attempt for the same
// --feed-min-scroll-fill value. activeRafHandle in particular was missed
// the first time this teardown was added — the *scheduled but not yet
// fired* requestAnimationFrame callback itself isn't a timer or observer,
// so stopInFlightPinAttempt() wasn't actually stopping it, only the two
// things that get created *after* it fires. This is what let scrolling
// behave differently depending on how many times an account had just been
// switched away from and back to, rather than just what its own content
// was — see chat history.
let activeRafHandle: number | null = null;
let activeObserver: MutationObserver | null = null;
let activeGiveUpTimer: ReturnType<typeof setTimeout> | null = null;

function stopInFlightPinAttempt(): void {
  if (activeRafHandle !== null) cancelAnimationFrame(activeRafHandle);
  activeRafHandle = null;
  activeObserver?.disconnect();
  activeObserver = null;
  if (activeGiveUpTimer !== null) clearTimeout(activeGiveUpTimer);
  activeGiveUpTimer = null;
}

// Guarantees #feed can actually be scrolled far enough to carry the New
// Email button out of view, regardless of how few emails — down to zero —
// the inbox currently has. Without this, a too-short inbox simply has
// nowhere for scrollTop to reach hiddenScrollTop() at all: the browser
// clamps it to whatever the real content allows, tryPin() below keeps
// failing, and ensureNewEmailBgPinned's own give-up timer used to be the
// only way out of that, permanently revealing the button (and leaving
// #feed genuinely too short to scroll at all) instead of hiding it.
//
// Measures the real content height via the last child's own document-flow
// position (offsetTop + offsetHeight), NOT via #feed's own scrollHeight —
// scrollHeight is clamped to never read below clientHeight (confirmed by
// reproducing this in a real browser: with only a few short cards,
// scrollHeight reported the full 700px viewport height even though the
// actual content only reached ~380px), so a shortfall computed from it
// silently under-counts by exactly the amount this function exists to
// detect, every time real content is shorter than the viewport — which is
// exactly the sparse-inbox case this is supposed to handle. offsetTop is a
// plain layout-flow measurement with no such floor.
//
// A deliberate few pixels past the theoretical exact minimum — offsetTop
// can be fractional (sub-pixel layout) and browsers round a scrollTop
// assignment, so aiming for the exact boundary risks landing a fraction of
// a pixel short of it.
const SCROLL_ROOM_MARGIN_PX = 4;

// BASE_PADDING_BOTTOM_PX *must* be subtracted here — leaving it as
// "harmless extra" was tried and wasn't: with a sparse inbox, the unwanted
// slack pushed the max scroll position (clientHeight + hiddenScrollTop(),
// which this fill is sized to just reach) well past where the *last card*
// actually starts, since that target no longer had anything to do with the
// real content's own position. Scrolling to the bottom then left most of
// the last card scrolled up out of view, with nothing but blank filler
// showing below it — see chat history. Subtracting the real base padding
// keeps the target scroll position pinned to just past the button, which
// (given the first, and so every later, card already starts right after
// the button+spacer, comfortably past hiddenScrollTop() on its own) never
// scrolls further than the last card's own top edge.
function ensureEnoughScrollRoom(): void {
  const last = feed.lastElementChild as HTMLElement | null;
  const contentBottom = last ? last.offsetTop + last.offsetHeight : 0;
  const shortfall =
    feed.clientHeight + hiddenScrollTop() + SCROLL_ROOM_MARGIN_PX - contentBottom - BASE_PADDING_BOTTOM_PX;
  feed.style.setProperty('--feed-min-scroll-fill', `${Math.max(0, shortfall)}px`);
}

function tryPin(): boolean {
  // offsetParent is null exactly when #feed (a position:absolute
  // element with a positioned ancestor) is display:none — see above.
  if (feed.offsetParent === null) return false;
  ensureEnoughScrollRoom();
  feed.scrollTop = hiddenScrollTop();
  // A tolerance, not strict equality, for the same sub-pixel/rounding
  // reason as SCROLL_ROOM_MARGIN_PX above — the assignment above can
  // legitimately land a fraction of a pixel away from the target and
  // still be visually/functionally pinned.
  return Math.abs(feed.scrollTop - hiddenScrollTop()) < 1;
}

// Safe to call any number of times, from any view: a no-op once already
// pinned (or while a previous attempt is still in flight), and a no-op
// while #feed isn't the visible view — callers don't need to know which
// case applies. Called once at module load, and again from showView()
// every time the reader switches to Inbox, since that may be the first
// time #feed has ever actually had a layout box to pin against.
export function ensureNewEmailBgPinned(): void {
  if (pinned || pinAttemptInFlight) return;
  if (feed.offsetParent === null) return; // not the visible view (yet)
  pinAttemptInFlight = true;
  activeRafHandle = requestAnimationFrame(() => {
    activeRafHandle = null;
    if (tryPin()) {
      pinned = true;
      pinAttemptInFlight = false;
      newEmailBg.style.visibility = '';
      return;
    }
    const observer = new MutationObserver(() => {
      if (tryPin()) {
        stopInFlightPinAttempt();
        pinned = true;
        pinAttemptInFlight = false;
        newEmailBg.style.visibility = '';
      }
    });
    observer.observe(feed, { childList: true });
    activeObserver = observer;
    // ensureEnoughScrollRoom (see tryPin) already guarantees enough scroll
    // range regardless of content, so this should rarely if ever actually
    // fire now — kept as a last-resort safety net (e.g. a fetch failing
    // outright, or some environment where the very first layout read is
    // unreliable) rather than the primary way a sparse inbox used to be
    // handled. Counts as "pinned" (no further retries): it already gave up
    // and revealed the button, so a later retry could only make things
    // worse by hiding it again.
    activeGiveUpTimer = setTimeout(() => {
      stopInFlightPinAttempt();
      pinned = true;
      pinAttemptInFlight = false;
      newEmailBg.style.visibility = '';
    }, 15000);
  });
}
ensureNewEmailBgPinned();

/** Re-arms the pin sequence for a freshly-loaded inbox under the same
 *  button — called when switching profile (see inbox.ts's switchAccount).
 *  The new account's inbox starts from a much shorter DOM (every card from
 *  the previous account was just removed), so scrollTop simply clamps to
 *  wherever that shrunk range allows — often revealing the button, since
 *  there's nothing to carry it out of view for yet. Hiding it again
 *  immediately and re-running the same pin logic used at initial load
 *  (already robust to a sparse/empty inbox via ensureEnoughScrollRoom)
 *  keeps a profile switch from ever surfacing the button by accident.
 *  Tears down any still-in-flight attempt from a previous switch first —
 *  the profile switcher deliberately stays open across selections, so
 *  switching again before an earlier attempt has resolved is routine, not
 *  an edge case. */
export function resetNewEmailBgPin(): void {
  stopInFlightPinAttempt();
  pinned = false;
  pinAttemptInFlight = false;
  newEmailBg.style.visibility = 'hidden';
  ensureNewEmailBgPinned();
}

document.getElementById('new-email-btn')!.addEventListener('click', () => {
  feed.scrollTop = hiddenScrollTop();
  openCompose({ mode: 'new', accountId: getActiveProfileId() ?? undefined });
});

// Whether a finger is currently down on the feed. Distinguishes a
// deliberate drag — finger still down, allowed to pull scrollTop past
// hiddenScrollTop() on purpose, since that's how the button is opened —
// from native momentum still coasting after the finger has already
// lifted, which should never be allowed to carry scrollTop past that
// point on its own (see the scroll handler below).
//
// Tracked via raw touch events, not Pointer Events: #feed allows native
// vertical panning (touch-action: pan-y), and the instant the browser
// recognizes a touch as a pan/scroll it fires pointercancel to hand
// control over to native scrolling — even though the finger is still
// down. Using pointerdown/-up/-cancel for this made the "finger down"
// state flip false right at the start of every pull, so the momentum
// catch below fought the drag itself instead of leaving it alone.
// touchstart/touchend/touchcancel don't get cancelled that way; they
// track the physical finger for the whole gesture regardless of who's
// driving the scroll. mousedown/mouseup is a harmless fallback so this
// still behaves sanely testing with a mouse (no touch events at all).
let pointerDown = false;
feed.addEventListener('touchstart', () => {
  pointerDown = true;
});
window.addEventListener('touchend', () => {
  pointerDown = false;
});
window.addEventListener('touchcancel', () => {
  pointerDown = false;
});
feed.addEventListener('mousedown', () => {
  pointerDown = true;
});
window.addEventListener('mouseup', () => {
  pointerDown = false;
});

let prevScrollTop = feed.scrollTop;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
feed.addEventListener(
  'scroll',
  () => {
    const h = hiddenScrollTop();
    const st = feed.scrollTop;

    // A fling decelerates smoothly through hiddenScrollTop() with
    // nothing to stop it short of one of the container's real
    // boundaries (scrollTop 0 revealed, or however far the mail list
    // goes) — same reason a JS-height-collapsed "hidden" state broke
    // under momentum earlier in this feature's history, and CSS
    // scroll-snap-stop: always would fix this but was dropped for being
    // unusably grabby on ordinary scrolling (see the comment above
    // hiddenScrollTop()). Catching it by hand here is narrower than
    // either: only when the finger's already up (pure momentum, not a
    // deliberate drag still in progress) and this event is the exact
    // frame crossing hiddenScrollTop() — from either side — do we clamp
    // back to it, arresting the fling right there instead of letting it
    // sail on past. Symmetric: a fling up from deep in the list stops
    // here instead of reaching all the way to revealed, and a fling
    // down from revealed stops here instead of diving into the list.
    //
    // The strict-inequality subtlety that makes scrolling away from a fresh
    // snap possible lives in shouldSnapToBoundary (with its own tests).
    if (shouldSnapToBoundary(pointerDown, prevScrollTop, st, h)) {
      feed.scrollTop = h;
      prevScrollTop = h;
      return;
    }
    prevScrollTop = st;

    // Once a scroll gesture settles (debounced — fires 90ms after the
    // last scroll event, so mid-gesture and momentum frames don't
    // trigger it) with scrollTop strictly between 0 and
    // hiddenScrollTop(), that's an ambiguous partial reveal — resolve
    // it to whichever end is nearer. Outside that exact range (0,
    // hiddenScrollTop() itself, or anywhere further into the list) this
    // does nothing at all.
    //
    // "Nearer" is deliberately not the midpoint: opening requires
    // pulling almost all the way to fully revealed (within
    // OPEN_FRACTION of it) — a pull that falls short, even well past
    // halfway, springs back to hidden instead of committing. A pull
    // gesture needs a real commit threshold near the end of its travel,
    // not a coin-flip at the midpoint, or it opens on pulls that were
    // never meant to.
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const hh = hiddenScrollTop();
      const scrolled = feed.scrollTop;
      if (scrolled <= 0 || scrolled >= hh) return;
      feed.scrollTo({ top: scrolled <= hh * OPEN_FRACTION ? 0 : hh, behavior: 'smooth' });
    }, 90);
  },
  { passive: true },
);

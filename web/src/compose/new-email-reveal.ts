import { feed } from '../feed/dom';
import { openCompose } from './compose';

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

// How close to fully revealed (as a fraction of hiddenScrollTop()) a
// settled pull needs to land to commit to opening — see the settle
// logic below.
const OPEN_FRACTION = 0.1;

function hiddenScrollTop(): number {
  return hiddenMarker.offsetTop;
}

// Start hidden — and stay invisible (not just unscrolled-to) until
// that's actually confirmed. A single requestAnimationFrame turned out
// not to be reliably enough of a wait on-device: the assignment can
// still land before the browser's layout has settled (e.g. while a
// custom font is still swapping in, changing the button's own height,
// and so hiddenScrollTop()) and silently not stick, leaving the button
// showing at scrollTop 0. So this is defensive on top of that, not
// instead of it: the strip is visibility: hidden (preserves its layout
// box, so hiddenScrollTop() keeps measuring correctly) until a
// requestAnimationFrame loop has verified feed.scrollTop actually
// equals hiddenScrollTop() — retrying on the next frame if not — at
// which point it's revealed. Since it's already scrolled out of the
// viewport by then, revealing it is invisible to the user either way.
//
// Capped at PIN_HIDDEN_MAX_ATTEMPTS: an empty inbox (nothing but the
// "no messages" status text) may never have enough content to scroll
// past hiddenScrollTop() at all, in which case this could never
// resolve — give up and reveal wherever it lands rather than leaving
// the compose button permanently invisible and this loop running
// forever.
const PIN_HIDDEN_MAX_ATTEMPTS = 60;
newEmailBg.style.visibility = 'hidden';
function pinHidden(attempt: number): void {
  feed.scrollTop = hiddenScrollTop();
  if (feed.scrollTop === hiddenScrollTop() || attempt >= PIN_HIDDEN_MAX_ATTEMPTS) {
    newEmailBg.style.visibility = '';
  } else {
    requestAnimationFrame(() => pinHidden(attempt + 1));
  }
}
requestAnimationFrame(() => pinHidden(0));

document.getElementById('new-email-btn')!.addEventListener('click', () => {
  feed.scrollTop = hiddenScrollTop();
  openCompose({ mode: 'new' });
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
    if (!pointerDown && ((prevScrollTop >= h && st < h) || (prevScrollTop <= h && st > h))) {
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

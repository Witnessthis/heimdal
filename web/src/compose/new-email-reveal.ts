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

function hiddenScrollTop(): number {
  return hiddenMarker.offsetTop;
}

// Start hidden. Setting scrollTop synchronously at module load doesn't
// reliably stick — the browser hasn't finished its first layout pass
// yet at that point, so the scrollable area isn't established and the
// assignment is silently dropped, leaving the button showing. A single
// requestAnimationFrame is enough: it fires after the browser's first
// layout/style pass, before the first paint, so there's no visible
// flash of the revealed state either.
requestAnimationFrame(() => {
  feed.scrollTop = hiddenScrollTop();
});

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

    // A fling from deep in the list decelerates smoothly through
    // hiddenScrollTop() with nothing to stop it short of the container's
    // real boundary (scrollTop 0) — same reason a JS-height-collapsed
    // "hidden" state broke under momentum earlier in this feature's
    // history, and CSS scroll-snap-stop: always would fix this but was
    // dropped for being unusably grabby on ordinary scrolling (see the
    // comment above hiddenScrollTop()). Catching it by hand here is
    // narrower than either: only when the finger's already up (pure
    // momentum, not a deliberate drag still in progress) and this event
    // is the exact frame crossing from at-or-past hiddenScrollTop() to
    // short of it do we clamp back to the boundary — arresting the
    // fling right there instead of letting it sail on to scrollTop 0.
    if (!pointerDown && prevScrollTop >= h && st < h) {
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
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const hh = hiddenScrollTop();
      const scrolled = feed.scrollTop;
      if (scrolled <= 0 || scrolled >= hh) return;
      feed.scrollTo({ top: scrolled < hh / 2 ? 0 : hh, behavior: 'smooth' });
    }, 90);
  },
  { passive: true },
);

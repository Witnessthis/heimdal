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

// Once a scroll gesture settles (debounced — fires 90ms after the last
// scroll event, so mid-gesture and momentum frames don't trigger it)
// with scrollTop strictly between 0 and hiddenScrollTop(), that's an
// ambiguous partial reveal — resolve it to whichever end is nearer.
// Outside that exact range (0, hiddenScrollTop() itself, or anywhere
// further into the list) this does nothing at all.
let settleTimer: ReturnType<typeof setTimeout> | null = null;
feed.addEventListener(
  'scroll',
  () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const h = hiddenScrollTop();
      const scrolled = feed.scrollTop;
      if (scrolled <= 0 || scrolled >= h) return;
      feed.scrollTo({ top: scrolled < h / 2 ? 0 : h, behavior: 'smooth' });
    }, 90);
  },
  { passive: true },
);

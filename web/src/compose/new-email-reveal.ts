import { feed } from '../feed/dom';
import { openCompose } from './compose';

// The "New Email" button lives at the very top of the feed, collapsed to
// zero height by default so the first card sits at the natural top of the
// scroll (scrollTop 0). That's what keeps momentum honest: a flick to the
// top rests on the mail, never on the button. The button is revealed only
// by a deliberate pull-down while already at the top — the feed's gesture
// recognizer (gestures.ts) drives dragNewEmailReveal/settleNewEmailReveal
// during that pull — and hidden again by simply scrolling it back off the
// top (see the scroll settle at the bottom of this file). It expands the
// strip's own height, pushing the cards down, rather than floating over
// them, so it reads as part of the same surface the cards sit on.
const newEmailBg = document.getElementById('new-email-bg') as HTMLElement;

let revealed = false;

// Full height the strip expands to when revealed. scrollHeight is NOT
// reliable here — WebKit misreports it for a flex container that's
// currently clamped to height:0 with overflow:hidden (returns something
// smaller than the actual content), which made the strip only ever open
// a few px, clipping the button's top and bottom border and making the
// "reveal" barely register as a snap. Measuring via a real height:auto
// layout pass and offsetHeight sidesteps that bug. Cached since it's read
// on every pointermove during a drag — re-measured on resize (rotation,
// or a PWA safe-area change) since it depends on env(safe-area-inset-top).
let cachedFullHeight = 0;

function measureFullHeight(): number {
  const prevHeight = newEmailBg.style.height;
  const prevTransition = newEmailBg.style.transition;
  newEmailBg.style.transition = 'none';
  newEmailBg.style.height = 'auto';
  const h = newEmailBg.offsetHeight;
  newEmailBg.style.height = prevHeight;
  newEmailBg.style.transition = prevTransition;
  return h;
}

function fullHeight(): number {
  if (cachedFullHeight === 0) cachedFullHeight = measureFullHeight();
  return cachedFullHeight;
}

window.addEventListener('resize', () => {
  cachedFullHeight = measureFullHeight();
});

export function isNewEmailRevealed(): boolean {
  return revealed;
}

// Live drag: follow the finger, clamped to [0, full height], no
// transition so it tracks the pointer directly.
export function dragNewEmailReveal(offset: number): void {
  newEmailBg.style.transition = 'none';
  newEmailBg.style.height = `${Math.max(0, Math.min(fullHeight(), offset))}px`;
}

// Release: snap fully open or shut depending on how far it was pulled,
// animating there via the strip's CSS height transition.
export function settleNewEmailReveal(offset: number): void {
  const h = fullHeight();
  newEmailBg.style.transition = '';
  revealed = offset > h / 2;
  newEmailBg.style.height = revealed ? `${h}px` : '0px';
}

// Snap shut immediately (no animation) — used when the strip is already
// off-screen or about to be covered (dismiss-by-scroll, opening compose).
function collapse(): void {
  newEmailBg.style.transition = 'none';
  newEmailBg.style.height = '0px';
  revealed = false;
}

document.getElementById('new-email-btn')!.addEventListener('click', () => {
  collapse();
  openCompose({ mode: 'new' });
});

// Dismiss-by-scrolling. While revealed, the strip is real content at the
// top of the feed, so scrolling up pushes it off like anything else. Once
// that scroll settles, resolve it: snap back fully open if it was barely
// nudged, otherwise collapse. If it was scrolled entirely past, collapse
// without moving the cards — drop the strip's height from both the
// content above and the scroll offset so nothing jumps.
let settleTimer: ReturnType<typeof setTimeout> | null = null;
feed.addEventListener(
  'scroll',
  () => {
    if (!revealed) return; // hidden: momentum already rests at the top on its own
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (!revealed) return;
      const h = fullHeight();
      const scrolled = feed.scrollTop;
      if (scrolled <= 0) return; // still fully revealed
      if (scrolled >= h) {
        collapse();
        feed.scrollTop = scrolled - h;
      } else if (scrolled < h / 2) {
        feed.scrollTop = 0; // barely nudged — snap back fully open
      } else {
        collapse();
        feed.scrollTop = 0;
      }
    }, 90);
  },
  { passive: true },
);

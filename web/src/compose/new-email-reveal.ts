import { feed } from '../feed/dom';
import { openCompose } from './compose';

// The "New Email" button is the first element inside the feed's scroll
// content, above the cards — not a separate panel and not anything the
// JS animates into place. Revealing/hiding it is the feed's own native
// vertical scroll: the feed rests scrolled down by the button's height
// so it's parked just off the top, scrolling up reveals it, scrolling
// back down hides it. The only scripted part is settling a half-
// finished reveal (below).
const newEmailBg = document.getElementById('new-email-bg') as HTMLElement;

// Reveal the button into the layout and park it just off the top of the
// feed. It's kept out of the layout (#feed:not(.loaded) in the CSS)
// until this runs, so it can't be stranded on screen during the initial
// load, when the feed is still too short to scroll it out of view.
// Called once after the first batch renders (inbox.ts), and again before
// composing so returning from compose doesn't leave it hanging open.
export function hideNewEmail(): void {
  feed.classList.add('loaded');
  feed.scrollTop = newEmailBg.offsetHeight;
}

document.getElementById('new-email-btn')!.addEventListener('click', () => {
  hideNewEmail();
  openCompose({ mode: 'new' });
});

// --- Snap a half-finished reveal to fully-shown or fully-hidden ------
// Done here in JS rather than with CSS scroll-snap on purpose: a snap
// point attracts from both sides, so the "hidden" point (which sits
// right where the reveal meets the feed) would yank the feed back to
// the top the instant you scrolled down past the parked button. This
// only acts while the scroll is resting *strictly inside* the button's
// height — mid-reveal — so at or past the parked position, i.e. anywhere
// in the feed proper, it does nothing at all.
let snapTimer: ReturnType<typeof setTimeout> | null = null;
let snapping = false;

function animateScrollTo(to: number): void {
  const from = feed.scrollTop;
  const start = performance.now();
  const DURATION_MS = 180;
  snapping = true;
  function step(now: number): void {
    const t = Math.min(1, (now - start) / DURATION_MS);
    const eased = 1 - (1 - t) * (1 - t); // ease-out quad
    feed.scrollTop = from + (to - from) * eased;
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      snapping = false;
    }
  }
  requestAnimationFrame(step);
}

feed.addEventListener(
  'scroll',
  () => {
    if (snapping) return; // our own animation is driving scrollTop — leave it be
    if (snapTimer !== null) clearTimeout(snapTimer);
    // Debounced: fire once the scroll has actually come to rest, not on
    // every event during a flick or momentum.
    snapTimer = setTimeout(() => {
      const revealHeight = newEmailBg.offsetHeight;
      const scrolled = feed.scrollTop;
      if (scrolled > 0 && scrolled < revealHeight) {
        animateScrollTo(scrolled < revealHeight / 2 ? 0 : revealHeight);
      }
    }, 90);
  },
  { passive: true },
);

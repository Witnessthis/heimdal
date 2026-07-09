import { feed } from '../feed/dom';
import { openCompose } from './compose';

// The "New Email" button is the first element inside the feed's scroll
// content, above the cards — not a separate panel and not anything the
// JS animates. The feed starts scrolled down by exactly this strip's
// height (see hideNewEmail, called once after the first batch renders
// in inbox.ts) so it's parked just off the top; scrolling the feed up
// to the very top reveals it, scrolling back down hides it. It's the
// same native scroll that moves the cards — no gesture recognizer, no
// transform, speed-independent by construction.
const newEmailBg = document.getElementById('new-email-bg') as HTMLElement;

// Park the reveal just off the top: scroll the feed down by the button
// strip's own height so the cards sit at the top and the button is
// hidden immediately above them. Also used after composing, so
// returning from compose doesn't leave the button hanging open.
export function hideNewEmail(): void {
  feed.scrollTop = newEmailBg.offsetHeight;
}

document.getElementById('new-email-btn')!.addEventListener('click', () => {
  hideNewEmail();
  openCompose({ mode: 'new' });
});

// Snap the reveal fully open or shut once scrolling settles anywhere
// inside its narrow band, so a slow scroll never leaves it resting
// half-shown. Debounced to fire on scroll-end rather than mid-scroll,
// and gated to only act while scrollTop is within the strip's height —
// so it never touches scrolling the feed proper, only the top reveal
// zone. behavior:'smooth' is the browser's own animation, not a
// hand-driven one.
let snapTimer: ReturnType<typeof setTimeout> | null = null;
feed.addEventListener(
  'scroll',
  () => {
    if (snapTimer !== null) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      const revealHeight = newEmailBg.offsetHeight;
      const scrolled = feed.scrollTop;
      if (scrolled > 0 && scrolled < revealHeight) {
        feed.scrollTo({ top: scrolled < revealHeight / 2 ? 0 : revealHeight, behavior: 'smooth' });
      }
    }, 120);
  },
  { passive: true },
);

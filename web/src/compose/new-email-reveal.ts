import { feed } from '../feed/dom';
import { openCompose } from './compose';

// The "New Email" button is the first element inside the feed's scroll
// content, above the cards — not a separate panel and not anything the
// JS animates. Revealing/hiding it is the feed's own native vertical
// scroll: the feed rests scrolled down by the button's height so it's
// parked just off the top, scrolling up reveals it, scrolling back down
// hides it. CSS scroll-snap (see #feed, #new-email-bg and
// .feed-snap-anchor in the CSS) pins it fully open or shut when a scroll
// settles near the top, so it never rests half-revealed — there's no
// JS gesture handling here at all.
const newEmailBg = document.getElementById('new-email-bg') as HTMLElement;

// Reveal the button into the layout and park it just off the top of the
// feed. It's kept out of the layout (see #feed:not(.loaded) in the CSS)
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

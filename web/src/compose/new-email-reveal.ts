import { feed } from '../feed/dom';
import { openCompose } from './compose';

// The New Email button is plain, static, in-flow content at the very
// top of the feed — no JS-driven height/transform animation. The
// reveal is native scroll + CSS scroll-snap (see #new-email-bg and
// .feed-top-spacer in compose.css): #feed snaps between "hidden"
// (.feed-top-spacer aligned to the viewport top, scrollTop == this
// strip's own height) and "revealed" (the strip itself aligned to the
// top, scrollTop == 0). scroll-snap-stop: always on the hidden marker
// is what makes this hold up under momentum — even a hard fling toward
// the top has to stop there rather than skipping through to fully
// revealed, which is what earlier hand-rolled versions of this kept
// getting wrong. proximity (not mandatory) snapping keeps ordinary
// scrolling through the mail list itself completely untouched: the
// browser only pulls toward one of these two snap points when a scroll
// gesture already comes to rest near one, never when you're actually
// scrolling through mail further down.
const hiddenMarker = document.querySelector('.feed-top-spacer') as HTMLElement;

// Start hidden. Setting scrollTop synchronously at module load doesn't
// reliably stick — the browser hasn't finished its first layout pass
// yet at that point, so the scrollable area isn't established and the
// assignment is silently dropped, leaving the button showing. A single
// requestAnimationFrame is enough: it fires after the browser's first
// layout/style pass, before the first paint, so there's no visible
// flash of the revealed state either.
requestAnimationFrame(() => {
  feed.scrollTop = hiddenMarker.offsetTop;
});

document.getElementById('new-email-btn')!.addEventListener('click', () => {
  feed.scrollTop = hiddenMarker.offsetTop;
  openCompose({ mode: 'new' });
});

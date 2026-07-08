import { feed } from './feed/dom';
// Side-effect only — registers the feed's long-press/swipe/pull/click
// pointer listeners (and transitively loads compose/shelf.ts, for the
// pull-to-reveal shelf). Nothing here needs a named import from it, but
// the module must still be loaded for those listeners to exist at all.
import './feed/gestures';
import { bootstrap, checkBatchTrigger } from './feed/inbox';
import { closeSwipe, openSwipeCard } from './feed/swipe-state';
import { handleScroll } from './settings/settings';

// Scroll events fire far more often than frames render, and both
// handleScroll and checkBatchTrigger read layout (scrollTop, offsetTop,
// clientHeight) — running them per event forces redundant synchronous
// layout work between frames. Coalesce to at most one run per frame;
// only closing an open swipe stays immediate, since that's gesture
// correctness rather than layout-dependent work.
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

bootstrap();

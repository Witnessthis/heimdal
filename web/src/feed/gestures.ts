import { closeShelf, isShelfOpen, openShelf, shelf } from '../compose/shelf';
import { feed } from './dom';
import { LONG_PRESS_MOVE_TOLERANCE_PX } from './gesture-constants';
import { clearRenderedBody, ensureFullBodyLoaded, markRead } from './render-body';
import { selectedIds, toggleSelect } from './selection';
import { closeSwipe, openSwipeCard, setOpenSwipeCard } from './swipe-state';

// One consolidated gesture recognizer for #feed, covering four
// behaviors that all start as "a pointer went down somewhere in the
// feed": tap (expand/collapse or select), long-press (enter selection
// mode), horizontal swipe on a card (reveal Reply/Forward), and a
// vertical pull while already at the top of the feed (reveal the new
// email shelf). Pointer Events unify mouse and touch behind one event
// model, so this works the same way on both without separate
// mousedown/touchstart handling.
//
// Direction is decided ONCE per gesture, the first time movement
// crosses LONG_PRESS_MOVE_TOLERANCE_PX — horizontal-dominant commits to
// 'swipe', vertical-dominant-while-pulling-down-from-the-top commits to
// 'pull', anything else vertical is left alone as plain native scroll
// (unchanged from before this gesture consolidation existed). Once
// committed to 'swipe' or 'pull', the long-press timer is cancelled and
// preventDefault() is called on further moves so native scroll doesn't
// fight the transform being driven by hand below — .card-front's
// touch-action: pan-y (see its CSS) is what lets the browser still own
// plain vertical scrolling right up until that point.
const LONG_PRESS_MS = 500;
const SWIPE_REVEAL_PX = 144; // two 72px action buttons — matches .card-swipe-actions CSS
const SWIPE_OPEN_THRESHOLD_PX = 40;
const PULL_OPEN_THRESHOLD_PX = 40;

let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressStartX = 0;
let pressStartY = 0;
let activeCard: HTMLElement | null = null; // the card this gesture started on, for its whole duration
let longPressFired = false;
let gestureDirection: 'swipe' | 'pull' | 'scroll' | null = null;
let gestureStartedAtTop = false;

function cancelLongPress(): void {
  if (pressTimer !== null) clearTimeout(pressTimer);
  pressTimer = null;
}

feed.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // primary mouse button / the actual touch point only
  const card = (e.target as Element).closest<HTMLElement>('.card');
  if (
    !card ||
    (e.target as Element).closest('.card-select') ||
    (e.target as Element).closest('.card-swipe-actions')
  )
    return;
  activeCard = card;
  pressStartX = e.clientX;
  pressStartY = e.clientY;
  gestureDirection = null;
  gestureStartedAtTop = feed.scrollTop <= 0;
  pressTimer = setTimeout(() => {
    longPressFired = true;
    toggleSelect(card);
    pressTimer = null;
  }, LONG_PRESS_MS);
});

feed.addEventListener('pointermove', (e) => {
  if (!activeCard) return;
  const dx = e.clientX - pressStartX;
  const dy = e.clientY - pressStartY;

  if (gestureDirection === null) {
    if (Math.hypot(dx, dy) <= LONG_PRESS_MOVE_TOLERANCE_PX) return; // not enough movement to decide yet
    cancelLongPress();
    if (Math.abs(dx) > Math.abs(dy)) {
      gestureDirection = 'swipe';
    } else if (dy > 0 && gestureStartedAtTop) {
      gestureDirection = 'pull';
    } else {
      gestureDirection = 'scroll'; // vertical, native — nothing further for this gesture to do
    }
  }

  if (gestureDirection === 'swipe') {
    e.preventDefault();
    const front = activeCard.querySelector<HTMLElement>('.card-front')!;
    const openOffset = activeCard === openSwipeCard ? -SWIPE_REVEAL_PX : 0;
    const offset = Math.min(0, Math.max(-SWIPE_REVEAL_PX, openOffset + dx));
    front.style.transition = 'none';
    front.style.transform = `translateX(${offset}px)`;
  } else if (gestureDirection === 'pull') {
    e.preventDefault();
    // shelf.offsetHeight is its real layout height regardless of its
    // current transform (transforms don't affect layout box size), so
    // this stays correct without duplicating the height as a JS
    // constant that could drift from the CSS.
    const shelfHeight = shelf.offsetHeight;
    const offset = Math.min(shelfHeight, Math.max(0, dy));
    shelf.style.transition = 'none';
    shelf.style.transform = `translateY(${offset - shelfHeight}px)`;
  }
});

feed.addEventListener('pointerup', (e) => {
  cancelLongPress();
  if (gestureDirection === 'swipe' && activeCard) {
    const front = activeCard.querySelector<HTMLElement>('.card-front')!;
    front.style.transition = '';
    const dx = e.clientX - pressStartX;
    const wasOpen = activeCard === openSwipeCard;
    const finalOffset = (wasOpen ? -SWIPE_REVEAL_PX : 0) + dx;
    if (openSwipeCard && openSwipeCard !== activeCard) closeSwipe(openSwipeCard);
    if (finalOffset < -SWIPE_OPEN_THRESHOLD_PX) {
      activeCard.classList.add('swipe-open');
      front.style.transform = `translateX(${-SWIPE_REVEAL_PX}px)`;
      setOpenSwipeCard(activeCard);
    } else {
      closeSwipe(activeCard);
    }
  } else if (gestureDirection === 'pull') {
    shelf.style.transition = '';
    const dy = e.clientY - pressStartY;
    if (dy > PULL_OPEN_THRESHOLD_PX) openShelf();
    else closeShelf();
  }
  activeCard = null;
  gestureDirection = null;
});
feed.addEventListener('pointercancel', () => {
  cancelLongPress();
  if (gestureDirection === 'swipe' && activeCard) closeSwipe(activeCard);
  if (gestureDirection === 'pull') closeShelf();
  activeCard = null;
  gestureDirection = null;
});

feed.addEventListener('click', (e) => {
  // A tap anywhere in the feed while the shelf is open closes it
  // instead of acting on whatever was tapped — the shelf's own button
  // has its own listener and never reaches this handler, since the
  // shelf isn't a descendant of #feed.
  if (isShelfOpen()) {
    closeShelf();
    return;
  }

  // Reply/Forward buttons handle their own clicks (see buildCard) —
  // don't also run card-click logic for the card they sit behind.
  if ((e.target as Element).closest('.card-swipe-actions')) return;

  // A tap anywhere outside the currently-open swiped card closes it
  // instead of performing whatever that tap would otherwise do —
  // standard swipe-list UX (matches e.g. iOS Mail).
  if (openSwipeCard && !openSwipeCard.contains(e.target as Node)) {
    closeSwipe(openSwipeCard);
    return;
  }

  // The click that follows a long-press's pointerup would otherwise
  // also toggle expand right after entering selection mode — consume
  // it here instead.
  if (longPressFired) {
    longPressFired = false;
    return;
  }

  const selectBtn = (e.target as Element).closest<HTMLElement>('.card-select');
  if (selectBtn) {
    toggleSelect(selectBtn.closest('.card')!);
    return;
  }
  const card = (e.target as Element).closest<HTMLElement>('.card');
  if (!card) return;

  // Once selection mode is active, a plain click/tap on a card toggles
  // its selection instead of expanding it — only the Cancel button or
  // deselecting everything exits back to normal browsing.
  if (selectedIds.size > 0) {
    toggleSelect(card);
    return;
  }

  const expanded = card.classList.toggle('expanded');
  if (expanded) {
    ensureFullBodyLoaded(card);
    markRead(card);
  } else {
    // Tear the rendered body down, don't just clip it: an HTML email
    // leaves behind a live iframe (its own document, styles, decoded
    // images) plus the ResizeObserver watching it, and before this
    // teardown every message expanded during a session stayed
    // resident forever — a leak that grew with reading activity.
    // Re-expanding is cheap: the full message stays cached in
    // cardData, and clearing renderedWithSettings makes
    // ensureFullBodyLoaded fall through to that cache (no refetch)
    // and rebuild the render.
    clearRenderedBody(card);
    delete card.dataset.renderedWithSettings;
  }
});

import { dragNewEmailReveal, isNewEmailRevealed, settleNewEmailReveal } from '../compose/new-email-reveal';
import { feed } from './dom';
import { LONG_PRESS_MOVE_TOLERANCE_PX } from './gesture-constants';
import { clearRenderedBody, ensureFullBodyLoaded, markRead } from './render-body';
import { selectedIds, toggleSelect } from './selection';
import { closeSwipe, openSwipeCard, setOpenSwipeCard } from './swipe-state';

// One consolidated gesture recognizer for #feed, covering four
// behaviors that all start as "a pointer went down somewhere in the
// feed": tap (expand/collapse or select), long-press (enter selection
// mode), a horizontal swipe on a card (reveal Reply/Forward), and a
// downward pull while already at the top (reveal the New Email button —
// see compose/new-email-reveal.ts). Pointer Events unify mouse and
// touch behind one event model, so this works the same way on both
// without separate mousedown/touchstart handling.
//
// Direction is decided ONCE per gesture, the first time movement
// crosses LONG_PRESS_MOVE_TOLERANCE_PX — horizontal-dominant commits to
// 'swipe', a downward drag that began at the very top (with the button
// still hidden) commits to 'pull', anything else vertical is left alone
// as plain native scroll. Once committed to 'swipe' or 'pull', the
// long-press timer is cancelled and preventDefault() is called so
// native scroll/overscroll doesn't fight the reveal being driven by
// hand — #feed's touch-action: pan-y (see its CSS) is what lets the
// browser still own plain vertical scrolling right up until that point.
// The pull only ever starts at the top boundary (scrollTop <= 0), where
// there is no vertical scroll to compete with, only the overscroll
// bounce — which is why it's speed-independent, unlike a mid-scroll
// gesture would be.
const LONG_PRESS_MS = 500;
const SWIPE_REVEAL_PX = 144; // two 72px action buttons — matches .card-swipe-actions CSS
const SWIPE_OPEN_THRESHOLD_PX = 40;

let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressStartX = 0;
let pressStartY = 0;
// Whether a gesture is currently being tracked at all — distinct from
// activeCard, which is null whenever the gesture didn't start on a card
// (empty feed, the padding strip above the first card, or the New Email
// button strip). Only swipe (needs a .card-front to drag) and
// long-press-to-select (needs a card to select) require a card.
let gestureActive = false;
let activeCard: HTMLElement | null = null; // the card this gesture started on, if any
let longPressFired = false;
// A swipe that ends by opening a card is immediately followed — on iOS
// Safari in particular — by a synthetic click at the same target the
// gesture started on, even though pointermove called preventDefault()
// the whole time. Without consuming it, that click falls into the
// generic tap handling below and toggles the card's expanded state
// right after swiping it open. Same shape as longPressFired, just for
// this case.
let dragJustSettled = false;
let gestureDirection: 'swipe' | 'pull' | 'scroll' | null = null;
// Whether the feed was already scrolled to the very top when this
// gesture began — a precondition for the pull-to-reveal, so the reveal
// can only ever begin at the boundary (never mid-scroll).
let gestureStartedAtTop = false;
// Last pull distance seen, remembered so a pull that ends via
// pointercancel (which carries no reliable coordinates) can still be
// settled by how far it actually got.
let pullDy = 0;

function cancelLongPress(): void {
  if (pressTimer !== null) clearTimeout(pressTimer);
  pressTimer = null;
}

feed.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // primary mouse button / the actual touch point only
  const target = e.target as Element;
  // The select checkbox and the reply/forward buttons behind a card
  // handle their own clicks — never start tracking a gesture from them.
  if (target.closest('.card-select') || target.closest('.card-swipe-actions')) return;
  const card = target.closest<HTMLElement>('.card');
  gestureActive = true;
  activeCard = card;
  pressStartX = e.clientX;
  pressStartY = e.clientY;
  gestureDirection = null;
  gestureStartedAtTop = feed.scrollTop <= 0;
  pullDy = 0;
  dragJustSettled = false;
  if (card) {
    pressTimer = setTimeout(() => {
      longPressFired = true;
      toggleSelect(card);
      pressTimer = null;
    }, LONG_PRESS_MS);
  }
});

feed.addEventListener('pointermove', (e) => {
  if (!gestureActive) return;
  const dx = e.clientX - pressStartX;
  const dy = e.clientY - pressStartY;

  // A downward drag that began at the top, with the button still hidden,
  // is a reveal pull. preventDefault() the moment it looks like one —
  // before the tolerance check below — so the browser never starts an
  // overscroll bounce it could then refuse to hand back (this is what
  // makes the reveal work the same at any drag speed). Horizontal-
  // dominant drags are left for the swipe branch, which preventDefaults
  // itself once committed.
  const pulling = gestureStartedAtTop && !isNewEmailRevealed() && dy > 0 && dy >= Math.abs(dx);
  if (pulling) e.preventDefault();

  if (gestureDirection === null) {
    if (Math.hypot(dx, dy) <= LONG_PRESS_MOVE_TOLERANCE_PX) return; // not enough movement to decide yet
    cancelLongPress();
    if (activeCard && Math.abs(dx) > Math.abs(dy)) {
      gestureDirection = 'swipe';
    } else if (pulling) {
      gestureDirection = 'pull';
    } else {
      gestureDirection = 'scroll'; // vertical, native — nothing further for this gesture to do
    }
  }

  if (gestureDirection === 'swipe' && activeCard) {
    e.preventDefault();
    const front = activeCard.querySelector<HTMLElement>('.card-front')!;
    const openOffset = activeCard === openSwipeCard ? -SWIPE_REVEAL_PX : 0;
    const offset = Math.min(0, Math.max(-SWIPE_REVEAL_PX, openOffset + dx));
    front.style.transition = 'none';
    front.style.transform = `translateX(${offset}px)`;
  } else if (gestureDirection === 'pull') {
    e.preventDefault();
    pullDy = dy;
    dragNewEmailReveal(dy);
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
      dragJustSettled = true;
    } else {
      closeSwipe(activeCard);
    }
  } else if (gestureDirection === 'pull') {
    settleNewEmailReveal(pullDy);
    dragJustSettled = true;
  }
  gestureActive = false;
  activeCard = null;
  gestureDirection = null;
});
feed.addEventListener('pointercancel', () => {
  cancelLongPress();
  if (gestureDirection === 'swipe' && activeCard) closeSwipe(activeCard);
  // Settle the same as a release: a cancel during a committed pull is
  // the browser reclaiming the gesture for overscroll, not a reason to
  // discard how far the button was already pulled — pullDy remembers
  // that distance since the cancel event's own coordinates don't.
  if (gestureDirection === 'pull') settleNewEmailReveal(pullDy);
  gestureActive = false;
  activeCard = null;
  gestureDirection = null;
});

feed.addEventListener('click', (e) => {
  // The synthetic click trailing a swipe that just opened a card (see
  // dragJustSettled's declaration above) — consume it before the tap
  // logic below toggles that card's expanded state.
  if (dragJustSettled) {
    dragJustSettled = false;
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

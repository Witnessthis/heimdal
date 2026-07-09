import { hideNewEmail, isNewEmailRevealed, newEmailBg, revealNewEmail } from '../compose/new-email-reveal';
import { feed } from './dom';
import { LONG_PRESS_MOVE_TOLERANCE_PX } from './gesture-constants';
import { clearRenderedBody, ensureFullBodyLoaded, markRead } from './render-body';
import { selectedIds, toggleSelect } from './selection';
import { closeSwipe, openSwipeCard, setOpenSwipeCard } from './swipe-state';

// One consolidated gesture recognizer for #feed, covering four
// behaviors that all start as "a pointer went down somewhere in the
// feed": tap (expand/collapse or select), long-press (enter selection
// mode), horizontal swipe on a card (reveal Reply/Forward), and a
// vertical pull while already at the top of the feed (drag #feed itself
// down to reveal the New Email button sitting fixed behind it — see
// compose/new-email-reveal.ts). Pointer Events unify mouse and touch
// behind one event model, so this works the same way on both without
// separate mousedown/touchstart handling.
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
// How far (in the direction of travel) the feed must be dragged from its
// current resting state — closed or revealed — before release snaps it
// to the other one instead of springing back to where it started.
const PULL_TOGGLE_THRESHOLD_PX = 40;

let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressStartX = 0;
let pressStartY = 0;
// Whether a gesture is currently being tracked at all — distinct from
// activeCard, which is null whenever the gesture didn't start on a card
// (empty feed, or the padding strip above the first card). The pull
// gesture doesn't need a card under the finger, so it must still be
// trackable in that case; only swipe (needs a .card-front to drag) and
// long-press-to-select (needs a card to select) require one.
let gestureActive = false;
let activeCard: HTMLElement | null = null; // the card this gesture started on, if any
let longPressFired = false;
// A drag that ends by revealing/settling something (the New Email
// button, or a swiped-open card) is immediately followed — on iOS
// Safari in particular — by a synthetic click at the same target the
// gesture started on, even though pointermove called preventDefault()
// the whole time. Without consuming it, that click falls into the
// generic tap handling below and does something the user didn't ask
// for: toggles the expanded state of whatever card the drag happened
// to start on. Same shape as longPressFired above, just for this case.
let dragJustSettled = false;
let gestureDirection: 'swipe' | 'pull' | 'scroll' | null = null;
let gestureStartedAtTop = false;
// The last pull distance seen during a pull gesture. Tracked separately
// from reading e.clientY at release time because a pull can end via
// pointercancel (iOS firing it when it decides the drag is a scroll)
// rather than pointerup, and pointercancel's own coordinates aren't
// reliable — this remembers where the finger last actually was.
let pullDy = 0;

function cancelLongPress(): void {
  if (pressTimer !== null) clearTimeout(pressTimer);
  pressTimer = null;
}

// Settle an ended pull: snap #feed to fully revealed or fully closed,
// whichever side of PULL_TOGGLE_THRESHOLD_PX the drag ended up on
// relative to where it started (revealed or closed), then spring it the
// rest of the way there via the transition set on #feed itself (see
// base.css). Runs for both a normal release (pointerup) and a
// browser-interrupted one (pointercancel), so a pull the browser
// cancels mid-gesture still commits based on how far it got instead of
// always snapping back to where it started.
function settlePull(): void {
  feed.style.transition = '';
  const revealHeight = newEmailBg.offsetHeight;
  const wasRevealed = isNewEmailRevealed();
  const base = wasRevealed ? revealHeight : 0;
  const finalOffset = Math.min(revealHeight, Math.max(0, base + pullDy));
  const shouldReveal = wasRevealed
    ? finalOffset > revealHeight - PULL_TOGGLE_THRESHOLD_PX
    : finalOffset > PULL_TOGGLE_THRESHOLD_PX;
  if (shouldReveal) {
    revealNewEmail();
  } else {
    hideNewEmail();
  }
  dragJustSettled = true;
}

feed.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return; // primary mouse button / the actual touch point only
  const target = e.target as Element;
  // The select checkbox and the reply/forward buttons behind a card
  // handle their own clicks — never start tracking a gesture from them.
  // Everything else in #feed is fair game, including empty space (no
  // .card under the finger at all): that's exactly where a pull-to-
  // reveal gesture starting from the top padding, or in an empty inbox
  // with no cards yet, needs to still begin.
  if (target.closest('.card-select') || target.closest('.card-swipe-actions')) return;
  const card = target.closest<HTMLElement>('.card');
  gestureActive = true;
  activeCard = card;
  pressStartX = e.clientX;
  pressStartY = e.clientY;
  gestureDirection = null;
  gestureStartedAtTop = feed.scrollTop <= 0;
  pullDy = 0;
  // Clear any stale settle flag from a previous gesture that ended via
  // pointercancel (which, unlike pointerup, isn't followed by the
  // synthetic click that would normally consume it) — otherwise it could
  // swallow this new gesture's tap.
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

  if (gestureDirection === null) {
    // Whether this move, however tiny, is heading the direction that
    // would pull the reveal open (closed, dragging down) or shut
    // (revealed, dragging up). Opening drags down while closed, closing
    // drags up while revealed — either way the feed's own scrollTop
    // hasn't moved (revealed is a transform, not a scroll), so
    // gestureStartedAtTop still holds throughout, including while
    // closing.
    const pulling = gestureStartedAtTop && (isNewEmailRevealed() ? dy < 0 : dy > 0);
    // A native touch scroll can only be cancelled on its very first
    // touchmove — once the browser has let a later one scroll natively,
    // no subsequent preventDefault() undoes it. Gating this behind the
    // tolerance check below (which exists to distinguish a tap/long-press
    // from a real drag) meant a fast flick crossed that tolerance within
    // its first event and stayed cancellable, while a slow drag crossed
    // it several events later, after native scroll had already won —
    // exactly what made this gesture feel speed-dependent. Calling
    // preventDefault as soon as a move is plausibly a pull, before the
    // tolerance check, fixes that regardless of how slowly it happens.
    if (pulling) e.preventDefault();

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
    // newEmailBg.offsetHeight is its real layout height — unaffected by
    // #feed's own transform, so this stays correct without duplicating
    // the height as a JS constant that could drift from the CSS.
    const revealHeight = newEmailBg.offsetHeight;
    const base = isNewEmailRevealed() ? revealHeight : 0;
    const offset = Math.min(revealHeight, Math.max(0, base + dy));
    feed.style.transition = 'none';
    feed.style.transform = `translateY(${offset}px)`;
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
    settlePull();
  }
  gestureActive = false;
  activeCard = null;
  gestureDirection = null;
});
feed.addEventListener('pointercancel', () => {
  cancelLongPress();
  if (gestureDirection === 'swipe' && activeCard) closeSwipe(activeCard);
  // A pointercancel during a committed pull is iOS taking the gesture
  // away because it decided the drag is a scroll — settle it the same
  // as a release so a nearly-complete drag still commits instead of
  // vanishing (see settlePull / pullDy).
  if (gestureDirection === 'pull') settlePull();
  gestureActive = false;
  activeCard = null;
  gestureDirection = null;
});

feed.addEventListener('click', (e) => {
  // The synthetic click trailing a drag that just settled something
  // (see dragJustSettled's declaration above) — consume it before any
  // of the logic below gets a chance to act on whatever card the drag
  // happened to start on.
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

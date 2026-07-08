import { LONG_PRESS_MOVE_TOLERANCE_PX } from '../feed/gesture-constants';
import { addressLockBar, closeCompose, composeTo, sendComposeMessage } from './compose';

// Its own reference rather than importing compose.ts's `composeView` —
// this module and compose.ts import from each other (compose.ts calls
// closeAddressSwipe() from openCompose(), this module calls
// closeCompose()/sendComposeMessage() from button handlers), and every
// other cross-reference here is only read from inside a deferred event
// callback, which circular ES module bindings handle fine. This one is
// different: `composeView.addEventListener(...)` below runs immediately
// at this module's own top level, during compose.ts's still-in-progress
// evaluation — reaching back into an import that early resolves to
// undefined rather than the real element. Query it directly instead.
const composeView = document.getElementById('compose-view') as HTMLElement;

// --- Address bar swipe-reveal (discard / send) -----------------------
// Same reveal-then-tap shape as a card's swipe-revealed Reply/Forward,
// just bidirectional and scoped to this one row instead of #feed:
// dragging the bar (never while it's an actively-focused input — see
// the activeElement checks below) live-follows the finger, snaps open
// on whichever side was dragged past a threshold or closed otherwise,
// and only a separate subsequent tap on the revealed icon commits
// anything. Send is only reachable while the address is locked (a real
// recipient is confirmed) — there's nothing to send to otherwise, so
// the swipe is clamped to the discard side only in that state.
// Deliberately a few px less than the button's own 64px width (see
// .address-swipe-actions button) rather than an exact match — the bar
// itself has rounded corners (the gradient border), so its trailing
// edge curves away right at the corners as it slides open. Matching
// the reveal distance to the button's width exactly left that curved
// notch landing right at the button's own edge, exposing whatever's
// behind through the gap. Stopping a few px short instead means the
// button's solid color always extends past where the bar's edge
// (curved corners included) ends, so the notch lands on solid button
// color with margin to spare.
const ADDRESS_REVEAL_PX = 58;
const ADDRESS_OPEN_THRESHOLD_PX = 28;

const addressWrap = document.getElementById('compose-to-wrap') as HTMLElement;
const addressFront = document.getElementById('compose-to-front') as HTMLElement;
const addressDiscardBtn = document.getElementById('compose-to-discard') as HTMLElement;
const addressSendBtn = document.getElementById('compose-to-send') as HTMLElement;

let addressGestureDirection: 'swipe' | 'scroll' | null = null;
let addressPressStartX = 0;
let addressPressStartY = 0;
let addressOpenSide: 'send' | 'discard' | null = null;

export function closeAddressSwipe(): void {
  addressOpenSide = null;
  addressFront.style.transition = '';
  addressFront.style.transform = '';
}

addressFront.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (document.activeElement === composeTo) return; // actively typing — leave native cursor/selection alone
  addressGestureDirection = null;
  addressPressStartX = e.clientX;
  addressPressStartY = e.clientY;
});

addressFront.addEventListener('pointermove', (e) => {
  if (document.activeElement === composeTo && addressGestureDirection === null) return;
  const dx = e.clientX - addressPressStartX;
  const dy = e.clientY - addressPressStartY;
  if (addressGestureDirection === null) {
    if (Math.hypot(dx, dy) <= LONG_PRESS_MOVE_TOLERANCE_PX) return;
    addressGestureDirection = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'scroll';
    // If the raw input grabbed native focus in the instant before we
    // could tell this was a drag, drop it now — a swipe should never
    // leave the field in edit mode or pop the keyboard open mid-drag.
    if (addressGestureDirection === 'swipe' && document.activeElement === composeTo) composeTo.blur();
  }
  if (addressGestureDirection !== 'swipe') return; // vertical — let native scroll of .compose-fields proceed
  e.preventDefault();
  const locked = addressLockBar.style.display !== 'none';
  const openOffset =
    addressOpenSide === 'send' ? -ADDRESS_REVEAL_PX : addressOpenSide === 'discard' ? ADDRESS_REVEAL_PX : 0;
  const minX = locked ? -ADDRESS_REVEAL_PX : 0;
  const offset = Math.min(ADDRESS_REVEAL_PX, Math.max(minX, openOffset + dx));
  addressFront.style.transition = 'none';
  addressFront.style.transform = `translateX(${offset}px)`;
});

addressFront.addEventListener('pointerup', (e) => {
  addressFront.style.transition = '';
  if (addressGestureDirection !== 'swipe') {
    addressGestureDirection = null;
    return;
  }
  const dx = e.clientX - addressPressStartX;
  const locked = addressLockBar.style.display !== 'none';
  const openOffset =
    addressOpenSide === 'send' ? -ADDRESS_REVEAL_PX : addressOpenSide === 'discard' ? ADDRESS_REVEAL_PX : 0;
  const finalOffset = openOffset + dx;
  if (locked && finalOffset < -ADDRESS_OPEN_THRESHOLD_PX) {
    addressFront.style.transform = `translateX(${-ADDRESS_REVEAL_PX}px)`;
    addressOpenSide = 'send';
  } else if (finalOffset > ADDRESS_OPEN_THRESHOLD_PX) {
    addressFront.style.transform = `translateX(${ADDRESS_REVEAL_PX}px)`;
    addressOpenSide = 'discard';
  } else {
    closeAddressSwipe();
  }
  addressGestureDirection = null;
});
addressFront.addEventListener('pointercancel', () => {
  addressGestureDirection = null;
  closeAddressSwipe();
});

// A tap anywhere else in the compose view closes an open reveal
// instead of leaving it hanging open — matches the card swipe's
// outside-tap-closes behavior.
composeView.addEventListener('click', (e) => {
  if (addressOpenSide && !addressWrap.contains(e.target as Node)) closeAddressSwipe();
});

addressDiscardBtn.addEventListener('click', () => {
  closeAddressSwipe();
  closeCompose();
});
addressSendBtn.addEventListener('click', () => {
  closeAddressSwipe();
  sendComposeMessage();
});

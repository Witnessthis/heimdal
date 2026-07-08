// Shared between the feed's own gesture recognizer (long-press/swipe/
// pull) and the compose view's address-bar swipe — both need the same
// "how much movement before a gesture commits to a direction" tuning,
// and duplicating the literal risked silent drift between the two.
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

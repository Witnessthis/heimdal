// The one card-swipe-reveal open at a time — a module-level singleton
// since only one can be open across the whole feed (opening a new one
// closes whatever was open). Lives in its own module (rather than inside
// the feed gesture recognizer) because compose's openReplyCompose/
// openForwardCompose also need to close a card's swipe-reveal when
// opening compose from it — keeping this one small piece of shared
// state in its own module lets compose import just it, rather than
// pulling in the whole gesture recognizer (render-body, selection, and
// their transitive imports) merely to reach setOpenSwipeCard.
export let openSwipeCard: HTMLElement | null = null;

export function setOpenSwipeCard(card: HTMLElement | null): void {
  openSwipeCard = card;
}

// Snaps a card's swipe-reveal shut. Safe to call on a card that isn't
// open — used both as the deliberate "close" action and defensively
// (e.g. before opening a different card).
export function closeSwipe(card: HTMLElement | null): void {
  if (!card) return;
  card.classList.remove('swipe-open');
  const front = card.querySelector<HTMLElement>('.card-front');
  if (front) {
    front.style.transition = '';
    front.style.transform = '';
  }
  if (openSwipeCard === card) openSwipeCard = null;
}

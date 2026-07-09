import { feed } from '../feed/dom';
import { openCompose } from './compose';

// The "New Email" button sits fixed behind the feed at all times (see
// #new-email-bg in index.html / compose.css) rather than flying in as
// its own panel — pulling down while already at the top of the feed
// drags the feed's own transform down to uncover it, and dragging back
// up covers it again. reveal()/hide() set the two resting states this
// snaps to on release; the live drag in between is driven directly off
// pointer movement in the feed's gesture recognizer (gestures.ts),
// which needs newEmailBg itself to read its offsetHeight (how far
// "revealed" is).
export const newEmailBg = document.getElementById('new-email-bg') as HTMLElement;

let revealed = false;

export function revealNewEmail(): void {
  feed.style.transition = '';
  feed.style.transform = `translateY(${newEmailBg.offsetHeight}px)`;
  revealed = true;
}

export function hideNewEmail(): void {
  feed.style.transition = '';
  feed.style.transform = '';
  revealed = false;
}

export function isNewEmailRevealed(): boolean {
  return revealed;
}

document.getElementById('new-email-btn')!.addEventListener('click', () => {
  hideNewEmail();
  openCompose({ mode: 'new' });
});

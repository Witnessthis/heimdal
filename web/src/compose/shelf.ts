import { openCompose } from './compose';

// New-email shelf — revealed by pulling down while already at the top
// of the feed (see the pull-gesture handling in the feed's gesture
// recognizer). openShelf()/closeShelf() set its fully-open/closed
// resting state; the drag itself live-updates the same transform
// directly from the gesture recognizer, which is why the element
// itself is exported alongside the state-transition functions.
export const shelf = document.getElementById('new-email-shelf') as HTMLElement;

export function openShelf(): void {
  shelf.style.transition = '';
  shelf.style.transform = 'translateY(0)';
  shelf.classList.add('open');
}

export function closeShelf(): void {
  shelf.style.transition = '';
  shelf.style.transform = '';
  shelf.classList.remove('open');
}

export function isShelfOpen(): boolean {
  return shelf.classList.contains('open');
}

document.getElementById('new-email-btn')!.addEventListener('click', () => {
  closeShelf();
  openCompose({ mode: 'new' });
});

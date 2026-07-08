import { feed, nav } from './dom';

// Selection: a lightweight multi-select for bulk actions (currently
// just "mark as read"). Tracked by id rather than by element reference
// so it survives a card being replaced/re-synced during pagination.
// Entered via a long-press (see the pointer handling in gestures.ts)
// rather than always showing a checkbox on every card — selection is
// rare enough that it shouldn't cost permanent visual weight on the
// feed.
export const selectedIds = new Set<string>();
const selectionBar = document.getElementById('selection-bar') as HTMLElement;
const selectionCount = document.getElementById('selection-count') as HTMLElement;

function updateSelectionBar(): void {
  const active = selectedIds.size > 0;
  selectionBar.style.display = active ? 'flex' : 'none';
  nav.style.display = active ? 'none' : '';
  feed.classList.toggle('selecting', active);
  if (active) selectionCount.textContent = `${selectedIds.size} selected`;
}

export function toggleSelect(card: HTMLElement): void {
  const id = card.dataset.id!;
  const nowSelected = !card.classList.contains('selected');
  card.classList.toggle('selected', nowSelected);
  if (nowSelected) selectedIds.add(id);
  else selectedIds.delete(id);
  updateSelectionBar();
}

export function clearSelection(): void {
  for (const id of selectedIds) {
    feed.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.remove('selected');
  }
  selectedIds.clear();
  updateSelectionBar();
}

document.getElementById('selection-cancel')!.addEventListener('click', clearSelection);

document.getElementById('selection-mark-read')!.addEventListener('click', async () => {
  const ids = [...selectedIds];
  await Promise.all(
    ids.map((id) =>
      fetch(`/api/mail/messages/${encodeURIComponent(id)}/read`, { method: 'POST' }).catch(() => {}),
    ),
  );
  for (const id of ids) {
    feed.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.remove('unread');
  }
  clearSelection();
});

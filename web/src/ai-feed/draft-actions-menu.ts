// Shared across every AI feed card, same as unsubscribe.ts's confirm
// dialog — only one card's draft can be in question at once, so one
// static instance (see index.html) beats building/tearing down a modal
// per card. Tapping the draft preview itself opens this instead of two
// small side-by-side icon buttons (Edit + ×) sitting on the row: those
// were easy to miss and easy to mis-tap on a phone; a big tappable
// preview plus a full-width action sheet is a much larger, clearer
// target either way.
const overlay = document.getElementById('draft-actions-menu') as HTMLElement;
const removeBtn = document.getElementById('draft-actions-remove') as HTMLButtonElement;
const editBtn = document.getElementById('draft-actions-edit') as HTMLButtonElement;
const closeBtn = document.getElementById('draft-actions-close') as HTMLButtonElement;

interface DraftActionsHandlers {
  onEdit: () => void;
  onRemove: () => void;
}

let handlers: DraftActionsHandlers | null = null;

function close(): void {
  overlay.style.display = 'none';
  handlers = null;
}

// Tapping the dimmed backdrop also cancels — a large, hard-to-miss
// target — but that alone isn't telegraphed as a way to close this, so
// closeBtn (top-right of the panel) is the explicit, discoverable one.
overlay.addEventListener('click', (event) => {
  if (event.target === overlay) close();
});
closeBtn.addEventListener('click', close);

editBtn.addEventListener('click', () => {
  const onEdit = handlers?.onEdit;
  close();
  onEdit?.();
});

removeBtn.addEventListener('click', () => {
  const onRemove = handlers?.onRemove;
  close();
  onRemove?.();
});

export function openDraftActionsMenu(next: DraftActionsHandlers): void {
  handlers = next;
  overlay.style.display = 'flex';
}

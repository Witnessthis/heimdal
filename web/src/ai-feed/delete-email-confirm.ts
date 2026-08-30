// Immediate, not staged behind the card's Confirm — a two-tap pattern
// (tap Delete, then confirm in this dialog) is its own complete
// commitment, same shape as the mailto-unsubscribe confirm already has,
// rather than a third thing bundled into whatever else the card happens
// to have staged. Reuses the existing /messages/:id/delete route (see
// src/routes/mail.ts) — a real, permanent delete (see
// ImapProvider.deleteMessage's own doc comment for why), not a move to
// Trash; the confirm dialog's copy says so plainly for exactly that
// reason.
const overlay = document.getElementById('delete-email-modal') as HTMLElement;
const cancelBtn = document.getElementById('delete-email-cancel') as HTMLButtonElement;
const confirmBtn = document.getElementById('delete-email-confirm') as HTMLButtonElement;
const closeBtn = document.getElementById('delete-email-close') as HTMLButtonElement;
const errorEl = document.getElementById('delete-email-error') as HTMLElement;

let pending: { emailId: string; onDeleted: () => void } | null = null;
let deleting = false;

function close(): void {
  overlay.style.display = 'none';
  pending = null;
  errorEl.textContent = '';
}

overlay.addEventListener('click', (event) => {
  if (event.target === overlay) close();
});
closeBtn.addEventListener('click', close);
cancelBtn.addEventListener('click', close);

confirmBtn.addEventListener('click', async () => {
  if (deleting || !pending) return;
  deleting = true;
  confirmBtn.disabled = true;
  errorEl.textContent = '';
  try {
    const res = await fetch(`/api/mail/messages/${encodeURIComponent(pending.emailId)}/delete`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const onDeleted = pending.onDeleted;
    close();
    onDeleted();
  } catch {
    errorEl.textContent = 'Could not delete — check your connection and try again.';
    // A genuine "trash folder missing" case doesn't exist any more (see
    // deleteMessage's own doc comment — nothing about this depends on the
    // account's folder structure), so unlike some other action handlers
    // in this app, this generic message is no longer covering for a
    // known, common, non-network failure mode — just real connectivity/
    // server errors, which is what it already says.
  } finally {
    deleting = false;
    confirmBtn.disabled = false;
  }
});

export function openDeleteEmailConfirm(emailId: string, onDeleted: () => void): void {
  pending = { emailId, onDeleted };
  errorEl.textContent = '';
  overlay.style.display = 'flex';
}

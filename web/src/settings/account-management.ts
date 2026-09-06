import { refreshProfileBadge } from '../profile/profile-switcher';
import { getActiveProfileId, setActiveProfileId } from '../shared/active-profile';

interface MailAccount {
  id: string;
  label: string;
  kind: string;
  color: string;
  connected: boolean;
  healthy: boolean;
}

const list = document.getElementById('accounts-list') as HTMLElement;
const removeModal = document.getElementById('remove-account-modal') as HTMLElement;
const removeLabel = document.getElementById('remove-account-label') as HTMLElement;
const removeError = document.getElementById('remove-account-error') as HTMLElement;
const removeCancelBtn = document.getElementById('remove-account-cancel') as HTMLButtonElement;
const removeCloseBtn = document.getElementById('remove-account-close') as HTMLButtonElement;
const removeConfirmBtn = document.getElementById('remove-account-confirm') as HTMLButtonElement;

// Set only while the two-step remove confirmation is open — the modal
// itself is one shared DOM instance (not per-row), so this is how its
// Confirm button knows which account the inline "Remove" tap that opened
// it was actually for.
let pendingRemoval: { id: string; label: string } | null = null;

function accountStatusText(account: MailAccount): string {
  if (!account.connected) return 'Not connected — try removing and re-adding it';
  return account.healthy
    ? `Connected via ${account.kind.toUpperCase()}`
    : `Connected via ${account.kind.toUpperCase()} — connection issue`;
}

async function patchAccount(id: string, patch: { label?: string; color?: string }): Promise<void> {
  try {
    await fetch(`/api/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch {
    // Best-effort — a failed save is corrected on the next visit to
    // Settings, when loadAccountManagement() re-syncs from the server.
  }
  if (id === getActiveProfileId()) void refreshProfileBadge();
}

function closeRemoveModal(): void {
  removeModal.style.display = 'none';
  removeError.textContent = '';
  pendingRemoval = null;
}

function openRemoveModal(account: MailAccount): void {
  pendingRemoval = { id: account.id, label: account.label };
  removeLabel.textContent = account.label;
  removeError.textContent = '';
  removeModal.style.display = 'flex';
}

removeCancelBtn.addEventListener('click', closeRemoveModal);
removeCloseBtn.addEventListener('click', closeRemoveModal);
removeModal.addEventListener('click', (event) => {
  if (event.target === removeModal) closeRemoveModal();
});

removeConfirmBtn.addEventListener('click', async () => {
  if (!pendingRemoval) return;
  const { id } = pendingRemoval;
  removeConfirmBtn.disabled = true;
  removeError.textContent = '';
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    closeRemoveModal();
    // The removed account may have been the active profile — fall back to
    // whatever's left, or bounce to the connect flow if nothing is.
    const wasActive = id === getActiveProfileId();
    await loadAccountManagement();
    if (wasActive) {
      const { accounts }: { accounts: MailAccount[] } = await fetch('/api/accounts').then((r) => r.json());
      if (accounts.length > 0) setActiveProfileId(accounts[0].id);
      else window.location.replace('/connect-provider.html');
    }
  } catch {
    removeError.textContent = 'Could not remove — check your connection and try again.';
  } finally {
    removeConfirmBtn.disabled = false;
  }
});

/** One account's row in Settings > Global > Account management — just
 *  identity (color/label) + connection status + switch/remove. No embedded
 *  memory/language editor here any more — those only ever show for the
 *  *active* profile now, in the "Settings for X" section (see settings.ts),
 *  not listed per-account here. */
function buildAccountRow(account: MailAccount): HTMLElement {
  const row = document.createElement('div');
  row.className = 'account-row';

  const header = document.createElement('div');
  header.className = 'account-row-header';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'account-color-input';
  colorInput.value = account.color;
  colorInput.setAttribute('aria-label', `${account.label} color`);
  colorInput.addEventListener('input', () => {
    void patchAccount(account.id, { color: colorInput.value });
  });

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'account-label-input';
  labelInput.value = account.label;
  labelInput.addEventListener('change', () => {
    const value = labelInput.value.trim();
    if (value) void patchAccount(account.id, { label: value });
    else labelInput.value = account.label;
  });

  header.append(colorInput, labelInput);

  const isActive = account.id === getActiveProfileId();
  if (isActive) {
    const current = document.createElement('span');
    current.className = 'account-current-badge';
    current.textContent = 'Current';
    header.appendChild(current);
  } else {
    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'btn-action';
    selectBtn.textContent = 'Select';
    selectBtn.addEventListener('click', () => {
      setActiveProfileId(account.id);
      void loadAccountManagement();
    });
    header.appendChild(selectBtn);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-action btn-action-danger';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => openRemoveModal(account));
  header.appendChild(removeBtn);

  const status = document.createElement('span');
  status.className = 'setting-desc account-status';
  status.textContent = accountStatusText(account);

  row.append(header, status);
  return row;
}

export async function loadAccountManagement(): Promise<void> {
  const { accounts }: { accounts: MailAccount[] } = await fetch('/api/accounts').then((r) => r.json());
  list.innerHTML = '';
  for (const account of accounts) list.appendChild(buildAccountRow(account));
}

document.getElementById('add-account-btn')?.addEventListener('click', () => {
  window.location.href = '/connect-provider.html';
});

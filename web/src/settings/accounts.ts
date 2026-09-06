import { createLanguageEditor } from './languages';

interface MailAccount {
  id: string;
  label: string;
  kind: string;
  color: string;
  connected: boolean;
  healthy: boolean;
}

const list = document.getElementById('accounts-list') as HTMLElement;

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
    // Settings, when loadAccounts() re-syncs from the server.
  }
}

/** One account's row: a color swatch + editable label up top, its
 *  connection status, a link into its own personalized-memory file (see
 *  web/memory.html), and its own independent "Languages I speak" editor
 *  (see languages.ts's createLanguageEditor) — everything this account
 *  carries that isn't the merged Feed or the Inbox tab itself. */
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

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-action btn-action-danger';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', async () => {
    if (
      !window.confirm(`Remove "${account.label}"? Its Feed cards will be cleared and it will stop syncing.`)
    ) {
      return;
    }
    removeBtn.disabled = true;
    try {
      await fetch(`/api/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      row.remove();
    } catch {
      removeBtn.disabled = false;
    }
  });

  header.append(colorInput, labelInput, removeBtn);

  const status = document.createElement('span');
  status.className = 'setting-desc account-status';
  status.textContent = accountStatusText(account);

  const memoryLink = document.createElement('a');
  memoryLink.className = 'btn-action account-memory-link';
  memoryLink.textContent = 'Personalized memory';
  memoryLink.href = `/memory.html?accountId=${encodeURIComponent(account.id)}`;

  const languages = document.createElement('div');
  languages.className = 'account-languages';
  void createLanguageEditor(languages, account.id);

  row.append(header, status, memoryLink, languages);
  return row;
}

export async function loadAccounts(): Promise<void> {
  const { accounts }: { accounts: MailAccount[] } = await fetch('/api/accounts').then((r) => r.json());
  list.innerHTML = '';
  for (const account of accounts) list.appendChild(buildAccountRow(account));
}

document.getElementById('add-account-btn')?.addEventListener('click', () => {
  window.location.href = '/connect-provider.html';
});

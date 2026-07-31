// "Languages I speak" — feeds classifyEmail()'s two-pass language
// correction (src/ai/triage.ts / src/ai/language.ts): a drafted reply
// only gets translated when the source language isn't one of these.
// Unlike the theme/reading-prefs settings (local, synchronous), this is
// real server state — the AI pipeline runs entirely server-side and never
// sees anything the browser holds locally — so it's fetched fresh each
// time Settings is shown, the same way loadTotpStatus() is.

const chips = document.getElementById('language-chips') as HTMLElement;
const addSelect = document.getElementById('language-add') as HTMLSelectElement;

let selected: string[] = [];
let available: string[] = [];

function renderChips(): void {
  chips.innerHTML = '';
  if (selected.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'language-chip-empty';
    empty.textContent = 'None selected — replies always draft in English.';
    chips.appendChild(empty);
    return;
  }
  for (const language of selected) {
    const chip = document.createElement('span');
    chip.className = 'language-chip';

    const label = document.createElement('span');
    label.textContent = language;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'language-chip-remove';
    remove.setAttribute('aria-label', `Remove ${language}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => updateSelected(selected.filter((l) => l !== language)));

    chip.append(label, remove);
    chips.appendChild(chip);
  }
}

function renderAddOptions(): void {
  addSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '+ Add language';
  placeholder.disabled = true;
  placeholder.selected = true;
  addSelect.appendChild(placeholder);

  for (const language of available) {
    if (selected.includes(language)) continue;
    const option = document.createElement('option');
    option.value = language;
    option.textContent = language;
    addSelect.appendChild(option);
  }
}

async function persist(): Promise<void> {
  try {
    await fetch('/api/settings/languages', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ languages: selected }),
    });
  } catch {
    // Best-effort — a failed save just means the next Settings visit
    // (loadLanguageSettings) re-syncs from the server's actual state
    // instead of whatever this optimistic update guessed.
  }
}

function updateSelected(next: string[]): void {
  selected = next;
  renderChips();
  renderAddOptions();
  void persist();
}

addSelect.addEventListener('change', () => {
  const value = addSelect.value;
  if (!value) return;
  updateSelected([...selected, value]);
});

export async function loadLanguageSettings(): Promise<void> {
  const data = await fetch('/api/settings/languages').then((r) => r.json());
  selected = data.selected;
  available = data.available;
  renderChips();
  renderAddOptions();
}

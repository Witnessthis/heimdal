import { getActiveProfileId, onActiveProfileChange, setActiveProfileId } from '../shared/active-profile';

interface ProfileSummary {
  id: string;
  label: string;
  color: string;
}

const swatch = document.getElementById('nav-profile-swatch') as HTMLElement;
const navProfile = document.getElementById('nav-profile') as HTMLElement;
const modal = document.getElementById('profile-switcher-modal') as HTMLElement;
const list = document.getElementById('profile-switcher-list') as HTMLElement;
const closeBtn = document.getElementById('profile-switcher-close') as HTMLButtonElement;
const settingsBtn = document.getElementById('profile-switcher-settings') as HTMLButtonElement;

// First letter of up to two whitespace-separated words in the label (e.g.
// "alice@example.local" -> "A", "Work Email" -> "WE") — good enough to
// visually distinguish a handful of profiles at a glance without needing a
// real avatar image anywhere in this app.
function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

async function fetchProfiles(): Promise<ProfileSummary[]> {
  const { accounts } = await fetch('/api/accounts').then((r) => r.json());
  return accounts;
}

function renderSwatch(profile: ProfileSummary | undefined): void {
  if (!profile) return;
  swatch.style.background = profile.color;
  swatch.textContent = initials(profile.label);
}

/** Re-fetches and re-renders the nav tab's swatch — called on every
 *  active-profile change, and once at load. Account rename/recolor now only
 *  happens on the standalone account-management.html page (a real
 *  navigation), so a page (re)load through bootstrap is what naturally
 *  picks up a changed label/color here — no live cross-update needed. */
async function refreshProfileBadge(): Promise<void> {
  const profiles = await fetchProfiles();
  renderSwatch(profiles.find((p) => p.id === getActiveProfileId()));
}

// Subscribe before any async work so the very first setActiveProfileId call
// from inbox.ts's bootstrap() is never missed regardless of module load order.
onActiveProfileChange(() => {
  void refreshProfileBadge();
});
void refreshProfileBadge();

function closeModal(): void {
  modal.style.display = 'none';
}

async function openModal(): Promise<void> {
  const profiles = await fetchProfiles();
  const activeId = getActiveProfileId();
  list.innerHTML = '';
  for (const profile of profiles) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `profile-switcher-row${profile.id === activeId ? ' active' : ''}`;

    const dot = document.createElement('span');
    dot.className = 'profile-switcher-dot';
    dot.style.background = profile.color;

    const label = document.createElement('span');
    label.textContent = profile.label;

    row.append(dot, label);
    row.addEventListener('click', () => {
      setActiveProfileId(profile.id);
      closeModal();
    });
    list.appendChild(row);
  }
  modal.style.display = 'flex';
}

navProfile.addEventListener('click', () => {
  void openModal();
});
closeBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal();
});

// A plain DOM event rather than importing showView/openSettings from
// settings.ts directly — keeps this module and settings.ts decoupled in
// both directions.
settingsBtn.addEventListener('click', () => {
  closeModal();
  document.dispatchEvent(new CustomEvent('heimdal:open-settings'));
});

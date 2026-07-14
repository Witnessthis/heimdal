import { ensureNewEmailBgPinned } from '../compose/new-email-reveal';
import { aiFeedView, feed, nav, navAiFeed, navInbox, navSettings, settingsView } from '../feed/dom';
import {
  isAutoLoadImagesEnabled,
  isRichHtmlEnabled,
  setAutoLoadImagesEnabled,
  setRichHtmlEnabled,
} from './reading-prefs';

// --- View switching --------------------------------------------------
// Three panels (AI Feed, Inbox, Settings) share the bottom nav, merged
// in rather than being separate pages: switching between them is just a
// display toggle, so the feed's state, scroll position, and the
// EventSource connection (inbox.ts) all keep running untouched the
// whole time — nothing gets re-fetched just because you looked at
// another view and came back. AI Feed is the default/landing view (see
// index.html); Inbox is demoted but still one tap away.

let lastScrollY = 0;

// Generic sub-setting connector: any row marked
// `data-sub-setting-of="<id of the parent row>"` gets its little
// tree-line positioned from real measured positions — the vertical
// stem runs from the bottom of the referenced parent row down to the
// vertical center of this row's own .setting-name — rather than a
// guessed em value. Works for any current or future sub-setting pair
// with no per-instance CSS tuning. Needs re-running whenever the
// layout could have changed: when Settings becomes visible (a
// display:none element measures as zero-size) and on resize (the
// description text can wrap differently at other widths).
function alignSubSettingConnectors(): void {
  document.querySelectorAll<HTMLElement>('[data-sub-setting-of]').forEach((row) => {
    const parent = document.getElementById(row.dataset.subSettingOf!);
    const connector = row.querySelector<HTMLElement>('.sub-setting-connector');
    const title = row.querySelector<HTMLElement>('.setting-name');
    if (!parent || !connector || !title) return;

    const rowTop = row.getBoundingClientRect().top;
    const top = parent.getBoundingClientRect().bottom - rowTop;
    const titleRect = title.getBoundingClientRect();
    const bottom = titleRect.top + titleRect.height / 2 - rowTop;

    connector.style.top = `${top}px`;
    connector.style.height = `${Math.max(bottom - top, 0)}px`;
  });
}

function showView(view: 'ai-feed' | 'inbox' | 'settings'): void {
  aiFeedView.style.display = view === 'ai-feed' ? '' : 'none';
  feed.style.display = view === 'inbox' ? '' : 'none';
  settingsView.style.display = view === 'settings' ? 'block' : 'none';
  navAiFeed.classList.toggle('active', view === 'ai-feed');
  navInbox.classList.toggle('active', view === 'inbox');
  navSettings.classList.toggle('active', view === 'settings');
  nav.classList.remove('hide');
  lastScrollY =
    view === 'settings' ? settingsView.scrollTop : view === 'ai-feed' ? aiFeedView.scrollTop : feed.scrollTop;
  if (view === 'inbox') {
    // #feed may be getting a real layout box for the very first time
    // here (AI Feed is the default landing view) — see
    // ensureNewEmailBgPinned in new-email-reveal.ts for why this can't
    // just run once at module load.
    ensureNewEmailBgPinned();
  }
  if (view === 'settings') {
    loadTotpStatus();
    alignSubSettingConnectors();
  }
}
window.addEventListener('resize', () => {
  if (settingsView.style.display !== 'none') alignSubSettingConnectors();
});

navAiFeed.addEventListener('click', () => showView('ai-feed'));
navInbox.addEventListener('click', () => showView('inbox'));
navSettings.addEventListener('click', () => showView('settings'));

async function loadTotpStatus(): Promise<void> {
  const status = await fetch('/api/totp/status').then((r) => r.json());
  const label = document.getElementById('totp-action-label')!;
  const btn = document.getElementById('totp-btn')!;
  if (status.enabled) {
    label.textContent = 'Reconfigure authenticator';
    btn.textContent = 'Reconfigure';
  } else {
    label.textContent = 'Set up authenticator';
    btn.textContent = 'Set up';
  }
}

document.getElementById('totp-btn')!.addEventListener('click', () => {
  window.location.href = '/totp-setup.html';
});

// Builds the theme picker grid once — the list of available themes
// never changes at runtime, so there's no need to rebuild it every
// time Settings is shown (unlike loadTotpStatus, which reflects
// server-side state that can change elsewhere).
function buildThemeGrid(): void {
  const grid = document.getElementById('theme-grid')!;
  const current = window.HeimdalThemes.currentTheme();
  for (const [key, theme] of Object.entries(window.HeimdalThemes.THEMES)) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = `theme-swatch${key === current ? ' active' : ''}`;
    swatch.dataset.theme = key;

    const dots = document.createElement('span');
    dots.className = 'theme-swatch-dots';
    for (const colorKey of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
      const dot = document.createElement('span');
      dot.style.background = theme[colorKey];
      dots.appendChild(dot);
    }

    const label = document.createElement('span');
    label.className = 'theme-swatch-label';
    label.textContent = theme.label;
    label.style.color = theme.fg;

    swatch.style.background = theme.bg;
    swatch.append(dots, label);
    swatch.addEventListener('click', () => {
      window.HeimdalThemes.setTheme(key);
      grid.querySelectorAll('.theme-swatch').forEach((el) => {
        el.classList.toggle('active', el === swatch);
      });
    });
    grid.appendChild(swatch);
  }
}
buildThemeGrid();

// Generic relevance: any row marked `data-relevance="<parentRowId>:on"`
// (or ":off") is "active" only while that parent row's toggle is in the
// named position. When it isn't, the row fades (.setting-inactive) and
// its own toggle is disabled — so a setting that currently can't do
// anything given the parent's state visibly steps back, and can't be
// fiddled with to no effect. Reads the parent's state straight off its
// toggle's badge-on/off class, so it works for any current or future
// pairing with no per-setting wiring. Each toggle's own on/off *display*
// stays driven by its stored preference regardless — the fade/disable
// conveys "inactive right now", not the stored value being lost.
function updateSettingRelevance(): void {
  document.querySelectorAll<HTMLElement>('[data-relevance]').forEach((row) => {
    const [parentId, wantState] = row.dataset.relevance!.split(':');
    const parentToggle = document.getElementById(parentId)?.querySelector('.badge');
    if (!parentToggle) return;
    const parentOn = parentToggle.classList.contains('badge-on');
    const active = (wantState === 'on') === parentOn;
    row.classList.toggle('setting-inactive', !active);
    const ownToggle = row.querySelector<HTMLButtonElement>('.badge');
    if (ownToggle) ownToggle.disabled = !active;
  });
}

// Same idea as buildThemeGrid() above — a local preference, not
// server state, so it's set up once at load rather than refreshed
// each time Settings is shown.
const richHtmlToggle = document.getElementById('rich-html-toggle')!;
function updateRichHtmlToggle(): void {
  const enabled = isRichHtmlEnabled();
  richHtmlToggle.textContent = enabled ? 'ON' : 'OFF';
  richHtmlToggle.className = `badge ${enabled ? 'badge-on' : 'badge-off'}`;
}
richHtmlToggle.addEventListener('click', () => {
  setRichHtmlEnabled(!isRichHtmlEnabled());
  updateRichHtmlToggle();
  // This is the parent of both relevance-linked rows below — re-evaluate
  // their active/faded state now that it changed.
  updateSettingRelevance();
});
updateRichHtmlToggle();

const autoLoadImagesToggle = document.getElementById('auto-load-images-toggle')!;
function updateAutoLoadImagesToggle(): void {
  const enabled = isAutoLoadImagesEnabled();
  autoLoadImagesToggle.textContent = enabled ? 'ON' : 'OFF';
  autoLoadImagesToggle.className = `badge ${enabled ? 'badge-on' : 'badge-off'}`;
}
autoLoadImagesToggle.addEventListener('click', () => {
  setAutoLoadImagesEnabled(!isAutoLoadImagesEnabled());
  updateAutoLoadImagesToggle();
});
updateAutoLoadImagesToggle();

// After every toggle's display is set from its stored value above, do a
// single relevance pass so faded/disabled state matches on first load.
updateSettingRelevance();

document.getElementById('logout-btn')!.addEventListener('click', async () => {
  const btn = document.getElementById('logout-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Logging out…';
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    window.location.replace('/login.html');
  }
});

// Auto-hide the bottom nav on scroll down, reveal it on scroll up —
// only in the feed. Settings is a short, static list rather than a
// long scroll a reader is trying to get out of the way of, so the nav
// (the only way back to the inbox) just stays put there instead.
export function handleScroll(scrollTop: number): void {
  if (scrollTop > lastScrollY && scrollTop > 50) {
    nav.classList.add('hide');
  } else {
    nav.classList.remove('hide');
  }
  lastScrollY = scrollTop;
}

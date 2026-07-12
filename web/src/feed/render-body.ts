import type { EmailMessage, EmailSummary } from '@server/mail/types';
import {
  isAutoLoadImagesEnabled,
  isRichHtmlEnabled,
  readingSettingsSignature,
} from '../settings/reading-prefs';
import { cardData } from './card-data';
import { bestPreviewText, isRichHtml } from './preview';

// Rewrites a message's HTML body before it's handed to the sandboxed
// iframe. When allowImages is false, remote images are blocked — a
// remote image is also a tracking pixel, since loading it tells the
// sender your IP and the exact moment you opened the message. Stripping
// <img src> is only half the job on its own: a sender can trigger the
// exact same remote fetch via srcset, <picture><source>, CSS
// background-image, @import, <video poster>, or the legacy background=
// attribute. Rather than enumerating and neutralizing every one of
// those by hand, an injected CSP <meta> tag blocks every remote-fetch
// vector at once via default-src 'none' — img-src is the only thing
// ever relaxed, and only when allowImages is true. It has to be a
// document-level policy baked in at parse time (CSP can't be loosened
// on a live document), which is why the "load images" control in
// renderHtmlBody below re-renders a fresh iframe with allowImages: true
// rather than mutating the existing one's <img> elements in place —
// that would still get silently blocked by the strict policy already
// in effect on that document.
//
// Also forces every link to open in a new tab/window rather than
// trying to navigate the iframe's own throwaway document in place.
// Inline images (already resolved to data: URIs by the backend from
// cid: references) carry none of the tracking risk and are left
// untouched either way — img-src always allows data:.
//
// Returns the prepared HTML plus how many <img src> elements got
// blocked, so the caller knows whether to show a "load images" control
// at all. (Only <img src> is counted/stripped — the other vectors CSP
// closes aren't enumerated here, so they're not reflected in the count;
// the security property holds regardless, they just don't get their own
// placeholder box or contribute to the "load N images" number.)
export function prepareHtmlForRender(
  html: string,
  allowImages: boolean,
): { html: string; blockedCount: number } {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  let blockedCount = 0;
  if (!allowImages) {
    doc.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!/^https?:\/\//i.test(src)) return;
      img.removeAttribute('src');
      img.classList.add('heimdal-blocked-image');
      // Reserve the declared space so revealing images later doesn't
      // reflow the layout — only possible when the email actually
      // declared a size. There's no way to know an undeclared remote
      // image's real dimensions without downloading it, which is
      // exactly what blocking it is meant to avoid.
      const width = img.getAttribute('width') || img.style.width;
      const height = img.getAttribute('height') || img.style.height;
      if (width) img.style.width = /^\d+$/.test(width) ? `${width}px` : width;
      if (height) img.style.height = /^\d+$/.test(height) ? `${height}px` : height;
      blockedCount++;
    });
  }

  const style = doc.createElement('style');
  style.textContent = `
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; overflow-wrap: anywhere; }
    img, table { max-width: 100%; }
    .heimdal-blocked-image {
      display: inline-block;
      min-width: 2em;
      min-height: 1.5em;
      background: #fff;
      border: 1px solid #ccc;
      vertical-align: middle;
    }
  `;
  doc.head.prepend(style);

  const base = doc.createElement('base');
  base.target = '_blank';
  doc.head.prepend(base);

  // Must end up first in <head> — a CSP meta tag only governs resources
  // parsed after it in document order, so prepend() this last (after
  // base/style, which fetch nothing themselves and so aren't at risk
  // either way) to be the actual first element.
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute(
    'content',
    allowImages
      ? "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline'"
      : "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  );
  doc.head.prepend(meta);

  return { html: `<!doctype html>${doc.documentElement.outerHTML}`, blockedCount };
}

// Renders a message's real HTML body into a sandboxed iframe once a
// card is expanded. `sandbox="allow-same-origin allow-popups"` is the
// deliberate combination: allow-same-origin lets *our* script (not the
// email's) read the iframe's contentDocument for height measurement
// and the "load images" reveal below, while omitting allow-scripts
// means nothing inside the email — inline <script>, onclick=, etc. —
// can ever execute, regardless of same-origin access. allow-popups is
// what lets a link with target="_blank" (forced via the injected
// <base> above) actually open a new tab; without it a sandboxed
// iframe silently blocks that. No allow-forms, no allow-top-navigation
// — forms can't submit and the email can't redirect the real page.
export function renderHtmlBody(card: HTMLElement, html: string): void {
  const bodyWrap = card.querySelector<HTMLElement>('.card-body-wrap');
  if (!bodyWrap) return;
  card.querySelector<HTMLElement>('.card-body')!.style.display = 'none';

  // A full re-render (fresh iframe, fresh CSP) rather than an in-place
  // DOM mutation — the strict CSP baked into the blocked iframe's
  // document can't be loosened after the fact, so "load images" has to
  // build a whole new document with the permissive policy from the
  // start. See the allowImages comment on prepareHtmlForRender.
  const renderFrame = (allowImages: boolean) => {
    bodyWrap.querySelector('.card-html-body')?.remove();
    bodyWrap.querySelector('.load-images-btn')?.remove();

    const { html: preparedHtml, blockedCount } = prepareHtmlForRender(html, allowImages);

    const iframe = document.createElement('iframe');
    iframe.className = 'card-html-body';
    iframe.setAttribute('sandbox', 'allow-same-origin allow-popups');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.srcdoc = preparedHtml;

    const resizeToContent = () => {
      const doc = iframe.contentDocument;
      if (doc?.body) iframe.style.height = `${doc.body.scrollHeight}px`;
    };
    iframe.addEventListener('load', () => {
      resizeToContent();
      // Images finishing change body's rendered height after the load
      // event already fired — keep the iframe's height in sync as that
      // happens instead of leaving stale empty space or a cut-off card.
      const doc = iframe.contentDocument;
      if (doc?.body && 'ResizeObserver' in window) {
        new ResizeObserver(resizeToContent).observe(doc.body);
      }
    });

    bodyWrap.appendChild(iframe);

    if (blockedCount > 0) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'load-images-btn';
      btn.textContent = `Load ${blockedCount} image${blockedCount > 1 ? 's' : ''}`;
      btn.addEventListener('click', () => renderFrame(true));
      bodyWrap.appendChild(btn);
    }
  };

  renderFrame(isAutoLoadImagesEnabled());
}

// Fetches one message's full content (body, attachments) on demand —
// only called when a card is actually expanded. The list/feed itself
// no longer needs this: listMessages() now returns a real, bounded
// preview snippet directly (see the backend), so there's no separate
// batch-fetch step for populating the feed at all anymore.
// A Heimdal-flavored spin on the Braille spinner modern CLI tools use
// (ora, Vercel's CLI, etc.) for "still working" — but as it rotates it
// also shimmers through the app's own theme colors, one per frame,
// instead of sitting in one fixed color. Standing in for the snippet
// text while the full message — attachments and all, see
// getMessage()'s unbounded fetch — is on its way down. Returns a
// function that restores whatever text was showing before, for the
// error path below.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_COLORS = [
  'var(--danger)',
  'var(--highlight)',
  'var(--success)',
  'var(--identity)',
  'var(--accent)',
];

function startCardSpinner(card: HTMLElement): () => void {
  const bodyEl = card.querySelector<HTMLElement>('.card-body')!;
  const previousText = bodyEl.textContent;
  let frame = 0;
  const render = () => {
    bodyEl.textContent = `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} Loading…`;
    bodyEl.style.color = SPINNER_COLORS[frame % SPINNER_COLORS.length];
  };
  render();
  const interval = setInterval(() => {
    frame++;
    render();
  }, 90);
  return () => {
    clearInterval(interval);
    bodyEl.style.color = '';
    if (bodyEl.textContent?.endsWith('Loading…')) bodyEl.textContent = previousText;
  };
}

// Undoes whatever a previous renderResolvedBody() call for this card
// left behind, so calling it again — e.g. after a Reading setting
// changed and the card is re-expanded — doesn't stack a second iframe
// (or "load images" button) alongside the first, or leave .card-body
// hidden after switching from an HTML render back to plain text.
export function clearRenderedBody(card: HTMLElement): void {
  const bodyWrap = card.querySelector<HTMLElement>('.card-body-wrap');
  bodyWrap?.querySelector('.card-html-body')?.remove();
  bodyWrap?.querySelector('.load-images-btn')?.remove();
  card.querySelector<HTMLElement>('.card-body')!.style.display = '';
}

function renderResolvedBody(card: HTMLElement, data: EmailSummary | EmailMessage): void {
  clearRenderedBody(card);
  const html = typeof data.body?.html === 'string' ? data.body.html.trim() : '';
  if (html && isRichHtmlEnabled() && isRichHtml(html)) {
    renderHtmlBody(card, html);
  } else {
    const bodyEl = card.querySelector<HTMLElement>('.card-body')!;
    bodyEl.textContent = bestPreviewText(data) || '(empty message)';
  }
}

export async function ensureFullBodyLoaded(card: HTMLElement): Promise<void> {
  if (card.dataset.loadingFull === 'true') return;

  const currentSettings = readingSettingsSignature();
  // Already loaded, and no Reading setting has changed since — genuinely
  // nothing to do. If a setting *did* change, fall through and
  // re-render (from cache below if we have it, otherwise re-fetch).
  if (card.dataset.fullyLoaded === 'true' && card.dataset.renderedWithSettings === currentSettings) return;

  // Already have the complete data client-side — either the list
  // fetch's bounded preview happened to capture the entire message
  // (see toSummary() on the backend), or a previous expand already
  // fetched it in full (the fetch path below caches what it gets back
  // for exactly this reason). Either way, re-deciding how to render
  // it after a settings change doesn't need a second network round
  // trip.
  const cached = cardData.get(card);
  if (cached?.body) {
    card.dataset.fullyLoaded = 'true';
    card.dataset.renderedWithSettings = currentSettings;
    renderResolvedBody(card, cached);
    return;
  }

  card.dataset.loadingFull = 'true';
  const stopSpinner = startCardSpinner(card);
  try {
    const res = await fetch(`/api/mail/messages/${encodeURIComponent(card.dataset.id!)}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const message: EmailMessage = await res.json();
    card.dataset.fullyLoaded = 'true';
    card.dataset.renderedWithSettings = currentSettings;
    cardData.set(card, message);
    renderResolvedBody(card, message);
  } catch (_err) {
    // Keep showing the existing preview snippet rather than replacing
    // decent content with an error — stopSpinner() below restores it.
  } finally {
    stopSpinner();
    card.dataset.loadingFull = 'false';
  }
}

// Marks read only once a card is actually expanded — scrolling past it
// (even lingering on it) doesn't count, since that was leaving unread
// mail looking read without the message ever really being opened.
export function markRead(card: HTMLElement): void {
  if (!card.classList.contains('unread')) return;
  card.classList.remove('unread');
  fetch(`/api/mail/messages/${encodeURIComponent(card.dataset.id!)}/read`, { method: 'POST' }).catch(
    () => {},
  );
}

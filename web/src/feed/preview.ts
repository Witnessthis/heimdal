import type { EmailSummary } from '@server/mail/types';

/** Converts an HTML email body to plain text WITHOUT ever inserting
 *  attacker-controlled markup into the live DOM. DOMParser-created
 *  documents are inert (no script execution, no resource fetching) —
 *  we only ever read .textContent back out of it, never its innerHTML,
 *  and only ever assign plain strings to the real page via .textContent
 *  wherever a caller uses this. Email bodies are untrusted input; this
 *  must never become an innerHTML assignment.
 *
 *  <script>/<style> are removed before reading textContent: their raw
 *  JS/CSS source *is* text content as far as textContent is concerned,
 *  so without this a message carrying an inline tracking script or a
 *  CSS reset block (common even in otherwise-plain marketing mail)
 *  would dump that source into the reader as if it were the message. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.body) return '';
  doc.body.querySelectorAll('script, style').forEach((el) => {
    el.remove();
  });
  return doc.body.textContent || '';
}

export function bestPreviewText(message: EmailSummary): string {
  if (message.body?.text) return message.body.text;
  if (message.body?.html) return htmlToText(message.body.html);
  return message.snippet || '';
}

// A lot of "plain text" email is still sent with an HTML alternative
// part — Gmail, Apple Mail, Outlook etc. all generate one even when
// the user only typed plain text, typically just `<div>`/`<p>`/`<br>`
// wrapping with no real formatting. Rendering that through the
// sandboxed iframe gets a fixed white canvas (see render-body.ts) for
// zero visual benefit, and breaks the whole point of theming for a
// message that's really just text. This only counts an HTML body as
// worth its own rendering when it has something a plain-text render
// would actually lose: real links/images, structural markup (tables,
// lists, headings, blockquotes, rules), or explicit inline styling.
const RICH_HTML_SELECTOR =
  'img, a[href], table, hr, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, pre, code, font, u, s, strike, mark';
const RICH_STYLE_PROPERTY = /(?:^|;)\s*(color|background|font-weight|font-style|text-decoration|border)\s*:/i;

export function isRichHtml(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.body) return false;
  if (doc.body.querySelector(RICH_HTML_SELECTOR)) return true;
  for (const el of doc.body.querySelectorAll('[style]')) {
    if (RICH_STYLE_PROPERTY.test(el.getAttribute('style') || '')) return true;
  }
  // A bare <style> block is common boilerplate even in otherwise plain
  // messages (e.g. a generic -webkit-text-size-adjust reset) — only
  // count it if its actual rules carry real color/formatting, not
  // just for existing.
  for (const styleEl of doc.querySelectorAll('style')) {
    if (RICH_STYLE_PROPERTY.test(styleEl.textContent || '')) return true;
  }
  return false;
}

export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

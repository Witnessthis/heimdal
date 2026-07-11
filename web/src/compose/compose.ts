import type { EmailAddress } from '@server/mail/types';
import { cardData } from '../feed/card-data';
import { nav } from '../feed/dom';
import { bestPreviewText, formatFullDate } from '../feed/preview';
import { ensureFullBodyLoaded, markRead } from '../feed/render-body';
import { closeSwipe } from '../feed/swipe-state';
import { closeAddressSwipe } from './address-swipe';

// One shared view for all three entry points (the background New Email
// button, and a card's swipe-revealed Reply/Forward). openCompose() takes a
// plain data object rather than reading anything off a card itself, so
// a future "load an AI-prepared draft" entry point can call it the
// same way without this view needing to change.
export const composeView = document.getElementById('compose-view') as HTMLElement;
export const composeTo = document.getElementById('compose-to') as HTMLInputElement;
const composeToField = document.getElementById('compose-to-field') as HTMLElement;
const composeToRow = document.getElementById('compose-to-row') as HTMLElement;
export const addressLockBar = document.getElementById('compose-to-lock') as HTMLElement;
const addressLockText = document.getElementById('compose-to-lock-text') as HTMLElement;
const addressEditBtn = document.getElementById('compose-to-edit') as HTMLElement;
const composeCc = document.getElementById('compose-cc') as HTMLInputElement;
const composeBcc = document.getElementById('compose-bcc') as HTMLInputElement;
const composeExpandToggle = document.getElementById('compose-expand-toggle') as HTMLElement;
const composeExtraFields = document.getElementById('compose-extra-fields') as HTMLElement;
const composeSubject = document.getElementById('compose-subject') as HTMLInputElement;
const composeBody = document.getElementById('compose-body') as HTMLTextAreaElement;
const composeError = document.getElementById('compose-error') as HTMLElement;

interface ComposeThreadContext {
  inReplyTo?: string;
  threadId?: string;
}
let composeThreadContext: ComposeThreadContext | null = null;

// Right-aligned inline hints (see .field-hint CSS) stand in for a
// separate label row or a native placeholder — but should stay
// visible for as long as there's room, only hiding once the typed
// text's actual rendered width would reach them. A single shared
// canvas 2D context does the width measurement (matching the input's
// own font) rather than a cruder length-based guess, which hid the
// hint the instant you typed a single character regardless of how
// short that character was.
const COMPOSE_HINTED_FIELDS = [composeTo, composeCc, composeBcc, composeSubject];
const hintMeasureCanvas = document.createElement('canvas');
const hintMeasureCtx = hintMeasureCanvas.getContext('2d')!;
const HINT_GAP_PX = 10; // minimum breathing room to keep between typed text and the hint

function updateFieldHint(input: HTMLInputElement): void {
  const hint = input.parentElement?.querySelector<HTMLElement>('.field-hint');
  if (!hint) return;
  if (!input.value) {
    hint.classList.remove('hidden');
    return;
  }
  const style = getComputedStyle(input);
  hintMeasureCtx.font = `${style.fontSize} ${style.fontFamily}`;
  const textWidth = hintMeasureCtx.measureText(input.value).width;
  const availableWidth = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  hint.classList.toggle('hidden', textWidth + hint.offsetWidth + HINT_GAP_PX > availableWidth);
}
COMPOSE_HINTED_FIELDS.forEach((input) => {
  input.addEventListener('input', () => updateFieldHint(input));
});
// Field width can change (phone rotation, resizing a desktop window),
// which changes how much text fits before the hint regardless of what
// was typed — re-check rather than waiting for the next keystroke.
// Only ever measures fields that are actually visible right now — To
// always, Cc/Bcc/Subject only when the collapsible section is open —
// same reasoning as setExtraFieldsExpanded() above.
window.addEventListener('resize', () => {
  updateFieldHint(composeTo);
  if (composeExtraFields.style.display !== 'none') {
    [composeCc, composeBcc, composeSubject].forEach(updateFieldHint);
  }
});

function setExtraFieldsExpanded(expanded: boolean): void {
  composeExtraFields.style.display = expanded ? 'flex' : 'none';
  composeExpandToggle.classList.toggle('expanded', expanded);
  // Cc/Bcc/Subject live inside this collapsible section, so any
  // updateFieldHint() call made while it was display:none measured
  // against a 0-width hidden box (clientWidth/offsetWidth are both 0
  // for anything inside a display:none ancestor) — that always came
  // out as "not enough room, hide the hint", regardless of how short
  // the actual text was. Recompute now that they're genuinely
  // visible and measurable.
  if (expanded) [composeCc, composeBcc, composeSubject].forEach(updateFieldHint);
}
composeExpandToggle.addEventListener('click', () => {
  setExtraFieldsExpanded(composeExtraFields.style.display === 'none');
});

// Locking swaps the raw input for a non-editable display of the same
// text; the pencil icon (never the bar itself) is the only way back
// into edit mode. This exists so the address row can be safely
// swiped — see address-swipe.ts — without ever risking a swipe
// landing back in editing.
function setAddressLocked(locked: boolean): void {
  if (locked) addressLockText.textContent = composeTo.value;
  composeToField.style.display = locked ? 'none' : '';
  addressLockBar.style.display = locked ? 'flex' : 'none';
  composeToRow.classList.toggle('address-locked', locked);
}
composeTo.addEventListener('blur', () => {
  if (composeTo.value.trim()) setAddressLocked(true);
});
addressEditBtn.addEventListener('click', () => {
  setAddressLocked(false);
  updateFieldHint(composeTo);
  composeTo.focus();
  composeTo.setSelectionRange(composeTo.value.length, composeTo.value.length);
});

interface OpenComposeOptions {
  mode: 'new' | 'reply' | 'forward';
  to?: string;
  subject?: string;
  body?: string;
  inReplyTo?: string;
  threadId?: string;
}

// `mode` isn't read here yet — the view's prefilled content already
// distinguishes the three. Destructure it back in if/when the view
// needs to branch on it.
export function openCompose({
  to = '',
  subject = '',
  body = '',
  inReplyTo,
  threadId,
}: OpenComposeOptions): void {
  closeAddressSwipe();
  composeTo.value = to;
  composeCc.value = '';
  composeBcc.value = '';
  composeSubject.value = subject;
  composeBody.value = body;
  // Reply/forward bodies are built as "blank space for your reply,
  // then the quoted/forwarded original" (see openReplyCompose/
  // openForwardCompose) — the cursor belongs at the very start, ready
  // to type, not wherever setting .value happens to leave it (the end,
  // by default), which would otherwise show the *bottom* of the quote
  // instead of the top.
  composeBody.setSelectionRange(0, 0);
  composeBody.scrollTop = 0;
  composeError.textContent = '';
  composeThreadContext = { inReplyTo, threadId };
  composeView.style.display = 'flex';
  nav.style.display = 'none';
  // Always starts collapsed, regardless of mode — even though reply/
  // forward come with a real (Re:/Fwd:-prefixed) subject already
  // filled in, the point of the toggle is to stay out of the way by
  // default; the subject is still there once expanded, just not
  // forced into view.
  setExtraFieldsExpanded(false);
  // Reply already knows its recipient, so it starts locked (swipeable
  // right away, nothing to blur out of first); new/forward start as a
  // plain empty input, same as before this field had a locked state.
  setAddressLocked(Boolean(to));
  // Only To is ever visible at this point — Cc/Bcc/Subject get their
  // own recompute inside setExtraFieldsExpanded() once actually shown.
  // Not needed when locked (the lock bar has no hint of its own).
  if (!to) updateFieldHint(composeTo);
  (to ? composeBody : composeTo).focus();
  // Focusing (and on mobile, the keyboard animating open) can nudge
  // scroll position again after the reset above — reassert it once
  // more on the next frame, once that's settled.
  requestAnimationFrame(() => {
    composeBody.scrollTop = 0;
  });
}

export function closeCompose(): void {
  composeView.style.display = 'none';
  nav.style.display = '';
}

// Comma-separated plain addresses only, matching the app's existing
// "keep compose simple, no rich contact picker" scope for this pass.
export function parseAddressList(text: string): EmailAddress[] {
  return text
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ address }));
}

let composeSending = false;
export async function sendComposeMessage(): Promise<void> {
  if (composeSending) return;
  const to = parseAddressList(composeTo.value);
  if (to.length === 0) {
    composeError.textContent = 'Add at least one recipient.';
    return;
  }
  composeSending = true;
  composeError.textContent = '';
  try {
    const res = await fetch('/api/mail/quick-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        cc: parseAddressList(composeCc.value),
        bcc: parseAddressList(composeBcc.value),
        subject: composeSubject.value,
        text: composeBody.value,
        inReplyTo: composeThreadContext?.inReplyTo,
        threadId: composeThreadContext?.threadId,
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    closeCompose();
  } catch (_err) {
    composeError.textContent = 'Could not send — check your connection and try again.';
  } finally {
    composeSending = false;
  }
}

// Reply/forward both need the complete message (real Message-ID for
// threading, full body to quote/forward) — ensureFullBodyLoaded()
// already fetches and caches this on demand and is a no-op if the card
// was already expanded, so there's no separate fetch path to maintain
// here.
export async function openReplyCompose(card: HTMLElement): Promise<void> {
  closeSwipe(card);
  markRead(card);
  await ensureFullBodyLoaded(card);
  const msg = cardData.get(card);
  if (!msg) return;
  const subject = msg.subject?.startsWith('Re: ') ? msg.subject : `Re: ${msg.subject || ''}`;
  const quoted = (bestPreviewText(msg) || '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const senderLabel = msg.from?.name || msg.from?.address || 'them';
  openCompose({
    mode: 'reply',
    to: msg.from?.address || '',
    subject,
    body: `\n\nOn ${formatFullDate(msg.receivedAt)}, ${senderLabel} wrote:\n${quoted}`,
    inReplyTo: msg.messageId,
    threadId: msg.threadId,
  });
}

export async function openForwardCompose(card: HTMLElement): Promise<void> {
  closeSwipe(card);
  markRead(card);
  await ensureFullBodyLoaded(card);
  const msg = cardData.get(card);
  if (!msg) return;
  const subject = msg.subject?.startsWith('Fwd: ') ? msg.subject : `Fwd: ${msg.subject || ''}`;
  const fromLabel = msg.from?.name ? `${msg.from.name} <${msg.from.address}>` : msg.from?.address || '';
  const toLabel = (msg.to || []).map((a) => a.address).join(', ');
  const original = bestPreviewText(msg) || '';
  openCompose({
    mode: 'forward',
    to: '',
    subject,
    body:
      `\n\n---------- Forwarded message ----------\n` +
      `From: ${fromLabel}\nDate: ${formatFullDate(msg.receivedAt)}\n` +
      `Subject: ${msg.subject || ''}\nTo: ${toLabel}\n\n${original}`,
  });
}

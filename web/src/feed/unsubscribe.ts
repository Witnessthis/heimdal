import type { UnsubscribeAction } from '@server/mail/list-unsubscribe';
import type { EmailMessage, EmailSummary } from '@server/mail/types';

type MailtoAction = Extract<UnsubscribeAction, { type: 'mailto' }>;

const overlay = document.getElementById('unsubscribe-confirm') as HTMLElement;
const addressEl = document.getElementById('unsubscribe-address') as HTMLElement;
const errorEl = document.getElementById('unsubscribe-error') as HTMLElement;
const cancelBtn = document.getElementById('unsubscribe-cancel') as HTMLButtonElement;
const sendBtn = document.getElementById('unsubscribe-send') as HTMLButtonElement;

let pending: MailtoAction | null = null;
let sending = false;

function closeConfirm(): void {
  overlay.style.display = 'none';
  pending = null;
  errorEl.textContent = '';
}

function openConfirm(action: MailtoAction): void {
  pending = action;
  addressEl.textContent = action.address;
  errorEl.textContent = '';
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';
  overlay.style.display = 'flex';
}

cancelBtn.addEventListener('click', closeConfirm);
// Tapping the dimmed backdrop also cancels — but only a direct hit on the
// overlay itself, not any bubbled click from inside the panel.
overlay.addEventListener('click', (event) => {
  if (event.target === overlay) closeConfirm();
});

sendBtn.addEventListener('click', async () => {
  if (sending || !pending) return;
  sending = true;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  errorEl.textContent = '';
  try {
    // Reuses quick-send rather than a dedicated unsubscribe-send route —
    // this really is just sending a normal email, from the user's own
    // account, to the address (and subject/body hints) the mailto URI
    // specified. See src/routes/mail.ts: quick-send is deliberately the
    // one and only route that puts a message on the wire.
    const res = await fetch('/api/mail/quick-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: [{ address: pending.address }],
        subject: pending.subject ?? 'Unsubscribe',
        text: pending.body ?? '',
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    closeConfirm();
  } catch {
    errorEl.textContent = 'Could not send — check your connection and try again.';
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  } finally {
    sending = false;
  }
});

// RFC 8058 one-click is deliberately silent — no confirm dialog — matching
// the convention every mail client already follows for it (Gmail, Yahoo,
// etc. fire it with no prompt at all; that's the whole point of the spec).
// mailto gets a confirm because it's a real outgoing email from the
// user's own account; a oneClick POST is a single, purpose-built request
// this server itself makes (see src/mail/perform-unsubscribe.ts and its
// SSRF guard — the URL is attacker-controlled email content, which is
// exactly why the browser is never trusted to make this request directly).
async function performOneClick(btn: HTMLButtonElement, messageId: string): Promise<void> {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Unsubscribing…';
  try {
    const res = await fetch(`/api/mail/messages/${encodeURIComponent(messageId)}/unsubscribe`, {
      method: 'POST',
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!res.ok || !data.ok) throw new Error('failed');
    btn.textContent = 'Unsubscribed';
  } catch {
    btn.textContent = "Couldn't unsubscribe — tap to retry";
    btn.disabled = false;
  }
}

/** Renders the "Unsubscribe" affordance for a fully-loaded card, when the
 *  message carries a working List-Unsubscribe mechanism (see
 *  src/mail/list-unsubscribe.ts on the backend). `data` may be either an
 *  EmailSummary or full EmailMessage — unsubscribe only ever exists on
 *  the latter (a full-fetch-only field, like body/attachments), so a
 *  summary just falls through as absent rather than needing its own
 *  branch here. Same button, same label, regardless of mechanism — what
 *  differs is only what tapping it actually does.
 *
 *  Skipped entirely for AI feed cards (card.dataset.aiFeed === 'true') —
 *  those render their own staged unsubscribe row instead (unsubscribe is
 *  staged behind the card's Confirm there, not immediate — see
 *  web/src/ai-feed/card.ts), and this function would otherwise still fire
 *  on every expand/re-expand via renderResolvedBody(), appending a second,
 *  conflicting immediate-fire button alongside it. */
export function renderUnsubscribeAction(card: HTMLElement, data: EmailSummary | EmailMessage): void {
  if (card.dataset.aiFeed === 'true') return;
  const unsubscribe = 'unsubscribe' in data ? data.unsubscribe : undefined;
  if (!unsubscribe || unsubscribe.type === 'none') return;

  const bodyWrap = card.querySelector<HTMLElement>('.card-body-wrap');
  if (!bodyWrap) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'unsubscribe-btn';
  btn.textContent = 'Unsubscribe';

  if (unsubscribe.type === 'mailto') {
    btn.addEventListener('click', () => openConfirm(unsubscribe));
  } else if (unsubscribe.type === 'link') {
    // A plain navigation — CSP's connectSrc only governs fetch/XHR, not
    // opening a link, so this is the one variant with no backend
    // involvement at all. noopener/noreferrer: the sender's own page
    // gets neither a handle back to this window nor a Referer header
    // pointing at it.
    btn.addEventListener('click', () => {
      window.open(unsubscribe.url, '_blank', 'noopener,noreferrer');
    });
  } else {
    const messageId = card.dataset.id;
    if (!messageId) return;
    btn.addEventListener('click', () => performOneClick(btn, messageId));
  }

  bodyWrap.appendChild(btn);
}

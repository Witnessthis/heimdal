import type { EmailMessage, EmailSummary } from '@server/mail/types';
import { openDeleteEmailConfirm } from '../ai-feed/delete-email-confirm';
import { cardData } from './card-data';
import { formatRelativeTime } from './preview';
import { closeSwipe } from './swipe-state';

// `data` is either an EmailSummary (list view, from loadMore() — no
// body content at all, see the backend's toSummary()) or a full
// EmailMessage (from a live SSE new-mail update via prependCard(),
// which does carry a body). Either way, buildCard() itself never
// shows body content — only ensureFullBodyLoaded(), on expand, does —
// so nothing about a card changes size after it first appears except
// that expand.
//
// onReply/onForward are passed in rather than imported directly — they
// live in the compose module, which itself needs card-related helpers
// (cardData, markRead) and the gesture module's closeSwipe(), so calling
// into compose directly here would create a circular module dependency.
// This also makes buildCard() testable without dragging in the whole
// compose view.
export function buildCard(
  data: EmailSummary | EmailMessage,
  onReply: (card: HTMLElement) => void,
  onForward: (card: HTMLElement) => void,
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card';
  card.classList.toggle('unread', !data.isRead);
  card.dataset.id = data.id;

  // Sits behind .card-front — see the swipe gesture handling below for
  // how .card-front's transform reveals these. Icons (not text) match
  // the same stroke-based SVG set the bottom nav uses (viewBox 0 0 24
  // 24, stroke-width 1.8, round caps/joins) — the markup here is
  // static and app-authored, never derived from data, so innerHTML is
  // safe (unlike the strict never-innerHTML rule for actual email
  // content elsewhere in this file).
  const swipeActions = document.createElement('div');
  swipeActions.className = 'card-swipe-actions';
  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'card-action-reply';
  replyBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg><span>Reply</span>';
  replyBtn.addEventListener('click', () => onReply(card));
  const forwardBtn = document.createElement('button');
  forwardBtn.type = 'button';
  forwardBtn.className = 'card-action-forward';
  forwardBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg><span>Forward</span>';
  forwardBtn.addEventListener('click', () => onForward(card));
  swipeActions.append(replyBtn, forwardBtn);

  // Revealed by swiping right instead of left — sits at the leading edge
  // of the card, mirroring swipeActions above (same button-layout CSS via
  // the shared .card-swipe-actions class, justify-content flipped by the
  // -leading modifier — see feed.css). DOM order [reprocess, delete] under
  // flex-start puts Reprocess at the true leading edge (revealed by the
  // smallest swipe) and Delete nearer the card content (needs a fuller
  // swipe) — the safer ordering for a destructive action sitting next to a
  // harmless one.
  const swipeActionsLeading = document.createElement('div');
  swipeActionsLeading.className = 'card-swipe-actions card-swipe-actions-leading';
  const reprocessBtn = document.createElement('button');
  reprocessBtn.type = 'button';
  reprocessBtn.className = 'card-action-reprocess';
  reprocessBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span>Reprocess</span>';
  // Re-runs this one email through classification and forces it into the
  // Feed regardless of the model's verdict — see reprocessMessage in
  // src/ai/reprocess.ts for what actually happens server-side. Closes the
  // swipe drawer immediately on tap, rather than waiting on the fetch to
  // resolve first — the backend route itself fires-and-forgets the actual
  // (slow, LLM-driven) reprocessing and always responds right away, so
  // waiting for that response tells the user nothing they can't already
  // see, and only delays (or — on a slow/failed request — entirely skips)
  // the one bit of feedback that a tap actually landed. No toast
  // infrastructure exists in this app, so a request failure is just logged,
  // the same as Reply/Forward have no failure UI of their own.
  reprocessBtn.addEventListener('click', () => {
    closeSwipe(card);
    fetch(`/api/mail/messages/${encodeURIComponent(data.id)}/reprocess`, { method: 'POST' }).catch((err) => {
      console.error(`Reprocess failed for ${data.id}:`, err);
    });
  });
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'card-action-delete';
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Delete</span>';
  // Reuses the existing generic confirm-modal/delete route verbatim (see
  // web/src/ai-feed/delete-email-confirm.ts) — a real, permanent delete,
  // not a move to Trash; that module's own confirm dialog says so.
  deleteBtn.addEventListener('click', () => {
    openDeleteEmailConfirm(data.id, () => {
      closeSwipe(card);
      card.closest('.card-wrap')?.remove();
    });
  });
  swipeActionsLeading.append(reprocessBtn, deleteBtn);

  const front = document.createElement('div');
  front.className = 'card-front';

  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'card-select';
  selectBtn.setAttribute('aria-label', 'Select email');

  const content = document.createElement('div');
  content.className = 'card-content';

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const fromName = document.createElement('span');
  fromName.className = 'card-from-name';
  fromName.textContent = data.from?.name || data.from?.address || '(unknown sender)';
  meta.appendChild(fromName);

  if (data.from?.name && data.from?.address) {
    const fromAddress = document.createElement('span');
    fromAddress.className = 'card-from-address';
    fromAddress.textContent = data.from.address;
    meta.appendChild(fromAddress);
  }

  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = formatRelativeTime(data.receivedAt);
  meta.appendChild(time);

  const subject = document.createElement('h2');
  subject.className = 'card-subject';
  subject.textContent = data.subject || '(no subject)';

  // Left empty deliberately — the collapsed card only ever shows
  // sender/time/subject now, never a body preview (see the backend's
  // toSummary(), which no longer fetches any body content for the
  // list view at all, bounded or otherwise). ensureFullBodyLoaded()
  // populates this element once the card is actually expanded; the
  // element still needs to exist here so that (and the fade/overflow
  // logic below) has something to find via querySelector.
  const body = document.createElement('div');
  body.className = 'card-body';

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'card-body-wrap';
  bodyWrap.appendChild(body);

  content.append(meta, subject, bodyWrap);
  front.append(selectBtn, content);
  card.append(swipeActions, swipeActionsLeading, front);
  cardData.set(card, data);

  // .card-wrap (not .card itself) is what actually gets inserted into
  // #feed — see the call sites below, which insert card.parentElement
  // rather than card. Keeping buildCard() return the .card element
  // itself (unchanged) means everything else that already treats its
  // return value as the card — cardData, the click/swipe gesture
  // handling's closest('.card') — needs no change.
  const wrap = document.createElement('div');
  wrap.className = 'card-wrap';
  wrap.append(card);

  return card;
}

import type { EmailMessage, EmailSummary } from '@server/mail/types';
import type { AiFeedListItem, ConfirmBody } from '@server/routes/ai-feed-types';
import { openComposeToStageDraft } from '../compose/compose';
import { cardData } from '../feed/card-data';
import { formatRelativeTime } from '../feed/preview';
import { clearRenderedBody, ensureFullBodyLoaded, markRead } from '../feed/render-body';
import { openDeleteEmailConfirm } from './delete-email-confirm';
import { aiFeedStatus, aiFeedView } from './dom';
import { openDraftActionsMenu } from './draft-actions-menu';
import { clearStagedField, dismissDraftReply, dropStaged, getStaged, setStaged } from './staged-actions';

// loadAiFeed() rebuilds every card from scratch on each tab show (see
// list.ts) — a fresh <article> has no entry in cardData's WeakMap (keyed
// by DOM node) and no dataset.fullyLoaded, so a message read minutes ago
// looks brand-new to ensureFullBodyLoaded and gets genuinely re-fetched
// over the network, spinner and all, the next time its (new) card is
// expanded. This cache is keyed by emailId instead, so it survives the
// rebuild: buildAiFeedCard seeds cardData from it for a returning
// message, and the click handler below feeds it back in after every
// full load.
const loadedBodies = new Map<string, EmailSummary | EmailMessage>();

// Tap-to-expand only — no swipe/select, unlike the inbox's gestures.ts.
// One delegated listener, registered once here rather than per-card,
// matching gestures.ts's own approach for #feed.
aiFeedView.addEventListener('click', (e) => {
  // The footer (staged-action rows, Confirm/Dismiss) handles its own
  // clicks — don't also toggle expand for the card it sits in.
  if ((e.target as Element).closest('.ai-feed-footer')) return;

  const card = (e.target as Element).closest<HTMLElement>('.card');
  if (!card) return;

  const expanded = card.classList.toggle('expanded');
  if (expanded) {
    void ensureFullBodyLoaded(card).then(() => {
      const data = cardData.get(card);
      if (data) loadedBodies.set(card.dataset.id!, data);
    });
    markRead(card);
  } else {
    clearRenderedBody(card);
    delete card.dataset.renderedWithSettings;
  }
});

function removeCard(card: HTMLElement, emailId: string): void {
  dropStaged(emailId);
  loadedBodies.delete(emailId);
  card.closest('.ai-feed-card-wrap')?.remove();
  // A card leaving the DOM never goes through loadAiFeed() itself — show
  // the empty state directly if that was the last one.
  if (aiFeedView.querySelector('.ai-feed-card-wrap')) return;
  aiFeedStatus.textContent = 'All caught up — nothing needs your attention right now.';
  if (!aiFeedStatus.isConnected) aiFeedView.prepend(aiFeedStatus);
}

async function handleDismiss(
  card: HTMLElement,
  emailId: string,
  buttons: HTMLButtonElement[],
): Promise<void> {
  buttons.forEach((b) => {
    b.disabled = true;
  });
  try {
    const res = await fetch(`/api/ai-feed/${encodeURIComponent(emailId)}/dismiss`, { method: 'POST' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    removeCard(card, emailId);
  } catch {
    buttons.forEach((b) => {
      b.disabled = false;
    });
  }
}

async function handleConfirm(
  card: HTMLElement,
  item: AiFeedListItem,
  buttons: HTMLButtonElement[],
  errorEl: HTMLElement,
): Promise<void> {
  const emailId = item.triage.emailId;
  const staged = getStaged(emailId);

  // Popup-blocker safety: a staged 'link' unsubscribe has to open
  // synchronously, first thing in this click handler — waiting on the
  // awaited fetch below would fall outside the original user-gesture
  // call stack and risk the browser silently blocking it. The backend
  // does nothing for a 'link' unsubscribe itself (see executeConfirm in
  // src/routes/ai-feed.ts) — this is the one piece of it that only ever
  // happens client-side.
  if (staged.unsubscribe && item.unsubscribe.type === 'link') {
    window.open(item.unsubscribe.url, '_blank', 'noopener,noreferrer');
  }

  buttons.forEach((b) => {
    b.disabled = true;
  });
  errorEl.textContent = '';
  try {
    // staged.draftReply is `| null` (dismissed) as far as this module's
    // own state goes — the backend's ConfirmBody schema only knows about
    // a real draft or absent, so null collapses to omitted here rather
    // than being sent and failing schema validation.
    const payload: ConfirmBody = {
      senderPreference: staged.senderPreference,
      draftReply: staged.draftReply ?? undefined,
      unsubscribe: staged.unsubscribe,
    };
    const res = await fetch(`/api/ai-feed/${encodeURIComponent(emailId)}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    removeCard(card, emailId);
  } catch {
    errorEl.textContent = 'Could not confirm — check your connection and try again.';
    buttons.forEach((b) => {
      b.disabled = false;
    });
  }
}

function buildDismissButton(onDismiss: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ai-feed-row-dismiss';
  btn.setAttribute('aria-label', 'Dismiss');
  btn.textContent = '×';
  btn.addEventListener('click', onDismiss);
  return btn;
}

// A checkbox, not the .ai-feed-choice toggle-pill tried briefly instead
// — a verb-labeled button ("Hide") reads as an immediate action, which
// is misleading for something that's actually staged until Confirm; a
// checkbox inherently communicates "a setting to apply later," matching
// the real behavior. The earlier checkbox attempt's real problem was
// sizing (20px, too small to comfortably tap), not the metaphor itself
// — see .ai-feed-checkbox-row in ai-feed.css for the larger version.
// Still always has a real value (never "untouched"): pre-staged to
// 'show' the moment this row is built, so Confirm always resolves the
// sender preference one way or the other even if the user never taps
// it — closes the old gap where an unanswered question left the sender
// stuck in 'pending' forever with no way to revisit it (see chat
// history). Only if undefined: loadAiFeed() rebuilds every card from
// scratch on each tab visit, so a choice already made on an earlier
// build of this same card must not get silently reset back to the
// default.
function buildSenderPreferenceRow(item: AiFeedListItem, onStagedChange: () => void): HTMLElement {
  const emailId = item.triage.emailId;
  if (getStaged(emailId).senderPreference === undefined) {
    setStaged(emailId, { senderPreference: 'show' });
  }

  // A <label>, not a <div> — same as every other row in this footer,
  // .ai-feed-row's own justify-content: space-between already puts the
  // checkbox on the right for free, and wrapping the whole row (not
  // just the checkbox itself) keeps the tap target large on mobile.
  const row = document.createElement('label');
  row.className = 'ai-feed-row ai-feed-checkbox-row';

  const text = document.createElement('span');
  text.className = 'ai-feed-row-text';
  text.textContent = 'Hide emails from this sender?';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = getStaged(emailId).senderPreference === 'hide';
  checkbox.addEventListener('change', () => {
    setStaged(emailId, { senderPreference: checkbox.checked ? 'hide' : 'show' });
    onStagedChange();
  });

  row.append(text, checkbox);
  return row;
}

// One row, in one of two states, for every card — never absent. A card
// with an AI-drafted reply starts in the "preview" state; a card with
// none (or one that's been dismissed) shows a plain invitation to write
// one from scratch instead of just disappearing. Dismissing a reply
// (AI's or your own) goes back to that invitation, not away entirely —
// dismissing a specific draft you don't like shouldn't cost you the
// ability to reply at all. onStagedChange lets buildAiFeedCard's
// Confirm/Dismiss row react when staging this reply is what makes
// Confirm meaningful for the first time (or stops being).
function buildReplySlot(
  item: AiFeedListItem,
  fallbackDraft: { subject: string; body: string },
  onStagedChange: () => void,
): HTMLElement {
  const slot = document.createElement('div');

  // rerender both rebuilds this slot's own content AND tells the card's
  // action row to re-check whether Confirm should show, since staging
  // (or un-staging) this reply is exactly what flips that. The initial
  // build below calls it too — a redundant extra recompute of the action
  // row the first time, harmless, simpler than a separate no-notify path
  // just for that one call.
  function rerender(): void {
    slot.innerHTML = '';
    const staged = getStaged(item.triage.emailId).draftReply;
    slot.appendChild(
      staged ? buildDraftPreviewRow(item, staged, rerender) : buildNoReplyRow(item, fallbackDraft, rerender),
    );
    onStagedChange();
  }
  rerender();
  return slot;
}

// The whole preview is one big tap target (a real <button>, not a div
// faking one — free keyboard/focus support) that opens a full-width
// action sheet (draft-actions-menu.ts) instead of two small side-by-side
// Edit/× icons — those were easy to miss and easy to mis-tap on a phone.
function buildDraftPreviewRow(
  item: AiFeedListItem,
  draft: { subject: string; body: string },
  rerender: () => void,
): HTMLElement {
  const emailId = item.triage.emailId;

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'ai-feed-draft-preview';
  const label = document.createElement('span');
  label.className = 'ai-feed-row-label';
  label.textContent = '↩ AI draft response';
  const subjectEl = document.createElement('p');
  subjectEl.className = 'ai-feed-draft-subject';
  subjectEl.textContent = draft.subject;
  const bodyEl = document.createElement('p');
  bodyEl.className = 'ai-feed-draft-body';
  bodyEl.textContent = draft.body;
  preview.append(label, subjectEl, bodyEl);

  preview.addEventListener('click', () => {
    openDraftActionsMenu({
      onEdit: () => {
        openComposeToStageDraft(
          {
            to: item.from.address,
            subject: draft.subject,
            body: draft.body,
            inReplyTo: item.messageId,
            threadId: item.threadId,
          },
          ({ subject, text: body }) => {
            setStaged(emailId, { draftReply: { subject, body } });
            rerender();
          },
        );
      },
      onRemove: () => {
        dismissDraftReply(emailId);
        rerender();
      },
    });
  });

  return preview;
}

function buildNoReplyRow(
  item: AiFeedListItem,
  fallbackDraft: { subject: string; body: string },
  rerender: () => void,
): HTMLElement {
  const emailId = item.triage.emailId;
  const row = document.createElement('div');
  row.className = 'ai-feed-row';

  const text = document.createElement('span');
  text.className = 'ai-feed-row-text';
  text.textContent = 'No reply drafted';

  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'ai-feed-choice';
  replyBtn.textContent = 'Reply';
  replyBtn.addEventListener('click', () => {
    openComposeToStageDraft(
      {
        to: item.from.address,
        subject: fallbackDraft.subject,
        body: fallbackDraft.body,
        inReplyTo: item.messageId,
        threadId: item.threadId,
      },
      ({ subject, text: body }) => {
        setStaged(emailId, { draftReply: { subject, body } });
        rerender();
      },
    );
  });

  row.append(text, replyBtn);
  return row;
}

function buildUnsubscribeRow(item: AiFeedListItem, onStagedChange: () => void): HTMLElement {
  const emailId = item.triage.emailId;
  const row = document.createElement('div');
  row.className = 'ai-feed-row';

  const text = document.createElement('span');
  text.className = 'ai-feed-row-text';
  text.textContent = 'Looks promotional';

  const controls = document.createElement('div');
  controls.className = 'ai-feed-row-controls';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ai-feed-choice';
  function renderState(): void {
    const staged = Boolean(getStaged(emailId).unsubscribe);
    toggle.textContent = staged ? 'Will unsubscribe ✓' : 'Unsubscribe';
    toggle.classList.toggle('active', staged);
  }
  renderState();
  toggle.addEventListener('click', () => {
    setStaged(emailId, { unsubscribe: !getStaged(emailId).unsubscribe });
    renderState();
    onStagedChange();
  });

  controls.append(
    toggle,
    buildDismissButton(() => {
      clearStagedField(emailId, 'unsubscribe');
      row.remove();
      onStagedChange();
    }),
  );

  row.append(text, controls);
  return row;
}

// Pure information, nothing else — no dismiss (there's nothing to "not
// change" about it) and no Delete button here either; that lives in the
// card's own action row instead (see renderActions in buildAiFeedCard),
// styled to match this banner's danger color as the one visible signal
// tying the two together.
function buildSuspiciousRow(reason: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ai-feed-row ai-feed-row-suspicious';

  const text = document.createElement('span');
  text.className = 'ai-feed-row-text';
  text.textContent = `⚠ ${reason}`;

  row.append(text);
  return row;
}

/** Builds one AI Feed card — header (sender/subject/time, same classes as
 *  an inbox card so it reuses that CSS directly) + a lazily-loaded body
 *  (tap to expand, via the same render-body.ts machinery inbox cards
 *  use) + a footer of independently dismissible rows for whatever the
 *  model flagged, plus the card-level Confirm/Dismiss pair. Everything a
 *  footer row needs is already in `item` — only the message body itself
 *  is deferred to expand. */
export function buildAiFeedCard(item: AiFeedListItem): HTMLElement {
  const { triage } = item;

  const card = document.createElement('article');
  card.className = 'card';
  card.classList.toggle('unread', !item.isRead);
  card.dataset.id = triage.emailId;
  // Tells renderUnsubscribeAction (web/src/feed/unsubscribe.ts) to skip
  // itself on expand — this card renders its own staged unsubscribe row
  // instead of that immediate-fire one.
  card.dataset.aiFeed = 'true';

  // Already fetched this message on an earlier build of this card (see
  // loadedBodies above) — seed it in now so the first expand of this
  // fresh element hits ensureFullBodyLoaded's cache branch instead of
  // re-fetching over the network.
  const cachedBody = loadedBodies.get(triage.emailId);
  if (cachedBody) cardData.set(card, cachedBody);

  const front = document.createElement('div');
  front.className = 'card-front';

  const content = document.createElement('div');
  content.className = 'card-content';

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const fromName = document.createElement('span');
  fromName.className = 'card-from-name';
  fromName.textContent = item.from.name || item.from.address || '(unknown sender)';
  meta.appendChild(fromName);
  if (item.from.name && item.from.address) {
    const fromAddress = document.createElement('span');
    fromAddress.className = 'card-from-address';
    fromAddress.textContent = item.from.address;
    meta.appendChild(fromAddress);
  }
  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = formatRelativeTime(item.receivedAt);
  meta.appendChild(time);

  const subject = document.createElement('h2');
  subject.className = 'card-subject';
  subject.textContent = item.subject || '(no subject)';

  // Starts collapsed (unlike an earlier version of this card) — shows
  // the same snippet the list response already carries, faded out via
  // .card-body-wrap's existing ::after (the same cue inbox cards use),
  // plus an explicit chevron below it: the fade alone isn't a strong
  // enough signal on its own that there's more to read, particularly on
  // a card type someone hasn't necessarily learned the conventions of
  // yet the way they have for the inbox.
  const body = document.createElement('div');
  body.className = 'card-body';
  body.textContent = item.snippet;
  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'card-body-wrap';
  bodyWrap.appendChild(body);

  // Static, app-authored markup, never derived from data — safe as
  // innerHTML the same way the other stroke-icon SVGs in this app are
  // (see e.g. card.ts's inbox reply/forward icons).
  const expandHint = document.createElement('div');
  expandHint.className = 'ai-feed-expand-hint';
  expandHint.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  content.append(meta, subject, bodyWrap, expandHint);
  front.appendChild(content);
  card.appendChild(front);

  // Appended to .card-front, not .card — .card-front is the only opaque
  // layer a card has (see feed.css: .card itself is just a thin
  // gradient-border shell with a mostly-transparent background; .card-
  // front's own background is what actually covers the interior).
  // Appending the footer straight to .card would leave it painted
  // directly on that raw gradient instead of the card's real background.
  const footer = document.createElement('div');
  footer.className = 'ai-feed-footer';

  // Passed into every row below that can stage something — `renderActions`
  // (defined further down) is assigned in once it exists; staging or
  // un-staging anything needs to re-check whether Confirm should show.
  let notifyActionsChanged = () => {};
  const onStagedChange = () => notifyActionsChanged();

  // Reply first — see chat history: the model's answer (or the prompt to
  // write one) is the most actionable thing on the card, ahead of the
  // sender-preference/unsubscribe/suspicious rows below it.
  //
  // Pre-stage an AI draft the first time this card is built this session
  // — see buildDraftPreviewRow's own comment on why Confirm should send
  // it by default rather than only once the user has opened and edited
  // it. undefined (never touched) vs. null (dismissed, see
  // dismissDraftReply) matters here: only pre-stage on undefined, so a
  // dismissal from an earlier build of this same card (loadAiFeed()
  // rebuilds every card from scratch on each tab show) doesn't get
  // silently un-dismissed.
  if (triage.draftReply.type === 'draft' && getStaged(triage.emailId).draftReply === undefined) {
    setStaged(triage.emailId, { draftReply: triage.draftReply });
  }
  const fallbackDraft =
    triage.draftReply.type === 'draft'
      ? triage.draftReply
      : { subject: item.subject?.startsWith('Re: ') ? item.subject : `Re: ${item.subject || ''}`, body: '' };
  footer.appendChild(buildReplySlot(item, fallbackDraft, onStagedChange));

  if (triage.checkSenderPreference) footer.appendChild(buildSenderPreferenceRow(item, onStagedChange));

  if (triage.unsubscribeCandidate && item.unsubscribe.type !== 'none') {
    footer.appendChild(buildUnsubscribeRow(item, onStagedChange));
  }
  if (triage.suspicious.type === 'yes') {
    footer.appendChild(buildSuspiciousRow(triage.suspicious.reason));
  }

  const errorEl = document.createElement('p');
  errorEl.className = 'ai-feed-error';

  const actions = document.createElement('div');
  actions.className = 'ai-feed-actions';

  // Dismiss always works — a card can always be ignored outright. Confirm
  // only appears once there's actually something for it to apply
  // (senderPreference/unsubscribe/a staged reply): showing it
  // unconditionally, back when a plain "nothing flagged" card had no
  // staged content at all, made it functionally identical to Dismiss —
  // exactly the "what am I confirming?" confusion this replaces.
  function renderActions(): void {
    actions.innerHTML = '';

    // Delete email sits here, not inside the suspicious banner itself —
    // that banner is pure information now, and this is the one real
    // action tied to it. Styled to match the banner's danger color as
    // the visible signal connecting the two, and placed leftmost (away
    // from Confirm) since it's the one destructive action in this row.
    // Unrelated to staging — always available whenever the message is
    // flagged, regardless of what else is or isn't staged.
    if (triage.suspicious.type === 'yes') {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-action-danger';
      deleteBtn.textContent = 'Delete email';
      deleteBtn.addEventListener('click', () => {
        openDeleteEmailConfirm(triage.emailId, () => removeCard(card, triage.emailId));
      });
      actions.appendChild(deleteBtn);
    }

    const hasStagedContent =
      getStaged(triage.emailId).senderPreference != null ||
      getStaged(triage.emailId).draftReply != null ||
      getStaged(triage.emailId).unsubscribe === true;

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = hasStagedContent ? 'btn-action' : 'btn-action-primary';
    dismissBtn.textContent = 'Dismiss';
    actions.appendChild(dismissBtn);

    if (!hasStagedContent) {
      const buttons = [dismissBtn];
      dismissBtn.addEventListener('click', () => handleDismiss(card, triage.emailId, buttons));
      return;
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn-action-primary';
    confirmBtn.textContent = 'Confirm';
    actions.appendChild(confirmBtn);

    const buttons = [dismissBtn, confirmBtn];
    dismissBtn.addEventListener('click', () => handleDismiss(card, triage.emailId, buttons));
    confirmBtn.addEventListener('click', () => handleConfirm(card, item, buttons, errorEl));
  }
  notifyActionsChanged = renderActions;
  renderActions();

  footer.append(errorEl, actions);
  front.appendChild(footer);

  const wrap = document.createElement('div');
  wrap.className = 'ai-feed-card-wrap';
  wrap.appendChild(card);
  return wrap;
}

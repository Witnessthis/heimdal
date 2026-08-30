// What's been set up on a card but not yet executed — only applied once
// the card's Confirm is tapped (see card.ts). Keyed by emailId rather than
// carried on the card DOM element itself: loadAiFeed() rebuilds every
// card from scratch on each tab show, and staging should survive that
// rebuild (glancing away to Settings and back shouldn't silently discard
// an in-progress draft edit) — a plain module-level Map outlives any
// individual card element.
export interface StagedActions {
  // null, not just absent — draftReply is pre-staged with the model's own
  // draft as soon as a card is built (see card.ts's buildAiFeedCard: the
  // draft is complete and ready-to-send by default, editing is optional,
  // not a prerequisite for Confirm to send anything), so a plain delete
  // would just get silently re-staged the next time loadAiFeed() rebuilds
  // this card. null is the durable "user dismissed this" marker for as
  // long as this session's Map entry lives; use dismissDraftReply() to
  // set it — the other fields are never auto-staged in the first place,
  // so plainly overwriting them with setStaged() is enough.
  draftReply?: { subject: string; body: string } | null;
  // 'unsubscribe': attempt the real mechanism, then always suppress too
  // (a fallback for senders that ignore it). 'suppress': skip the real
  // mechanism, just stop this sender being force-shown again.
  unsubscribeAction?: 'unsubscribe' | 'suppress';
  // The one signal unambiguous enough to feed the personalized-memory loop
  // regardless of which button (Confirm or Dismiss) closes the card — see
  // describeCardAction in src/routes/ai-feed.ts. undefined means no opinion
  // at all, with zero effect either way; a plain dismiss no longer feeds the
  // memory loop on its own (see chat history — too ambiguous to learn from).
  categoryPreference?: 'more' | 'less';
}

const staged = new Map<string, StagedActions>();

export function getStaged(emailId: string): StagedActions {
  return staged.get(emailId) ?? {};
}

export function setStaged(emailId: string, patch: Partial<StagedActions>): void {
  staged.set(emailId, { ...getStaged(emailId), ...patch });
}

export function dismissDraftReply(emailId: string): void {
  setStaged(emailId, { draftReply: null });
}

// Called once a card leaves the feed (confirmed or dismissed) — nothing
// unbounded here: only ever holds entries for cards seen this session.
export function dropStaged(emailId: string): void {
  staged.delete(emailId);
}

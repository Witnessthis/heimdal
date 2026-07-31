// What's been set up on a card but not yet executed — only applied once
// the card's Confirm is tapped (see card.ts). Keyed by emailId rather than
// carried on the card DOM element itself: loadAiFeed() rebuilds every
// card from scratch on each tab show, and staging should survive that
// rebuild (glancing away to Settings and back shouldn't silently discard
// an in-progress draft edit or a picked sender-preference answer) — a
// plain module-level Map outlives any individual card element.
export interface StagedActions {
  senderPreference?: 'show' | 'hide';
  // null, not just absent — draftReply is pre-staged with the model's own
  // draft as soon as a card is built (see card.ts's buildAiFeedCard: the
  // draft is complete and ready-to-send by default, editing is optional,
  // not a prerequisite for Confirm to send anything), so a plain delete
  // would just get silently re-staged the next time loadAiFeed() rebuilds
  // this card. null is the durable "user dismissed this" marker for as
  // long as this session's Map entry lives; use dismissDraftReply() to
  // set it, never clearStagedField() (which is only for the other two
  // fields, neither of which is ever auto-staged in the first place).
  draftReply?: { subject: string; body: string } | null;
  unsubscribe?: boolean;
}

const staged = new Map<string, StagedActions>();

export function getStaged(emailId: string): StagedActions {
  return staged.get(emailId) ?? {};
}

export function setStaged(emailId: string, patch: Partial<StagedActions>): void {
  staged.set(emailId, { ...getStaged(emailId), ...patch });
}

export function clearStagedField(emailId: string, field: 'senderPreference' | 'unsubscribe'): void {
  const current = { ...getStaged(emailId) };
  delete current[field];
  staged.set(emailId, current);
}

export function dismissDraftReply(emailId: string): void {
  setStaged(emailId, { draftReply: null });
}

// Called once a card leaves the feed (confirmed or dismissed) — nothing
// unbounded here: only ever holds entries for cards seen this session.
export function dropStaged(emailId: string): void {
  staged.delete(emailId);
}

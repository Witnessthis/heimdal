// Which account the Inbox tab is currently showing — a standalone module
// with no other dependencies so both inbox.ts (the writer) and compose.ts/
// new-email-reveal.ts (readers, for a fresh "New Email" compose with no
// originating card to derive an account from) can import it without
// creating a cycle between inbox.ts and compose.ts, which already import
// from each other the other direction (inbox.ts calls openReplyCompose/
// openForwardCompose).
let currentAccountId: string | null = null;

export function getCurrentInboxAccountId(): string | null {
  return currentAccountId;
}

export function setCurrentInboxAccountId(id: string): void {
  currentAccountId = id;
}

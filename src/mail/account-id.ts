// Qualifies a provider-local id (e.g. ImapProvider's "imap:INBOX:42") with
// the account it came from, so ids stay globally unique once more than one
// mail account exists. `|` is safe as a separator: local ids only ever
// contain `:`, and any literal `|` inside a folder path would already have
// been percent-encoded by encodeURIComponent (see providers/imap/index.ts's
// encodeMessageId) before it ever reaches here. accountId itself is a hex
// string (see lib/accounts.ts), so it can't contain one either.
const SEPARATOR = '|';

export function qualifyId(accountId: string, localId: string): string {
  return `${accountId}${SEPARATOR}${localId}`;
}

export function splitQualifiedId(id: string): { accountId: string; localId: string } {
  const idx = id.indexOf(SEPARATOR);
  if (idx === -1) throw new Error(`Not an account-qualified id: ${id}`);
  return { accountId: id.slice(0, idx), localId: id.slice(idx + 1) };
}

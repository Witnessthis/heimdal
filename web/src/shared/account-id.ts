// Mirrors src/mail/account-id.ts (backend) — duplicated rather than
// imported since the frontend's build only bundles from web/src, and this
// is a couple of lines unlikely to drift. Used wherever the frontend needs
// to know which account a card/message came from (e.g. to send a reply
// through the right account) without the backend having to spell it out
// as a separate field everywhere an id already carries it.
const SEPARATOR = '|';

export function splitQualifiedId(id: string): { accountId: string; localId: string } {
  const idx = id.indexOf(SEPARATOR);
  if (idx === -1) throw new Error(`Not an account-qualified id: ${id}`);
  return { accountId: id.slice(0, idx), localId: id.slice(idx + 1) };
}

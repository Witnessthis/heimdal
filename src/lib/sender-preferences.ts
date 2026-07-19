import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** undefined (no row) means "unset" — this sender has never triggered
 *  checkSenderPreference, or no email from them ever will need to ask.
 *  "pending" means an ask is currently showing in the feed, waiting on
 *  the user; "show"/"hide" are the user's actual answer, once given.
 *  See src/ai/triage.ts's checkSenderPreference field and the chat
 *  history for the full mechanism this backs.
 *
 *  node:sqlite's DatabaseSync, not a flat JSON file like the rest of
 *  src/lib/ — deliberately, per the chat history: it's built into Node
 *  itself (no native-binding dependency to cross-compile for the
 *  Raspberry Pi deploy target), and the "never re-ask/never downgrade an
 *  already-resolved sender" invariant becomes a single atomic
 *  ON CONFLICT clause instead of a JS-level read-then-conditionally-write
 *  that a concurrent call could race. Lands in the same DATA_DIR/volume
 *  as every other persisted file in this app either way — see
 *  docker-compose.yml's ./data:/app/data mount. */
export type SenderPreference = 'pending' | 'show' | 'hide';

const FILE_NAME = 'sender-preferences.sqlite';

async function openDb(dataDir: string): Promise<DatabaseSync> {
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, FILE_NAME));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sender_preferences (
      address TEXT PRIMARY KEY,
      preference TEXT NOT NULL CHECK (preference IN ('pending', 'show', 'hide'))
    )
  `);
  return db;
}

// Email addresses are compared case-insensitively throughout this store —
// virtually no real-world provider treats the local part as case-sensitive
// in practice, and the alternative (the same sender silently ending up as
// two different rows depending on how a given message happened to
// capitalize it) is a worse failure mode than the rare false collision.
function normalize(address: string): string {
  return address.trim().toLowerCase();
}

export async function getSenderPreference(
  dataDir: string,
  address: string,
): Promise<SenderPreference | undefined> {
  const db = await openDb(dataDir);
  try {
    const row = db
      .prepare('SELECT preference FROM sender_preferences WHERE address = ?')
      .get(normalize(address)) as { preference: SenderPreference } | undefined;
    return row?.preference;
  } finally {
    db.close();
  }
}

/** Transitions unset -> pending. A no-op if this sender already has any
 *  row at all, pending or resolved — once a sender has been asked about
 *  (or answered for), a *different* email from them coming back
 *  checkSenderPreference: true must never re-trigger a duplicate ask or
 *  downgrade an already-resolved answer back to pending. ON CONFLICT DO
 *  NOTHING makes this atomic rather than a JS-level check-then-write. */
export async function markSenderPending(dataDir: string, address: string): Promise<void> {
  const db = await openDb(dataDir);
  try {
    db.prepare(
      'INSERT INTO sender_preferences (address, preference) VALUES (?, ?) ON CONFLICT(address) DO NOTHING',
    ).run(normalize(address), 'pending');
  } finally {
    db.close();
  }
}

/** The user has actually answered the "keep seeing mail from this
 *  sender?" prompt — the final state for this sender, until/unless a
 *  future settings UI lets them change their mind. Unlike
 *  markSenderPending, this always overwrites — resolving again later
 *  (e.g. from a future "manage senders" settings screen) is meant to
 *  update the stored answer, not be blocked by it. */
export async function resolveSenderPreference(
  dataDir: string,
  address: string,
  decision: 'show' | 'hide',
): Promise<void> {
  const db = await openDb(dataDir);
  try {
    db.prepare(
      'INSERT INTO sender_preferences (address, preference) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET preference = excluded.preference',
    ).run(normalize(address), decision);
  } finally {
    db.close();
  }
}

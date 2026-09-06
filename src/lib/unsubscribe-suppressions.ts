import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { accountDir } from './accounts';

/** Whether a sender's unsubscribe has already been handled — either a real
 *  attempt was made ('unsubscribed') or the user chose to just stop seeing
 *  mail from them without contacting the sender ('suppressed'). Either
 *  value means the same thing to isSuppressed: a full block, identical in
 *  strength to how a hidden sender used to work back when that existed —
 *  this sender's mail never reaches the AI again at all, not just "don't
 *  force it into the feed" (see chat history). The unsubscribed/suppressed
 *  distinction is kept only for a future "why did I stop seeing X" view —
 *  nothing reads it today. See src/ai/auto-classify.ts and
 *  src/routes/ai-feed.ts for the mechanism this backs.
 *
 *  One database per account (see accountDir), not a single global one —
 *  unsubscribing/suppressing a sender through one mail account says
 *  nothing about whether the user wants that sender's mail to a *different*
 *  account (see chat history: these are deliberately independent, not a
 *  cross-account block on the address itself).
 *
 *  node:sqlite: built into Node, no native binding to cross-compile for
 *  the Raspberry Pi deploy target. */
export type SuppressionMethod = 'unsubscribed' | 'suppressed';

const FILE_NAME = 'unsubscribe-suppressions.sqlite';

async function openDb(dataDir: string, accountId: string): Promise<DatabaseSync> {
  const dir = accountDir(dataDir, accountId);
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, FILE_NAME));
  db.exec(`
    CREATE TABLE IF NOT EXISTS unsubscribe_suppressions (
      address TEXT PRIMARY KEY,
      method TEXT NOT NULL CHECK (method IN ('unsubscribed', 'suppressed')),
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

// Case-insensitive: no real-world provider treats the local part as
// case-sensitive, and the same sender ending up as two rows depending on
// capitalization is a worse failure mode than the rare false collision.
function normalize(address: string): string {
  return address.trim().toLowerCase();
}

export async function isSuppressed(dataDir: string, accountId: string, address: string): Promise<boolean> {
  const db = await openDb(dataDir, accountId);
  try {
    const row = db
      .prepare('SELECT 1 FROM unsubscribe_suppressions WHERE address = ?')
      .get(normalize(address));
    return row !== undefined;
  } finally {
    db.close();
  }
}

/** Always overwrites — a sender already recorded as 'suppressed' can later
 *  be recorded as 'unsubscribed' (or vice versa) without this call being
 *  blocked by the earlier row. */
export async function recordSuppression(
  dataDir: string,
  accountId: string,
  address: string,
  method: SuppressionMethod,
): Promise<void> {
  const db = await openDb(dataDir, accountId);
  try {
    db.prepare(
      `INSERT INTO unsubscribe_suppressions (address, method, created_at) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET method = excluded.method, created_at = excluded.created_at`,
    ).run(normalize(address), method, new Date().toISOString());
  } finally {
    db.close();
  }
}

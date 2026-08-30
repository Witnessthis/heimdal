import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
 *  node:sqlite: built into Node, no native binding to cross-compile for
 *  the Raspberry Pi deploy target. */
export type SuppressionMethod = 'unsubscribed' | 'suppressed';

const FILE_NAME = 'unsubscribe-suppressions.sqlite';

async function openDb(dataDir: string): Promise<DatabaseSync> {
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, FILE_NAME));
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

export async function isSuppressed(dataDir: string, address: string): Promise<boolean> {
  const db = await openDb(dataDir);
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
  address: string,
  method: SuppressionMethod,
): Promise<void> {
  const db = await openDb(dataDir);
  try {
    db.prepare(
      `INSERT INTO unsubscribe_suppressions (address, method, created_at) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET method = excluded.method, created_at = excluded.created_at`,
    ).run(normalize(address), method, new Date().toISOString());
  } finally {
    db.close();
  }
}

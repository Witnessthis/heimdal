import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** One row per subscribed browser/device — a user may have more than one
 *  (phone + desktop), so this is a table keyed by endpoint (unique per
 *  subscription), not a single global value. node:sqlite for the same
 *  reasons as sender-preferences.ts/ai-feed.ts: no native binding to
 *  cross-compile for the Raspberry Pi deploy target. */
export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const FILE_NAME = 'push-subscriptions.sqlite';

async function openDb(dataDir: string): Promise<DatabaseSync> {
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, FILE_NAME));
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL
    )
  `);
  return db;
}

/** Upserts rather than errors on a re-subscribe of an already-known
 *  endpoint — the browser can return the same endpoint with refreshed
 *  keys, and that should just replace the stored pair, not conflict. */
export async function saveSubscription(dataDir: string, sub: StoredSubscription): Promise<void> {
  const db = await openDb(dataDir);
  try {
    db.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  } finally {
    db.close();
  }
}

export async function removeSubscription(dataDir: string, endpoint: string): Promise<void> {
  const db = await openDb(dataDir);
  try {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  } finally {
    db.close();
  }
}

export async function getAllSubscriptions(dataDir: string): Promise<StoredSubscription[]> {
  const db = await openDb(dataDir);
  try {
    const rows = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all() as {
      endpoint: string;
      p256dh: string;
      auth: string;
    }[];
    return rows.map((row) => ({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }));
  } finally {
    db.close();
  }
}

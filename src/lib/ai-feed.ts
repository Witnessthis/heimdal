import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EmailTriage } from '../ai/triage';

// The ephemeral worklist behind the AI Feed view — NOT a permanent record.
// One row per email currently awaiting a decision; removed once dealt
// with (see removeFeedItem) rather than accumulating forever. See chat
// history for the full design: this is deliberately separate from
// unsubscribe-suppressions.ts (that's a small, long-lived per-sender
// table; this is a larger, short-lived per-email one), and from the old
// src/ai/apply.ts/ModelDecision scaffolding, which predates this design
// and hasn't been reconciled with it yet.
//
// A flattened/normalized schema, not one JSON blob per row like a naive
// port of EmailTriage would be — this store actually needs to filter by
// visibility (show only "feed", plus "snooze" items whose time has come)
// rather than just look things up by emailId, and real columns let SQL
// do that filtering directly instead of loading every row into JS first.
// Built on node:sqlite for the same reasons as unsubscribe-suppressions.ts:
// no native binding to cross-compile for the Raspberry Pi deploy target,
// and atomic upserts instead of hand-rolled read-then-write.

const FILE_NAME = 'ai-feed.sqlite';

async function openDb(dataDir: string): Promise<DatabaseSync> {
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, FILE_NAME));
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_feed (
      email_id TEXT PRIMARY KEY,
      -- Deliberately no 'filtered' here — a filtered result is never
      -- inserted at all (see upsertFeedItem), so there's nothing for
      -- this column to represent that state; excluding it from the
      -- CHECK makes accidentally storing one a hard failure, not a
      -- silent bug.
      visibility_type TEXT NOT NULL CHECK (visibility_type IN ('feed', 'snooze')),
      visibility_until TEXT,
      draft_reply_type TEXT NOT NULL CHECK (draft_reply_type IN ('none', 'draft')),
      draft_reply_subject TEXT,
      draft_reply_body TEXT,
      suspicious_type TEXT NOT NULL CHECK (suspicious_type IN ('no', 'yes')),
      suspicious_reason TEXT,
      created_at TEXT NOT NULL
    )
  `);
  // One-time migrations for columns that moved out of EmailTriage entirely
  // (see chat history: unsubscribeCandidate, then checkSenderPreference) —
  // an already-deployed file still has these NOT NULL columns, which would
  // fail every insert below once they stop being supplied. Safe to attempt
  // unconditionally: a fresh DB (CREATE TABLE above never included them)
  // or an already-migrated one both just throw "no such column", swallowed
  // here.
  for (const column of ['unsubscribe_candidate', 'check_sender_preference']) {
    try {
      db.exec(`ALTER TABLE ai_feed DROP COLUMN ${column}`);
    } catch {
      // Already migrated, or never had the column — nothing to do.
    }
  }
  return db;
}

interface Row {
  email_id: string;
  visibility_type: 'feed' | 'snooze';
  visibility_until: string | null;
  draft_reply_type: 'none' | 'draft';
  draft_reply_subject: string | null;
  draft_reply_body: string | null;
  suspicious_type: 'no' | 'yes';
  suspicious_reason: string | null;
}

function rowToTriage(row: Row): EmailTriage {
  return {
    emailId: row.email_id,
    visibility:
      row.visibility_type === 'snooze'
        ? { type: 'snooze', until: row.visibility_until as string }
        : { type: 'feed' },
    draftReply:
      row.draft_reply_type === 'draft'
        ? { type: 'draft', subject: row.draft_reply_subject as string, body: row.draft_reply_body as string }
        : { type: 'none' },
    suspicious:
      row.suspicious_type === 'yes'
        ? { type: 'yes', reason: row.suspicious_reason as string }
        : { type: 'no' },
  };
}

/** Inserts or replaces this email's feed entry — a re-classification
 *  overwrites rather than duplicating or erroring. A "filtered" result
 *  is a deliberate no-op: nothing gets stored, matching the design that
 *  "filtered" simply means no feed entry exists at all, not a stored
 *  state of its own. */
export async function upsertFeedItem(dataDir: string, triage: EmailTriage): Promise<void> {
  if (triage.visibility.type === 'filtered') return;

  const db = await openDb(dataDir);
  try {
    db.prepare(
      `INSERT INTO ai_feed (
        email_id, visibility_type, visibility_until,
        draft_reply_type, draft_reply_subject, draft_reply_body,
        suspicious_type, suspicious_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email_id) DO UPDATE SET
        visibility_type = excluded.visibility_type,
        visibility_until = excluded.visibility_until,
        draft_reply_type = excluded.draft_reply_type,
        draft_reply_subject = excluded.draft_reply_subject,
        draft_reply_body = excluded.draft_reply_body,
        suspicious_type = excluded.suspicious_type,
        suspicious_reason = excluded.suspicious_reason`,
    ).run(
      triage.emailId,
      triage.visibility.type,
      triage.visibility.type === 'snooze' ? triage.visibility.until : null,
      triage.draftReply.type,
      triage.draftReply.type === 'draft' ? triage.draftReply.subject : null,
      triage.draftReply.type === 'draft' ? triage.draftReply.body : null,
      triage.suspicious.type,
      triage.suspicious.type === 'yes' ? triage.suspicious.reason : null,
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

/** Everything currently due to show in the feed: items visible now
 *  ("feed"), plus snoozed items whose resurface time has already passed
 *  — computed against the current time on every read rather than a
 *  background job "waking up" snoozed rows, since a plain comparison in
 *  the query is simpler than scheduling anything for a single-user app
 *  this size. Oldest first, so newly-arrived items don't jump ahead of
 *  ones already waiting on a decision. */
export async function getFeedItems(dataDir: string): Promise<EmailTriage[]> {
  const db = await openDb(dataDir);
  try {
    const rows = db
      .prepare(
        `SELECT * FROM ai_feed
         WHERE visibility_type = 'feed'
            OR (visibility_type = 'snooze' AND visibility_until <= ?)
         ORDER BY created_at ASC`,
      )
      .all(new Date().toISOString()) as unknown as Row[];
    return rows.map(rowToTriage);
  } finally {
    db.close();
  }
}

export async function getFeedItem(dataDir: string, emailId: string): Promise<EmailTriage | undefined> {
  const db = await openDb(dataDir);
  try {
    const row = db.prepare('SELECT * FROM ai_feed WHERE email_id = ?').get(emailId) as unknown as
      | Row
      | undefined;
    return row ? rowToTriage(row) : undefined;
  } finally {
    db.close();
  }
}

/** Removes a feed item entirely — called once the user resolves every
 *  section of the card (Confirm), explicitly dismisses it, or the
 *  underlying email disappears (the existing messageDeleted SSE event
 *  should trigger this too, once wired up). A no-op if the item's
 *  already gone. */
export async function removeFeedItem(dataDir: string, emailId: string): Promise<void> {
  const db = await openDb(dataDir);
  try {
    db.prepare('DELETE FROM ai_feed WHERE email_id = ?').run(emailId);
  } finally {
    db.close();
  }
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailTriage } from '../ai/triage';
import { getFeedItem, getFeedItems, removeFeedItem, upsertFeedItem } from './ai-feed';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-ai-feed-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const feedItem = (emailId: string): EmailTriage => ({
  emailId,
  visibility: { type: 'feed' },
  draftReply: { type: 'none' },
  suspicious: { type: 'no' },
});

describe('upsertFeedItem / getFeedItem', () => {
  it('round-trips a plain feed item', async () => {
    await upsertFeedItem(dir, feedItem('imap:INBOX:1'));
    expect(await getFeedItem(dir, 'imap:INBOX:1')).toEqual(feedItem('imap:INBOX:1'));
  });

  it('round-trips a snoozed item with its until date', async () => {
    const item: EmailTriage = {
      ...feedItem('imap:INBOX:2'),
      visibility: { type: 'snooze', until: '2026-09-01T09:00:00Z' },
    };
    await upsertFeedItem(dir, item);
    expect(await getFeedItem(dir, 'imap:INBOX:2')).toEqual(item);
  });

  it('round-trips a drafted reply', async () => {
    const item: EmailTriage = {
      ...feedItem('imap:INBOX:3'),
      draftReply: { type: 'draft', subject: 'Re: hi', body: 'Sounds good!' },
    };
    await upsertFeedItem(dir, item);
    expect(await getFeedItem(dir, 'imap:INBOX:3')).toEqual(item);
  });

  it('round-trips a suspicious flag with its reason', async () => {
    const item: EmailTriage = {
      ...feedItem('imap:INBOX:4'),
      suspicious: { type: 'yes', reason: 'lookalike domain' },
    };
    await upsertFeedItem(dir, item);
    expect(await getFeedItem(dir, 'imap:INBOX:4')).toEqual(item);
  });

  it('never stores a filtered result — a deliberate no-op', async () => {
    const filtered: EmailTriage = { ...feedItem('imap:INBOX:6'), visibility: { type: 'filtered' } };
    await upsertFeedItem(dir, filtered);
    expect(await getFeedItem(dir, 'imap:INBOX:6')).toBeUndefined();
  });

  it('returns undefined for an item that was never stored', async () => {
    expect(await getFeedItem(dir, 'imap:INBOX:nonexistent')).toBeUndefined();
  });

  it('overwrites an existing item on re-classification rather than duplicating', async () => {
    await upsertFeedItem(dir, feedItem('imap:INBOX:7'));
    const updated: EmailTriage = { ...feedItem('imap:INBOX:7'), suspicious: { type: 'yes', reason: 'test' } };
    await upsertFeedItem(dir, updated);

    expect(await getFeedItem(dir, 'imap:INBOX:7')).toEqual(updated);
    expect((await getFeedItems(dir)).filter((i) => i.emailId === 'imap:INBOX:7')).toHaveLength(1);
  });
});

describe('getFeedItems', () => {
  it('includes plain feed items', async () => {
    await upsertFeedItem(dir, feedItem('imap:INBOX:1'));
    const items = await getFeedItems(dir);
    expect(items.map((i) => i.emailId)).toContain('imap:INBOX:1');
  });

  it('includes a snoozed item once its resurface time has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const item: EmailTriage = {
      ...feedItem('imap:INBOX:2'),
      visibility: { type: 'snooze', until: '2025-12-31T00:00:00Z' },
    };
    await upsertFeedItem(dir, item);

    const items = await getFeedItems(dir);
    expect(items.map((i) => i.emailId)).toContain('imap:INBOX:2');
    vi.useRealTimers();
  });

  it('excludes a snoozed item whose resurface time has not arrived yet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const item: EmailTriage = {
      ...feedItem('imap:INBOX:3'),
      visibility: { type: 'snooze', until: '2026-06-01T00:00:00Z' },
    };
    await upsertFeedItem(dir, item);

    const items = await getFeedItems(dir);
    expect(items.map((i) => i.emailId)).not.toContain('imap:INBOX:3');
    vi.useRealTimers();
  });

  it('orders oldest-created first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await upsertFeedItem(dir, feedItem('imap:INBOX:first'));
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    await upsertFeedItem(dir, feedItem('imap:INBOX:second'));
    vi.useRealTimers();

    const items = await getFeedItems(dir);
    const ids = items.map((i) => i.emailId);
    expect(ids.indexOf('imap:INBOX:first')).toBeLessThan(ids.indexOf('imap:INBOX:second'));
  });

  it('returns an empty array when nothing is pending', async () => {
    expect(await getFeedItems(dir)).toEqual([]);
  });
});

describe('removeFeedItem', () => {
  it('removes an item entirely', async () => {
    await upsertFeedItem(dir, feedItem('imap:INBOX:1'));
    await removeFeedItem(dir, 'imap:INBOX:1');
    expect(await getFeedItem(dir, 'imap:INBOX:1')).toBeUndefined();
  });

  it('is a no-op for an item that does not exist', async () => {
    await expect(removeFeedItem(dir, 'imap:INBOX:nonexistent')).resolves.not.toThrow();
  });

  it('only removes the targeted item, leaving others intact', async () => {
    await upsertFeedItem(dir, feedItem('imap:INBOX:1'));
    await upsertFeedItem(dir, feedItem('imap:INBOX:2'));
    await removeFeedItem(dir, 'imap:INBOX:1');

    expect(await getFeedItem(dir, 'imap:INBOX:1')).toBeUndefined();
    expect(await getFeedItem(dir, 'imap:INBOX:2')).toBeDefined();
  });
});

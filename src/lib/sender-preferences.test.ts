import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSenderPreference, markSenderPending, resolveSenderPreference } from './sender-preferences';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-sender-prefs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('unset senders', () => {
  it('returns undefined for a sender never seen before', async () => {
    expect(await getSenderPreference(dir, 'new@example.com')).toBeUndefined();
  });
});

describe('markSenderPending', () => {
  it('transitions an unset sender to pending', async () => {
    await markSenderPending(dir, 'newsletter@example.com');
    expect(await getSenderPreference(dir, 'newsletter@example.com')).toBe('pending');
  });

  it('is a no-op once already pending — does not re-trigger or duplicate', async () => {
    await markSenderPending(dir, 'newsletter@example.com');
    await markSenderPending(dir, 'newsletter@example.com');
    expect(await getSenderPreference(dir, 'newsletter@example.com')).toBe('pending');
  });

  it('never downgrades an already-resolved sender back to pending', async () => {
    await resolveSenderPreference(dir, 'newsletter@example.com', 'hide');
    await markSenderPending(dir, 'newsletter@example.com');
    expect(await getSenderPreference(dir, 'newsletter@example.com')).toBe('hide');
  });
});

describe('resolveSenderPreference', () => {
  it('records show', async () => {
    await resolveSenderPreference(dir, 'friend@example.com', 'show');
    expect(await getSenderPreference(dir, 'friend@example.com')).toBe('show');
  });

  it('records hide', async () => {
    await resolveSenderPreference(dir, 'spammy@example.com', 'hide');
    expect(await getSenderPreference(dir, 'spammy@example.com')).toBe('hide');
  });

  it('overwrites a pending state with the actual answer', async () => {
    await markSenderPending(dir, 'newsletter@example.com');
    await resolveSenderPreference(dir, 'newsletter@example.com', 'show');
    expect(await getSenderPreference(dir, 'newsletter@example.com')).toBe('show');
  });

  it('can be resolved again later, overwriting a previous answer', async () => {
    await resolveSenderPreference(dir, 'newsletter@example.com', 'show');
    await resolveSenderPreference(dir, 'newsletter@example.com', 'hide');
    expect(await getSenderPreference(dir, 'newsletter@example.com')).toBe('hide');
  });
});

describe('address normalization', () => {
  it('treats addresses case-insensitively', async () => {
    await resolveSenderPreference(dir, 'Newsletter@Example.com', 'hide');
    expect(await getSenderPreference(dir, 'newsletter@example.com')).toBe('hide');
    expect(await getSenderPreference(dir, 'NEWSLETTER@EXAMPLE.COM')).toBe('hide');
  });

  it('trims surrounding whitespace', async () => {
    await resolveSenderPreference(dir, '  spacey@example.com  ', 'show');
    expect(await getSenderPreference(dir, 'spacey@example.com')).toBe('show');
  });
});

describe('multiple senders', () => {
  it('tracks independent state per sender', async () => {
    await resolveSenderPreference(dir, 'a@example.com', 'show');
    await resolveSenderPreference(dir, 'b@example.com', 'hide');
    await markSenderPending(dir, 'c@example.com');

    expect(await getSenderPreference(dir, 'a@example.com')).toBe('show');
    expect(await getSenderPreference(dir, 'b@example.com')).toBe('hide');
    expect(await getSenderPreference(dir, 'c@example.com')).toBe('pending');
    expect(await getSenderPreference(dir, 'd@example.com')).toBeUndefined();
  });
});

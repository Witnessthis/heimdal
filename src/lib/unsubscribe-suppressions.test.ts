import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSuppressed, recordSuppression } from './unsubscribe-suppressions';

const ACCOUNT_ID = 'acc1';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-unsubscribe-suppressions-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('isSuppressed', () => {
  it('is false for a sender never recorded', async () => {
    expect(await isSuppressed(dir, ACCOUNT_ID, 'new@example.com')).toBe(false);
  });

  it('is true once recorded as unsubscribed', async () => {
    await recordSuppression(dir, ACCOUNT_ID, 'newsletter@example.com', 'unsubscribed');
    expect(await isSuppressed(dir, ACCOUNT_ID, 'newsletter@example.com')).toBe(true);
  });

  it('is true once recorded as suppressed', async () => {
    await recordSuppression(dir, ACCOUNT_ID, 'newsletter@example.com', 'suppressed');
    expect(await isSuppressed(dir, ACCOUNT_ID, 'newsletter@example.com')).toBe(true);
  });
});

describe('recordSuppression', () => {
  it('can be recorded again later with a different method, overwriting the previous one', async () => {
    await recordSuppression(dir, ACCOUNT_ID, 'newsletter@example.com', 'suppressed');
    await recordSuppression(dir, ACCOUNT_ID, 'newsletter@example.com', 'unsubscribed');
    expect(await isSuppressed(dir, ACCOUNT_ID, 'newsletter@example.com')).toBe(true);
  });
});

describe('address normalization', () => {
  it('treats addresses case-insensitively', async () => {
    await recordSuppression(dir, ACCOUNT_ID, 'Newsletter@Example.com', 'suppressed');
    expect(await isSuppressed(dir, ACCOUNT_ID, 'newsletter@example.com')).toBe(true);
    expect(await isSuppressed(dir, ACCOUNT_ID, 'NEWSLETTER@EXAMPLE.COM')).toBe(true);
  });

  it('trims surrounding whitespace', async () => {
    await recordSuppression(dir, ACCOUNT_ID, '  spacey@example.com  ', 'suppressed');
    expect(await isSuppressed(dir, ACCOUNT_ID, 'spacey@example.com')).toBe(true);
  });
});

describe('multiple senders', () => {
  it('tracks independent state per sender', async () => {
    await recordSuppression(dir, ACCOUNT_ID, 'a@example.com', 'unsubscribed');

    expect(await isSuppressed(dir, ACCOUNT_ID, 'a@example.com')).toBe(true);
    expect(await isSuppressed(dir, ACCOUNT_ID, 'b@example.com')).toBe(false);
  });
});

describe('multiple accounts', () => {
  it('tracks independent state per account — suppressing via one account never affects another', async () => {
    await recordSuppression(dir, 'acc1', 'shared@example.com', 'suppressed');

    expect(await isSuppressed(dir, 'acc1', 'shared@example.com')).toBe(true);
    expect(await isSuppressed(dir, 'acc2', 'shared@example.com')).toBe(false);
  });
});

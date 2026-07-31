import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getVapidKeys } from './push-keys';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-push-keys-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('getVapidKeys', () => {
  it('generates a fresh key pair on first call', async () => {
    const keys = await getVapidKeys(dir);
    expect(keys.publicKey).toBeTruthy();
    expect(keys.privateKey).toBeTruthy();
  });

  it('returns the same pair on every subsequent call', async () => {
    const first = await getVapidKeys(dir);
    const second = await getVapidKeys(dir);
    expect(second).toEqual(first);
  });

  it('never produces two different pairs for concurrent first-ever calls (regression)', async () => {
    // Two callers racing to generate the very first pair (e.g. a
    // subscribe request racing the classification pipeline's first
    // send) must agree on one winner, not each write their own —
    // exercises the 'wx'-then-reread fallback in getVapidKeys.
    const [a, b, c] = await Promise.all([getVapidKeys(dir), getVapidKeys(dir), getVapidKeys(dir)]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

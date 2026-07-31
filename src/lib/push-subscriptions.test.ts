import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAllSubscriptions, removeSubscription, saveSubscription } from './push-subscriptions';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-push-subs-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const subA = { endpoint: 'https://push.example/a', keys: { p256dh: 'p256dh-a', auth: 'auth-a' } };
const subB = { endpoint: 'https://push.example/b', keys: { p256dh: 'p256dh-b', auth: 'auth-b' } };

describe('saveSubscription / getAllSubscriptions', () => {
  it('returns an empty list when nothing is subscribed', async () => {
    expect(await getAllSubscriptions(dir)).toEqual([]);
  });

  it('stores and returns a subscription', async () => {
    await saveSubscription(dir, subA);
    expect(await getAllSubscriptions(dir)).toEqual([subA]);
  });

  it('tracks multiple independent subscriptions (e.g. phone + desktop)', async () => {
    await saveSubscription(dir, subA);
    await saveSubscription(dir, subB);
    const all = await getAllSubscriptions(dir);
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([subA, subB]));
  });

  it('upserts refreshed keys for an already-known endpoint instead of erroring', async () => {
    await saveSubscription(dir, subA);
    const refreshed = { endpoint: subA.endpoint, keys: { p256dh: 'new-p256dh', auth: 'new-auth' } };
    await saveSubscription(dir, refreshed);
    expect(await getAllSubscriptions(dir)).toEqual([refreshed]);
  });
});

describe('removeSubscription', () => {
  it('removes exactly the given endpoint, leaving others intact', async () => {
    await saveSubscription(dir, subA);
    await saveSubscription(dir, subB);
    await removeSubscription(dir, subA.endpoint);
    expect(await getAllSubscriptions(dir)).toEqual([subB]);
  });

  it('is a no-op for an endpoint that was never subscribed', async () => {
    await saveSubscription(dir, subA);
    await removeSubscription(dir, 'https://push.example/never-existed');
    expect(await getAllSubscriptions(dir)).toEqual([subA]);
  });
});

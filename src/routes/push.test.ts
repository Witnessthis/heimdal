import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAllSubscriptions, saveSubscription } from '../lib/push-subscriptions';
import { generateSetupToken } from '../lib/session';
import { buildServer } from '../server';

// Route-wiring/auth/validation coverage against the real Fastify stack,
// same pattern as ai-feed-routes.test.ts/settings.test.ts. Storage
// behavior itself (upsert-on-re-subscribe, multi-device tracking, etc.)
// is covered separately in push-subscriptions.test.ts — what's exercised
// here is exactly what a route test adds: auth gating, schema
// validation, and that the route handlers actually call through to that
// store correctly.
let app: FastifyInstance;
let dir: string;
let session: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-push-routes-'));
  app = await buildServer({ dataDir: dir, webDir: join(dir, 'no-web'), logger: false });
  await app.ready();

  const token = generateSetupToken();
  await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token, password: 'a-strong-password-123' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: 'a-strong-password-123' },
  });
  session = login.cookies.find((c) => c.name === 'session')!.value;
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const validSubscription = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'a-p256dh-key', auth: 'an-auth-secret' },
};

describe('auth gating', () => {
  it.each([
    { method: 'GET' as const, url: '/api/push/vapid-public-key' },
    { method: 'POST' as const, url: '/api/push/subscribe' },
    { method: 'POST' as const, url: '/api/push/unsubscribe' },
  ])('rejects an unauthenticated request to $method $url', async ({ method, url }) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /vapid-public-key', () => {
  it('returns a public key once authenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/push/vapid-public-key', cookies: { session } });
    expect(res.statusCode).toBe(200);
    expect(res.json().publicKey).toEqual(expect.any(String));
    expect(res.json().publicKey.length).toBeGreaterThan(0);
  });

  it('returns the same key on repeated calls', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
      cookies: { session },
    });
    const second = await app.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
      cookies: { session },
    });
    expect(second.json().publicKey).toBe(first.json().publicKey);
  });
});

describe('POST /subscribe', () => {
  it('rejects a body missing endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      cookies: { session },
      payload: { keys: { p256dh: 'x', auth: 'y' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body missing keys', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      cookies: { session },
      payload: { endpoint: 'https://push.example/abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('persists a valid subscription', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      cookies: { session },
      payload: validSubscription,
    });
    expect(res.statusCode).toBe(200);
    expect(await getAllSubscriptions(dir)).toEqual([validSubscription]);
  });
});

describe('POST /unsubscribe', () => {
  it('rejects a body missing endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      cookies: { session },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('removes an existing subscription', async () => {
    await saveSubscription(dir, validSubscription);
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      cookies: { session },
      payload: { endpoint: validSubscription.endpoint },
    });
    expect(res.statusCode).toBe(200);
    expect(await getAllSubscriptions(dir)).toEqual([]);
  });
});

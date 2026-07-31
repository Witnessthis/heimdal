import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSetupToken } from '../lib/session';
import { buildServer } from '../server';

// Route-wiring/auth/validation coverage against the real Fastify stack —
// mirrors settings.test.ts's pattern. Deliberately never configures a
// mail provider: these three routes all need mailService.getProvider(),
// and there's no lightweight fake for it (mail.ts's own routes have the
// same gap — only the greenmail integration suite exercises a real
// provider). What's covered here is exactly what doesn't need one: auth
// gating, the "no provider configured" gate, and request-schema
// validation. executeConfirm/buildFeedList's actual branching logic is
// covered separately, with mocks, in ai-feed.test.ts.
let app: FastifyInstance;
let dir: string;
let session: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-ai-feed-routes-'));
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

describe('auth gating', () => {
  it.each([
    { method: 'GET' as const, url: '/api/ai-feed' },
    { method: 'POST' as const, url: '/api/ai-feed/imap:INBOX:1/confirm' },
    { method: 'POST' as const, url: '/api/ai-feed/imap:INBOX:1/dismiss' },
  ])('rejects an unauthenticated request to $method $url', async ({ method, url }) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
  });
});

describe('no mail provider configured', () => {
  it.each([
    { method: 'GET' as const, url: '/api/ai-feed', payload: undefined },
    { method: 'POST' as const, url: '/api/ai-feed/imap:INBOX:1/confirm', payload: {} },
    { method: 'POST' as const, url: '/api/ai-feed/imap:INBOX:1/dismiss', payload: undefined },
  ])('returns 409 for $method $url when no provider is set up', async ({ method, url, payload }) => {
    const res = await app.inject({ method, url, payload, cookies: { session } });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /:emailId/confirm request validation', () => {
  it('rejects a senderPreference value outside show/hide', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai-feed/imap:INBOX:1/confirm',
      cookies: { session },
      payload: { senderPreference: 'maybe' },
    });
    // Schema validation (400) runs before the provider-configured gate
    // (409) — an invalid request should never even reach that check.
    expect(res.statusCode).toBe(400);
  });

  it('rejects a draftReply missing body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai-feed/imap:INBOX:1/confirm',
      cookies: { session },
      payload: { draftReply: { subject: 'Re: hi' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts an empty body (nothing staged) and reaches the provider-configured gate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai-feed/imap:INBOX:1/confirm',
      cookies: { session },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });
});

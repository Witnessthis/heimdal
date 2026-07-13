import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTotpSecret } from './lib/credentials';
import { generateSetupToken } from './lib/session';
import { buildServer } from './server';

// Real route stack via .inject() — no socket, no IMAP. A fresh instance +
// throwaway dataDir per test also means each test gets its own in-memory
// rate-limit budget, so the auth endpoints' limits never cause cross-test
// flakiness.
let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-routes-'));
  app = await buildServer({ dataDir: dir, webDir: join(dir, 'no-web'), logger: false });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function configure(password: string): Promise<void> {
  const token = generateSetupToken();
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { token, password } });
  expect(res.statusCode).toBe(200);
}

describe('first-run setup', () => {
  it('reports unconfigured, then configured after a valid setup', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json()).toEqual({
      configured: false,
    });
    await configure('a-strong-password-123');
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json()).toEqual({
      configured: true,
    });
  });

  it('rejects a wrong setup token (right length, wrong value)', async () => {
    generateSetupToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'AAAA-BBBB-CCCC-DDDD', password: 'a-strong-password-123' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a too-short password via the schema (min 12)', async () => {
    const token = generateSetupToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('require-auth', () => {
  it('rejects a protected route with no session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/totp/status' });
    expect(res.statusCode).toBe(401);
  });
});

describe('password login (no TOTP)', () => {
  beforeEach(() => configure('the-password-123'));

  it('rejects a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'not-the-password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('sets a session cookie on the correct password, which then authorizes a protected route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'the-password-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cookie = res.cookies.find((c) => c.name === 'session');
    expect(cookie).toBeDefined();

    const authed = await app.inject({
      method: 'GET',
      url: '/api/totp/status',
      cookies: { session: cookie!.value },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toEqual({ enabled: false });
  });
});

describe('TOTP login — a wrong code must not burn the pending session (regression)', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP';
  beforeEach(async () => {
    await configure('pw-123456789');
    await setTotpSecret(dir, SECRET);
  });

  it('wrong code → 401 but the same pending token still verifies the correct code', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'pw-123456789' },
    });
    expect(login.statusCode).toBe(200);
    const { totpRequired, pendingToken } = login.json();
    expect(totpRequired).toBe(true);
    expect(pendingToken).toBeTruthy();

    const valid = authenticator.generate(SECRET);
    const wrongCode = valid === '000000' ? '999999' : '000000';

    // A wrong guess must be rejected WITHOUT retiring the pending token,
    // and without flagging the session as expired (that would bounce the
    // UI back to the password step).
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/login/totp',
      payload: { pendingToken, code: wrongCode },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().expired).toBeUndefined();

    // Same pending token, correct code → success.
    const right = await app.inject({
      method: 'POST',
      url: '/api/login/totp',
      payload: { pendingToken, code: valid },
    });
    expect(right.statusCode).toBe(200);
    expect(right.cookies.find((c) => c.name === 'session')).toBeDefined();
  });

  it('a consumed pending token cannot be reused (single-use on success)', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'pw-123456789' },
    });
    const { pendingToken } = login.json();
    const code = authenticator.generate(SECRET);

    const first = await app.inject({
      method: 'POST',
      url: '/api/login/totp',
      payload: { pendingToken, code },
    });
    expect(first.statusCode).toBe(200);

    // Replaying the now-consumed pending token is rejected as expired.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/login/totp',
      payload: { pendingToken, code: authenticator.generate(SECRET) },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().expired).toBe(true);
  });
});

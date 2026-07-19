import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSetupToken } from '../lib/session';
import { buildServer } from '../server';

let app: FastifyInstance;
let dir: string;
let session: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-settings-routes-'));
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

describe('GET /api/settings/languages', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/languages' });
    expect(res.statusCode).toBe(401);
  });

  it('starts empty, with the full ISO-639-1 name list available', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/languages',
      cookies: { session },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.selected).toEqual([]);
    expect(body.available).toContain('English');
    expect(body.available).toContain('Danish');
    expect(body.available.length).toBeGreaterThan(100);
  });
});

describe('PUT /api/settings/languages', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/languages',
      payload: { languages: ['English'] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('saves a valid set, which a subsequent GET reflects', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/languages',
      cookies: { session },
      payload: { languages: ['English', 'Danish'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ selected: ['English', 'Danish'] });

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings/languages',
      cookies: { session },
    });
    expect(get.json().selected).toEqual(['English', 'Danish']);
  });

  it('rejects a name that is not a real language, without saving anything', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/languages',
      cookies: { session },
      payload: { languages: ['English', 'Klingon'] },
    });
    expect(res.statusCode).toBe(400);

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings/languages',
      cookies: { session },
    });
    expect(get.json().selected).toEqual([]);
  });

  it('dedupes a repeated entry rather than rejecting it', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/languages',
      cookies: { session },
      payload: { languages: ['English', 'English'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ selected: ['English'] });
  });

  it('overwrites the previous set entirely, including clearing it with an empty array', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/languages',
      cookies: { session },
      payload: { languages: ['English'] },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/languages',
      cookies: { session },
      payload: { languages: [] },
    });
    expect(res.json()).toEqual({ selected: [] });
  });
});

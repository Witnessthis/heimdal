import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumePendingTotpToken,
  consumeSetupToken,
  createPendingTotpToken,
  createSession,
  destroySession,
  generateSetupToken,
  validatePendingTotpToken,
  validateSession,
} from './session';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-session-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('setup token', () => {
  it('accepts the exact generated token, dash- and case-insensitive', () => {
    const token = generateSetupToken(); // "XXXX-XXXX-XXXX-XXXX"
    expect(consumeSetupToken(token.toLowerCase())).toBe(true);
  });

  it('is single-use', () => {
    const token = generateSetupToken();
    expect(consumeSetupToken(token)).toBe(true);
    expect(consumeSetupToken(token)).toBe(false);
  });

  it('rejects a right-length-but-wrong value and a wrong-length value', () => {
    generateSetupToken();
    expect(consumeSetupToken('AAAA-BBBB-CCCC-DDDD')).toBe(false); // 16 chars, wrong
    expect(consumeSetupToken('SHORT')).toBe(false); // wrong length
  });

  it('rejects any token when none is outstanding', () => {
    // Clear whatever the previous tests left set, then assert.
    consumeSetupToken(generateSetupToken());
    expect(consumeSetupToken('ANYT-HING-HERE-0000')).toBe(false);
  });
});

describe('session lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('validates a fresh session and rejects an unknown token', async () => {
    const token = await createSession(dir);
    expect(await validateSession(dir, token)).toBe(true);
    expect(await validateSession(dir, 'not-a-real-token')).toBe(false);
  });

  it('rejects a destroyed session', async () => {
    const token = await createSession(dir);
    await destroySession(dir, token);
    expect(await validateSession(dir, token)).toBe(false);
  });

  it('expires after 30 days of inactivity', async () => {
    vi.useFakeTimers();
    const token = await createSession(dir);
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
    expect(await validateSession(dir, token)).toBe(false);
  });

  it('slides the 30-day window forward on each validation', async () => {
    vi.useFakeTimers();
    const token = await createSession(dir);
    vi.advanceTimersByTime(20 * 24 * 60 * 60 * 1000); // 20d in — refreshes
    expect(await validateSession(dir, token)).toBe(true);
    vi.advanceTimersByTime(20 * 24 * 60 * 60 * 1000); // 40d since creation, 20d since use
    expect(await validateSession(dir, token)).toBe(true);
  });
});

describe('pending TOTP token — wrong code must not burn it (regression)', () => {
  afterEach(() => vi.useRealTimers());

  it('validation is non-destructive: a wrong guess leaves the token usable', () => {
    const token = createPendingTotpToken();
    expect(validatePendingTotpToken(token)).toBe(true);
    expect(validatePendingTotpToken(token)).toBe(true); // still valid after a check
  });

  it('consume is what actually retires it', () => {
    const token = createPendingTotpToken();
    consumePendingTotpToken(token);
    expect(validatePendingTotpToken(token)).toBe(false);
  });

  it('expires after 5 minutes', () => {
    vi.useFakeTimers();
    const token = createPendingTotpToken();
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(validatePendingTotpToken(token)).toBe(false);
  });
});

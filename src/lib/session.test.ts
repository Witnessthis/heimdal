import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('validates a fresh session and rejects an unknown token', () => {
    const token = createSession();
    expect(validateSession(token)).toBe(true);
    expect(validateSession('not-a-real-token')).toBe(false);
  });

  it('rejects a destroyed session', () => {
    const token = createSession();
    destroySession(token);
    expect(validateSession(token)).toBe(false);
  });

  it('expires after 30 days of inactivity', () => {
    vi.useFakeTimers();
    const token = createSession();
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
    expect(validateSession(token)).toBe(false);
  });

  it('slides the 30-day window forward on each validation', () => {
    vi.useFakeTimers();
    const token = createSession();
    vi.advanceTimersByTime(20 * 24 * 60 * 60 * 1000); // 20d in — refreshes
    expect(validateSession(token)).toBe(true);
    vi.advanceTimersByTime(20 * 24 * 60 * 60 * 1000); // 40d since creation, 20d since use
    expect(validateSession(token)).toBe(true);
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

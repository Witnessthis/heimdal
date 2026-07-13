import { describe, expect, it } from 'vitest';
import { clampPageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './index';

// pageSize reaches listMessages straight from an authenticated request's
// query string, so it must be bounded: a huge value would force one giant
// IMAP fetch (an authenticated self-DoS), and junk values must not blow up
// the range math downstream.
describe('clampPageSize', () => {
  it('caps an oversized request at MAX_PAGE_SIZE', () => {
    expect(clampPageSize(101)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(1_000_000)).toBe(MAX_PAGE_SIZE);
  });

  it('passes an in-range size through unchanged', () => {
    expect(clampPageSize(1)).toBe(1);
    expect(clampPageSize(50)).toBe(50);
    expect(clampPageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
  });

  it('falls back to the default for missing, zero, negative, or non-finite input', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(-5)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE);
  });
});

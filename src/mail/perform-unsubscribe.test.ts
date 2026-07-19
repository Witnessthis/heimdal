import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPublicIp } from './perform-unsubscribe';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const { lookup } = await import('node:dns/promises');
const { resolvesToPublicAddress, performOneClickUnsubscribe } = await import('./perform-unsubscribe');

describe('isPublicIp', () => {
  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['203.0.113.5', true],
    ['10.0.0.1', false],
    ['10.255.255.255', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false], // cloud metadata endpoint
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['172.32.0.1', true], // just outside the RFC 1918 172.16.0.0/12 range
    ['192.168.1.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
  ])('classifies IPv4 %s as public=%s', (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });

  it.each([
    ['2001:4860:4860::8888', true], // Google public DNS
    ['::1', false], // loopback
    ['::', false], // unspecified
    ['fe80::1', false], // link-local
    ['fc00::1', false], // unique local
    ['fd12:3456:789a::1', false], // unique local
    ['::ffff:127.0.0.1', false], // IPv4-mapped loopback
    ['::ffff:8.8.8.8', true], // IPv4-mapped public
  ])('classifies IPv6 %s as public=%s', (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });

  it('rejects a string that is not an IP address at all', () => {
    expect(isPublicIp('not-an-ip')).toBe(false);
  });
});

describe('resolvesToPublicAddress', () => {
  it('checks an IP-literal hostname directly, without a DNS lookup', async () => {
    await expect(resolvesToPublicAddress('8.8.8.8')).resolves.toBe(true);
    await expect(resolvesToPublicAddress('127.0.0.1')).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('resolves a hostname via DNS and checks the resulting address', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '8.8.8.8', family: 4 });
    await expect(resolvesToPublicAddress('example.com')).resolves.toBe(true);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '169.254.169.254', family: 4 });
    await expect(resolvesToPublicAddress('metadata.internal')).resolves.toBe(false);
  });

  it('rejects a hostname that fails to resolve', async () => {
    vi.mocked(lookup).mockRejectedValue(new Error('ENOTFOUND'));
    await expect(resolvesToPublicAddress('does-not-exist.invalid')).resolves.toBe(false);
  });
});

describe('performOneClickUnsubscribe', () => {
  beforeEach(() => {
    vi.mocked(lookup).mockResolvedValue({ address: '8.8.8.8', family: 4 });
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the exact RFC 8058 body to the url, without following redirects', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    const ok = await performOneClickUnsubscribe('https://example.com/unsub?id=1');

    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe('https://example.com/unsub?id=1');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
    });
  });

  it('returns false for a non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));
    expect(await performOneClickUnsubscribe('https://example.com/unsub')).toBe(false);
  });

  it('returns false when fetch itself throws (network error, timeout)', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));
    expect(await performOneClickUnsubscribe('https://example.com/unsub')).toBe(false);
  });

  it('rejects a non-https url without ever calling fetch', async () => {
    expect(await performOneClickUnsubscribe('http://example.com/unsub')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed url without ever calling fetch', async () => {
    expect(await performOneClickUnsubscribe('not a url')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a url whose host resolves to a private address, without ever calling fetch', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '169.254.169.254', family: 4 });
    expect(await performOneClickUnsubscribe('https://metadata.internal/unsub')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an https IP-literal url pointing at a private address, without ever calling fetch', async () => {
    expect(await performOneClickUnsubscribe('https://127.0.0.1/unsub')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

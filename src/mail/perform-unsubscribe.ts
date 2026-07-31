import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const REQUEST_TIMEOUT_MS = 10_000;

/** Executes an RFC 8058 one-click unsubscribe POST. Runs server-side only
 *  — see the route this backs (src/routes/mail.ts) for why: the
 *  frontend's own CSP locks connectSrc to 'self', so a request to an
 *  arbitrary sender-controlled URL can never be made from browser JS.
 *
 *  The url comes straight from an email's List-Unsubscribe header —
 *  content an attacker fully controls, and this server is about to make
 *  an outbound request to it on the sender's behalf. That's the textbook
 *  SSRF shape, so before ever calling fetch: the scheme must be https
 *  (mirrors parseListUnsubscribe's own oneClick requirement, checked
 *  again here as defense in depth), the hostname's *resolved* address is
 *  checked against the private/loopback/link-local ranges (not just the
 *  hostname string, which would miss a domain simply pointed at an
 *  internal IP), and redirects are never followed — a legitimate
 *  one-click endpoint doesn't need one (RFC 8058 expects a direct 2xx),
 *  and following one would reopen the same hole via a redirect target
 *  this check never saw. */
export async function performOneClickUnsubscribe(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (!(await resolvesToPublicAddress(parsed.hostname))) return false;

  try {
    const response = await fetch(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return isPublicIp(hostname);
  try {
    const { address } = await lookup(hostname);
    return isPublicIp(address);
  } catch {
    return false;
  }
}

export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family === 6) return isPublicIpv6(ip);
  return false;
}

function isPublicIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return false; // "this network" (RFC 791)
  if (a === 10) return false; // RFC 1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a >= 224) return false; // multicast + reserved
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return false; // loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return false; // link-local, fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false; // unique local, fc00::/7
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — the embedded address is the one that actually
    // matters, not the ::ffff: wrapper.
    const embedded = lower.slice('::ffff:'.length);
    if (isIP(embedded) === 4) return isPublicIpv4(embedded);
  }
  return true;
}

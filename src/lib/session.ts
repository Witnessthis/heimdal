import { randomBytes, timingSafeEqual } from 'node:crypto';

let setupToken: string | null = null;

interface Session {
  expiresAt: number;
}
const sessions = new Map<string, Session>();

// 30 days, sliding — refreshed on every validated request (see
// validateSession and require-auth.ts), so an actively-used session
// never expires mid-use, but an abandoned or stolen token dies within
// this long of its last use instead of lasting forever.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'session';
export const sessionCookieOpts = {
  httpOnly: true,
  // Only require HTTPS when a domain is configured (i.e. production).
  // Localhost is a secure context so this is safe in development.
  secure: !!process.env.DOMAIN,
  sameSite: 'strict' as const,
  path: '/',
  maxAge: SESSION_TTL_MS / 1000, // @fastify/cookie takes seconds
};

export function generateSetupToken(): string {
  const raw = randomBytes(8).toString('hex').toUpperCase();
  setupToken = raw;
  return raw.match(/.{1,4}/g)!.join('-');
}

export function consumeSetupToken(token: string): boolean {
  if (setupToken === null) return false;
  const normalized = token.replace(/-/g, '').toUpperCase();
  if (normalized.length !== setupToken.length) return false;
  const match = timingSafeEqual(Buffer.from(normalized, 'utf8'), Buffer.from(setupToken, 'utf8'));
  if (match) setupToken = null;
  return match;
}

export function createSession(): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function validateSession(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() >= session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

// Pending TOTP tokens — issued after password verification, consumed on TOTP verification
interface PendingTotp {
  expiresAt: number;
}
const pendingTotpTokens = new Map<string, PendingTotp>();

export function createPendingTotpToken(): string {
  const token = randomBytes(16).toString('hex');
  pendingTotpTokens.set(token, { expiresAt: Date.now() + 5 * 60 * 1000 });
  return token;
}

export function consumePendingTotpToken(token: string): boolean {
  const entry = pendingTotpTokens.get(token);
  if (!entry) return false;
  pendingTotpTokens.delete(token);
  return Date.now() < entry.expiresAt;
}

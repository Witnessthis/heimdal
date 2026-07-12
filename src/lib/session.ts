import { randomBytes, timingSafeEqual } from 'node:crypto';

let setupToken: string | null = null;
const sessions = new Set<string>();

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
  sessions.add(token);
  return token;
}

export function validateSession(token: string): boolean {
  return sessions.has(token);
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

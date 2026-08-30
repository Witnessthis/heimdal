import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let setupToken: string | null = null;

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

// Persisted (node:sqlite, same convention as unsubscribe-suppressions.ts/
// ai-feed.ts — no native binding to cross-compile for the Raspberry Pi
// deploy target) rather than an in-memory Map. The dev server's tsx watch
// does a full process restart on every backend file change; an in-memory
// store would wipe every logged-in session on each one, forcing a fresh
// login after every edit. Only the long-lived login session gets this
// treatment — the setup token above and the pending-TOTP token below are
// both short-lived, single-use values scoped to one in-progress flow, not
// worth the same durability.
const SESSION_FILE_NAME = 'sessions.sqlite';

async function openSessionDb(dataDir: string): Promise<DatabaseSync> {
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, SESSION_FILE_NAME));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )
  `);
  return db;
}

export async function createSession(dataDir: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const db = await openSessionDb(dataDir);
  try {
    db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(
      token,
      Date.now() + SESSION_TTL_MS,
    );
  } finally {
    db.close();
  }
  return token;
}

export async function validateSession(dataDir: string, token: string): Promise<boolean> {
  const db = await openSessionDb(dataDir);
  try {
    const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token) as
      | { expires_at: number }
      | undefined;
    if (!row) return false;
    if (Date.now() >= row.expires_at) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return false;
    }
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() + SESSION_TTL_MS, token);
    return true;
  } finally {
    db.close();
  }
}

export async function destroySession(dataDir: string, token: string): Promise<void> {
  const db = await openSessionDb(dataDir);
  try {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  } finally {
    db.close();
  }
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

// Non-destructive: a wrong TOTP guess must not burn the pending login —
// the user still has the rest of the 5-minute window to try again. Only
// the caller's own successful-login path should call consumePendingTotpToken.
export function validatePendingTotpToken(token: string): boolean {
  const entry = pendingTotpTokens.get(token);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt) {
    pendingTotpTokens.delete(token);
    return false;
  }
  return true;
}

export function consumePendingTotpToken(token: string): void {
  pendingTotpTokens.delete(token);
}

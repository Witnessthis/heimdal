import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

interface Credentials {
  passwordHash: string;
  totp?: { secret: string };
}

export async function loadCredentials(dataDir: string): Promise<Credentials | null> {
  try {
    const raw = await readFile(join(dataDir, 'credentials.json'), 'utf-8');
    return JSON.parse(raw) as Credentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(dataDir: string, password: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  const credentials: Credentials = { passwordHash: `${salt}:${hash.toString('hex')}` };
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}

export async function savePendingTotpSecret(dataDir: string, secret: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'totp-pending.json'), JSON.stringify({ secret, createdAt: Date.now() }), {
    mode: 0o600,
  });
}

export async function loadPendingTotpSecret(dataDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(dataDir, 'totp-pending.json'), 'utf-8');
    const { secret, createdAt } = JSON.parse(raw) as { secret: string; createdAt: number };
    // Expire after 30 minutes
    if (Date.now() - createdAt > 30 * 60 * 1000) return null;
    return secret;
  } catch {
    return null;
  }
}

export async function clearPendingTotpSecret(dataDir: string): Promise<void> {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(join(dataDir, 'totp-pending.json'));
  } catch {
    // already gone, that's fine
  }
}

export async function setTotpSecret(dataDir: string, secret: string): Promise<void> {
  const credentials = await loadCredentials(dataDir);
  if (!credentials) throw new Error('Not configured');
  credentials.totp = { secret };
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}

export async function verifyCredentials(dataDir: string, password: string): Promise<boolean> {
  const credentials = await loadCredentials(dataDir);
  if (!credentials) return false;
  const [salt, storedHash] = credentials.passwordHash.split(':');
  const storedBuffer = Buffer.from(storedHash, 'hex');
  const derivedBuffer = (await scryptAsync(password, salt, 64)) as Buffer;
  return timingSafeEqual(storedBuffer, derivedBuffer);
}

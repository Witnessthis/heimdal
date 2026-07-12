import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decrypt, encrypt, loadOrCreateMasterKey } from './crypto';

// Node's crypto.scrypt default (2^14) — implicit N for hashes saved
// before the cost was made explicit and self-describing below.
const LEGACY_SCRYPT_N = 16384;
// OWASP's current minimum recommendation (2^17).
const SCRYPT_N = 131072;
// scrypt memory usage is ~128*N*r bytes; default r=8 puts SCRYPT_N at
// ~128MiB, over Node's default 32MiB maxmem cap — must raise it explicitly
// or scrypt throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

// Hand-rolled instead of promisify(scrypt) — the options-object overload
// (needed for N/maxmem) isn't one of promisify's typed overloads for scrypt.
function scryptHash(password: string, salt: string, N: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N, maxmem: SCRYPT_MAXMEM }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

interface Credentials {
  passwordHash: string;
  // Encrypted at rest (crypto.ts's iv.tag.ciphertext format) — or, for a
  // secret saved before that was added, still legacy plaintext base32
  // until resolveTotpSecret() migrates it on next use. loadCredentials
  // returns this exactly as stored; only resolveTotpSecret decrypts it.
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
  // Preserve any existing totp field — this is also called by
  // verifyCredentials' opportunistic rehash-on-login, which must not
  // silently drop an already-configured TOTP secret.
  const existing = await loadCredentials(dataDir);
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptHash(password, salt, SCRYPT_N);
  const credentials: Credentials = {
    ...existing,
    passwordHash: `${SCRYPT_N}:${salt}:${hash.toString('hex')}`,
  };
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
  const key = await loadOrCreateMasterKey(dataDir);
  credentials.totp = { secret: encrypt(key, secret) };
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}

// otplib's base32 secrets are uppercase A-Z2-7 only; the encrypted format
// (crypto.ts's encrypt()) is three base64 segments joined by '.', so
// exactly two dots reliably distinguishes it from a legacy plaintext one.
function isEncryptedTotpSecret(value: string): boolean {
  return value.split('.').length === 3;
}

/** Resolves credentials.totp.secret (as returned by loadCredentials,
 *  unchanged) to its usable plaintext form. A secret already encrypted
 *  at rest is decrypted; a legacy plaintext secret (saved before this
 *  was encrypted) is migrated — re-saved encrypted via setTotpSecret —
 *  transparently, the first time it's actually used again. */
export async function resolveTotpSecret(dataDir: string, storedSecret: string): Promise<string> {
  if (isEncryptedTotpSecret(storedSecret)) {
    const key = await loadOrCreateMasterKey(dataDir);
    return decrypt(key, storedSecret);
  }
  await setTotpSecret(dataDir, storedSecret);
  return storedSecret;
}

export async function verifyCredentials(dataDir: string, password: string): Promise<boolean> {
  const credentials = await loadCredentials(dataDir);
  if (!credentials) return false;
  const parts = credentials.passwordHash.split(':');
  const [N, salt, storedHash] =
    parts.length === 3 ? [Number(parts[0]), parts[1], parts[2]] : [LEGACY_SCRYPT_N, parts[0], parts[1]];
  const storedBuffer = Buffer.from(storedHash, 'hex');
  const derivedBuffer = await scryptHash(password, salt, N);
  const valid = timingSafeEqual(storedBuffer, derivedBuffer);

  // Opportunistic upgrade: a hash saved at an old (or legacy, unlabeled)
  // cost gets re-hashed at the current cost right here, since this is the
  // one place the plaintext password is ever available again. Self-heals
  // every real user's hash to the current cost within one login, with no
  // separate migration step or forced reset.
  if (valid && N < SCRYPT_N) await saveCredentials(dataDir, password);

  return valid;
}

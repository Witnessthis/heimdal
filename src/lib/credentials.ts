import { hash as argon2Hash, argon2id, needsRehash, verify as argon2Verify } from 'argon2';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decrypt, encrypt, loadOrCreateMasterKey } from './crypto';

// OWASP's current recommended baseline for Argon2id.
const ARGON2_OPTIONS = { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

/** Splits "<scheme-id>:<payload>" on the first ':'. Scheme ids never
 *  contain ':' themselves; payloads may (argon2's own encoded hash uses
 *  '$' as its separator, and encrypt()'s output uses '.'), so splitting
 *  on the first occurrence only is unambiguous either way. */
function splitSchemeTag(stored: string): [id: string, payload: string] {
  const i = stored.indexOf(':');
  return [stored.slice(0, i), stored.slice(i + 1)];
}

// --- Password hashing: a tagged-scheme registry ------------------------
//
// passwordHash is stored as "<scheme-id>:<scheme-specific payload>", with
// the scheme id explicit rather than inferred from the payload's shape.
// A verify always knows exactly how to check whatever's stored, and on
// success always knows exactly how to re-hash to the current scheme in
// one direct step — switching schemes N times over the app's life never
// requires walking through the ones in between, since each one is
// independently self-contained and verifiable on its own.
interface PasswordScheme {
  hash(password: string): Promise<string>;
  verify(password: string, payload: string): Promise<boolean>;
  /** True if a payload that already verified correctly should still be
   *  re-hashed — e.g. this scheme's own cost parameters were tuned up
   *  since the payload was created. Lets cost tuning happen without a
   *  new scheme id: argon2's encoded hash embeds its own parameters, so
   *  needsRehash() catches parameter drift within argon2id-v1 itself. */
  needsUpgrade(payload: string): boolean;
}

const PASSWORD_SCHEMES: Record<string, PasswordScheme> = {
  'argon2id-v1': {
    hash: (password) => argon2Hash(password, ARGON2_OPTIONS),
    verify: (password, payload) => argon2Verify(payload, password),
    needsUpgrade: (payload) => needsRehash(payload, ARGON2_OPTIONS),
  },
};
const CURRENT_PASSWORD_SCHEME = 'argon2id-v1';

async function hashPassword(password: string): Promise<string> {
  const payload = await PASSWORD_SCHEMES[CURRENT_PASSWORD_SCHEME].hash(password);
  return `${CURRENT_PASSWORD_SCHEME}:${payload}`;
}

// --- TOTP secret encryption: the same tagged-scheme pattern ------------
//
// Mirrors the password scheme registry above, but two-way (decrypt, not
// verify) since the plaintext secret is needed again for TOTP checks.
interface TotpScheme {
  encrypt(dataDir: string, secret: string): Promise<string>;
  decrypt(dataDir: string, payload: string): Promise<string>;
}

const TOTP_SCHEMES: Record<string, TotpScheme> = {
  'aesgcm-v1': {
    encrypt: async (dataDir, secret) => encrypt(await loadOrCreateMasterKey(dataDir), secret),
    decrypt: async (dataDir, payload) => decrypt(await loadOrCreateMasterKey(dataDir), payload),
  },
};
const CURRENT_TOTP_SCHEME = 'aesgcm-v1';

interface Credentials {
  // "<scheme-id>:<payload>" — see the PasswordScheme registry above.
  passwordHash: string;
  // "<scheme-id>:<payload>" — see the TotpScheme registry above.
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
  // verifyCredentials' opportunistic upgrade-on-login, which must not
  // silently drop an already-configured TOTP secret.
  const existing = await loadCredentials(dataDir);
  const credentials: Credentials = { ...existing, passwordHash: await hashPassword(password) };
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
  const payload = await TOTP_SCHEMES[CURRENT_TOTP_SCHEME].encrypt(dataDir, secret);
  credentials.totp = { secret: `${CURRENT_TOTP_SCHEME}:${payload}` };
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}

/** Resolves credentials.totp.secret (as returned by loadCredentials,
 *  unchanged) to its usable plaintext form, upgrading it to the current
 *  TOTP scheme in one direct step if it wasn't already stored under it. */
export async function resolveTotpSecret(dataDir: string, stored: string): Promise<string> {
  const [schemeId, payload] = splitSchemeTag(stored);
  const scheme = TOTP_SCHEMES[schemeId];
  if (!scheme) throw new Error(`Unknown TOTP secret scheme: ${schemeId}`);
  const secret = await scheme.decrypt(dataDir, payload);
  if (schemeId !== CURRENT_TOTP_SCHEME) await setTotpSecret(dataDir, secret);
  return secret;
}

export async function verifyCredentials(dataDir: string, password: string): Promise<boolean> {
  const credentials = await loadCredentials(dataDir);
  if (!credentials) return false;
  const [schemeId, payload] = splitSchemeTag(credentials.passwordHash);
  const scheme = PASSWORD_SCHEMES[schemeId];
  if (!scheme) return false;
  const valid = await scheme.verify(password, payload);

  // Opportunistic upgrade: re-hash under the current scheme (a different
  // scheme id entirely, or the same one with tuned-up parameters) right
  // here, since this is the one place the plaintext password is ever
  // available again. Self-heals every real user's hash within one login,
  // with no separate migration step or forced reset — works the same way
  // regardless of how many scheme changes happened since this hash was
  // created, or which one it started from.
  if (valid && (schemeId !== CURRENT_PASSWORD_SCHEME || scheme.needsUpgrade(payload))) {
    await saveCredentials(dataDir, password);
  }

  return valid;
}

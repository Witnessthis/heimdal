import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ALGO = 'aes-256-gcm';

/** Key management: not derived from the login password. IMAP IDLE
 *  reconnects (and future OAuth token refresh) must run unattended right
 *  after a container restart, before anyone has logged in — a
 *  password-derived key would leave background sync dead until the next
 *  login. `HEIMDAL_MASTER_KEY` is an escape hatch for operators who want
 *  the key managed outside the data volume entirely (Docker/k8s secret);
 *  otherwise a key is generated once into its own file, separate from
 *  provider-credentials.json, so leaking one doesn't automatically leak
 *  the other. */
export async function loadOrCreateMasterKey(dataDir: string): Promise<Buffer> {
  const envKey = process.env.HEIMDAL_MASTER_KEY;
  if (envKey) return Buffer.from(envKey, 'base64');

  const keyPath = join(dataDir, 'master.key');
  try {
    const raw = await readFile(keyPath, 'utf-8');
    return Buffer.from(raw.trim(), 'base64');
  } catch (err) {
    // Only treat "the file doesn't exist yet" as license to generate a new
    // key. Any other error (permissions, transient I/O) must propagate —
    // silently generating a replacement key here would permanently brick
    // every secret already encrypted under the real one.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await mkdir(dataDir, { recursive: true });
    const key = randomBytes(32);
    await writeFile(keyPath, key.toString('base64'), { mode: 0o600 });
    return key;
  }
}

/** Returns `iv.authTag.ciphertext`, each base64. */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join('.');
}

export function decrypt(key: Buffer, payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

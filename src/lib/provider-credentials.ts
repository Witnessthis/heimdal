import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountDir } from './accounts';
import { decrypt, encrypt, loadOrCreateMasterKey } from './crypto';

/** Connection details for the configured provider. No secrets here — those
 *  live separately in ProviderSecret, encrypted at rest. Shaped so Gmail's
 *  and Outlook's OAuth client id / tenant fit alongside IMAP's host/port
 *  without a rewrite once those providers are implemented. */
export type ProviderConfig =
  | {
      kind: 'imap';
      host: string;
      port: number;
      secure: boolean;
      smtpHost: string;
      smtpPort: number;
      smtpSecure: boolean;
      username: string;
    }
  | { kind: 'gmail'; oauthClientId: string; email: string }
  | { kind: 'outlook'; oauthClientId: string; tenant: string; email: string };

export interface ImapSecret {
  password: string;
  smtpPassword?: string;
}

export interface OAuthSecret {
  refreshToken: string;
  clientSecret?: string;
}

export type ProviderSecret = ImapSecret | OAuthSecret;

interface StoredProviderCredentials {
  config: ProviderConfig;
  secret: string; // encrypted JSON.stringify(ProviderSecret)
}

const FILE_NAME = 'provider-credentials.json';

export async function saveProviderCredentials(
  dataDir: string,
  accountId: string,
  config: ProviderConfig,
  secret: ProviderSecret,
): Promise<void> {
  const dir = accountDir(dataDir, accountId);
  await mkdir(dir, { recursive: true });
  // The master key stays global (one key, dataDir-rooted) rather than
  // per-account — see crypto.ts's own doc comment on why it must be
  // available before any account-specific state exists (e.g. right after a
  // container restart, before anyone has logged in).
  const key = await loadOrCreateMasterKey(dataDir);
  const stored: StoredProviderCredentials = {
    config,
    secret: encrypt(key, JSON.stringify(secret)),
  };
  await writeFile(join(dir, FILE_NAME), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

export async function loadProviderCredentials(
  dataDir: string,
  accountId: string,
): Promise<{ config: ProviderConfig; secret: ProviderSecret } | null> {
  try {
    const raw = await readFile(join(accountDir(dataDir, accountId), FILE_NAME), 'utf-8');
    const stored = JSON.parse(raw) as StoredProviderCredentials;
    const key = await loadOrCreateMasterKey(dataDir);
    const secret = JSON.parse(decrypt(key, stored.secret)) as ProviderSecret;
    return { config: stored.config, secret };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Failed to load provider credentials:', err);
    }
    return null;
  }
}

export async function updateProviderSecret(
  dataDir: string,
  accountId: string,
  secret: ProviderSecret,
): Promise<void> {
  const existing = await loadProviderCredentials(dataDir, accountId);
  if (!existing) throw new Error('No provider configured');
  await saveProviderCredentials(dataDir, accountId, existing.config, secret);
}

export async function clearProviderCredentials(dataDir: string, accountId: string): Promise<void> {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(join(accountDir(dataDir, accountId), FILE_NAME));
  } catch {
    // already gone, that's fine
  }
}

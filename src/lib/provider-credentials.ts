import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { loadOrCreateMasterKey, encrypt, decrypt } from './crypto';

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
  config: ProviderConfig,
  secret: ProviderSecret
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const key = await loadOrCreateMasterKey(dataDir);
  const stored: StoredProviderCredentials = {
    config,
    secret: encrypt(key, JSON.stringify(secret)),
  };
  await writeFile(join(dataDir, FILE_NAME), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

export async function loadProviderCredentials(
  dataDir: string
): Promise<{ config: ProviderConfig; secret: ProviderSecret } | null> {
  try {
    const raw = await readFile(join(dataDir, FILE_NAME), 'utf-8');
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
  secret: ProviderSecret
): Promise<void> {
  const existing = await loadProviderCredentials(dataDir);
  if (!existing) throw new Error('No provider configured');
  await saveProviderCredentials(dataDir, existing.config, secret);
}

export async function clearProviderCredentials(dataDir: string): Promise<void> {
  try {
    const { unlink } = await import('fs/promises');
    await unlink(join(dataDir, FILE_NAME));
  } catch {
    // already gone, that's fine
  }
}

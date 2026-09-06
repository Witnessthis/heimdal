import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderKind } from '../mail/provider';
import { requalifyLegacyFeedItems } from './ai-feed';

export interface MailAccount {
  id: string;
  label: string;
  kind: ProviderKind;
  // Hex color, e.g. "#7aa2f7" — a small per-card accent (see web/src/ai-feed/
  // card.ts), deliberately independent of the active theme (see chat
  // history: it must read the same regardless of which theme is active, so
  // it's picked from a fixed palette below rather than derived from
  // themes.js). Defaults from the palette at creation time, freely
  // overridable afterward via updateAccount — a plain hex string rather
  // than a constrained enum, since the override is a native
  // `<input type="color">` in Settings, not a swatch picker.
  color: string;
  // A key into web/public/themes.js's THEMES map — unlike `color` above,
  // this genuinely changes what switching profile looks like (see chat
  // history: the user wants each profile to remember and reapply its own
  // whole-app theme). Just a plain string here; this module and its
  // callers never validate it against the real theme list — an unknown
  // value is themes.js's own resolve()'s job to fall back safely from,
  // same as an unrecognized value already read from localStorage does.
  theme: string;
  createdAt: string;
}

// Matches themes.js's own DEFAULT_THEME — duplicated rather than shared
// across the backend/frontend boundary (no runtime coupling exists between
// them today), same reasoning as web/src/shared/account-id.ts's own
// duplicated-rather-than-imported comment.
const DEFAULT_THEME = 'heimdal';

const INDEX_FILE_NAME = 'accounts.json';

// Curated, not derived from themes.js on purpose — see MailAccount.color's
// own doc comment. Chosen for mutual distinctiveness and to read reasonably
// on both light and dark card backgrounds, since a small swatch never needs
// the contrast guarantees a theme's own text/background pairing does.
const COLOR_PALETTE = [
  '#e06c75', // red
  '#61afef', // blue
  '#98c379', // green
  '#e5c07b', // yellow
  '#c678dd', // purple
  '#56b6c2', // cyan
  '#d19a66', // orange
  '#be5046', // brick
  '#7aa2f7', // periwinkle
  '#f78c6c', // coral
];

export function nextDefaultColor(existingCount: number): string {
  return COLOR_PALETTE[existingCount % COLOR_PALETTE.length];
}

export function accountDir(dataDir: string, accountId: string): string {
  return join(dataDir, 'accounts', accountId);
}

function indexPath(dataDir: string): string {
  return join(dataDir, INDEX_FILE_NAME);
}

async function readIndex(dataDir: string): Promise<MailAccount[]> {
  try {
    const raw = await readFile(indexPath(dataDir), 'utf-8');
    const accounts = JSON.parse(raw) as MailAccount[];
    // Backfills `theme` for accounts written before it existed — self-heals
    // on disk the next time anything calls writeIndex (e.g. any PATCH),
    // rather than needing a dedicated one-time migration for what's really
    // just one optional-at-read-time field.
    return accounts.map((a) => (a.theme ? a : { ...a, theme: DEFAULT_THEME }));
  } catch {
    return [];
  }
}

async function writeIndex(dataDir: string, accounts: MailAccount[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(indexPath(dataDir), JSON.stringify(accounts, null, 2));
}

export async function listAccounts(dataDir: string): Promise<MailAccount[]> {
  return readIndex(dataDir);
}

export async function getAccount(dataDir: string, accountId: string): Promise<MailAccount | undefined> {
  return (await readIndex(dataDir)).find((a) => a.id === accountId);
}

/** Registers a new account's identity/metadata and creates its data
 *  directory — does NOT store mail credentials or connect anything; callers
 *  (see routes/accounts.ts) save provider credentials into the returned
 *  account's directory and connect it via mailService separately, so a
 *  failed connection attempt doesn't leave a half-registered account with
 *  no directory to write credentials into. */
export async function createAccount(
  dataDir: string,
  input: { label: string; kind: ProviderKind },
): Promise<MailAccount> {
  const accounts = await readIndex(dataDir);
  const account: MailAccount = {
    id: randomBytes(8).toString('hex'),
    label: input.label,
    kind: input.kind,
    color: nextDefaultColor(accounts.length),
    theme: DEFAULT_THEME,
    createdAt: new Date().toISOString(),
  };
  await mkdir(accountDir(dataDir, account.id), { recursive: true });
  await writeIndex(dataDir, [...accounts, account]);
  return account;
}

export async function updateAccount(
  dataDir: string,
  accountId: string,
  patch: { label?: string; color?: string; theme?: string },
): Promise<MailAccount> {
  const accounts = await readIndex(dataDir);
  const index = accounts.findIndex((a) => a.id === accountId);
  if (index === -1) throw new Error(`No such account: ${accountId}`);
  const updated: MailAccount = {
    ...accounts[index],
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
  };
  accounts[index] = updated;
  await writeIndex(dataDir, accounts);
  return updated;
}

/** Removes an account's metadata and its whole data directory (provider
 *  credentials, personalized memory, language settings). Does NOT touch
 *  `ai_feed`/disconnect the live provider — see routes/accounts.ts's DELETE
 *  handler, which orchestrates all three (mailService.disconnectAccount,
 *  this, and purging that account's feed rows) in the right order. */
export async function removeAccount(dataDir: string, accountId: string): Promise<void> {
  const accounts = await readIndex(dataDir);
  await writeIndex(
    dataDir,
    accounts.filter((a) => a.id !== accountId),
  );
  await rm(accountDir(dataDir, accountId), { recursive: true, force: true });
}

const LEGACY_PROVIDER_CREDENTIALS_FILE = 'provider-credentials.json';
const LEGACY_MEMORY_FILE = 'memory.md';
const LEGACY_LANGUAGE_SETTINGS_FILE = 'language-settings.json';
const LEGACY_UNSUBSCRIBE_SUPPRESSIONS_FILE = 'unsubscribe-suppressions.sqlite';

/** One-time upgrade path for installs that predate multi-account support:
 *  everything used to live flat in dataDir (one provider-credentials.json,
 *  one memory.md, one language-settings.json, one unsubscribe-
 *  suppressions.sqlite). Without this, an existing install would silently
 *  lose its configured mail account entirely on upgrade — accounts.json
 *  wouldn't exist yet, so mailService.initAll would connect nothing.
 *
 *  Promotes that single legacy account into the new accounts/<id>/
 *  layout (moving its four files there) and re-qualifies its existing
 *  ai_feed rows (see requalifyLegacyFeedItems) — their ids reference the
 *  old unqualified message-id scheme, which the rest of the app no longer
 *  recognizes now that every id must carry its account.
 *
 *  Safe to call on every startup: a no-op once accounts.json exists,
 *  whether from a real migration already having run or a fresh multi-
 *  account install that never had the old layout at all. */
export async function migrateLegacyAccountIfNeeded(dataDir: string): Promise<void> {
  if (existsSync(indexPath(dataDir))) return;
  const legacyCredentialsPath = join(dataDir, LEGACY_PROVIDER_CREDENTIALS_FILE);
  if (!existsSync(legacyCredentialsPath)) return;

  // The config half of provider-credentials.json is plaintext JSON (only
  // `secret` is encrypted) — read straight through it for a kind/label,
  // without needing the master key at all.
  let kind: ProviderKind = 'imap';
  let label = 'Mail';
  try {
    const raw = JSON.parse(await readFile(legacyCredentialsPath, 'utf-8'));
    if (raw?.config?.kind) kind = raw.config.kind;
    if (typeof raw?.config?.username === 'string') label = raw.config.username;
    else if (typeof raw?.config?.email === 'string') label = raw.config.email;
  } catch {
    // Corrupt/unreadable — fall through with the defaults above;
    // loadProviderCredentials will surface the real problem once this
    // account is actually connected, same as it would have before.
  }

  const account: MailAccount = {
    id: randomBytes(8).toString('hex'),
    label,
    kind,
    color: nextDefaultColor(0),
    theme: DEFAULT_THEME,
    createdAt: new Date().toISOString(),
  };
  const dir = accountDir(dataDir, account.id);
  await mkdir(dir, { recursive: true });

  for (const file of [
    LEGACY_PROVIDER_CREDENTIALS_FILE,
    LEGACY_MEMORY_FILE,
    LEGACY_LANGUAGE_SETTINGS_FILE,
    LEGACY_UNSUBSCRIBE_SUPPRESSIONS_FILE,
  ]) {
    const from = join(dataDir, file);
    if (existsSync(from)) await rename(from, join(dir, file));
  }

  await writeIndex(dataDir, [account]);
  await requalifyLegacyFeedItems(dataDir, account.id);
}

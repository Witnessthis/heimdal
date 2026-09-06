import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountDir,
  createAccount,
  getAccount,
  listAccounts,
  migrateLegacyAccountIfNeeded,
  nextDefaultColor,
  removeAccount,
  updateAccount,
} from './accounts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-accounts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createAccount / listAccounts / getAccount', () => {
  it('creates an account with a generated id, default color/theme, and its own directory', async () => {
    const account = await createAccount(dir, { label: 'Work', kind: 'imap' });
    expect(account.label).toBe('Work');
    expect(account.kind).toBe('imap');
    expect(account.color).toBe(nextDefaultColor(0));
    expect(account.theme).toBe('heimdal');
    expect(account.id).toMatch(/^[0-9a-f]{16}$/);

    const listed = await listAccounts(dir);
    expect(listed).toEqual([account]);
    expect(await getAccount(dir, account.id)).toEqual(account);
  });

  it('assigns unique default colors in creation order', async () => {
    const first = await createAccount(dir, { label: 'A', kind: 'imap' });
    const second = await createAccount(dir, { label: 'B', kind: 'imap' });
    expect(first.color).not.toBe(second.color);
    expect(second.color).toBe(nextDefaultColor(1));
  });

  it('returns an empty list when nothing has been created', async () => {
    expect(await listAccounts(dir)).toEqual([]);
  });

  it('returns undefined for an account that does not exist', async () => {
    expect(await getAccount(dir, 'nonexistent')).toBeUndefined();
  });

  it('backfills a default theme for an account written before that field existed', async () => {
    await writeFile(
      join(dir, 'accounts.json'),
      JSON.stringify([
        { id: 'legacy1', label: 'Legacy', kind: 'imap', color: '#e06c75', createdAt: '2026-01-01T00:00:00Z' },
      ]),
    );
    const [account] = await listAccounts(dir);
    expect(account.theme).toBe('heimdal');
  });
});

describe('updateAccount', () => {
  it('updates the label without touching color', async () => {
    const account = await createAccount(dir, { label: 'Work', kind: 'imap' });
    const updated = await updateAccount(dir, account.id, { label: 'Work (new)' });
    expect(updated.label).toBe('Work (new)');
    expect(updated.color).toBe(account.color);
  });

  it('updates the color without touching label', async () => {
    const account = await createAccount(dir, { label: 'Work', kind: 'imap' });
    const updated = await updateAccount(dir, account.id, { color: '#123456' });
    expect(updated.color).toBe('#123456');
    expect(updated.label).toBe('Work');
  });

  it('updates the theme without touching color/label', async () => {
    const account = await createAccount(dir, { label: 'Work', kind: 'imap' });
    const updated = await updateAccount(dir, account.id, { theme: 'dracula' });
    expect(updated.theme).toBe('dracula');
    expect(updated.color).toBe(account.color);
    expect(updated.label).toBe('Work');
  });

  it('throws for an account that does not exist', async () => {
    await expect(updateAccount(dir, 'nonexistent', { label: 'x' })).rejects.toThrow();
  });
});

describe('removeAccount', () => {
  it('removes the account from the index and deletes its directory', async () => {
    const account = await createAccount(dir, { label: 'Work', kind: 'imap' });
    await removeAccount(dir, account.id);
    expect(await listAccounts(dir)).toEqual([]);
    await expect(readFile(join(accountDir(dir, account.id), 'memory.md'))).rejects.toThrow();
  });

  it('leaves other accounts intact', async () => {
    const a = await createAccount(dir, { label: 'A', kind: 'imap' });
    const b = await createAccount(dir, { label: 'B', kind: 'imap' });
    await removeAccount(dir, a.id);
    expect(await listAccounts(dir)).toEqual([b]);
  });
});

describe('migrateLegacyAccountIfNeeded', () => {
  it('is a no-op when there is no legacy provider-credentials.json', async () => {
    await migrateLegacyAccountIfNeeded(dir);
    expect(await listAccounts(dir)).toEqual([]);
  });

  it('is a no-op once accounts.json already exists, even with a legacy file present', async () => {
    await createAccount(dir, { label: 'Already migrated', kind: 'imap' });
    await writeFile(join(dir, 'provider-credentials.json'), JSON.stringify({ config: { kind: 'imap' } }));
    await migrateLegacyAccountIfNeeded(dir);
    const accounts = await listAccounts(dir);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].label).toBe('Already migrated');
  });

  it('promotes a legacy single-account layout into accounts/<id>/, deriving the label from username', async () => {
    await writeFile(
      join(dir, 'provider-credentials.json'),
      JSON.stringify({
        config: { kind: 'imap', username: 'alice@example.com' },
        secret: 'encrypted-blob',
      }),
    );
    await writeFile(join(dir, 'memory.md'), '- learned something');
    await writeFile(join(dir, 'language-settings.json'), JSON.stringify({ spokenLanguages: ['English'] }));

    await migrateLegacyAccountIfNeeded(dir);

    const accounts = await listAccounts(dir);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].label).toBe('alice@example.com');
    expect(accounts[0].kind).toBe('imap');

    const newDir = accountDir(dir, accounts[0].id);
    expect(
      JSON.parse(await readFile(join(newDir, 'provider-credentials.json'), 'utf-8')).config.username,
    ).toBe('alice@example.com');
    expect(await readFile(join(newDir, 'memory.md'), 'utf-8')).toBe('- learned something');
    expect(await readFile(join(dir, 'provider-credentials.json'), 'utf-8').catch(() => null)).toBeNull();
  });

  it('re-qualifies existing ai_feed rows with the newly created account id', async () => {
    await writeFile(
      join(dir, 'provider-credentials.json'),
      JSON.stringify({ config: { kind: 'imap', username: 'alice@example.com' }, secret: 'x' }),
    );
    const feedDb = new DatabaseSync(join(dir, 'ai-feed.sqlite'));
    feedDb.exec(`
      CREATE TABLE ai_feed (
        email_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL DEFAULT '',
        visibility_type TEXT NOT NULL,
        visibility_until TEXT,
        draft_reply_type TEXT NOT NULL,
        draft_reply_subject TEXT,
        draft_reply_body TEXT,
        suspicious_type TEXT NOT NULL,
        suspicious_reason TEXT,
        created_at TEXT NOT NULL
      )
    `);
    feedDb
      .prepare(
        `INSERT INTO ai_feed (email_id, visibility_type, draft_reply_type, suspicious_type, created_at)
         VALUES ('imap:INBOX:1', 'feed', 'none', 'no', '2026-01-01T00:00:00Z')`,
      )
      .run();
    feedDb.close();

    await migrateLegacyAccountIfNeeded(dir);
    const [account] = await listAccounts(dir);

    const verifyDb = new DatabaseSync(join(dir, 'ai-feed.sqlite'));
    const row = verifyDb.prepare('SELECT email_id, account_id FROM ai_feed').get() as {
      email_id: string;
      account_id: string;
    };
    verifyDb.close();
    expect(row.email_id).toBe(`${account.id}|imap:INBOX:1`);
    expect(row.account_id).toBe(account.id);
  });

  it('falls back to a generic label when the legacy file has no username/email', async () => {
    await writeFile(join(dir, 'provider-credentials.json'), JSON.stringify({ config: { kind: 'imap' } }));
    await migrateLegacyAccountIfNeeded(dir);
    expect((await listAccounts(dir))[0].label).toBe('Mail');
  });

  it('does not fail when the legacy file is corrupt — falls back to defaults', async () => {
    await writeFile(join(dir, 'provider-credentials.json'), 'not json');
    await migrateLegacyAccountIfNeeded(dir);
    const accounts = await listAccounts(dir);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].kind).toBe('imap');
    expect(accounts[0].label).toBe('Mail');
  });

  it('moves the legacy unsubscribe-suppressions.sqlite file too, when present', async () => {
    await writeFile(join(dir, 'provider-credentials.json'), JSON.stringify({ config: { kind: 'imap' } }));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'unsubscribe-suppressions.sqlite'), 'not a real sqlite file, just a marker');

    await migrateLegacyAccountIfNeeded(dir);

    const [account] = await listAccounts(dir);
    const moved = await readFile(
      join(accountDir(dir, account.id), 'unsubscribe-suppressions.sqlite'),
      'utf-8',
    );
    expect(moved).toBe('not a real sqlite file, just a marker');
  });
});

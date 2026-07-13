import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeTotpSeedFile,
  loadCredentials,
  resolveTotpSecret,
  saveCredentials,
  setTotpSecret,
  verifyCredentials,
} from './credentials';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-creds-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('password hashing', () => {
  it('verifies the correct password and rejects a wrong one', async () => {
    await saveCredentials(dir, 'correct horse battery staple');
    expect(await verifyCredentials(dir, 'correct horse battery staple')).toBe(true);
    expect(await verifyCredentials(dir, 'wrong password entirely')).toBe(false);
  });

  it('returns false for an unconfigured data dir', async () => {
    expect(await verifyCredentials(dir, 'anything')).toBe(false);
  });

  it('stores a scheme-tagged argon2id hash, never the plaintext', async () => {
    await saveCredentials(dir, 'my-secret-password');
    const creds = await loadCredentials(dir);
    expect(creds?.passwordHash.startsWith('argon2id-v1:')).toBe(true);
    expect(creds?.passwordHash).not.toContain('my-secret-password');
  });
});

describe('saveCredentials preserves an existing TOTP secret (regression)', () => {
  // A password change must not wipe an already-configured second factor.
  // The opportunistic upgrade-on-login path also calls saveCredentials, so
  // this exact bug would have silently dropped TOTP on the next login.
  it('keeps totp intact across a password re-save', async () => {
    await saveCredentials(dir, 'first-password-123');
    await setTotpSecret(dir, 'JBSWY3DPEHPK3PXP');

    await saveCredentials(dir, 'second-password-456');

    const creds = await loadCredentials(dir);
    expect(creds?.totp).toBeDefined();
    expect(await verifyCredentials(dir, 'second-password-456')).toBe(true);
    expect(await resolveTotpSecret(dir, creds!.totp!.secret)).toBe('JBSWY3DPEHPK3PXP');
  });
});

describe('TOTP secret encryption', () => {
  it('round-trips a secret through encrypt + resolve', async () => {
    await saveCredentials(dir, 'pw-for-totp-test');
    await setTotpSecret(dir, 'KRSXG5CTMVRXEZLU');
    const creds = await loadCredentials(dir);
    expect(creds?.totp?.secret.startsWith('aesgcm-v1:')).toBe(true);
    expect(await resolveTotpSecret(dir, creds!.totp!.secret)).toBe('KRSXG5CTMVRXEZLU');
  });

  it('throws on an unknown scheme id rather than guessing', async () => {
    await expect(resolveTotpSecret(dir, 'bogus-v9:payload')).rejects.toThrow(/Unknown TOTP secret scheme/);
  });
});

describe('consumeTotpSeedFile — dev seed (regression)', () => {
  const seedPath = () => join(dir, 'totp-seed.txt');

  it('strips ALL whitespace, including the spaces authenticator apps display', async () => {
    // "NF3R OJRV EQAQ YDLU" must decode to the same bytes as the app's own
    // unspaced secret — embedded spaces were the bug we shipped and fixed.
    await writeFile(seedPath(), 'NF3R OJRV EQAQ YDLU\n');
    expect(await consumeTotpSeedFile(dir)).toBe('NF3ROJRVEQAQYDLU');
  });

  it('deletes the file so it cannot re-seed on a later restart', async () => {
    await writeFile(seedPath(), 'JBSWY3DPEHPK3PXP');
    expect(await consumeTotpSeedFile(dir)).toBe('JBSWY3DPEHPK3PXP');
    await expect(access(seedPath())).rejects.toThrow();
    expect(await consumeTotpSeedFile(dir)).toBeNull();
  });

  it('returns null for a missing file and for a whitespace-only file', async () => {
    expect(await consumeTotpSeedFile(dir)).toBeNull();
    await writeFile(seedPath(), '   \n\t  ');
    expect(await consumeTotpSeedFile(dir)).toBeNull();
  });
});

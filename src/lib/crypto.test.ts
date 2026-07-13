import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, encrypt, loadOrCreateMasterKey } from './crypto';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-crypto-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = randomBytes(32);

describe('encrypt / decrypt', () => {
  it('round-trips plaintext back to the original', () => {
    expect(decrypt(KEY, encrypt(KEY, 'hello secret'))).toBe('hello secret');
  });

  it('produces different output each call for the same input (random IV)', () => {
    expect(encrypt(KEY, 'same')).not.toBe(encrypt(KEY, 'same'));
  });

  it('rejects a tampered ciphertext — GCM integrity, not just confidentiality', () => {
    const [iv, tag, data] = encrypt(KEY, 'hello').split('.');
    const bad = Buffer.from(data, 'base64');
    bad[0] ^= 0xff;
    expect(() => decrypt(KEY, [iv, tag, bad.toString('base64')].join('.'))).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const [iv, tag, data] = encrypt(KEY, 'hello').split('.');
    const bad = Buffer.from(tag, 'base64');
    bad[0] ^= 0xff;
    expect(() => decrypt(KEY, [iv, bad.toString('base64'), data].join('.'))).toThrow();
  });

  it('rejects decryption under the wrong key', () => {
    const ciphertext = encrypt(KEY, 'hello');
    expect(() => decrypt(randomBytes(32), ciphertext)).toThrow();
  });
});

describe('loadOrCreateMasterKey', () => {
  const savedEnv = process.env.HEIMDAL_MASTER_KEY;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HEIMDAL_MASTER_KEY;
    else process.env.HEIMDAL_MASTER_KEY = savedEnv;
  });

  it('generates a fresh 32-byte key, written 0600, when none exists', async () => {
    delete process.env.HEIMDAL_MASTER_KEY;
    const key = await loadOrCreateMasterKey(dir);
    expect(key).toHaveLength(32);
    expect((await stat(join(dir, 'master.key'))).mode & 0o777).toBe(0o600);
  });

  it('returns the same key on a second call (persisted, not regenerated)', async () => {
    delete process.env.HEIMDAL_MASTER_KEY;
    const first = await loadOrCreateMasterKey(dir);
    const second = await loadOrCreateMasterKey(dir);
    expect(second.toString('base64')).toBe(first.toString('base64'));
  });

  it('uses HEIMDAL_MASTER_KEY when set, ignoring the data dir entirely', async () => {
    const envKey = randomBytes(32);
    process.env.HEIMDAL_MASTER_KEY = envKey.toString('base64');
    const key = await loadOrCreateMasterKey(dir);
    expect(key.toString('base64')).toBe(envKey.toString('base64'));
  });

  it('propagates a non-ENOENT read error instead of silently regenerating', async () => {
    // A real key that becomes momentarily unreadable (permissions, I/O)
    // must NOT be replaced by a fresh one — that would brick every secret
    // already encrypted under it. Simulate with a directory where the key
    // file is expected: readFile throws EISDIR, not ENOENT.
    delete process.env.HEIMDAL_MASTER_KEY;
    await mkdir(join(dir, 'master.key'));
    await expect(loadOrCreateMasterKey(dir)).rejects.toThrow();
  });
});

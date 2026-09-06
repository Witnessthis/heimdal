import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSpokenLanguages, setSpokenLanguages } from './language-settings';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-language-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ACCOUNT_ID = 'acc1';

describe('getSpokenLanguages', () => {
  it('returns an empty array when nothing has been set', async () => {
    expect(await getSpokenLanguages(dir, ACCOUNT_ID)).toEqual([]);
  });
});

describe('setSpokenLanguages / getSpokenLanguages', () => {
  it('round-trips a set of languages', async () => {
    await setSpokenLanguages(dir, ACCOUNT_ID, ['English', 'Danish']);
    expect(await getSpokenLanguages(dir, ACCOUNT_ID)).toEqual(['English', 'Danish']);
  });

  it('overwrites the previous set rather than merging with it', async () => {
    await setSpokenLanguages(dir, ACCOUNT_ID, ['English', 'Danish']);
    await setSpokenLanguages(dir, ACCOUNT_ID, ['French']);
    expect(await getSpokenLanguages(dir, ACCOUNT_ID)).toEqual(['French']);
  });

  it('round-trips an empty set (clearing everything)', async () => {
    await setSpokenLanguages(dir, ACCOUNT_ID, ['English']);
    await setSpokenLanguages(dir, ACCOUNT_ID, []);
    expect(await getSpokenLanguages(dir, ACCOUNT_ID)).toEqual([]);
  });
});

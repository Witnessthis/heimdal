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

describe('getSpokenLanguages', () => {
  it('returns an empty array when nothing has been set', async () => {
    expect(await getSpokenLanguages(dir)).toEqual([]);
  });
});

describe('setSpokenLanguages / getSpokenLanguages', () => {
  it('round-trips a set of languages', async () => {
    await setSpokenLanguages(dir, ['English', 'Danish']);
    expect(await getSpokenLanguages(dir)).toEqual(['English', 'Danish']);
  });

  it('overwrites the previous set rather than merging with it', async () => {
    await setSpokenLanguages(dir, ['English', 'Danish']);
    await setSpokenLanguages(dir, ['French']);
    expect(await getSpokenLanguages(dir)).toEqual(['French']);
  });

  it('round-trips an empty set (clearing everything)', async () => {
    await setSpokenLanguages(dir, ['English']);
    await setSpokenLanguages(dir, []);
    expect(await getSpokenLanguages(dir)).toEqual([]);
  });
});

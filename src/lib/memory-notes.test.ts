import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMemory, setMemory } from './memory-notes';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heimdal-memory-notes-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ACCOUNT_ID = 'acc1';

describe('getMemory', () => {
  it('is empty when nothing has been written yet', async () => {
    expect(await getMemory(dir, ACCOUNT_ID)).toBe('');
  });
});

describe('setMemory / getMemory round trip', () => {
  it('returns what was written', async () => {
    await setMemory(dir, ACCOUNT_ID, '- The user dismisses most newsletters from deal sites.');
    expect(await getMemory(dir, ACCOUNT_ID)).toBe('- The user dismisses most newsletters from deal sites.');
  });

  it('overwrites the previous content on a later write', async () => {
    await setMemory(dir, ACCOUNT_ID, 'first version');
    await setMemory(dir, ACCOUNT_ID, 'second version');
    expect(await getMemory(dir, ACCOUNT_ID)).toBe('second version');
  });

  it('trims surrounding whitespace on read', async () => {
    await setMemory(dir, ACCOUNT_ID, '\n  some notes  \n\n');
    expect(await getMemory(dir, ACCOUNT_ID)).toBe('some notes');
  });
});

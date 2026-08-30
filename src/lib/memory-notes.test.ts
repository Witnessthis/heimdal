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

describe('getMemory', () => {
  it('is empty when nothing has been written yet', async () => {
    expect(await getMemory(dir)).toBe('');
  });
});

describe('setMemory / getMemory round trip', () => {
  it('returns what was written', async () => {
    await setMemory(dir, '- The user dismisses most newsletters from deal sites.');
    expect(await getMemory(dir)).toBe('- The user dismisses most newsletters from deal sites.');
  });

  it('overwrites the previous content on a later write', async () => {
    await setMemory(dir, 'first version');
    await setMemory(dir, 'second version');
    expect(await getMemory(dir)).toBe('second version');
  });

  it('trims surrounding whitespace on read', async () => {
    await setMemory(dir, '\n  some notes  \n\n');
    expect(await getMemory(dir)).toBe('some notes');
  });
});

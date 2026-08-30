import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Plain markdown, not SQLite/JSON like the other lib/ stores — this is a
// single free-text blob the model itself writes and revises (see
// src/ai/memory-update.ts) and that the user can read/edit directly (see
// src/routes/memory.ts), not structured data with anything to query.

const FILE_NAME = 'memory.md';

/** '' (never missing/undefined) when nothing has been learned yet — callers
 *  treat an empty string as "no personalization to apply", identical to
 *  behavior before this feature existed. */
export async function getMemory(dataDir: string): Promise<string> {
  try {
    return (await readFile(join(dataDir, FILE_NAME), 'utf-8')).trim();
  } catch {
    return '';
  }
}

export async function setMemory(dataDir: string, content: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, FILE_NAME), content);
}

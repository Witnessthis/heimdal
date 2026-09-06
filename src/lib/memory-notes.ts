import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountDir } from './accounts';

// Plain markdown, not SQLite/JSON like the other lib/ stores — this is a
// single free-text blob the model itself writes and revises (see
// src/ai/memory-update.ts) and that the user can read/edit directly (see
// src/routes/memory.ts), not structured data with anything to query.
// One file per account (see accountDir) — each mail account has its own
// memory, exactly the same way it has its own inbox.

const FILE_NAME = 'memory.md';

/** '' (never missing/undefined) when nothing has been learned yet — callers
 *  treat an empty string as "no personalization to apply", identical to
 *  behavior before this feature existed. */
export async function getMemory(dataDir: string, accountId: string): Promise<string> {
  try {
    return (await readFile(join(accountDir(dataDir, accountId), FILE_NAME), 'utf-8')).trim();
  } catch {
    return '';
  }
}

export async function setMemory(dataDir: string, accountId: string, content: string): Promise<void> {
  const dir = accountDir(dataDir, accountId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, FILE_NAME), content);
}

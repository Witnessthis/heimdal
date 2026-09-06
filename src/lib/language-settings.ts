import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountDir } from './accounts';

// Plain JSON, not SQLite like unsubscribe-suppressions.ts/ai-feed.ts — this
// is a single per-account value with nothing to filter or query by, the
// same shape of problem credentials.ts already solves this way. One file
// per account (see accountDir) — each mail account has its own spoken
// languages, exactly the same way it has its own inbox/memory.

interface LanguageSettings {
  // Full language names ("English", "Danish", ...), matching
  // src/ai/language.ts's LANGUAGE_NAMES — never ISO codes — so a value
  // read from here is directly comparable to detectLanguage()'s output
  // with no lookup/translation step in between.
  spokenLanguages: string[];
}

const FILE_NAME = 'language-settings.json';

/** Empty by default — classifyEmail()'s own resolveReplyLanguage falls
 *  back to English whenever userLanguages is empty, so an unconfigured
 *  install behaves exactly the same as it did before this setting
 *  existed. */
export async function getSpokenLanguages(dataDir: string, accountId: string): Promise<string[]> {
  try {
    const raw = await readFile(join(accountDir(dataDir, accountId), FILE_NAME), 'utf-8');
    return (JSON.parse(raw) as LanguageSettings).spokenLanguages;
  } catch {
    return [];
  }
}

/** Callers are responsible for validating each entry is a real language
 *  name (see LANGUAGE_NAMES) before calling this — kept a dumb setter,
 *  same division of responsibility as the rest of src/lib/: routes
 *  validate external input, storage just persists it. */
export async function setSpokenLanguages(
  dataDir: string,
  accountId: string,
  languages: string[],
): Promise<void> {
  const dir = accountDir(dataDir, accountId);
  await mkdir(dir, { recursive: true });
  const settings: LanguageSettings = { spokenLanguages: languages };
  await writeFile(join(dir, FILE_NAME), JSON.stringify(settings, null, 2));
}

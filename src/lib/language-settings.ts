import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Plain JSON, not SQLite like sender-preferences.ts/ai-feed.ts — this is a
// single global value with nothing to filter or query by, the same shape
// of problem credentials.ts already solves this way.

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
export async function getSpokenLanguages(dataDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(dataDir, FILE_NAME), 'utf-8');
    return (JSON.parse(raw) as LanguageSettings).spokenLanguages;
  } catch {
    return [];
  }
}

/** Callers are responsible for validating each entry is a real language
 *  name (see LANGUAGE_NAMES) before calling this — kept a dumb setter,
 *  same division of responsibility as the rest of src/lib/: routes
 *  validate external input, storage just persists it. */
export async function setSpokenLanguages(dataDir: string, languages: string[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const settings: LanguageSettings = { spokenLanguages: languages };
  await writeFile(join(dataDir, FILE_NAME), JSON.stringify(settings, null, 2));
}

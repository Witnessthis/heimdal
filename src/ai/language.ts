import { generateText, NoObjectGeneratedError, Output } from 'ai';
import iso6391 from 'iso-639-1';
import { z } from 'zod';
import { getModel } from './model';

// The full ISO 639-1 language name list — used both as the language
// detector's closed output vocabulary and (eventually) the settings UI's
// selection list, so a detected language and a user-configured one are
// always comparable by exact string match, never fuzzy-matched between
// differently-formatted identifiers ("English" vs "en" vs "eng").
export const LANGUAGE_NAMES: readonly string[] = iso6391.getAllNames();

const languageSchema = z.object({
  // A closed enum, not a free string — same "no true optionality, give
  // the model a fixed, checkable vocabulary" reasoning as the rest of
  // this module. "unknown" covers text too short/ambiguous to tell.
  language: z.enum([...LANGUAGE_NAMES, 'unknown'] as unknown as [string, ...string[]]),
});

const DETECT_INSTRUCTIONS =
  'Identify the language the given text is written in. Respond with exactly one language name from the allowed list. A clear, well-formed sentence in a real language should always get a definite answer, even a language you are only moderately confident about — do not reach for "unknown" just because you are not 100% certain. Only answer "unknown" if the text is genuinely too short, garbled, or ambiguous for any language to be a reasonable guess at all.';

/** A narrow, single-purpose call — deliberately not sharing the main
 *  triage schema/instructions. Isolating language ID as its own question
 *  measurably outperforms asking the model to also do this conditional
 *  check as one part of the larger triage decision — see chat history:
 *  the combined version reliably failed the "email language isn't one the
 *  user speaks, fall back to English" case even after stronger wording
 *  and a worked example. Returns null on genuine detection failure
 *  (network/non-validation errors still propagate, same as classifyEmail). */
export async function detectLanguage(text: string): Promise<string | null> {
  try {
    const result = await generateText({
      model: getModel(),
      instructions: DETECT_INSTRUCTIONS,
      prompt: text,
      output: Output.object({ schema: languageSchema }),
    });
    return result.output.language === 'unknown' ? null : result.output.language;
  } catch (err) {
    if (err instanceof NoObjectGeneratedError) return null;
    throw err;
  }
}

/** Deterministic, app-side — never asks a model to do this lookup. See
 *  chat history for why: checking membership in a dynamically-provided
 *  list is exactly the kind of multi-step conditional logic a small model
 *  handles unreliably, whereas this is a one-line Array.includes() when
 *  the app does it directly. English is always the fallback, independent
 *  of whether it happens to appear in userLanguages — it's the most
 *  broadly useful default regardless of what else the user speaks. */
export function resolveReplyLanguage(detected: string | null, userLanguages: string[]): string {
  if (detected && userLanguages.includes(detected)) return detected;
  return 'English';
}

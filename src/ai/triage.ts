import { generateText, type ModelMessage, NoObjectGeneratedError, Output } from 'ai';
import { z } from 'zod';
import { detectLanguage, resolveReplyLanguage } from './language';
import { getModel } from './model';
import type { EmailForModel } from './types';

// "capped at a couple of attempts, then fails gracefully" — README's
// "Validation and retry". 1 initial try + 2 corrective retries.
const MAX_ATTEMPTS = 3;

// Zod's z.iso.datetime() embeds a large regex `pattern` in the JSON Schema
// it generates for schema-locked structured output — confirmed by testing
// to be exactly what breaks Ollama's grammar compiler ("Failed to
// initialize samplers: failed to parse grammar") on a schema with this
// much other structure around it. A .refine() enforces the identical
// ISO-8601 check at parse time without ever appearing in the JSON Schema
// sent to the model, sidestepping the crash entirely — confirmed by
// testing too.
const isoDateTime = z
  .string()
  .refine((val) => !Number.isNaN(Date.parse(val)) && /^\d{4}-\d{2}-\d{2}T/.test(val), {
    message: 'must be an ISO 8601 date-time string',
  });

// What the model actually produces. emailId is deliberately NOT here — the
// call is always scoped to exactly one email (see buildPrompt), so the app
// already knows which email this is about and stitches emailId on after
// the call returns, rather than asking the model to echo back a fact it
// was never in a position to get right or wrong.
//
// No .optional() fields anywhere on purpose: an LLM generating JSON is
// trying to complete a shape it's been shown, one token at a time —
// omitting a key is an unnatural act for that process (it produced
// explicit `null` instead, in testing), where writing *something* is the
// path of least resistance. Every field here is always required, with an
// explicit value standing in for "no" / "none" instead of relying on
// absence to mean that. suspicious carries its reason the same way
// draftReply carries its subject/body — only present in the branch where
// it's meaningful, never a dangling optional next to a boolean.
export const modelDecisionSchema = z.object({
  // Exactly one — what happens to this email's visibility right now.
  visibility: z.discriminatedUnion('type', [
    z.object({ type: z.literal('feed') }),
    z.object({ type: z.literal('snooze'), until: isoDateTime }),
    z.object({ type: z.literal('filtered') }),
  ]),
  // True only for the rare "uncertain about an editorial newsletter"
  // case — see INSTRUCTIONS. The app checks a per-sender preference store
  // before ever reaching this field: an already-resolved sender's mail
  // never triggers a repeat ask, and a "hide" sender's mail skips the
  // model entirely, so this field only matters the first time a given
  // sender's editorial content shows up.
  checkSenderPreference: z.boolean(),
  unsubscribeCandidate: z.boolean(),
  draftReply: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('draft'), subject: z.string(), body: z.string() }),
  ]),
  suspicious: z.discriminatedUnion('type', [
    z.object({ type: z.literal('no') }),
    z.object({ type: z.literal('yes'), reason: z.string() }),
  ]),
});

export type ModelDecisionOutput = z.infer<typeof modelDecisionSchema>;

// The full record persisted to the AI feed store — model output plus the
// one fact the app already had before ever calling the model.
export interface EmailTriage extends ModelDecisionOutput {
  emailId: string;
}

// Deliberately no language-handling here at all — draftReply's language is
// entirely a Pass 2 concern (see redraftInLanguage below and the chat
// history for why): asking the model to both judge whether a reply is
// warranted AND correctly apply a "fall back to English unless the source
// language is one the user speaks" conditional, in the same call,
// reliably failed the fallback case even after stronger wording and a
// worked example. This pass only judges content; a second, narrower pass
// only judges language, and the two are never asked of the model at once.
const INSTRUCTIONS = `You are Heimdal's mail triage assistant. Heimdal's whole purpose is to cut down on notification noise — most incoming mail should NOT interrupt the user.

You are never told who the user's contacts are, and you don't need to be — judge every email on its own intrinsic qualities: how it's written, who it's addressed to, and what it asks for. A short, informal, directly-addressed question from an unfamiliar name deserves exactly the same read as one from someone the user knows well.

Signals that an email is personal and expects a reply:
- Directly addresses "you" with a specific question or request.
- Informal, conversational register (short sentences, casual phrasing).
- Asks something only the recipient can answer (availability, an opinion, a decision).
- Comes from an individual human name, not a company/team/no-reply address.

Signals that an email does NOT expect a reply, however it's addressed:
- Mass-mailing markers: "unsubscribe" footers, "Dear customer," marketing language, promotional offers.
- Purely informational: receipts, shipping updates, automated notifications, newsletters.
- Sent from a no-reply/notifications/support-style address.

For the single email described below, decide:

1. visibility — exactly one:
   - "feed": worth the user's attention now; show it to them. When genuinely unsure whether an email belongs here, prefer "feed" — missing something real is worse than one extra card the user dismisses in a second. Security alerts, payment failures, and account-access notices are ALWAYS "feed", even from automated/no-reply senders — these are exactly the kind of "automated" mail that isn't actually noise. Being CC'd on a substantive work thread, even with no direct question to the user, is also "feed".
   - "snooze": not actionable right now but will be later (e.g. a reminder tied to a future date); include the ISO 8601 date/time to resurface it.
   - "filtered": not important; don't show it at all. This is the default for promotional/marketing content (see unsubscribeCandidate below) and for routine automated mail with nothing notable in it — receipts, shipping updates, ordinary newsletters.

2. checkSenderPreference — true ONLY when this is an editorial/informational newsletter (genuinely not promotional — see unsubscribeCandidate below) and you are truly uncertain whether the user wants to keep seeing mail like this long-term. This should be rare: false for almost every email, including ones that are clearly feed-worthy or clearly filtered for other reasons.

3. unsubscribeCandidate — true if this email's content is promotional/marketing in character: sales language, discount codes, "shop now" calls to action. Judge this from the actual content, not the format or how the email arrived — a newsletter that isn't sales-driven doesn't automatically count, but any real promotional content does, even from a source the user has generally chosen to hear from. An email that's mainly transactional (a receipt, a confirmation) with a small promotional section tacked on the bottom is NOT a candidate — judge the email's primary purpose, not every section of it. When genuinely unsure, lean toward flagging it.

4. draftReply — exactly one: {"type":"none"} unless this email genuinely expects a personal response (see the signals above), in which case {"type":"draft","subject":...,"body":...}. When genuinely unsure whether a reply is warranted at all, draft one anyway — an unused draft costs nothing, but a missing one might be needed. For the draft itself:
   - Keep it short and minimal.
   - Match the tone/formality of the original email — casual in, casual out; formal in, formal out.
   - Mirror whether the original included a greeting and sign-off — except if the email reads as a formal inquiry, always include a brief greeting and sign-off regardless of what the original did.
   - If the answer is obvious from context, commit to it directly (e.g. "Yes, Thursday works for me") rather than hedging — the user reviews and edits before anything sends, so a direct answer saves more effort than a noncommittal placeholder.
   - Never draft a reply to no-reply/automated senders or content that isn't actually addressed to the user personally.

5. suspicious — exactly one: {"type":"no"} unless this email shows signs of phishing or a scam, in which case {"type":"yes","reason":"..."} with a short explanation. Look for:
   - Body content: urgency/pressure tactics, requests for credentials or payment, suspicious or mismatched links.
   - The sender's display name versus their actual address: a display name claiming to be a known service or company (e.g. "PayPal Support", "Bank Security Team") should roughly match the real domain — a clear mismatch is a strong signal on its own.
   - Lookalike/typosquatted domains: character substitutions and near-misses of real domains (e.g. "arnaz0n.com", "paypa1-secure.com"), or unnecessary extra subdomains designed to look legitimate. Look character-by-character rather than just whether a familiar brand name appears somewhere in the string.
   This is a caution flag only — you are never asked to take any action based on it, and it does NOT change how you judge visibility, checkSenderPreference, unsubscribeCandidate, or draftReply; classify those exactly as you otherwise would regardless of this field. When genuinely unsure whether something looks suspicious, lean toward flagging it — a false alarm here costs nothing since it's just a banner, not an action.

Examples:

Email: From "Sam Rivera" <sam.rivera@gmail.com>, Subject "quick question" — "Hey, are you around for a call tomorrow afternoon? Let me know what time works."
Correct output: {"visibility":{"type":"feed"},"checkSenderPreference":false,"unsubscribeCandidate":false,"draftReply":{"type":"draft","subject":"Re: quick question","body":"Hi Sam, tomorrow afternoon works for me — how does 2pm sound? Let me know if that works for you."},"suspicious":{"type":"no"}}

Email: From "GreatDeals Weekly" <newsletter@greatdeals.example>, Subject "50% OFF everything this weekend!" — "Huge savings across the whole store, this weekend only! Shop now. Unsubscribe anytime."
Correct output: {"visibility":{"type":"filtered"},"checkSenderPreference":false,"unsubscribeCandidate":true,"draftReply":{"type":"none"},"suspicious":{"type":"no"}}

Email: From "PayPal Support" <security@paypa1-verify.com>, Subject "Your account has been limited" — "We noticed unusual activity. Verify your identity immediately or your account will be suspended within 24 hours. Click here to confirm your password."
Correct output: {"visibility":{"type":"feed"},"checkSenderPreference":false,"unsubscribeCandidate":false,"draftReply":{"type":"none"},"suspicious":{"type":"yes","reason":"Display name claims PayPal but the domain (paypa1-verify.com) is a lookalike, not paypal.com; urgent threat language and a request to verify a password are classic phishing patterns."}}

Base every judgment only on the email content given below. Do not invent facts not present in the email.`;

function buildPrompt(email: EmailForModel): string {
  const from = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address;
  const lines = [
    `From: ${from}`,
    `Subject: ${email.subject}`,
    `Received: ${email.receivedAt}`,
    email.threadSummary ? `Prior thread context: ${email.threadSummary}` : undefined,
    '',
    email.body ?? email.snippet,
  ];
  return lines.filter((line) => line !== undefined).join('\n');
}

const translationSchema = z.object({ subject: z.string(), body: z.string() });

function buildTranslateInstructions(fromLanguage: string, toLanguage: string): string {
  return `Translate the given email reply from ${fromLanguage} to ${toLanguage}. Preserve the tone and meaning exactly — this is a translation, not a rewrite. Respond with only the translated subject and body.`;
}

/** Pass 2 of the two-pass language fix (see chat history) — and the
 *  second version of it. The first version asked the model to draft
 *  fresh directly in a target language ("write in English, regardless of
 *  what language the email is in") and that failed most of the time
 *  (measured: 1 of 6) even as a flat, unconditional instruction — there's
 *  a strong pull toward matching the input language that persists past
 *  simple directives. Explicit translation of the already-good first-pass
 *  draft is a fundamentally different, much more heavily-trained task and
 *  measured reliably (4 of 4). Returns null on repeated schema failure or
 *  a real error; classifyEmail falls back to the original draft. */
async function translateDraft(
  draft: { subject: string; body: string },
  fromLanguage: string,
  toLanguage: string,
): Promise<{ subject: string; body: string } | null> {
  const instructions = buildTranslateInstructions(fromLanguage, toLanguage);
  const messages: ModelMessage[] = [{ role: 'user', content: `Subject: ${draft.subject}\n\n${draft.body}` }];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await generateText({
        model: getModel(),
        instructions,
        messages,
        output: Output.object({ schema: translationSchema }),
      });
      return result.output;
    } catch (err) {
      if (!(err instanceof NoObjectGeneratedError)) throw err;
      if (attempt === MAX_ATTEMPTS) return null;
      messages.push(
        { role: 'assistant', content: err.text ?? '' },
        { role: 'user', content: `That didn't match the required format: ${err.message}. Try again.` },
      );
    }
  }
  return null;
}

export interface ClassifyEmailOptions {
  /** The user's own spoken languages, for the translateDraft pass.
   *  Defaults to English — see resolveReplyLanguage. */
  userLanguages?: string[];
}

/** Classifies one email. Returns null if the model couldn't be coaxed into
 *  a schema-valid response within MAX_ATTEMPTS — per README's "Validation
 *  and retry", this is expected given small/local model sizes, not
 *  exceptional: the email just gets no automated decision this round
 *  rather than crashing whatever triggered the call. A non-validation
 *  error (network, Ollama unreachable, ...) is a different failure mode
 *  and propagates instead of being swallowed the same way. */
export async function classifyEmail(
  email: EmailForModel,
  options: ClassifyEmailOptions = {},
): Promise<EmailTriage | null> {
  const messages: ModelMessage[] = [{ role: 'user', content: buildPrompt(email) }];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await generateText({
        model: getModel(),
        instructions: INSTRUCTIONS,
        messages,
        output: Output.object({ schema: modelDecisionSchema }),
      });
      const triage: EmailTriage = { ...result.output, emailId: email.id };

      // Two-pass language correction — only when a reply was actually
      // drafted, so most emails (which don't need one at all) never pay
      // for either extra pass. The first-pass draft reliably matches the
      // email's own source language on its own (that part was never the
      // problem); this only translates it when the source language isn't
      // one the user actually speaks. Skips both extra calls entirely
      // when the source language is already fine. A failure here falls
      // back to keeping the original (untranslated) draft rather than
      // losing the "this needs a reply" judgment over a wording refinement.
      if (triage.draftReply.type === 'draft') {
        try {
          const detected = await detectLanguage(`${email.subject}\n\n${email.body ?? email.snippet}`);
          const targetLanguage = resolveReplyLanguage(detected, options.userLanguages ?? []);
          if (detected && detected !== targetLanguage) {
            const translated = await translateDraft(triage.draftReply, detected, targetLanguage);
            if (translated) {
              triage.draftReply = { type: 'draft', ...translated };
            }
          }
        } catch {
          // Keep the original draft — see comment above.
        }
      }

      return triage;
    } catch (err) {
      if (!(err instanceof NoObjectGeneratedError)) throw err;
      if (attempt === MAX_ATTEMPTS) return null;
      messages.push(
        { role: 'assistant', content: err.text ?? '' },
        { role: 'user', content: `That didn't match the required format: ${err.message}. Try again.` },
      );
    }
  }
  return null;
}

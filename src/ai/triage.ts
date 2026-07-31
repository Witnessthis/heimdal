import { generateText, type ModelMessage, NoObjectGeneratedError, Output } from 'ai';
import { z } from 'zod';
import { detectLanguage, resolveReplyLanguage } from './language';
import { getModel } from './model';
import { type EmailTriage, modelDecisionSchema } from './triage-schema';
import type { EmailForModel } from './types';

export type { EmailTriage, ModelDecisionOutput } from './triage-schema';
export { modelDecisionSchema } from './triage-schema';

// "capped at a couple of attempts, then fails gracefully" — README's
// "Validation and retry". 1 initial try + 2 corrective retries.
const MAX_ATTEMPTS = 3;

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
- Asks the recipient a direct question and expects an answer — this is NOT limited to things only the recipient could know (availability, an opinion, a decision); a plain factual/definitional question ("What does X mean?", "How do I do Y?") sent straight to the user counts just as much. The test is whether a real person asked a real question expecting a real reply, not whether the subject matter happens to be personal.
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

4. draftReply — exactly one: {"type":"none"} unless this email genuinely expects a reply from the user (see the signals above), in which case {"type":"draft","subject":...,"body":...}. This isn't limited to personal/subjective asks — a direct factual or definitional question sent straight to the user deserves an attempted answer just as much as a scheduling question does. When genuinely unsure whether a reply is warranted at all, draft one anyway — an unused draft costs nothing, but a missing one might be needed. For the draft itself:
   - Keep it short and minimal.
   - Match the tone/formality of the original email — casual in, casual out; formal in, formal out.
   - Mirror whether the original included a greeting and sign-off — except if the email reads as a formal inquiry, always include a brief greeting and sign-off regardless of what the original did.
   - Always attempt a real, substantive answer to whatever the email is actually asking. Never draft a reply that is itself just another question bouncing the ask back to the sender unanswered — that isn't a draft, it's a restatement of the problem. If the answer is obvious from context, commit to it directly (e.g. "Yes, Thursday works for me"). If it isn't — you don't actually know the user's real availability, opinion, or decision — still commit to a concrete, reasonable best guess rather than deflecting: propose a specific time instead of asking "what time works for you?"; give a plausible stance instead of asking "what do you think?". The user reviews and edits before anything sends, so a concrete starting point (even a wrong one) saves more effort than a reply that only asks the question back.
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

Email: From "Maria Chen" <maria.chen@example.com>, Subject "thoughts on the proposal?" — "Hey, did you get a chance to look at the proposal I sent over? Curious what you think, especially about the timeline."
Wrong draftReply (do NOT do this — it just asks the question back instead of answering it): {"type":"draft","subject":"Re: thoughts on the proposal?","body":"Hi Maria, thanks for sending that over — what specifically did you want my thoughts on, the timeline or something else?"}
Correct draftReply (commits to a real stance, even without full context): {"type":"draft","subject":"Re: thoughts on the proposal?","body":"Hi Maria, yes, took a look — overall it seems solid. The timeline feels a little tight, but workable. Happy to discuss further if useful."}

Email: From "Jonas Berg" <jonas.berg@example.com>, Subject "Word meaning" — "What does empathy mean?"
Wrong draftReply (do NOT do this — this is a real, direct question sent to the user; "none" treats it as if it weren't): {"type":"none"}
Correct draftReply: {"type":"draft","subject":"Re: Word meaning","body":"Hi Jonas, empathy means being able to understand and share what someone else is feeling — putting yourself in their shoes, not just recognizing it intellectually but sensing it with them."}

Base every classification judgment — visibility, checkSenderPreference, unsubscribeCandidate, suspicious — only on the email content given below; do not invent facts about the sender or situation that aren't present. This does NOT apply to draftReply: answering a genuine question is expected to draw on your own general knowledge (definitions, facts, how-to explanations, anything else you actually know), not just what's written in the email itself. Refusing to answer a real question because the answer "isn't in the email" defeats the whole point of drafting a reply.`;

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

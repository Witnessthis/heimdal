import { generateText } from 'ai';
import { getMemory, setMemory } from '../lib/memory-notes';
import type { EmailMessage } from '../mail/types';
import { extractPlainBody } from './email-for-model';
import { getModel } from './model';
import type { EmailTriage } from './triage-schema';

// Long enough for the memory-update model to spot a real distinguishing
// feature (a phrase, a sender detail, a fake-urgency line) without paying
// for (or risking distraction from) a full message body — see chat history:
// without any content at all, a dissenting action on an otherwise-uniform
// category (e.g. the 10th "package shipped" email out of ten) gave the
// model nothing to reason about except "this one was different," with no
// way to say *how*, which is what pushed it toward flattening an
// established pattern into its opposite instead of noting an exception.
const EXCERPT_LENGTH = 300;

/** Turns one Feed-card action into a short, human-readable observation —
 *  what the AI had decided about this email, what it actually said, and
 *  what the user did about it. Pure string building, no model call — see
 *  scheduleMemoryUpdate for where this feeds into one. Kept separate so
 *  it's unit-testable with no mocking at all, the way most formatting
 *  helpers in this codebase are.
 *
 *  Only needs `from`/`subject`/`body` — accepting just that (rather than
 *  the full EmailMessage) keeps tests from having to construct a whole
 *  message just to describe one action. Reuses email-for-model.ts's own
 *  plain-text extraction rather than re-deriving it, and truncates to
 *  EXCERPT_LENGTH — this is one line in a prompt, not the email reader. */
export function buildMemoryEvent(
  message: Pick<EmailMessage, 'from' | 'subject' | 'body'>,
  triage: EmailTriage,
  actionSummary: string,
): string {
  const from = message.from.name ? `${message.from.name} <${message.from.address}>` : message.from.address;
  const plainBody = extractPlainBody(message.body)?.trim();
  const excerpt = plainBody
    ? plainBody.length > EXCERPT_LENGTH
      ? `${plainBody.slice(0, EXCERPT_LENGTH)}…`
      : plainBody
    : undefined;
  return [
    `Email from ${from}, subject "${message.subject || '(no subject)'}".`,
    excerpt ? `Excerpt: ${excerpt}` : undefined,
    `AI's own read: visibility=${triage.visibility.type}, suspicious=${triage.suspicious.type}, draftReply=${triage.draftReply.type}.`,
    `User action: ${actionSummary}.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

const INSTRUCTIONS = `You maintain a persistent memory file that personalizes Heimdal's mail triage to one specific user, based on real actions they take on cards in their Feed over time — not on the day-zero instructions every user starts from.

You will be given the current memory file (it may be empty, meaning nothing has been learned yet) and one new observation: an email the AI already classified, and what the user actually did about it (confirmed / dismissed, and how).

The file holds a growing set of CATEGORY-level classifications, not a log of individual emails. Each bullet names a kind of mail — invent categories freely, split an existing one into more specific ones, or broaden one, whatever best captures a real recurring pattern (e.g. "package delivery notifications from known carriers", "invoices from recurring vendors") — plus the user's actual preference toward it.

The existing file is the source of truth, not the newest observation — you are layering one more data point onto everything already learned, not rewriting the file around it. For every response:
- If this observation reinforces or refines a category that's already recorded, sharpen or expand THAT bullet in place (tighten its scope, resolve an edge case, add a genuine distinguishing detail) and leave every other, unrelated bullet exactly as it already reads.
- If it clearly doesn't fit any existing category, add a new bullet — but only once a pattern is actually emerging; a single isolated action rarely justifies one on its own (the explicit-correction case below is the exception).
- Never drop, collapse, or silently rewrite an existing bullet unless this specific observation directly contradicts it. Being about an unrelated topic is not a contradiction — categories accumulate; the file is additive by default, and something true a week ago doesn't stop being true just because today's observation is about something else.

Never write a bullet about one specific message — not its exact sender, its subject line, or "an email about X was dismissed." Fold whatever generalizes from it into the relevant category and discard the rest. A specific sender or concrete detail belongs in a bullet only when it's a genuine defining feature of the category itself (e.g. "...from known carriers" vs. "...from unfamiliar senders" is the actual distinction the category is about) — never simply because it happened to be the most recent example processed.

Write in short plain-prose bullet points. A file that grows somewhat as real understanding accumulates is fine and expected — don't compress, shorten, or drop existing bullets just to save space. Only merge two bullets when they've genuinely become redundant or one has been folded into a broader one; never merge or trim purely to keep a length target. If the user has written their own note directly into this file, preserve it as-is unless a clear pattern of their own actions now contradicts it.

An observation that describes the user explicitly overriding a specific AI verdict, or explicitly stating a category preference (as opposed to a routine confirm/dismiss), is a much stronger signal than routine card actions — note it even from this single occurrence rather than waiting to see it repeated.

When a new observation contradicts a pattern already recorded in the memory file, use the excerpt you're given to look for what's actually different about this specific email — its sender, its wording, something in its content — compared to the emails that established that pattern. If something real distinguishes it, write a sharper, more specific note capturing that distinction instead of replacing the general one (e.g. a pattern about "package delivery notifications" plus one dissenting instance that turns out to be from an unfamiliar sender becomes a note about delivery notifications *from known carriers*, not a flip to hiding all of them). If nothing in the content actually explains the disagreement, record it as a rare exception alongside the existing pattern instead of overturning it — a single unexplained outlier should never flip an established preference into its opposite.

Respond with ONLY the full updated file content, nothing else — no preamble, no explanation, no markdown code fence.`;

// Serializes concurrent calls against the same file — two Feed actions taken
// in quick succession must not both read the same "before" content and then
// race to write, silently dropping one of them. Keyed per account: two
// different accounts' memory files are independent and their updates must
// not wait on each other, but two updates to the *same* account's file
// still need to queue behind one another.
const queues = new Map<string, Promise<void>>();

async function doUpdate(dataDir: string, accountId: string, eventDescription: string): Promise<void> {
  const current = await getMemory(dataDir, accountId);
  const result = await generateText({
    model: getModel(),
    instructions: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: `Current memory file (may be empty):\n"""\n${current}\n"""\n\nNew observation:\n${eventDescription}`,
      },
    ],
  });
  await setMemory(dataDir, accountId, result.text.trim());
}

/** Fire-and-forget from the caller's perspective (see src/routes/ai-feed.ts)
 *  — a failure here (model unreachable, bad output, ...) must never affect
 *  the confirm/dismiss request it was triggered by. Not unit-tested
 *  directly, same as classifyEmail itself: this is only ever mocked at the
 *  call site in tests, never exercised against a real model. */
export function scheduleMemoryUpdate(
  dataDir: string,
  accountId: string,
  eventDescription: string,
): Promise<void> {
  const queue = queues.get(accountId) ?? Promise.resolve();
  const run = queue.then(() => doUpdate(dataDir, accountId, eventDescription));
  // Swallow here too (not just at the caller) so one failed update doesn't
  // permanently wedge this account's queue for every update after it.
  queues.set(
    accountId,
    run.catch(() => {}),
  );
  return run;
}

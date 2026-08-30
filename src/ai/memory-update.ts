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

const INSTRUCTIONS = `You maintain a short memory file that personalizes Heimdal's mail triage to one specific user, based on real actions they take on cards in their Feed over time — not on the day-zero instructions every user starts from.

You will be given the current memory file (it may be empty, meaning nothing has been learned yet) and one new observation: an email the AI already classified, and what the user actually did about it (confirmed / dismissed, and how).

Update the memory file to fold in anything genuinely useful this observation reveals about the user's real preferences — a category of mail they consistently dismiss despite the AI showing it, a sender or kind of content they always act on, a pattern in what they actually reply to. A single observation is rarely enough to justify a new note on its own — only add or strengthen a note when this observation fits a pattern rather than describing an isolated one-off, and prefer merging into an existing related note over adding a new one.

Write in short plain-prose bullet points, not raw logs of individual emails. Keep the whole file concise — well under 500 words — trimming or merging older notes if it's getting long. If the user has written their own note directly into this file, preserve it as-is unless a clear pattern of their own actions now contradicts it.

An observation that describes the user explicitly overriding a specific AI verdict, or explicitly stating a category preference (as opposed to a routine confirm/dismiss), is a much stronger signal than routine card actions — note it even from this single occurrence rather than waiting to see it repeated.

When a new observation contradicts a pattern already recorded in the memory file, use the excerpt you're given to look for what's actually different about this specific email — its sender, its wording, something in its content — compared to the emails that established that pattern. If something real distinguishes it, write a sharper, more specific note capturing that distinction instead of replacing the general one (e.g. a pattern about "package delivery notifications" plus one dissenting instance that turns out to be from an unfamiliar sender becomes a note about delivery notifications *from known carriers*, not a flip to hiding all of them). If nothing in the content actually explains the disagreement, record it as a rare exception alongside the existing pattern instead of overturning it — a single unexplained outlier should never flip an established preference into its opposite.

Respond with ONLY the full updated file content, nothing else — no preamble, no explanation, no markdown code fence.`;

// Serializes concurrent calls against the same file — two Feed actions taken
// in quick succession must not both read the same "before" content and then
// race to write, silently dropping one of them.
let queue: Promise<void> = Promise.resolve();

async function doUpdate(dataDir: string, eventDescription: string): Promise<void> {
  const current = await getMemory(dataDir);
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
  await setMemory(dataDir, result.text.trim());
}

/** Fire-and-forget from the caller's perspective (see src/routes/ai-feed.ts)
 *  — a failure here (model unreachable, bad output, ...) must never affect
 *  the confirm/dismiss request it was triggered by. Not unit-tested
 *  directly, same as classifyEmail itself: this is only ever mocked at the
 *  call site in tests, never exercised against a real model. */
export function scheduleMemoryUpdate(dataDir: string, eventDescription: string): Promise<void> {
  const run = queue.then(() => doUpdate(dataDir, eventDescription));
  // Swallow here too (not just at the caller) so one failed update doesn't
  // permanently wedge the queue for every update after it.
  queue = run.catch(() => {});
  return run;
}

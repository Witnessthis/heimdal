import { upsertFeedItem } from '../lib/ai-feed';
import { getSpokenLanguages } from '../lib/language-settings';
import { getMemory } from '../lib/memory-notes';
import { splitQualifiedId } from '../mail/account-id';
import { mailService } from '../mail/registry';
import { buildEmailForModel } from './email-for-model';
import { buildMemoryEvent, scheduleMemoryUpdate } from './memory-update';
import { classifyEmail, type EmailTriage } from './triage';

/** A user-triggered re-run of one specific email through classification —
 *  deliberately a separate function from handleNewMessage in
 *  auto-classify.ts, not a shared refactor: the two differ in exactly the
 *  ways that matter (suppression handling, forced visibility, notification,
 *  memory framing), and forcing them through one parameterized helper would
 *  obscure that rather than clarify it.
 *
 *  Always forces the result into the Feed regardless of what the model
 *  decides — the whole point (see chat history: the swipe-right "Reprocess"
 *  action on an inbox card) is giving the user a way to see a normally-
 *  hidden category of mail at all, and to correct the pattern once they do,
 *  via the personalized-memory feedback loop. */
export async function reprocessMessage(dataDir: string, messageId: string): Promise<void> {
  const { accountId } = splitQualifiedId(messageId);
  const message = await mailService.getMessage(messageId);

  // Deliberately does NOT check isSuppressed — this is a direct, targeted
  // request about one specific email, not the automatic pipeline
  // isSuppressed exists to quiet. It doesn't touch the suppression record
  // either: this email gets shown; the sender's suppression status is
  // untouched.
  const userLanguages = await getSpokenLanguages(dataDir, accountId);
  const memory = await getMemory(dataDir, accountId);
  const result = await classifyEmail(buildEmailForModel(message), { userLanguages, memory });

  // Preserve what the model actually decided (for the memory note below)
  // before forcing visibility — same fallback shape as handleNewMessage's
  // own null-classification case in auto-classify.ts.
  const originalVisibility = result?.visibility.type ?? null;
  const triage: EmailTriage = result
    ? { ...result, visibility: { type: 'feed' } }
    : {
        emailId: message.id,
        accountId,
        visibility: { type: 'feed' },
        draftReply: { type: 'none' },
        suspicious: { type: 'no' },
      };

  await upsertFeedItem(dataDir, triage);

  // No push notification here, unlike handleNewMessage — the user is
  // already looking at this email right now; a notification about their
  // own action would just be noise.

  const actionSummary =
    originalVisibility === 'feed'
      ? 'the user explicitly marked this for reprocessing even though the AI already had it visible — reinforcing that this kind of email belongs in the Feed'
      : `the user explicitly marked this for reprocessing and forced it into the Feed, overriding the AI's own verdict (visibility=${originalVisibility ?? 'no valid classification produced'}) — this is a deliberate, single-instance correction, not a passive action`;
  await scheduleMemoryUpdate(dataDir, accountId, buildMemoryEvent(message, triage, actionSummary));
}

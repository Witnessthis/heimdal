import { getFeedItems, upsertFeedItem } from '../lib/ai-feed';
import { getSpokenLanguages } from '../lib/language-settings';
import { sendFeedNotification } from '../lib/send-push';
import { isSuppressed } from '../lib/unsubscribe-suppressions';
import type { MailEvent } from '../mail/provider';
import { mailService } from '../mail/registry';
import { buildEmailForModel } from './email-for-model';
import { classifyEmail, type EmailTriage } from './triage';

/** Wires classifyEmail() into live mail arrival. Subscribes to
 *  mailService's newMessage events and, for each one, runs the full AI
 *  feed pipeline: suppression gate -> classify -> persist. Call once
 *  at startup (see server.ts, alongside mailService.init()) — the listener
 *  is registered on the mailService singleton itself, not on whatever
 *  provider happens to be connected at the time, so it survives a later
 *  provider-setup/reconfigure without needing to be re-registered. Returns
 *  an unsubscribe function mirroring mailService.onEvent's own contract. */
export function startAutoClassification(dataDir: string): () => void {
  return mailService.onEvent((event) => {
    if (event.type !== 'newMessage') return;
    void handleNewMessage(dataDir, event).catch((err) => {
      console.error(`Auto-classification failed for ${event.messageId}:`, err);
    });
  });
}

async function handleNewMessage(
  dataDir: string,
  event: Extract<MailEvent, { type: 'newMessage' }>,
): Promise<void> {
  // No lighter-weight single-message fetch exists on MailProvider, so the
  // suppression gate below runs after a full fetch rather than before it —
  // one extra message body over the wire per suppressed sender, never a
  // batch, so not worth a new provider method for.
  const message = await mailService.getProvider().getMessage(event.messageId);

  // A sender the user has unsubscribed from or suppressed never reaches
  // the model at all — see chat history: "if I have chosen to suppress an
  // email, I don't want it to be processed by the AI ever again either."
  // A full block, not just "don't force it into the feed."
  if (await isSuppressed(dataDir, message.from.address)) return;

  // Deterministic, no model involved (see list-unsubscribe.ts) — a real
  // working unsubscribe mechanism is, on its own, enough to earn a feed
  // slot regardless of what the AI below makes of the content (this
  // sender is confirmed not suppressed, or the check above would already
  // have returned). The AI still runs regardless (see chat history: it
  // should still evaluate everything else — draft reply, phishing, etc.)
  // — this only ever widens visibility, never narrows what the AI would
  // have shown anyway.
  const unsubscribeEligible = message.unsubscribe.type !== 'none';

  const userLanguages = await getSpokenLanguages(dataDir);
  let triage = await classifyEmail(buildEmailForModel(message), { userLanguages });
  if (!triage) {
    // The model couldn't be coaxed into a valid response within the retry
    // budget — per classifyEmail's own doc comment, expected occasionally
    // with small/local models, not exceptional. Normally this message
    // just gets no automated decision this round — but an unsubscribe-
    // eligible email still deserves its feed slot even without a usable
    // AI read, so it gets a minimal stand-in triage instead of bailing.
    if (!unsubscribeEligible) {
      console.log(`Classification produced no valid response for ${event.messageId}`);
      return;
    }
    triage = {
      emailId: message.id,
      visibility: { type: 'feed' },
      draftReply: { type: 'none' },
      suspicious: { type: 'no' },
    } satisfies EmailTriage;
  } else if (unsubscribeEligible && triage.visibility.type !== 'feed') {
    triage = { ...triage, visibility: { type: 'feed' } };
  }
  // A "filtered" result and a failed classification above look identical
  // from the outside otherwise — nothing in the AI feed, no error logged
  // — which made a genuine "the event pipeline never ran" bug
  // indistinguishable from "it ran and correctly decided this one wasn't
  // worth showing." This closes that gap for good, not just for one
  // debugging session.
  console.log(
    `Classified ${event.messageId}: visibility=${triage.visibility.type}, draftReply=${triage.draftReply.type}`,
  );

  // upsertFeedItem is itself a no-op for a "filtered" result, so there's
  // no need to branch on visibility here too.
  await upsertFeedItem(dataDir, triage);

  // Only "feed" — matches what's already showing up as a card right
  // now. A "snooze" item isn't visible yet (see getFeedItems in
  // lib/ai-feed.ts), so notifying for it here would be telling the user
  // about something they can't actually see or act on; there's no
  // resurface-time notification mechanism, that's a separate feature.
  if (triage.visibility.type === 'feed') {
    // getFeedItems already reflects this item (upsertFeedItem above has
    // run) plus any snoozed items whose resurface time has passed — the
    // same count the AI Feed view itself would show right now.
    const count = (await getFeedItems(dataDir)).length;
    await sendFeedNotification(dataDir, {
      title: message.subject || '(no subject)',
      body: message.snippet,
      emailId: triage.emailId,
      count,
    });
  }
}

import { getFeedItems, upsertFeedItem } from '../lib/ai-feed';
import { getSpokenLanguages } from '../lib/language-settings';
import { sendFeedNotification } from '../lib/send-push';
import { getSenderPreference, markSenderPending } from '../lib/sender-preferences';
import type { MailEvent } from '../mail/provider';
import { mailService } from '../mail/registry';
import { buildEmailForModel } from './email-for-model';
import { classifyEmail } from './triage';

/** Wires classifyEmail() into live mail arrival. Subscribes to
 *  mailService's newMessage events and, for each one, runs the full AI
 *  feed pipeline: sender-preference gate -> classify -> persist. Call once
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
  // sender-preference gate below runs after a full fetch rather than
  // before it — one extra message body over the wire per hidden sender,
  // never a batch, so not worth a new provider method for.
  const message = await mailService.getProvider().getMessage(event.messageId);

  // A sender the user has already said to hide never reaches the model at
  // all — see chat history: "Do we want the LLM to process an email where
  // the user has marked that sender as hide?" -> no.
  const preference = await getSenderPreference(dataDir, message.from.address);
  if (preference === 'hide') return;

  const userLanguages = await getSpokenLanguages(dataDir);
  const triage = await classifyEmail(buildEmailForModel(message), { userLanguages });
  // The model couldn't be coaxed into a valid response within the retry
  // budget — per classifyEmail's own doc comment, expected occasionally
  // with small/local models, not exceptional. This message just gets no
  // automated decision this round.
  if (!triage) {
    console.log(`Classification produced no valid response for ${event.messageId}`);
    return;
  }
  // A "filtered" result and a failed classification above look identical
  // from the outside otherwise — nothing in the AI feed, no error logged
  // — which made a genuine "the event pipeline never ran" bug
  // indistinguishable from "it ran and correctly decided this one wasn't
  // worth showing." This closes that gap for good, not just for one
  // debugging session.
  console.log(
    `Classified ${event.messageId}: visibility=${triage.visibility.type}, checkSenderPreference=${triage.checkSenderPreference}, draftReply=${triage.draftReply.type}`,
  );

  // markSenderPending is a no-op once this sender has any state at all
  // (pending, show, or hide) — see its own doc comment — so it's always
  // safe to call here without checking `preference` again first.
  if (triage.checkSenderPreference) {
    await markSenderPending(dataDir, message.from.address);
  }

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

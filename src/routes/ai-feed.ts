import type { FastifyPluginAsync } from 'fastify';
import { buildMemoryEvent, scheduleMemoryUpdate } from '../ai/memory-update';
import type { EmailTriage } from '../ai/triage';
import { listAccounts } from '../lib/accounts';
import { getFeedItems, removeFeedItem } from '../lib/ai-feed';
import { requireAuth } from '../lib/require-auth';
import { isSuppressed, recordSuppression } from '../lib/unsubscribe-suppressions';
import { splitQualifiedId } from '../mail/account-id';
import { performOneClickUnsubscribe } from '../mail/perform-unsubscribe';
import { mailService } from '../mail/registry';
import type { EmailMessage } from '../mail/types';
import type { AiFeedListItem, ConfirmBody, DismissBody } from './ai-feed-types';

interface Options {
  dataDir: string;
}

/** Joins the stored triage decisions with each message's real current
 *  data — a plain function (see executeConfirm's own doc comment for why)
 *  rather than inlined in the route handler. Drops (and cleans up) any
 *  row whose message no longer exists rather than surfacing a card for
 *  content that's gone.
 *
 *  Uses getMessageSummaries (one batched fetch for every pending id)
 *  rather than looping getMessage() once per item — the latter used to
 *  make this route's load time scale linearly with how many items were
 *  pending (each one a full message fetch *and* its own fresh IMAP
 *  connection), which is exactly the kind of thing "AI feed item counts
 *  are small by design" doesn't hold up against once more than a couple
 *  of items are actually pending at once (see chat history: real
 *  response times up to 40-60s were measured). Summary data means no
 *  snippet on the card face any more — same tradeoff the inbox list
 *  already made (see ImapProvider.toSummary) — but expanding a card is
 *  unaffected, since that already goes through its own on-demand
 *  getMessage() fetch regardless. */
export async function buildFeedList(dataDir: string): Promise<AiFeedListItem[]> {
  const triageItems = await getFeedItems(dataDir);
  if (triageItems.length === 0) return [];

  const summaries = await mailService.getMessageSummaries(triageItems.map((t) => t.emailId));
  // Looked up once per list build (not per item) and joined in below — see
  // AiFeedListItem's own doc comment for why accountColor/accountLabel are
  // baked in here rather than left for the frontend to fetch/join itself.
  const accounts = new Map((await listAccounts(dataDir)).map((a) => [a.id, a]));

  const items: AiFeedListItem[] = [];
  for (const triage of triageItems) {
    const message = summaries.get(triage.emailId);
    if (!message) {
      // The message is gone (deleted/moved) since it was classified —
      // drop the stale feed row rather than showing a card for content
      // that no longer exists.
      await removeFeedItem(dataDir, triage.emailId);
      continue;
    }
    const account = accounts.get(triage.accountId);
    items.push({
      triage,
      from: message.from,
      subject: message.subject,
      receivedAt: message.receivedAt,
      isRead: message.isRead,
      messageId: message.messageId,
      threadId: message.threadId,
      unsubscribe: message.unsubscribe,
      unsubscribeEligible:
        message.unsubscribe.type !== 'none' &&
        !(await isSuppressed(dataDir, triage.accountId, message.from.address)),
      accountColor: account?.color ?? '#888888',
      accountLabel: account?.label ?? 'Unknown account',
    });
  }
  return items;
}

/** Executes whatever was staged for one AI feed card, against the
 *  message's real data — never trusts the client about which unsubscribe
 *  mechanism applies (same principle as the existing
 *  /messages/:id/unsubscribe route), only ever acting on what the message
 *  actually supports. A plain function rather than inlined in the route
 *  handler so it's unit-testable with mocked dependencies, the same way
 *  src/ai/auto-classify.ts is. */
export async function executeConfirm(
  dataDir: string,
  message: EmailMessage,
  staged: ConfirmBody,
): Promise<void> {
  // message.id is already account-qualified (see mail/registry.ts) — the
  // account to send through is always the one that received the email
  // being acted on, never ambiguous.
  const { accountId } = splitQualifiedId(message.id);

  if (staged.draftReply) {
    await mailService.send(accountId, {
      to: [message.from],
      subject: staged.draftReply.subject,
      body: { text: staged.draftReply.body },
      inReplyTo: message.messageId,
      threadId: message.threadId,
    });
  }

  if (staged.unsubscribeAction === 'unsubscribe') {
    const unsubscribe = message.unsubscribe;
    if (unsubscribe.type === 'mailto') {
      await mailService.send(accountId, {
        to: [{ address: unsubscribe.address }],
        subject: unsubscribe.subject ?? 'Unsubscribe',
        body: { text: unsubscribe.body ?? '' },
      });
    } else if (unsubscribe.type === 'oneClick') {
      await performOneClickUnsubscribe(unsubscribe.url);
    }
    // 'link'/'none': nothing to do server-side. A 'link' unsubscribe is
    // opened client-side, synchronously inside the Confirm click handler,
    // before this route is ever called — see web/src/ai-feed/card.ts.

    // Always recorded, regardless of whether the real attempt above
    // reports success — a sender that never actually processes the
    // request (or a 'link'/'none' mechanism this server can't verify at
    // all) would otherwise keep getting force-shown forever. This is the
    // local-suppression fallback the real attempt doesn't guarantee.
    await recordSuppression(dataDir, accountId, message.from.address, 'unsubscribed');
  } else if (staged.unsubscribeAction === 'suppress') {
    await recordSuppression(dataDir, accountId, message.from.address, 'suppressed');
  }
}

/** Builds the plain-English summary of a card action fed into the
 *  personalized-memory update (see logCardActionForMemory below) — separate
 *  from executeConfirm itself, which only cares about what to actually do,
 *  not how to describe it afterward.
 *
 *  Returns null for a plain dismiss with no category preference set — a
 *  dismiss alone is too ambiguous to learn anything from (see chat history:
 *  it might mean "read it, got what I needed," "not interested," or "not
 *  right now," three different signals collapsed into one gesture), so it
 *  must produce no memory update at all rather than a vague one. Confirm
 *  always returns non-null: it only ever renders once something concrete is
 *  staged (see hasStagedContent in card.ts), so there's always something
 *  real to describe. categoryPreference, when set, is the one signal
 *  unambiguous enough to log regardless of which button closed the card —
 *  it's an explicit, deliberate opinion the user chose to leave, not an
 *  inference from which button they happened to press. */
export function describeCardAction(body: ConfirmBody | DismissBody, confirmed: boolean): string | null {
  const parts: string[] = [];
  if (confirmed) {
    const staged = body as ConfirmBody;
    if (staged.draftReply) parts.push('sent the drafted reply');
    if (staged.unsubscribeAction === 'unsubscribe') {
      parts.push("chose 'Unsubscribe & suppress' for this sender");
    }
    if (staged.unsubscribeAction === 'suppress') parts.push("chose 'Suppress only' for this sender");
  }
  if (body.categoryPreference === 'more') {
    parts.push(
      'explicitly said they want to keep seeing emails like this in the Feed — a deliberate, unambiguous signal',
    );
  } else if (body.categoryPreference === 'less') {
    parts.push(
      'explicitly said they want to see fewer emails like this in the Feed — a deliberate, unambiguous signal',
    );
  }
  if (parts.length === 0) return confirmed ? 'confirmed with nothing staged' : null;
  return `${confirmed ? 'confirmed' : 'dismissed'} — ${parts.join('; ')}`;
}

/** Best-effort side channel feeding the personalized-memory feature (see
 *  src/ai/memory-update.ts) off the same two Feed-card actions confirm/
 *  dismiss already support — deliberately separate from executeConfirm's
 *  own logic (and its existing tests) since this is allowed to fail
 *  silently where the real action it's describing must not. Always called
 *  fire-and-forget (see the two route handlers below).
 *
 *  Takes `triage` already-fetched rather than looking it up itself: both
 *  route handlers below need to read it from the AI feed store *before*
 *  calling removeFeedItem, and calling this fire-and-forget means its own
 *  body can't be trusted to run before that delete does — two independent
 *  async chains, no ordering guarantee between them. getMessage() (the one
 *  part of this that's still looked up in here) hits the mail server, not
 *  that store, so it isn't subject to the same race.
 *
 *  A real getMessage() fetch (with body), not the lightweight
 *  getMessageSummaries() buildFeedList uses — this runs once per explicit
 *  feedback action, not once per rendered list item, so it doesn't
 *  reintroduce the N-fetches-per-list-render cost that optimization was
 *  about. buildMemoryEvent needs the real content: without it, the
 *  memory-update model has nothing to reason about beyond a subject line
 *  when one email disagrees with an otherwise-consistent pattern (see chat
 *  history — this was flattening real distinctions into an outright flip of
 *  the stored preference). A message that's vanished since throws here and
 *  is swallowed by this function's own fire-and-forget caller, same as any
 *  other failure in this best-effort path. */
export async function logCardActionForMemory(
  dataDir: string,
  triage: EmailTriage,
  actionSummary: string,
): Promise<void> {
  const message = await mailService.getMessage(triage.emailId);
  await scheduleMemoryUpdate(dataDir, triage.accountId, buildMemoryEvent(message, triage, actionSummary));
}

export const aiFeedRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  fastify.addHook('onRequest', requireAuth(dataDir));
  fastify.addHook('preHandler', async (_request, reply) => {
    if (!mailService.isConfigured()) {
      return reply.code(409).send({ error: 'No mail provider configured' });
    }
  });

  // See buildFeedList's own doc comment for how this stays fast: one
  // batched summary fetch for every pending item, not one full-message
  // fetch per item. Body/attachments are deliberately left out of the
  // response to keep the list payload light either way; a card's full
  // body still loads lazily through the ordinary /messages/:id route when
  // expanded.
  fastify.get('/', async (_request, reply) => {
    return reply.send({ items: await buildFeedList(dataDir) });
  });

  fastify.post<{ Params: { emailId: string }; Body: ConfirmBody }>(
    '/:emailId/confirm',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            draftReply: {
              type: 'object',
              required: ['subject', 'body'],
              properties: { subject: { type: 'string' }, body: { type: 'string' } },
            },
            unsubscribeAction: { type: 'string', enum: ['unsubscribe', 'suppress'] },
            categoryPreference: { type: 'string', enum: ['more', 'less'] },
          },
        },
      },
    },
    async (request, reply) => {
      const emailId = request.params.emailId;
      const message = await mailService.getMessage(emailId);
      // Read before removeFeedItem deletes this row — see
      // logCardActionForMemory's own comment on why.
      const triage = (await getFeedItems(dataDir)).find((item) => item.emailId === emailId);
      await executeConfirm(dataDir, message, request.body);
      const actionSummary = describeCardAction(request.body, true);
      if (triage && actionSummary) {
        void logCardActionForMemory(dataDir, triage, actionSummary).catch((err) =>
          console.error(`Memory update failed for ${emailId}:`, err),
        );
      }
      await removeFeedItem(dataDir, emailId);
      return reply.send({ ok: true });
    },
  );

  fastify.post<{ Params: { emailId: string }; Body: DismissBody }>(
    '/:emailId/dismiss',
    {
      schema: {
        body: {
          type: 'object',
          properties: { categoryPreference: { type: 'string', enum: ['more', 'less'] } },
        },
      },
    },
    async (request, reply) => {
      const emailId = request.params.emailId;
      const triage = (await getFeedItems(dataDir)).find((item) => item.emailId === emailId);
      const actionSummary = describeCardAction(request.body, false);
      if (triage && actionSummary) {
        void logCardActionForMemory(dataDir, triage, actionSummary).catch((err) =>
          console.error(`Memory update failed for ${emailId}:`, err),
        );
      }
      await removeFeedItem(dataDir, emailId);
      return reply.send({ ok: true });
    },
  );
};

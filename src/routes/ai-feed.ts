import type { FastifyPluginAsync } from 'fastify';
import { getFeedItems, removeFeedItem } from '../lib/ai-feed';
import { requireAuth } from '../lib/require-auth';
import { isSuppressed, recordSuppression } from '../lib/unsubscribe-suppressions';
import { performOneClickUnsubscribe } from '../mail/perform-unsubscribe';
import { mailService } from '../mail/registry';
import type { EmailMessage } from '../mail/types';
import type { AiFeedListItem, ConfirmBody } from './ai-feed-types';

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

  const summaries = await mailService.getProvider().getMessageSummaries(triageItems.map((t) => t.emailId));

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
        message.unsubscribe.type !== 'none' && !(await isSuppressed(dataDir, message.from.address)),
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
  if (staged.draftReply) {
    await mailService.getProvider().send({
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
      await mailService.getProvider().send({
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
    await recordSuppression(dataDir, message.from.address, 'unsubscribed');
  } else if (staged.unsubscribeAction === 'suppress') {
    await recordSuppression(dataDir, message.from.address, 'suppressed');
  }
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
          },
        },
      },
    },
    async (request, reply) => {
      const message = await mailService.getProvider().getMessage(request.params.emailId);
      await executeConfirm(dataDir, message, request.body);
      await removeFeedItem(dataDir, request.params.emailId);
      return reply.send({ ok: true });
    },
  );

  fastify.post<{ Params: { emailId: string } }>('/:emailId/dismiss', async (request, reply) => {
    await removeFeedItem(dataDir, request.params.emailId);
    return reply.send({ ok: true });
  });
};

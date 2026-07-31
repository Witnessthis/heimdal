import type { FastifyPluginAsync } from 'fastify';
import { getFeedItems, removeFeedItem } from '../lib/ai-feed';
import { requireAuth } from '../lib/require-auth';
import { resolveSenderPreference } from '../lib/sender-preferences';
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
 *  content that's gone. */
export async function buildFeedList(dataDir: string): Promise<AiFeedListItem[]> {
  const triageItems = await getFeedItems(dataDir);
  const items: AiFeedListItem[] = [];
  for (const triage of triageItems) {
    try {
      const message = await mailService.getProvider().getMessage(triage.emailId);
      items.push({
        triage,
        from: message.from,
        subject: message.subject,
        snippet: message.snippet,
        receivedAt: message.receivedAt,
        isRead: message.isRead,
        messageId: message.messageId,
        threadId: message.threadId,
        unsubscribe: message.unsubscribe,
      });
    } catch {
      // The message is gone (deleted/moved) since it was classified —
      // drop the stale feed row rather than showing a card for content
      // that no longer exists.
      await removeFeedItem(dataDir, triage.emailId);
    }
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
  if (staged.senderPreference) {
    await resolveSenderPreference(dataDir, message.from.address, staged.senderPreference);
  }

  if (staged.draftReply) {
    await mailService.getProvider().send({
      to: [message.from],
      subject: staged.draftReply.subject,
      body: { text: staged.draftReply.body },
      inReplyTo: message.messageId,
      threadId: message.threadId,
    });
  }

  if (staged.unsubscribe) {
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
  }
}

export const aiFeedRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  fastify.addHook('onRequest', requireAuth(dataDir));
  fastify.addHook('preHandler', async (_request, reply) => {
    if (!mailService.isConfigured()) {
      return reply.code(409).send({ error: 'No mail provider configured' });
    }
  });

  // No lighter-weight "get one summary by id" path exists on MailProvider
  // — .unsubscribe is only ever populated by the full getMessage() fetch
  // (see src/ai/auto-classify.ts's identical note) — so buildFeedList pays
  // for one full fetch per pending item. Body/attachments are deliberately
  // left out of the response to keep the list payload light; a card's
  // full body still loads lazily through the ordinary /messages/:id route
  // when expanded. AI feed item counts are small by design (triage's
  // whole job is to keep this list short), so that second fetch on expand
  // is cheaper than threading a body cache through just for this.
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
            senderPreference: { type: 'string', enum: ['show', 'hide'] },
            draftReply: {
              type: 'object',
              required: ['subject', 'body'],
              properties: { subject: { type: 'string' }, body: { type: 'string' } },
            },
            unsubscribe: { type: 'boolean' },
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

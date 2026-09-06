import type { FastifyPluginAsync } from 'fastify';
import { reprocessMessage } from '../ai/reprocess';
import { requireAuth } from '../lib/require-auth';
import { performOneClickUnsubscribe } from '../mail/perform-unsubscribe';
import { InvalidRequestError } from '../mail/provider';
import { mailService } from '../mail/registry';
import type { EmailAddress } from '../mail/types';

interface Options {
  dataDir: string;
}

interface QuickSendBody {
  // No message id to derive this from (a fresh compose has no originating
  // card) — the Inbox tab's compose UI always knows which account it's
  // currently viewing (see its account switcher) and sends that along
  // explicitly.
  accountId: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  threadId?: string;
}

const addressSchema = {
  type: 'object',
  required: ['address'],
  properties: {
    name: { type: 'string' },
    address: { type: 'string' },
  },
};

export const mailRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  // onRequest, not preHandler — runs before Fastify's schema validation, so
  // an unauthenticated request gets a 401 instead of a 400 that leaks the
  // body schema.
  fastify.addHook('onRequest', requireAuth(dataDir));
  fastify.addHook('preHandler', async (_request, reply) => {
    if (!mailService.isConfigured()) {
      return reply.code(409).send({ error: 'No mail provider configured' });
    }
  });

  // Malformed message ids / page tokens are caller error, not a backend
  // failure — map them to a clean 400 instead of leaking whatever opaque
  // protocol error the provider threw as a 500.
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof InvalidRequestError) {
      return reply.code(400).send({ error: error.message });
    }
    reply.send(error);
  });

  fastify.get<{ Querystring: { accountId: string } }>(
    '/folders',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['accountId'],
          properties: { accountId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const folders = await mailService.listFolders(request.query.accountId);
      return reply.send({ folders });
    },
  );

  // Server-Sent Events stream of mailService's events (newMessage,
  // messageUpdated, messageDeleted, connectionState) — the delivery half of
  // the IMAP IDLE session's detection half. Without this, IDLE notices new
  // mail arriving but nothing ever tells a connected browser about it.
  // Scoped to one account (?accountId=) — the Inbox tab only ever looks at
  // one account's live stream at a time (see its account switcher);
  // events from every other connected account are filtered out here
  // rather than left for the browser to sort through.
  fastify.get<{ Querystring: { accountId: string } }>('/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write('\n');

    const { accountId } = request.query;
    const unsubscribe = mailService.onEvent((event) => {
      if (event.accountId !== accountId) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Keeps intermediary proxies (Caddy, browser) from timing out an
    // idle-looking long-lived connection.
    const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      reply.raw.end();
    });
  });

  fastify.get<{
    Querystring: { accountId: string; folderId: string; pageToken?: string; pageSize?: string };
  }>(
    '/messages',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['accountId', 'folderId'],
          properties: {
            accountId: { type: 'string' },
            folderId: { type: 'string' },
            pageToken: { type: 'string' },
            pageSize: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { accountId, folderId, pageToken, pageSize } = request.query;
      const page = await mailService.listMessages(accountId, {
        folderId,
        pageToken,
        pageSize: pageSize ? Number(pageSize) : undefined,
      });
      return reply.send(page);
    },
  );

  fastify.get<{ Params: { id: string } }>('/messages/:id', async (request, reply) => {
    const message = await mailService.getMessage(request.params.id);
    return reply.send(message);
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/read', async (request, reply) => {
    await mailService.setRead(request.params.id, true);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/unread', async (request, reply) => {
    await mailService.setRead(request.params.id, false);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/flag', async (request, reply) => {
    await mailService.setFlagged(request.params.id, true);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/unflag', async (request, reply) => {
    await mailService.setFlagged(request.params.id, false);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string }; Body: { folderId: string } }>(
    '/messages/:id/move',
    {
      schema: {
        body: {
          type: 'object',
          required: ['folderId'],
          properties: { folderId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      await mailService.moveToFolder(request.params.id, request.body.folderId);
      return reply.send({ ok: true });
    },
  );

  fastify.post<{ Params: { id: string } }>('/messages/:id/archive', async (request, reply) => {
    await mailService.archive(request.params.id);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/delete', async (request, reply) => {
    await mailService.deleteMessage(request.params.id);
    return reply.send({ ok: true });
  });

  // Fire-and-forget, same reasoning as everywhere else this pattern is
  // already used in this codebase: classifyEmail is an LLM round-trip, and
  // this request must return immediately rather than hold the swipe button
  // (and the HTTP connection) open for it. See reprocessMessage's own doc
  // comment for what this actually does.
  fastify.post<{ Params: { id: string } }>('/messages/:id/reprocess', async (request, reply) => {
    void reprocessMessage(dataDir, request.params.id).catch((err) =>
      console.error(`Reprocess failed for ${request.params.id}:`, err),
    );
    return reply.send({ ok: true });
  });

  // Only meaningful for a message whose List-Unsubscribe/-Post headers
  // resolved to { type: 'oneClick' } (see src/mail/list-unsubscribe.ts) —
  // a plain "link" or "mailto" action needs no backend involvement at all
  // (a real navigation, or reusing quick-send, both happen client-side).
  // The actual outbound request happens in performOneClickUnsubscribe,
  // never in the browser — this app's CSP locks connectSrc to 'self', and
  // the target URL is attacker-controlled email content regardless.
  fastify.post<{ Params: { id: string } }>('/messages/:id/unsubscribe', async (request, reply) => {
    const message = await mailService.getMessage(request.params.id);
    if (message.unsubscribe.type !== 'oneClick') {
      return reply.code(400).send({ error: 'This message has no one-click unsubscribe available' });
    }
    const ok = await performOneClickUnsubscribe(message.unsubscribe.url);
    return reply.send({ ok });
  });

  // The only route that puts a message on the wire — always a direct,
  // user-triggered request. The AI layer (src/ai/) never calls this.
  fastify.post<{ Body: QuickSendBody }>(
    '/quick-send',
    {
      schema: {
        body: {
          type: 'object',
          required: ['accountId', 'to', 'subject'],
          properties: {
            accountId: { type: 'string' },
            to: { type: 'array', items: addressSchema, minItems: 1 },
            cc: { type: 'array', items: addressSchema },
            bcc: { type: 'array', items: addressSchema },
            subject: { type: 'string' },
            text: { type: 'string' },
            html: { type: 'string' },
            inReplyTo: { type: 'string' },
            threadId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const result = await mailService.send(body.accountId, {
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        subject: body.subject,
        body: { text: body.text, html: body.html },
        inReplyTo: body.inReplyTo,
        threadId: body.threadId,
      });
      return reply.send(result);
    },
  );
};

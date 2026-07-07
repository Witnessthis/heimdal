import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../lib/require-auth';
import { InvalidRequestError } from '../mail/provider';
import { mailService } from '../mail/registry';
import type { EmailAddress } from '../mail/types';

interface Options {
  dataDir: string;
}

interface QuickSendBody {
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

export const mailRoutes: FastifyPluginAsync<Options> = async (fastify) => {
  // onRequest, not preHandler — runs before Fastify's schema validation, so
  // an unauthenticated request gets a 401 instead of a 400 that leaks the
  // body schema.
  fastify.addHook('onRequest', requireAuth);
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

  fastify.get('/folders', async (_request, reply) => {
    const folders = await mailService.getProvider().listFolders();
    return reply.send({ folders });
  });

  // Server-Sent Events stream of mailService's events (newMessage,
  // messageUpdated, messageDeleted, connectionState) — the delivery half of
  // the IMAP IDLE session's detection half. Without this, IDLE notices new
  // mail arriving but nothing ever tells a connected browser about it.
  fastify.get('/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write('\n');

    const unsubscribe = mailService.onEvent((event) => {
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

  fastify.get<{ Querystring: { folderId: string; pageToken?: string; pageSize?: string } }>(
    '/messages',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['folderId'],
          properties: {
            folderId: { type: 'string' },
            pageToken: { type: 'string' },
            pageSize: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { folderId, pageToken, pageSize } = request.query;
      const page = await mailService.getProvider().listMessages({
        folderId,
        pageToken,
        pageSize: pageSize ? Number(pageSize) : undefined,
      });
      return reply.send(page);
    },
  );

  fastify.get<{ Params: { id: string } }>('/messages/:id', async (request, reply) => {
    const message = await mailService.getProvider().getMessage(request.params.id);
    return reply.send(message);
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/read', async (request, reply) => {
    await mailService.getProvider().setRead(request.params.id, true);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/unread', async (request, reply) => {
    await mailService.getProvider().setRead(request.params.id, false);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/flag', async (request, reply) => {
    await mailService.getProvider().setFlagged(request.params.id, true);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/unflag', async (request, reply) => {
    await mailService.getProvider().setFlagged(request.params.id, false);
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
      await mailService.getProvider().moveToFolder(request.params.id, request.body.folderId);
      return reply.send({ ok: true });
    },
  );

  fastify.post<{ Params: { id: string } }>('/messages/:id/archive', async (request, reply) => {
    await mailService.getProvider().archive(request.params.id);
    return reply.send({ ok: true });
  });

  fastify.post<{ Params: { id: string } }>('/messages/:id/trash', async (request, reply) => {
    await mailService.getProvider().trash(request.params.id);
    return reply.send({ ok: true });
  });

  // The only route that puts a message on the wire — always a direct,
  // user-triggered request. The AI layer (src/ai/) never calls this.
  fastify.post<{ Body: QuickSendBody }>(
    '/quick-send',
    {
      schema: {
        body: {
          type: 'object',
          required: ['to', 'subject'],
          properties: {
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
      const result = await mailService.getProvider().send({
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

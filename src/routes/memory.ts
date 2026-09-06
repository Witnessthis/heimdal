import type { FastifyPluginAsync } from 'fastify';
import { getMemory, setMemory } from '../lib/memory-notes';
import { requireAuth } from '../lib/require-auth';

interface Options {
  dataDir: string;
}

/** Read/write access to one account's personalized-memory file (see
 *  src/ai/memory-update.ts for how it's written automatically, and
 *  web/memory.html for the settings page that uses this directly) — the
 *  user's own way to see what's been learned and correct it. Each mail
 *  account has its own memory file, the same way it has its own inbox. */
export const memoryRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  fastify.addHook('onRequest', requireAuth(dataDir));

  fastify.get<{ Params: { accountId: string } }>('/:accountId', async (request, reply) => {
    return reply.send({ content: await getMemory(dataDir, request.params.accountId) });
  });

  fastify.put<{ Params: { accountId: string }; Body: { content: string } }>(
    '/:accountId',
    {
      schema: {
        body: {
          type: 'object',
          required: ['content'],
          properties: { content: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      await setMemory(dataDir, request.params.accountId, request.body.content);
      return reply.send({ ok: true });
    },
  );
};

import type { FastifyPluginAsync } from 'fastify';
import { getMemory, setMemory } from '../lib/memory-notes';
import { requireAuth } from '../lib/require-auth';

interface Options {
  dataDir: string;
}

/** Read/write access to the personalized-memory file (see
 *  src/ai/memory-update.ts for how it's written automatically, and
 *  web/memory.html for the settings page that uses this directly) — the
 *  user's own way to see what's been learned and correct it. */
export const memoryRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  fastify.addHook('onRequest', requireAuth(dataDir));

  fastify.get('/', async (_request, reply) => {
    return reply.send({ content: await getMemory(dataDir) });
  });

  fastify.put<{ Body: { content: string } }>(
    '/',
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
      await setMemory(dataDir, request.body.content);
      return reply.send({ ok: true });
    },
  );
};

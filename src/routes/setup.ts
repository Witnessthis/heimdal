import { FastifyPluginAsync } from 'fastify';
import { loadCredentials, saveCredentials } from '../lib/credentials';
import { consumeSetupToken } from '../lib/session';

interface Options {
  dataDir: string;
}

export const setupRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  fastify.get('/status', async (_request, reply) => {
    const credentials = await loadCredentials(dataDir);
    return reply.send({ configured: credentials !== null });
  });

  fastify.post<{ Body: { token: string; password: string } }>(
    '/setup',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: {
            token: { type: 'string' },
            password: { type: 'string', minLength: 12 },
          },
        },
      },
    },
    async (request, reply) => {
      const credentials = await loadCredentials(dataDir);
      if (credentials) {
        return reply.code(403).send({ error: 'Already configured' });
      }

      const { token, password } = request.body;
      if (!consumeSetupToken(token)) {
        return reply.code(401).send({ error: 'Invalid setup token' });
      }

      await saveCredentials(dataDir, password);
      return reply.send({ ok: true });
    }
  );
};

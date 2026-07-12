import type { FastifyPluginAsync } from 'fastify';
import { consumeTotpSeedFile, loadCredentials, saveCredentials, setTotpSecret } from '../lib/credentials';
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
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
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

      // Same escape hatch as server.ts's startup check — also needed
      // here, since a seed file dropped in before setup completes would
      // otherwise sit unconsumed until the next full server restart (the
      // startup check only fires when credentials already exist at boot).
      const seededSecret = await consumeTotpSeedFile(dataDir);
      if (seededSecret) await setTotpSecret(dataDir, seededSecret);

      return reply.send({ ok: true });
    },
  );
};

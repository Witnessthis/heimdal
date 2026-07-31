import type { FastifyPluginAsync } from 'fastify';
import { getVapidKeys } from '../lib/push-keys';
import { removeSubscription, type StoredSubscription, saveSubscription } from '../lib/push-subscriptions';
import { requireAuth } from '../lib/require-auth';

interface Options {
  dataDir: string;
}

const subscriptionSchema = {
  type: 'object',
  required: ['endpoint', 'keys'],
  properties: {
    endpoint: { type: 'string' },
    keys: {
      type: 'object',
      required: ['p256dh', 'auth'],
      properties: {
        p256dh: { type: 'string' },
        auth: { type: 'string' },
      },
    },
  },
};

export const pushRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  fastify.addHook('onRequest', requireAuth(dataDir));

  // Needed client-side before pushManager.subscribe() can even be
  // called — the applicationServerKey has to be this exact public key,
  // or the push service will reject the subscription.
  fastify.get('/vapid-public-key', async (_request, reply) => {
    const { publicKey } = await getVapidKeys(dataDir);
    return reply.send({ publicKey });
  });

  // No GET /status route — the browser already knows whether it has an
  // active subscription via pushManager.getSubscription(), so the
  // Settings UI checks that directly instead of this duplicating it.
  fastify.post<{ Body: StoredSubscription }>(
    '/subscribe',
    { schema: { body: subscriptionSchema } },
    async (request, reply) => {
      await saveSubscription(dataDir, request.body);
      return reply.send({ ok: true });
    },
  );

  fastify.post<{ Body: { endpoint: string } }>(
    '/unsubscribe',
    {
      schema: {
        body: {
          type: 'object',
          required: ['endpoint'],
          properties: { endpoint: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      await removeSubscription(dataDir, request.body.endpoint);
      return reply.send({ ok: true });
    },
  );
};

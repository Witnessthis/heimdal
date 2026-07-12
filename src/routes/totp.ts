import type { FastifyPluginAsync } from 'fastify';
import { authenticator } from 'otplib';

authenticator.options = { window: 1 };

import QRCode from 'qrcode';
import {
  clearPendingTotpSecret,
  loadCredentials,
  loadPendingTotpSecret,
  savePendingTotpSecret,
  setTotpSecret,
} from '../lib/credentials';
import { requireAuth } from '../lib/require-auth';

interface Options {
  dataDir: string;
}

export const totpRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  // onRequest, not preHandler — runs before Fastify's schema validation, so
  // an unauthenticated request gets a 401 instead of a 400 that leaks the
  // body schema.
  fastify.addHook('onRequest', requireAuth);

  fastify.get('/status', async (_request, reply) => {
    const credentials = await loadCredentials(dataDir);
    return reply.send({ enabled: !!credentials?.totp });
  });

  fastify.get('/setup', async (_request, reply) => {
    // Reuse existing pending secret (survives server restarts) so the QR stays consistent
    const existing = await loadPendingTotpSecret(dataDir);
    const secret = existing ?? authenticator.generateSecret();
    if (!existing) await savePendingTotpSecret(dataDir, secret);
    const otpauthUri = authenticator.keyuri('Heimdal', 'Heimdal', secret);
    const qrCode = await QRCode.toDataURL(otpauthUri, { width: 256, margin: 2 });
    const readableSecret = secret.match(/.{1,4}/g)?.join(' ') ?? secret;
    return reply.header('Cache-Control', 'no-store').send({ otpauthUri, qrCode, readableSecret });
  });

  fastify.post<{ Body: { code: string } }>(
    '/enable',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const secret = await loadPendingTotpSecret(dataDir);
      if (!secret) return reply.code(400).send({ error: 'No pending TOTP setup. Reload and try again.' });

      const valid = authenticator.verify({ token: request.body.code, secret });
      if (!valid) return reply.code(401).send({ error: 'Invalid code' });

      await setTotpSecret(dataDir, secret);
      await clearPendingTotpSecret(dataDir);
      return reply.send({ ok: true });
    },
  );
};

import type { FastifyPluginAsync } from 'fastify';
import { authenticator } from 'otplib';
import { loadCredentials, verifyCredentials } from '../lib/credentials';
import {
  consumePendingTotpToken,
  createPendingTotpToken,
  createSession,
  destroySession,
  SESSION_COOKIE,
  sessionCookieOpts,
  validateSession,
} from '../lib/session';

interface Options {
  dataDir: string;
}

export const authRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  fastify.post<{ Body: { password: string } }>(
    '/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: { password: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { password } = request.body;
      const valid = await verifyCredentials(dataDir, password);
      if (!valid) return reply.code(401).send({ error: 'Invalid password' });

      const credentials = await loadCredentials(dataDir);
      if (credentials?.totp) {
        const pendingToken = createPendingTotpToken();
        return reply.send({ totpRequired: true, pendingToken });
      }

      const token = createSession();
      return reply.setCookie(SESSION_COOKIE, token, sessionCookieOpts).send({ ok: true });
    },
  );

  fastify.post<{ Body: { pendingToken: string; code: string } }>(
    '/login/totp',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['pendingToken', 'code'],
          properties: {
            pendingToken: { type: 'string' },
            code: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { pendingToken, code } = request.body;
      if (!consumePendingTotpToken(pendingToken)) {
        return reply.code(401).send({ error: 'Session expired. Please sign in again.' });
      }

      const credentials = await loadCredentials(dataDir);
      if (!credentials?.totp) return reply.code(400).send({ error: 'TOTP not configured' });

      const valid = authenticator.verify({ token: code, secret: credentials.totp.secret });
      if (!valid) return reply.code(401).send({ error: 'Invalid code' });

      const token = createSession();
      return reply.setCookie(SESSION_COOKIE, token, sessionCookieOpts).send({ ok: true });
    },
  );

  fastify.post('/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) destroySession(token);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true });
  });

  fastify.get('/me', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token || !validateSession(token)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    // See require-auth.ts — keeps the browser's cookie in step with the
    // sliding server-side expiry.
    return reply.setCookie(SESSION_COOKIE, token, sessionCookieOpts).send({ ok: true });
  });
};

import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, sessionCookieOpts, validateSession } from './session';

// A factory, not a bare hook — validateSession needs dataDir (see
// session.ts), and each route plugin already has its own dataDir in scope
// from its Options, so every registration site does
// `fastify.addHook('onRequest', requireAuth(dataDir))` instead.
export function requireAuth(dataDir: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token || !(await validateSession(dataDir, token))) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    // Keep the browser's copy of the cookie in step with the sliding
    // server-side expiry — otherwise it would drop 30 days after login
    // regardless of activity, even though the server kept the session alive.
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOpts);
  };
}

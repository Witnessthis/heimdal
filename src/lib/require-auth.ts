import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, sessionCookieOpts, validateSession } from './session';

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token || !validateSession(token)) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
  // Keep the browser's copy of the cookie in step with the sliding
  // server-side expiry — otherwise it would drop 30 days after login
  // regardless of activity, even though the server kept the session alive.
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOpts);
}

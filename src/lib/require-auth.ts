import type { FastifyReply, FastifyRequest } from 'fastify';
import { validateSession } from './session';

const COOKIE = 'session';

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[COOKIE];
  if (!token || !validateSession(token)) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

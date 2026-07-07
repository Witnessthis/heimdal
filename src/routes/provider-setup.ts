import type { FastifyPluginAsync } from 'fastify';
import {
  type ImapSecret,
  loadProviderCredentials,
  saveProviderCredentials,
} from '../lib/provider-credentials';
import { requireAuth } from '../lib/require-auth';
import { ImapProvider } from '../mail/providers/imap';
import { mailService } from '../mail/registry';

interface Options {
  dataDir: string;
}

/** imapflow throws a generic Error('Command failed') for IMAP protocol
 *  rejections (bad login, etc.) and attaches the server's actual reason
 *  separately as `responseText` — without this, callers only ever see
 *  "Command failed" and never find out it was e.g. "Application-specific
 *  password required" from Gmail. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const responseText = (err as { responseText?: unknown }).responseText;
    return typeof responseText === 'string' && responseText ? `${err.message}: ${responseText}` : err.message;
  }
  return String(err);
}

interface ImapSetupBody {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpPassword?: string;
}

export const providerSetupRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  // onRequest, not preHandler — runs before Fastify's schema validation, so
  // an unauthenticated request gets a 401 instead of a 400 that leaks the
  // body schema.
  fastify.addHook('onRequest', requireAuth);

  fastify.get('/status', async (_request, reply) => {
    const stored = await loadProviderCredentials(dataDir);
    return reply.send({
      configured: stored !== null,
      kind: stored?.config.kind ?? null,
      healthy: mailService.isConfigured() ? mailService.getProvider().isHealthy() : false,
    });
  });

  fastify.post<{ Body: ImapSetupBody }>(
    '/imap',
    {
      schema: {
        body: {
          type: 'object',
          required: ['host', 'port', 'secure', 'username', 'password', 'smtpHost', 'smtpPort', 'smtpSecure'],
          properties: {
            host: { type: 'string', minLength: 1 },
            port: { type: 'integer' },
            secure: { type: 'boolean' },
            username: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 1 },
            smtpHost: { type: 'string', minLength: 1 },
            smtpPort: { type: 'integer' },
            smtpSecure: { type: 'boolean' },
            smtpPassword: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const config = {
        kind: 'imap' as const,
        host: body.host,
        port: body.port,
        secure: body.secure,
        smtpHost: body.smtpHost,
        smtpPort: body.smtpPort,
        smtpSecure: body.smtpSecure,
        username: body.username,
      };
      const secret: ImapSecret = { password: body.password, smtpPassword: body.smtpPassword };

      // Validate before persisting anything — a wrong host/password should
      // fail loudly here, not silently at the next IDLE reconnect.
      const probe = new ImapProvider(config, secret);
      try {
        await probe.connect();
        await probe.disconnect();
      } catch (err) {
        return reply.code(400).send({
          error: 'Could not connect with the given credentials',
          detail: describeError(err),
        });
      }

      await saveProviderCredentials(dataDir, config, secret);
      try {
        await mailService.init(dataDir);
      } catch (err) {
        // Credentials are valid (the probe above succeeded) and are already
        // saved, so this is presumed transient — resubmitting this same
        // request will retry both the save (no-op, same values) and init.
        return reply.code(502).send({
          error: 'Credentials saved, but connecting failed. Try again.',
          detail: describeError(err),
        });
      }
      return reply.send({ ok: true });
    },
  );
};

import type { FastifyPluginAsync } from 'fastify';
import { createAccount, listAccounts, removeAccount, updateAccount } from '../lib/accounts';
import { removeFeedItemsForAccount } from '../lib/ai-feed';
import { type ImapSecret, saveProviderCredentials } from '../lib/provider-credentials';
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

interface AddImapAccountBody {
  label: string;
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

/** Mail-account management — connecting, listing, recoloring/renaming, and
 *  removing the mail accounts feeding this Heimdal install. Replaces the
 *  old single-account src/routes/provider-setup.ts entirely: today's
 *  connect-imap.html always adds a new account rather than overwriting the
 *  one that already exists. Only IMAP is wired up here, matching
 *  MailService's own instantiateProvider — Gmail/Outlook stay
 *  unimplemented. */
export const accountsRoutes: FastifyPluginAsync<Options> = async (fastify, { dataDir }) => {
  fastify.addHook('onRequest', requireAuth(dataDir));

  fastify.get('/', async (_request, reply) => {
    const accounts = await listAccounts(dataDir);
    return reply.send({
      accounts: accounts.map((account) => ({
        ...account,
        connected: mailService.isAccountConnected(account.id),
        healthy: mailService.isAccountHealthy(account.id),
      })),
    });
  });

  fastify.post<{ Body: AddImapAccountBody }>(
    '/imap',
    {
      schema: {
        body: {
          type: 'object',
          required: [
            'label',
            'host',
            'port',
            'secure',
            'username',
            'password',
            'smtpHost',
            'smtpPort',
            'smtpSecure',
          ],
          properties: {
            label: { type: 'string', minLength: 1 },
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

      const account = await createAccount(dataDir, { label: body.label, kind: 'imap' });
      await saveProviderCredentials(dataDir, account.id, config, secret);
      try {
        await mailService.connectAccount(dataDir, account.id);
      } catch (err) {
        // Credentials are valid (the probe above succeeded) and the account
        // is already registered, so this is presumed transient — the
        // account shows up as disconnected and can be retried by removing
        // and re-adding it, or a future "retry" affordance.
        return reply.code(502).send({
          error: 'Account saved, but connecting failed. Try again.',
          detail: describeError(err),
        });
      }
      return reply.send({ ok: true, account });
    },
  );

  fastify.patch<{ Params: { id: string }; Body: { label?: string; color?: string; theme?: string } }>(
    '/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            label: { type: 'string', minLength: 1 },
            color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
            theme: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const account = await updateAccount(dataDir, request.params.id, request.body);
      return reply.send({ account });
    },
  );

  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    await mailService.disconnectAccount(id);
    await removeFeedItemsForAccount(dataDir, id);
    await removeAccount(dataDir, id);
    return reply.send({ ok: true });
  });
};

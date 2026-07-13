import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImapProviderConfig } from './index';
import { ImapProvider } from './index';

// A real send -> receive round-trip through the production ImapProvider
// against a live GreenMail server (a real IMAP/SMTP implementation), not a
// mock. Exercises the SMTP send path, IMAP login, folder listing, and
// envelope parsing end to end. Opt-in: needs Docker, run via
// `npm run test:integration`.
//
// GreenMail ships a self-signed cert, so implicit-TLS ports (IMAPS/SMTPS)
// only complete the handshake with cert validation relaxed. That is scoped
// to THIS process (the integration project runs alone under
// test:integration) and never touches production code, which keeps
// rejectUnauthorized at its safe default.

const USER = 'alice@example.local';
const PASSWORD = 'test-password';

async function retry<T>(fn: () => Promise<T>, attempts = 30, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

describe('ImapProvider against GreenMail', () => {
  let container: StartedTestContainer;
  let provider: ImapProvider;
  let savedTlsReject: string | undefined;

  beforeAll(async () => {
    savedTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    container = await new GenericContainer('greenmail/standalone:2.1.0')
      .withExposedPorts(3993, 3465) // IMAPS, SMTPS
      .withEnvironment({
        GREENMAIL_OPTS:
          '-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.verbose',
      })
      .start();

    const host = container.getHost();
    const config: ImapProviderConfig = {
      kind: 'imap',
      host,
      port: container.getMappedPort(3993),
      secure: true,
      smtpHost: host,
      smtpPort: container.getMappedPort(3465),
      smtpSecure: true,
      username: USER,
    };
    provider = new ImapProvider(config, { password: PASSWORD });

    // GreenMail's ports may accept connections a beat before it's ready to
    // authenticate — retry the initial login.
    await retry(() => provider.connect());
  }, 120_000);

  afterAll(async () => {
    await provider?.disconnect().catch(() => {});
    await container?.stop().catch(() => {});
    if (savedTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsReject;
  });

  it('lists INBOX among the folders', async () => {
    const folders = await provider.listFolders();
    expect(folders.some((f) => f.kind === 'inbox')).toBe(true);
  });

  it('sends a message and reads it back out of the mailbox', async () => {
    const subject = `Heimdal round-trip ${Date.now()}`;
    await provider.send({
      to: [{ address: USER }],
      subject,
      body: { text: 'hello from the GreenMail integration test' },
    });

    const inbox = (await provider.listFolders()).find((f) => f.kind === 'inbox');
    expect(inbox).toBeDefined();

    // Delivery is asynchronous — poll the mailbox until the message lands.
    const message = await retry(async () => {
      const page = await provider.listMessages({ folderId: inbox!.id, pageSize: 25 });
      const found = page.items.find((m) => m.subject === subject);
      if (!found) throw new Error('message not delivered yet');
      return found;
    });

    expect(message.from.address).toBe(USER);
    expect(message.subject).toBe(subject);
  });
});

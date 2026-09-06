import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailEvent, MailProvider } from './provider';

vi.mock('../lib/provider-credentials', () => ({ loadProviderCredentials: vi.fn() }));
vi.mock('../lib/accounts', () => ({ listAccounts: vi.fn() }));

// A fake MailProvider per account — instance-scoped (own EventEmitter,
// own call log) so tests can assert exactly which account's provider a
// given registry call reached, without pulling in a real ImapProvider or
// mocking the whole module.
function fakeProvider(): MailProvider & { emitter: EventEmitter; log: string[] } {
  const emitter = new EventEmitter();
  const log: string[] = [];
  return {
    kind: 'imap',
    emitter,
    log,
    connect: vi.fn(async () => {
      log.push('connect');
    }),
    disconnect: vi.fn(async () => {
      log.push('disconnect');
    }),
    isHealthy: vi.fn(() => true),
    listFolders: vi.fn(async () => {
      log.push('listFolders');
      return [{ id: 'INBOX', displayName: 'Inbox', kind: 'inbox' as const }];
    }),
    listMessages: vi.fn(async (options) => {
      log.push(`listMessages:${options.folderId}`);
      return { items: [{ ...baseSummary, id: 'imap:INBOX:1', folderId: options.folderId }] };
    }),
    getMessageSummaries: vi.fn(async (ids: string[]) => {
      log.push(`getMessageSummaries:${ids.join(',')}`);
      return new Map(ids.map((id) => [id, { ...baseSummary, id }]));
    }),
    getMessage: vi.fn(async (id: string) => {
      log.push(`getMessage:${id}`);
      return { ...baseSummary, id, cc: [], bcc: [], body: {}, attachments: [], references: [] };
    }),
    getThread: vi.fn(),
    setRead: vi.fn(async (id: string) => {
      log.push(`setRead:${id}`);
    }),
    setFlagged: vi.fn(async (id: string) => {
      log.push(`setFlagged:${id}`);
    }),
    moveToFolder: vi.fn(async (id: string, folderId: string) => {
      log.push(`moveToFolder:${id}:${folderId}`);
    }),
    archive: vi.fn(async (id: string) => {
      log.push(`archive:${id}`);
    }),
    deleteMessage: vi.fn(async (id: string) => {
      log.push(`deleteMessage:${id}`);
    }),
    saveDraft: vi.fn(async () => {
      log.push('saveDraft');
      return { draftId: 'imap:Drafts:1' };
    }),
    updateDraft: vi.fn(async (id: string) => {
      log.push(`updateDraft:${id}`);
    }),
    send: vi.fn(async () => {
      log.push('send');
      return { messageId: 'sent-1' };
    }),
    subscribe: vi.fn((onEvent: (event: MailEvent) => void) => {
      emitter.on('event', onEvent);
      return () => emitter.off('event', onEvent);
    }),
  };
}

const baseSummary = {
  threadId: 't1',
  folderId: 'INBOX',
  from: { address: 'a@example.com' },
  to: [],
  subject: 'Hi',
  snippet: '',
  receivedAt: '2026-01-01T00:00:00Z',
  isRead: false,
  isFlagged: false,
  hasAttachments: false,
  unsubscribe: { type: 'none' as const },
};

const { loadProviderCredentials } = await import('../lib/provider-credentials');
const { ImapProvider } = await import('./providers/imap');
vi.mock('./providers/imap', () => ({ ImapProvider: vi.fn() }));

const { mailService } = await import('./registry');

let providers: Record<string, ReturnType<typeof fakeProvider>>;

beforeEach(() => {
  vi.clearAllMocks();
  providers = { acc1: fakeProvider(), acc2: fakeProvider() };
  // A regular function, not an arrow — vi.fn()'s mock implementation is
  // invoked via `new` (see registry.ts's instantiateProvider), and arrow
  // functions can't be constructors. The test always passes a
  // `{ kind: 'imap', accountId }` stand-in config (see loadProviderCredentials'
  // mock below) so this can hand back the right fake instance.
  // biome-ignore lint/complexity/useArrowFunction: must stay `new`-able
  vi.mocked(ImapProvider).mockImplementation(function (config: unknown) {
    return providers[(config as { accountId: string }).accountId] as unknown as InstanceType<
      typeof ImapProvider
    >;
  } as unknown as typeof ImapProvider);
  vi.mocked(loadProviderCredentials).mockImplementation(async (_dataDir: string, accountId: string) => {
    if (!providers[accountId]) return null;
    return { config: { kind: 'imap', accountId } as never, secret: { password: 'x' } };
  });
});

describe('connectAccount / disconnectAccount', () => {
  it('connects the right provider for the given account and starts it', async () => {
    await mailService.connectAccount('/data', 'acc1');
    expect(providers.acc1.connect).toHaveBeenCalled();
    expect(mailService.isAccountConnected('acc1')).toBe(true);
    expect(mailService.isAccountConnected('acc2')).toBe(false);
  });

  it('runs two accounts independently', async () => {
    await mailService.connectAccount('/data', 'acc1');
    await mailService.connectAccount('/data', 'acc2');
    expect(mailService.getAccountIds().sort()).toEqual(['acc1', 'acc2']);
    expect(mailService.isConfigured()).toBe(true);
  });

  it('disconnects only the requested account', async () => {
    await mailService.connectAccount('/data', 'acc1');
    await mailService.connectAccount('/data', 'acc2');
    await mailService.disconnectAccount('acc1');
    expect(mailService.isAccountConnected('acc1')).toBe(false);
    expect(mailService.isAccountConnected('acc2')).toBe(true);
    expect(providers.acc1.disconnect).toHaveBeenCalled();
    expect(providers.acc2.disconnect).not.toHaveBeenCalled();
  });

  it('disconnecting an unknown account is a no-op', async () => {
    await expect(mailService.disconnectAccount('nonexistent')).resolves.toBeUndefined();
  });

  it('throws when connecting an account with no stored credentials', async () => {
    await expect(mailService.connectAccount('/data', 'ghost')).rejects.toThrow();
  });
});

describe('message-scoped routing', () => {
  beforeEach(async () => {
    await mailService.connectAccount('/data', 'acc1');
    await mailService.connectAccount('/data', 'acc2');
  });

  it('getMessage decodes the account from the qualified id and routes to the right provider', async () => {
    const message = await mailService.getMessage('acc1|imap:INBOX:1');
    expect(providers.acc1.getMessage).toHaveBeenCalledWith('imap:INBOX:1');
    expect(providers.acc2.getMessage).not.toHaveBeenCalled();
    expect(message.id).toBe('acc1|imap:INBOX:1');
  });

  it('routes to acc2 for an acc2-qualified id', async () => {
    await mailService.getMessage('acc2|imap:INBOX:5');
    expect(providers.acc2.getMessage).toHaveBeenCalledWith('imap:INBOX:5');
    expect(providers.acc1.getMessage).not.toHaveBeenCalled();
  });

  it('setRead/setFlagged/moveToFolder/archive/deleteMessage all decode and route the same way', async () => {
    await mailService.setRead('acc1|imap:INBOX:1', true);
    await mailService.setFlagged('acc1|imap:INBOX:1', true);
    await mailService.moveToFolder('acc1|imap:INBOX:1', 'Archive');
    await mailService.archive('acc1|imap:INBOX:1');
    await mailService.deleteMessage('acc1|imap:INBOX:1');
    expect(providers.acc1.log).toEqual([
      'connect',
      'setRead:imap:INBOX:1',
      'setFlagged:imap:INBOX:1',
      'moveToFolder:imap:INBOX:1:Archive',
      'archive:imap:INBOX:1',
      'deleteMessage:imap:INBOX:1',
    ]);
  });

  it('getMessageSummaries groups a mixed batch of ids by account and merges the results', async () => {
    const result = await mailService.getMessageSummaries(['acc1|imap:INBOX:1', 'acc2|imap:INBOX:2']);
    expect(providers.acc1.getMessageSummaries).toHaveBeenCalledWith(['imap:INBOX:1']);
    expect(providers.acc2.getMessageSummaries).toHaveBeenCalledWith(['imap:INBOX:2']);
    expect([...result.keys()].sort()).toEqual(['acc1|imap:INBOX:1', 'acc2|imap:INBOX:2']);
  });

  it('saveDraft/updateDraft qualify and unqualify the draft id through the right account', async () => {
    const { draftId } = await mailService.saveDraft('acc1', {
      to: [],
      subject: '',
      body: {},
    });
    expect(draftId).toBe('acc1|imap:Drafts:1');
    await mailService.updateDraft(draftId, { to: [], subject: '', body: {} });
    expect(providers.acc1.updateDraft).toHaveBeenCalledWith('imap:Drafts:1', expect.anything());
  });

  it('send() takes an explicit accountId since DraftInput carries no message id to derive one from', async () => {
    await mailService.send('acc2', { to: [], subject: '', body: {} });
    expect(providers.acc2.send).toHaveBeenCalled();
    expect(providers.acc1.send).not.toHaveBeenCalled();
  });
});

describe('account-first operations', () => {
  beforeEach(async () => {
    await mailService.connectAccount('/data', 'acc1');
  });

  it('listFolders/listMessages route by explicit accountId, and listMessages qualifies returned ids', async () => {
    const folders = await mailService.listFolders('acc1');
    expect(folders).toEqual([{ id: 'INBOX', displayName: 'Inbox', kind: 'inbox' }]);

    const page = await mailService.listMessages('acc1', { folderId: 'INBOX' });
    expect(page.items[0].id).toBe('acc1|imap:INBOX:1');
  });
});

describe('event qualification', () => {
  it('re-emits a provider event with messageId qualified and accountId attached', async () => {
    await mailService.connectAccount('/data', 'acc1');
    const received: unknown[] = [];
    mailService.onEvent((event) => received.push(event));

    providers.acc1.emitter.emit('event', {
      type: 'newMessage',
      folderId: 'INBOX',
      messageId: 'imap:INBOX:9',
    });

    expect(received).toEqual([
      { type: 'newMessage', folderId: 'INBOX', messageId: 'acc1|imap:INBOX:9', accountId: 'acc1' },
    ]);
  });

  it('attaches accountId to a connectionState event even though it has no message id to decode', async () => {
    await mailService.connectAccount('/data', 'acc1');
    const received: unknown[] = [];
    mailService.onEvent((event) => received.push(event));

    providers.acc1.emitter.emit('event', { type: 'connectionState', state: 'reconnecting' });

    expect(received).toEqual([{ type: 'connectionState', state: 'reconnecting', accountId: 'acc1' }]);
  });

  it('stops re-emitting events from an account after it disconnects', async () => {
    await mailService.connectAccount('/data', 'acc1');
    const received: unknown[] = [];
    mailService.onEvent((event) => received.push(event));
    await mailService.disconnectAccount('acc1');

    providers.acc1.emitter.emit('event', { type: 'connectionState', state: 'degraded' });

    expect(received).toEqual([]);
  });
});

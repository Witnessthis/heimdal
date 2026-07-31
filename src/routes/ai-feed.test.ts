import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailTriage } from '../ai/triage';
import type { EmailMessage } from '../mail/types';

vi.mock('../lib/ai-feed', () => ({ getFeedItems: vi.fn(), removeFeedItem: vi.fn() }));
vi.mock('../lib/sender-preferences', () => ({ resolveSenderPreference: vi.fn() }));
vi.mock('../mail/perform-unsubscribe', () => ({ performOneClickUnsubscribe: vi.fn() }));
vi.mock('../mail/registry', () => ({
  mailService: { getProvider: vi.fn(), isConfigured: vi.fn() },
}));

const { getFeedItems, removeFeedItem } = await import('../lib/ai-feed');
const { resolveSenderPreference } = await import('../lib/sender-preferences');
const { performOneClickUnsubscribe } = await import('../mail/perform-unsubscribe');
const { mailService } = await import('../mail/registry');
const { buildFeedList, executeConfirm } = await import('./ai-feed');

const DATA_DIR = '/data';

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  id: 'imap:INBOX:1',
  messageId: 'msg-1@example.com',
  threadId: 'imap:INBOX:1',
  folderId: 'imap:INBOX',
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [{ address: 'me@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Hi',
  snippet: 'Hi there',
  receivedAt: '2026-07-20T12:00:00Z',
  isRead: false,
  isFlagged: false,
  hasAttachments: false,
  body: { text: 'Hi there' },
  attachments: [],
  references: [],
  unsubscribe: { type: 'none' },
  ...overrides,
});

const triage = (overrides: Partial<EmailTriage> = {}): EmailTriage => ({
  emailId: 'imap:INBOX:1',
  visibility: { type: 'feed' },
  checkSenderPreference: false,
  unsubscribeCandidate: false,
  draftReply: { type: 'none' },
  suspicious: { type: 'no' },
  ...overrides,
});

let sendMock: ReturnType<typeof vi.fn>;
let getMessageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  sendMock = vi.fn().mockResolvedValue({ messageId: 'sent-1' });
  getMessageMock = vi.fn().mockResolvedValue(message());
  vi.mocked(mailService.getProvider).mockReturnValue({
    getMessage: getMessageMock,
    send: sendMock,
  } as unknown as ReturnType<typeof mailService.getProvider>);
});

describe('executeConfirm', () => {
  it('does nothing when nothing was staged', async () => {
    await executeConfirm(DATA_DIR, message(), {});
    expect(resolveSenderPreference).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(performOneClickUnsubscribe).not.toHaveBeenCalled();
  });

  it('resolves the staged sender preference against the message', async () => {
    await executeConfirm(DATA_DIR, message(), { senderPreference: 'hide' });
    expect(resolveSenderPreference).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com', 'hide');
  });

  it('sends the staged (possibly edited) draft reply, threaded to the original message', async () => {
    await executeConfirm(DATA_DIR, message(), {
      draftReply: { subject: 'Re: Hi', body: 'Sounds good!' },
    });
    expect(sendMock).toHaveBeenCalledWith({
      to: [{ name: 'Jane Doe', address: 'jane@example.com' }],
      subject: 'Re: Hi',
      body: { text: 'Sounds good!' },
      inReplyTo: 'msg-1@example.com',
      threadId: 'imap:INBOX:1',
    });
  });

  it('sends a mailto unsubscribe using the real unsubscribe action, not anything from the client', async () => {
    await executeConfirm(
      DATA_DIR,
      message({ unsubscribe: { type: 'mailto', address: 'unsub@example.com', subject: 'Unsubscribe me' } }),
      { unsubscribe: true },
    );
    expect(sendMock).toHaveBeenCalledWith({
      to: [{ address: 'unsub@example.com' }],
      subject: 'Unsubscribe me',
      body: { text: '' },
    });
  });

  it('performs a one-click unsubscribe using the real URL', async () => {
    await executeConfirm(
      DATA_DIR,
      message({ unsubscribe: { type: 'oneClick', url: 'https://example.com/unsub' } }),
      { unsubscribe: true },
    );
    expect(performOneClickUnsubscribe).toHaveBeenCalledWith('https://example.com/unsub');
  });

  it('does nothing server-side for a link unsubscribe — already opened client-side', async () => {
    await executeConfirm(
      DATA_DIR,
      message({ unsubscribe: { type: 'link', url: 'https://example.com/unsub' } }),
      {
        unsubscribe: true,
      },
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(performOneClickUnsubscribe).not.toHaveBeenCalled();
  });

  it('does nothing when unsubscribe is staged but the message has none', async () => {
    await executeConfirm(DATA_DIR, message({ unsubscribe: { type: 'none' } }), { unsubscribe: true });
    expect(sendMock).not.toHaveBeenCalled();
    expect(performOneClickUnsubscribe).not.toHaveBeenCalled();
  });

  it('executes every staged action together in one call', async () => {
    await executeConfirm(
      DATA_DIR,
      message({ unsubscribe: { type: 'oneClick', url: 'https://example.com/unsub' } }),
      {
        senderPreference: 'show',
        draftReply: { subject: 'Re: Hi', body: 'Sounds good!' },
        unsubscribe: true,
      },
    );
    expect(resolveSenderPreference).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com', 'show');
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(performOneClickUnsubscribe).toHaveBeenCalledWith('https://example.com/unsub');
  });
});

describe('buildFeedList', () => {
  it("joins each triage row with the message's current data", async () => {
    vi.mocked(getFeedItems).mockResolvedValue([triage()]);
    getMessageMock.mockResolvedValue(message({ subject: 'Hello there' }));

    const items = await buildFeedList(DATA_DIR);

    expect(items).toEqual([
      {
        triage: triage(),
        from: { name: 'Jane Doe', address: 'jane@example.com' },
        subject: 'Hello there',
        snippet: 'Hi there',
        receivedAt: '2026-07-20T12:00:00Z',
        isRead: false,
        messageId: 'msg-1@example.com',
        threadId: 'imap:INBOX:1',
        unsubscribe: { type: 'none' },
      },
    ]);
  });

  it('drops and cleans up a row whose message no longer exists', async () => {
    vi.mocked(getFeedItems).mockResolvedValue([triage({ emailId: 'imap:INBOX:gone' })]);
    getMessageMock.mockRejectedValue(new Error('not found'));

    const items = await buildFeedList(DATA_DIR);

    expect(items).toEqual([]);
    expect(removeFeedItem).toHaveBeenCalledWith(DATA_DIR, 'imap:INBOX:gone');
  });

  it('keeps healthy rows even when a different row in the same batch is stale', async () => {
    vi.mocked(getFeedItems).mockResolvedValue([
      triage({ emailId: 'imap:INBOX:gone' }),
      triage({ emailId: 'imap:INBOX:ok' }),
    ]);
    getMessageMock.mockImplementation((id: string) =>
      id === 'imap:INBOX:gone' ? Promise.reject(new Error('not found')) : Promise.resolve(message({ id })),
    );

    const items = await buildFeedList(DATA_DIR);

    expect(items).toHaveLength(1);
    expect(removeFeedItem).toHaveBeenCalledWith(DATA_DIR, 'imap:INBOX:gone');
    expect(removeFeedItem).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when nothing is pending', async () => {
    vi.mocked(getFeedItems).mockResolvedValue([]);
    expect(await buildFeedList(DATA_DIR)).toEqual([]);
  });
});

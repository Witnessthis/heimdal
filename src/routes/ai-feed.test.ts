import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailTriage } from '../ai/triage';
import type { EmailMessage, EmailSummary } from '../mail/types';

vi.mock('../lib/ai-feed', () => ({ getFeedItems: vi.fn(), removeFeedItem: vi.fn() }));
vi.mock('../lib/unsubscribe-suppressions', () => ({ isSuppressed: vi.fn(), recordSuppression: vi.fn() }));
vi.mock('../mail/perform-unsubscribe', () => ({ performOneClickUnsubscribe: vi.fn() }));
vi.mock('../mail/registry', () => ({
  mailService: { getProvider: vi.fn(), isConfigured: vi.fn() },
}));

const { getFeedItems, removeFeedItem } = await import('../lib/ai-feed');
const { isSuppressed, recordSuppression } = await import('../lib/unsubscribe-suppressions');
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

const summary = (overrides: Partial<EmailSummary> = {}): EmailSummary => ({
  id: 'imap:INBOX:1',
  messageId: 'msg-1@example.com',
  threadId: 'imap:INBOX:1',
  folderId: 'imap:INBOX',
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [{ address: 'me@example.com' }],
  subject: 'Hi',
  snippet: '',
  receivedAt: '2026-07-20T12:00:00Z',
  isRead: false,
  isFlagged: false,
  hasAttachments: false,
  unsubscribe: { type: 'none' },
  ...overrides,
});

const triage = (overrides: Partial<EmailTriage> = {}): EmailTriage => ({
  emailId: 'imap:INBOX:1',
  visibility: { type: 'feed' },
  draftReply: { type: 'none' },
  suspicious: { type: 'no' },
  ...overrides,
});

let sendMock: ReturnType<typeof vi.fn>;
let getMessageMock: ReturnType<typeof vi.fn>;
let getMessageSummariesMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  sendMock = vi.fn().mockResolvedValue({ messageId: 'sent-1' });
  getMessageMock = vi.fn().mockResolvedValue(message());
  getMessageSummariesMock = vi.fn().mockResolvedValue(new Map([[summary().id, summary()]]));
  vi.mocked(isSuppressed).mockResolvedValue(false);
  vi.mocked(mailService.getProvider).mockReturnValue({
    getMessage: getMessageMock,
    getMessageSummaries: getMessageSummariesMock,
    send: sendMock,
  } as unknown as ReturnType<typeof mailService.getProvider>);
});

describe('executeConfirm', () => {
  it('does nothing when nothing was staged', async () => {
    await executeConfirm(DATA_DIR, message(), {});
    expect(sendMock).not.toHaveBeenCalled();
    expect(performOneClickUnsubscribe).not.toHaveBeenCalled();
    expect(recordSuppression).not.toHaveBeenCalled();
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
      { unsubscribeAction: 'unsubscribe' },
    );
    expect(sendMock).toHaveBeenCalledWith({
      to: [{ address: 'unsub@example.com' }],
      subject: 'Unsubscribe me',
      body: { text: '' },
    });
    expect(recordSuppression).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com', 'unsubscribed');
  });

  it('performs a one-click unsubscribe using the real URL', async () => {
    await executeConfirm(
      DATA_DIR,
      message({ unsubscribe: { type: 'oneClick', url: 'https://example.com/unsub' } }),
      { unsubscribeAction: 'unsubscribe' },
    );
    expect(performOneClickUnsubscribe).toHaveBeenCalledWith('https://example.com/unsub');
    expect(recordSuppression).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com', 'unsubscribed');
  });

  it('does nothing server-side for a link unsubscribe — already opened client-side — but still records suppression', async () => {
    await executeConfirm(
      DATA_DIR,
      message({ unsubscribe: { type: 'link', url: 'https://example.com/unsub' } }),
      {
        unsubscribeAction: 'unsubscribe',
      },
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(performOneClickUnsubscribe).not.toHaveBeenCalled();
    expect(recordSuppression).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com', 'unsubscribed');
  });

  it('records suppression even when the message turns out to have no unsubscribe mechanism', async () => {
    await executeConfirm(DATA_DIR, message({ unsubscribe: { type: 'none' } }), {
      unsubscribeAction: 'unsubscribe',
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(performOneClickUnsubscribe).not.toHaveBeenCalled();
    expect(recordSuppression).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com', 'unsubscribed');
  });

  it('suppress-only records suppression without attempting the real mechanism', async () => {
    await executeConfirm(
      DATA_DIR,
      message({ unsubscribe: { type: 'oneClick', url: 'https://example.com/unsub' } }),
      { unsubscribeAction: 'suppress' },
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(performOneClickUnsubscribe).not.toHaveBeenCalled();
    expect(recordSuppression).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com', 'suppressed');
  });

  it('executes every staged action together in one call', async () => {
    await executeConfirm(
      DATA_DIR,
      message({ unsubscribe: { type: 'oneClick', url: 'https://example.com/unsub' } }),
      {
        draftReply: { subject: 'Re: Hi', body: 'Sounds good!' },
        unsubscribeAction: 'unsubscribe',
      },
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(performOneClickUnsubscribe).toHaveBeenCalledWith('https://example.com/unsub');
    expect(recordSuppression).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com', 'unsubscribed');
  });
});

describe('buildFeedList', () => {
  it("joins each triage row with the message's current summary data", async () => {
    vi.mocked(getFeedItems).mockResolvedValue([triage()]);
    getMessageSummariesMock.mockResolvedValue(
      new Map([['imap:INBOX:1', summary({ subject: 'Hello there' })]]),
    );

    const items = await buildFeedList(DATA_DIR);

    expect(getMessageSummariesMock).toHaveBeenCalledWith(['imap:INBOX:1']);
    expect(items).toEqual([
      {
        triage: triage(),
        from: { name: 'Jane Doe', address: 'jane@example.com' },
        subject: 'Hello there',
        receivedAt: '2026-07-20T12:00:00Z',
        isRead: false,
        messageId: 'msg-1@example.com',
        threadId: 'imap:INBOX:1',
        unsubscribe: { type: 'none' },
        unsubscribeEligible: false,
      },
    ]);
  });

  it('is unsubscribe-eligible when the message has a real mechanism and the sender is not suppressed', async () => {
    vi.mocked(getFeedItems).mockResolvedValue([triage()]);
    vi.mocked(isSuppressed).mockResolvedValue(false);
    getMessageSummariesMock.mockResolvedValue(
      new Map([
        ['imap:INBOX:1', summary({ unsubscribe: { type: 'oneClick', url: 'https://example.com/unsub' } })],
      ]),
    );

    const [item] = await buildFeedList(DATA_DIR);

    expect(item.unsubscribeEligible).toBe(true);
  });

  it('is not unsubscribe-eligible once the sender has already been suppressed', async () => {
    vi.mocked(getFeedItems).mockResolvedValue([triage()]);
    vi.mocked(isSuppressed).mockResolvedValue(true);
    getMessageSummariesMock.mockResolvedValue(
      new Map([
        ['imap:INBOX:1', summary({ unsubscribe: { type: 'oneClick', url: 'https://example.com/unsub' } })],
      ]),
    );

    const [item] = await buildFeedList(DATA_DIR);

    expect(item.unsubscribeEligible).toBe(false);
  });

  it('drops and cleans up a row whose message no longer exists', async () => {
    vi.mocked(getFeedItems).mockResolvedValue([triage({ emailId: 'imap:INBOX:gone' })]);
    getMessageSummariesMock.mockResolvedValue(new Map());

    const items = await buildFeedList(DATA_DIR);

    expect(items).toEqual([]);
    expect(removeFeedItem).toHaveBeenCalledWith(DATA_DIR, 'imap:INBOX:gone');
  });

  it('keeps healthy rows even when a different row in the same batch is stale', async () => {
    vi.mocked(getFeedItems).mockResolvedValue([
      triage({ emailId: 'imap:INBOX:gone' }),
      triage({ emailId: 'imap:INBOX:ok' }),
    ]);
    getMessageSummariesMock.mockResolvedValue(new Map([['imap:INBOX:ok', summary({ id: 'imap:INBOX:ok' })]]));

    const items = await buildFeedList(DATA_DIR);

    expect(items).toHaveLength(1);
    expect(removeFeedItem).toHaveBeenCalledWith(DATA_DIR, 'imap:INBOX:gone');
    expect(removeFeedItem).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list when nothing is pending, without calling the provider at all', async () => {
    vi.mocked(getFeedItems).mockResolvedValue([]);
    expect(await buildFeedList(DATA_DIR)).toEqual([]);
    expect(getMessageSummariesMock).not.toHaveBeenCalled();
  });
});

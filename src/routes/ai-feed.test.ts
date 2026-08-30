import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailTriage } from '../ai/triage';
import type { EmailMessage, EmailSummary } from '../mail/types';

vi.mock('../ai/memory-update', () => ({ buildMemoryEvent: vi.fn(), scheduleMemoryUpdate: vi.fn() }));
vi.mock('../lib/ai-feed', () => ({ getFeedItems: vi.fn(), removeFeedItem: vi.fn() }));
vi.mock('../lib/unsubscribe-suppressions', () => ({ isSuppressed: vi.fn(), recordSuppression: vi.fn() }));
vi.mock('../mail/perform-unsubscribe', () => ({ performOneClickUnsubscribe: vi.fn() }));
vi.mock('../mail/registry', () => ({
  mailService: { getProvider: vi.fn(), isConfigured: vi.fn() },
}));

const { buildMemoryEvent, scheduleMemoryUpdate } = await import('../ai/memory-update');
const { getFeedItems, removeFeedItem } = await import('../lib/ai-feed');
const { isSuppressed, recordSuppression } = await import('../lib/unsubscribe-suppressions');
const { performOneClickUnsubscribe } = await import('../mail/perform-unsubscribe');
const { mailService } = await import('../mail/registry');
const { buildFeedList, executeConfirm, describeCardAction, logCardActionForMemory } = await import(
  './ai-feed'
);

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
  vi.mocked(buildMemoryEvent).mockReturnValue('event description');
  vi.mocked(scheduleMemoryUpdate).mockResolvedValue(undefined);
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

describe('describeCardAction', () => {
  describe('confirmed', () => {
    it('describes nothing staged', () => {
      expect(describeCardAction({}, true)).toBe('confirmed with nothing staged');
    });

    it('describes a sent draft reply', () => {
      expect(describeCardAction({ draftReply: { subject: 'Re: Hi', body: 'ok' } }, true)).toBe(
        'confirmed — sent the drafted reply',
      );
    });

    it('describes an unsubscribe-and-suppress choice', () => {
      expect(describeCardAction({ unsubscribeAction: 'unsubscribe' }, true)).toBe(
        "confirmed — chose 'Unsubscribe & suppress' for this sender",
      );
    });

    it('describes a suppress-only choice', () => {
      expect(describeCardAction({ unsubscribeAction: 'suppress' }, true)).toBe(
        "confirmed — chose 'Suppress only' for this sender",
      );
    });

    it('combines a draft reply and an unsubscribe choice made in the same confirm', () => {
      expect(
        describeCardAction(
          {
            draftReply: { subject: 'Re: Hi', body: 'ok' },
            unsubscribeAction: 'suppress',
          },
          true,
        ),
      ).toBe("confirmed — sent the drafted reply; chose 'Suppress only' for this sender");
    });

    it('still reports a category preference alongside other staged actions', () => {
      expect(describeCardAction({ unsubscribeAction: 'suppress', categoryPreference: 'less' }, true)).toBe(
        "confirmed — chose 'Suppress only' for this sender; explicitly said they want to see fewer emails like this in the Feed — a deliberate, unambiguous signal",
      );
    });
  });

  describe('dismissed', () => {
    it('is null for a plain dismiss with no category preference — too ambiguous to learn from', () => {
      expect(describeCardAction({}, false)).toBeNull();
    });

    it('describes a "show more" preference set before dismissing', () => {
      expect(describeCardAction({ categoryPreference: 'more' }, false)).toBe(
        'dismissed — explicitly said they want to keep seeing emails like this in the Feed — a deliberate, unambiguous signal',
      );
    });

    it('describes a "show less" preference set before dismissing', () => {
      expect(describeCardAction({ categoryPreference: 'less' }, false)).toBe(
        'dismissed — explicitly said they want to see fewer emails like this in the Feed — a deliberate, unambiguous signal',
      );
    });
  });
});

describe('logCardActionForMemory', () => {
  it('folds the action into the memory file using the full current message — body included, not just the summary', async () => {
    getMessageMock.mockResolvedValue(message());

    await logCardActionForMemory(DATA_DIR, triage(), 'dismissed without acting on it');

    expect(getMessageMock).toHaveBeenCalledWith('imap:INBOX:1');
    expect(buildMemoryEvent).toHaveBeenCalledWith(message(), triage(), 'dismissed without acting on it');
    expect(scheduleMemoryUpdate).toHaveBeenCalledWith(DATA_DIR, 'event description');
  });

  it('propagates (for its fire-and-forget caller to swallow) when the message no longer exists', async () => {
    getMessageMock.mockRejectedValue(new Error('not found'));

    await expect(
      logCardActionForMemory(DATA_DIR, triage(), 'dismissed without acting on it'),
    ).rejects.toThrow('not found');
    expect(scheduleMemoryUpdate).not.toHaveBeenCalled();
  });
});

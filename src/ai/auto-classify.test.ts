import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailEvent } from '../mail/provider';
import type { EmailMessage } from '../mail/types';
import type { EmailTriage } from './triage';

vi.mock('../mail/registry', () => ({
  mailService: { onEvent: vi.fn(() => () => {}), getProvider: vi.fn() },
}));
vi.mock('./triage', () => ({ classifyEmail: vi.fn() }));
vi.mock('./email-for-model', () => ({ buildEmailForModel: vi.fn() }));
vi.mock('../lib/ai-feed', () => ({ upsertFeedItem: vi.fn(), getFeedItems: vi.fn() }));
vi.mock('../lib/language-settings', () => ({ getSpokenLanguages: vi.fn() }));
vi.mock('../lib/memory-notes', () => ({ getMemory: vi.fn() }));
vi.mock('../lib/send-push', () => ({ sendFeedNotification: vi.fn() }));
vi.mock('../lib/unsubscribe-suppressions', () => ({ isSuppressed: vi.fn() }));

const { mailService } = await import('../mail/registry');
const { classifyEmail } = await import('./triage');
const { buildEmailForModel } = await import('./email-for-model');
const { upsertFeedItem, getFeedItems } = await import('../lib/ai-feed');
const { getSpokenLanguages } = await import('../lib/language-settings');
const { getMemory } = await import('../lib/memory-notes');
const { sendFeedNotification } = await import('../lib/send-push');
const { isSuppressed } = await import('../lib/unsubscribe-suppressions');
const { startAutoClassification } = await import('./auto-classify');

const DATA_DIR = '/data';

const message: EmailMessage = {
  id: 'imap:INBOX:1',
  threadId: 'imap:INBOX:1',
  folderId: 'imap:INBOX',
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [{ address: 'me@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Hi',
  snippet: 'Hi there',
  receivedAt: '2026-07-19T12:00:00Z',
  isRead: false,
  isFlagged: false,
  hasAttachments: false,
  body: { text: 'Hi there' },
  attachments: [],
  references: [],
  unsubscribe: { type: 'none' },
};

const triage = (overrides: Partial<EmailTriage> = {}): EmailTriage => ({
  emailId: message.id,
  visibility: { type: 'feed' },
  draftReply: { type: 'none' },
  suspicious: { type: 'no' },
  ...overrides,
});

// The listener is registered inside startAutoClassification, not exported
// directly — capturing it off the mocked onEvent() call is how these tests
// drive it, same as mailService itself would.
function captureListener(): (event: MailEvent) => void {
  startAutoClassification(DATA_DIR);
  const call = vi.mocked(mailService.onEvent).mock.calls.at(-1);
  if (!call) throw new Error('startAutoClassification did not call mailService.onEvent');
  return call[0];
}

// handleNewMessage runs un-awaited behind the listener (see auto-classify's
// own doc comment on why: an EventEmitter listener has no caller to
// propagate a rejection to) — tests wait for its effects rather than its
// return value.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mailService.onEvent).mockReturnValue(() => {});
  vi.mocked(mailService.getProvider).mockReturnValue({
    getMessage: vi.fn().mockResolvedValue(message),
  } as unknown as ReturnType<typeof mailService.getProvider>);
  vi.mocked(buildEmailForModel).mockReturnValue({
    id: message.id,
    threadId: message.threadId,
    from: message.from,
    to: message.to,
    subject: message.subject,
    snippet: message.snippet,
    receivedAt: message.receivedAt,
    isRead: message.isRead,
    body: message.body.text,
  });
  vi.mocked(getSpokenLanguages).mockResolvedValue([]);
  vi.mocked(getMemory).mockResolvedValue('');
  vi.mocked(classifyEmail).mockResolvedValue(triage());
  vi.mocked(getFeedItems).mockResolvedValue([triage()]);
  vi.mocked(isSuppressed).mockResolvedValue(false);
});

describe('startAutoClassification', () => {
  it('passes the stored spoken-languages setting through to classifyEmail', async () => {
    vi.mocked(getSpokenLanguages).mockResolvedValue(['English', 'Danish']);
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() =>
      expect(classifyEmail).toHaveBeenCalledWith(expect.anything(), {
        userLanguages: ['English', 'Danish'],
        memory: '',
      }),
    );
  });

  it('passes the stored personalized-memory notes through to classifyEmail', async () => {
    vi.mocked(getMemory).mockResolvedValue('- The user dismisses most newsletters.');
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() =>
      expect(classifyEmail).toHaveBeenCalledWith(expect.anything(), {
        userLanguages: [],
        memory: '- The user dismisses most newsletters.',
      }),
    );
  });

  it('ignores events other than newMessage', async () => {
    const listener = captureListener();
    listener({ type: 'connectionState', state: 'connected' });
    listener({ type: 'messageUpdated', messageId: message.id });
    listener({ type: 'messageDeleted', messageId: message.id });
    await flush();

    expect(mailService.getProvider).not.toHaveBeenCalled();
  });

  it('classifies and persists a normal message', async () => {
    const result = triage();
    vi.mocked(classifyEmail).mockResolvedValue(result);
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() => expect(upsertFeedItem).toHaveBeenCalledWith(DATA_DIR, result));
  });

  it('does nothing further when the model never produced a valid response', async () => {
    vi.mocked(classifyEmail).mockResolvedValue(null);
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() => expect(classifyEmail).toHaveBeenCalled());
    await flush();

    expect(upsertFeedItem).not.toHaveBeenCalled();
  });

  it('sends a push notification when the model classifies visibility as feed', async () => {
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() =>
      expect(sendFeedNotification).toHaveBeenCalledWith(DATA_DIR, {
        title: message.subject,
        body: message.snippet,
        emailId: message.id,
        count: 1,
      }),
    );
  });

  it.each([
    'snooze',
    'filtered',
  ] as const)('does not send a push notification when visibility is %s', async (visibilityType) => {
    vi.mocked(classifyEmail).mockResolvedValue(
      triage({
        visibility:
          visibilityType === 'snooze'
            ? { type: 'snooze', until: '2026-08-01T00:00:00Z' }
            : { type: 'filtered' },
      }),
    );
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() => expect(classifyEmail).toHaveBeenCalled());
    await flush();

    expect(sendFeedNotification).not.toHaveBeenCalled();
  });

  it('logs and swallows a failure instead of throwing out of the listener', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(mailService.getProvider).mockReturnValue({
      getMessage: vi.fn().mockRejectedValue(new Error('IMAP unreachable')),
    } as unknown as ReturnType<typeof mailService.getProvider>);
    const listener = captureListener();

    expect(() =>
      listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id }),
    ).not.toThrow();
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());

    consoleError.mockRestore();
  });
});

describe('unsubscribe-eligible mail', () => {
  const eligibleMessage: EmailMessage = {
    ...message,
    unsubscribe: { type: 'oneClick', url: 'https://example.com/unsub' },
  };

  function mockMessage(msg: EmailMessage): void {
    vi.mocked(mailService.getProvider).mockReturnValue({
      getMessage: vi.fn().mockResolvedValue(msg),
    } as unknown as ReturnType<typeof mailService.getProvider>);
  }

  it('forces visibility to feed even when the model classifies it as filtered', async () => {
    mockMessage(eligibleMessage);
    vi.mocked(classifyEmail).mockResolvedValue(triage({ visibility: { type: 'filtered' } }));
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() =>
      expect(upsertFeedItem).toHaveBeenCalledWith(
        DATA_DIR,
        expect.objectContaining({ visibility: { type: 'feed' } }),
      ),
    );
  });

  it('forces visibility to feed even when the model classifies it as snooze', async () => {
    mockMessage(eligibleMessage);
    vi.mocked(classifyEmail).mockResolvedValue(
      triage({ visibility: { type: 'snooze', until: '2026-08-01T00:00:00Z' } }),
    );
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() =>
      expect(upsertFeedItem).toHaveBeenCalledWith(
        DATA_DIR,
        expect.objectContaining({ visibility: { type: 'feed' } }),
      ),
    );
  });

  it('produces a minimal feed entry even when the model never produced a valid response', async () => {
    mockMessage(eligibleMessage);
    vi.mocked(classifyEmail).mockResolvedValue(null);
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() =>
      expect(upsertFeedItem).toHaveBeenCalledWith(DATA_DIR, {
        emailId: message.id,
        visibility: { type: 'feed' },
        draftReply: { type: 'none' },
        suspicious: { type: 'no' },
      }),
    );
  });

  it('fully blocks a suppressed sender — never even reaches the model, same as a hidden sender', async () => {
    mockMessage(eligibleMessage);
    vi.mocked(isSuppressed).mockResolvedValue(true);
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() => expect(isSuppressed).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com'));
    await flush();

    expect(classifyEmail).not.toHaveBeenCalled();
    expect(upsertFeedItem).not.toHaveBeenCalled();
  });
});

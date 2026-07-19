import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailEvent } from '../mail/provider';
import type { EmailMessage } from '../mail/types';
import type { EmailTriage } from './triage';

vi.mock('../mail/registry', () => ({
  mailService: { onEvent: vi.fn(() => () => {}), getProvider: vi.fn() },
}));
vi.mock('./triage', () => ({ classifyEmail: vi.fn() }));
vi.mock('./email-for-model', () => ({ buildEmailForModel: vi.fn() }));
vi.mock('../lib/sender-preferences', () => ({
  getSenderPreference: vi.fn(),
  markSenderPending: vi.fn(),
}));
vi.mock('../lib/ai-feed', () => ({ upsertFeedItem: vi.fn() }));
vi.mock('../lib/language-settings', () => ({ getSpokenLanguages: vi.fn() }));

const { mailService } = await import('../mail/registry');
const { classifyEmail } = await import('./triage');
const { buildEmailForModel } = await import('./email-for-model');
const { getSenderPreference, markSenderPending } = await import('../lib/sender-preferences');
const { upsertFeedItem } = await import('../lib/ai-feed');
const { getSpokenLanguages } = await import('../lib/language-settings');
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
  checkSenderPreference: false,
  unsubscribeCandidate: false,
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
  vi.mocked(getSenderPreference).mockResolvedValue(undefined);
  vi.mocked(getSpokenLanguages).mockResolvedValue([]);
  vi.mocked(classifyEmail).mockResolvedValue(triage());
});

describe('startAutoClassification', () => {
  it('passes the stored spoken-languages setting through to classifyEmail', async () => {
    vi.mocked(getSpokenLanguages).mockResolvedValue(['English', 'Danish']);
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() =>
      expect(classifyEmail).toHaveBeenCalledWith(expect.anything(), {
        userLanguages: ['English', 'Danish'],
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

  it('skips a sender the user has marked hide without calling the model', async () => {
    vi.mocked(getSenderPreference).mockResolvedValue('hide');
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() => expect(getSenderPreference).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com'));
    await flush();

    expect(classifyEmail).not.toHaveBeenCalled();
    expect(upsertFeedItem).not.toHaveBeenCalled();
  });

  it.each([
    'pending',
    'show',
    undefined,
  ] as const)('classifies and persists when sender preference is %s', async (preference) => {
    vi.mocked(getSenderPreference).mockResolvedValue(preference);
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

    expect(markSenderPending).not.toHaveBeenCalled();
    expect(upsertFeedItem).not.toHaveBeenCalled();
  });

  it('marks the sender pending when the model flags checkSenderPreference', async () => {
    vi.mocked(classifyEmail).mockResolvedValue(triage({ checkSenderPreference: true }));
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() => expect(markSenderPending).toHaveBeenCalledWith(DATA_DIR, 'jane@example.com'));
  });

  it('does not mark the sender pending when checkSenderPreference is false', async () => {
    const listener = captureListener();

    listener({ type: 'newMessage', folderId: 'imap:INBOX', messageId: message.id });
    await vi.waitFor(() => expect(upsertFeedItem).toHaveBeenCalled());

    expect(markSenderPending).not.toHaveBeenCalled();
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

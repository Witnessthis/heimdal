import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailMessage } from '../mail/types';
import type { EmailTriage } from './triage';

vi.mock('../mail/registry', () => ({ mailService: { getMessage: vi.fn() } }));
vi.mock('./triage', () => ({ classifyEmail: vi.fn() }));
vi.mock('./email-for-model', () => ({ buildEmailForModel: vi.fn() }));
vi.mock('../lib/ai-feed', () => ({ upsertFeedItem: vi.fn() }));
vi.mock('../lib/language-settings', () => ({ getSpokenLanguages: vi.fn() }));
vi.mock('../lib/memory-notes', () => ({ getMemory: vi.fn() }));
vi.mock('./memory-update', () => ({ buildMemoryEvent: vi.fn(), scheduleMemoryUpdate: vi.fn() }));

const { mailService } = await import('../mail/registry');
const { classifyEmail } = await import('./triage');
const { buildEmailForModel } = await import('./email-for-model');
const { upsertFeedItem } = await import('../lib/ai-feed');
const { getSpokenLanguages } = await import('../lib/language-settings');
const { getMemory } = await import('../lib/memory-notes');
const { buildMemoryEvent, scheduleMemoryUpdate } = await import('./memory-update');
const { reprocessMessage } = await import('./reprocess');

const DATA_DIR = '/data';
const ACCOUNT_ID = 'acc1';

const message: EmailMessage = {
  id: `${ACCOUNT_ID}|imap:INBOX:1`,
  messageId: 'msg-1@example.com',
  threadId: 'imap:INBOX:1',
  folderId: 'imap:INBOX',
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [{ address: 'me@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Your package has shipped',
  snippet: 'Your package has shipped',
  receivedAt: '2026-08-30T12:00:00Z',
  isRead: false,
  isFlagged: false,
  hasAttachments: false,
  body: { text: 'Your package has shipped' },
  attachments: [],
  references: [],
  unsubscribe: { type: 'none' },
};

const triage = (overrides: Partial<EmailTriage> = {}): EmailTriage => ({
  emailId: message.id,
  accountId: ACCOUNT_ID,
  visibility: { type: 'filtered' },
  draftReply: { type: 'none' },
  suspicious: { type: 'no' },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mailService.getMessage).mockResolvedValue(message);
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
  vi.mocked(buildMemoryEvent).mockReturnValue('event description');
  vi.mocked(scheduleMemoryUpdate).mockResolvedValue(undefined);
});

describe('reprocessMessage', () => {
  it('forces visibility to feed over a filtered verdict', async () => {
    vi.mocked(classifyEmail).mockResolvedValue(triage({ visibility: { type: 'filtered' } }));

    await reprocessMessage(DATA_DIR, message.id);

    expect(upsertFeedItem).toHaveBeenCalledWith(
      DATA_DIR,
      expect.objectContaining({ visibility: { type: 'feed' } }),
    );
  });

  it('forces visibility to feed over a snooze verdict', async () => {
    vi.mocked(classifyEmail).mockResolvedValue(
      triage({ visibility: { type: 'snooze', until: '2026-09-01T00:00:00Z' } }),
    );

    await reprocessMessage(DATA_DIR, message.id);

    expect(upsertFeedItem).toHaveBeenCalledWith(
      DATA_DIR,
      expect.objectContaining({ visibility: { type: 'feed' } }),
    );
  });

  it('builds a minimal fallback triage when classification returns null', async () => {
    vi.mocked(classifyEmail).mockResolvedValue(null);

    await reprocessMessage(DATA_DIR, message.id);

    expect(upsertFeedItem).toHaveBeenCalledWith(DATA_DIR, {
      emailId: message.id,
      accountId: ACCOUNT_ID,
      visibility: { type: 'feed' },
      draftReply: { type: 'none' },
      suspicious: { type: 'no' },
    });
  });

  it('never checks suppression — a direct, targeted request overrides it', async () => {
    await reprocessMessage(DATA_DIR, message.id);
    expect(classifyEmail).toHaveBeenCalled();
  });

  it('passes the stored spoken-languages and memory settings through to classifyEmail', async () => {
    vi.mocked(getSpokenLanguages).mockResolvedValue(['English', 'Danish']);
    vi.mocked(getMemory).mockResolvedValue('- The user dismisses most newsletters.');

    await reprocessMessage(DATA_DIR, message.id);

    expect(classifyEmail).toHaveBeenCalledWith(expect.anything(), {
      userLanguages: ['English', 'Danish'],
      memory: '- The user dismisses most newsletters.',
    });
    expect(getSpokenLanguages).toHaveBeenCalledWith(DATA_DIR, ACCOUNT_ID);
    expect(getMemory).toHaveBeenCalledWith(DATA_DIR, ACCOUNT_ID);
  });

  it('names the original verdict in the memory event when overriding it', async () => {
    vi.mocked(classifyEmail).mockResolvedValue(triage({ visibility: { type: 'filtered' } }));

    await reprocessMessage(DATA_DIR, message.id);

    expect(buildMemoryEvent).toHaveBeenCalledWith(
      message,
      expect.objectContaining({ visibility: { type: 'feed' } }),
      expect.stringContaining('visibility=filtered'),
    );
  });

  it('uses a different summary when the AI already had it visible', async () => {
    vi.mocked(classifyEmail).mockResolvedValue(triage({ visibility: { type: 'feed' } }));

    await reprocessMessage(DATA_DIR, message.id);

    expect(buildMemoryEvent).toHaveBeenCalledWith(
      message,
      expect.objectContaining({ visibility: { type: 'feed' } }),
      expect.stringContaining('the AI already had it visible'),
    );
  });

  it('names a null classification in the memory event too', async () => {
    vi.mocked(classifyEmail).mockResolvedValue(null);

    await reprocessMessage(DATA_DIR, message.id);

    expect(buildMemoryEvent).toHaveBeenCalledWith(
      message,
      expect.objectContaining({ visibility: { type: 'feed' } }),
      expect.stringContaining('no valid classification produced'),
    );
  });

  it('schedules the built memory event', async () => {
    await reprocessMessage(DATA_DIR, message.id);
    expect(scheduleMemoryUpdate).toHaveBeenCalledWith(DATA_DIR, ACCOUNT_ID, 'event description');
  });
});

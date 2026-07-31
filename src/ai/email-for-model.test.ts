import { describe, expect, it } from 'vitest';
import type { EmailMessage } from '../mail/types';
import { buildEmailForModel } from './email-for-model';

const baseMessage: EmailMessage = {
  id: 'imap:INBOX:42',
  threadId: 'imap:INBOX:42',
  folderId: 'imap:INBOX',
  from: { name: 'Jane Doe', address: 'jane@example.com' },
  to: [{ address: 'me@example.com' }],
  cc: [],
  bcc: [],
  subject: 'Lunch?',
  snippet: 'Are you free for lunch?',
  receivedAt: '2026-07-19T12:00:00Z',
  isRead: false,
  isFlagged: false,
  hasAttachments: false,
  body: { text: 'Are you free for lunch tomorrow?' },
  attachments: [],
  references: [],
  unsubscribe: { type: 'none' },
};

describe('field mapping', () => {
  it('maps every straightforward field across unchanged', () => {
    const result = buildEmailForModel(baseMessage);
    expect(result.id).toBe('imap:INBOX:42');
    expect(result.threadId).toBe('imap:INBOX:42');
    expect(result.from).toEqual({ name: 'Jane Doe', address: 'jane@example.com' });
    expect(result.to).toEqual([{ address: 'me@example.com' }]);
    expect(result.subject).toBe('Lunch?');
    expect(result.snippet).toBe('Are you free for lunch?');
    expect(result.receivedAt).toBe('2026-07-19T12:00:00Z');
    expect(result.isRead).toBe(false);
  });

  it('maps folderId to folderHint', () => {
    expect(buildEmailForModel(baseMessage).folderHint).toBe('imap:INBOX');
  });

  it('never populates threadSummary — not built yet, deliberately', () => {
    expect(buildEmailForModel(baseMessage).threadSummary).toBeUndefined();
  });

  it('works identically for a differently-shaped provider id — nothing here is IMAP-specific', () => {
    const gmailShaped: EmailMessage = {
      ...baseMessage,
      id: 'gmail:18c2f9e1a2b3c4d5',
      threadId: 'gmail:thread-1',
    };
    const result = buildEmailForModel(gmailShaped);
    expect(result.id).toBe('gmail:18c2f9e1a2b3c4d5');
    expect(result.threadId).toBe('gmail:thread-1');
  });
});

describe('body extraction', () => {
  it('prefers plain text when present', () => {
    const message: EmailMessage = {
      ...baseMessage,
      body: { text: 'plain version', html: '<p>html version</p>' },
    };
    expect(buildEmailForModel(message).body).toBe('plain version');
  });

  it('falls back to stripped html when there is no plain-text part', () => {
    const message: EmailMessage = { ...baseMessage, body: { html: '<p>Are you free <b>tomorrow</b>?</p>' } };
    expect(buildEmailForModel(message).body).toBe('Are you free tomorrow?');
  });

  it('excludes script content when falling back to html', () => {
    const message: EmailMessage = {
      ...baseMessage,
      body: { html: '<div>Hello there</div><script>trackUser(); stealCookies();</script>' },
    };
    const body = buildEmailForModel(message).body;
    expect(body).toContain('Hello there');
    expect(body).not.toContain('trackUser');
    expect(body).not.toContain('stealCookies');
  });

  it('excludes style content when falling back to html', () => {
    const message: EmailMessage = {
      ...baseMessage,
      body: {
        html: '<div>Hello there</div><style>.foo { color: red; font-family: tracking-pixel-reset; }</style>',
      },
    };
    const body = buildEmailForModel(message).body;
    expect(body).toContain('Hello there');
    expect(body).not.toContain('tracking-pixel-reset');
  });

  it('leaves body undefined when there is neither text nor html', () => {
    const message: EmailMessage = { ...baseMessage, body: {} };
    expect(buildEmailForModel(message).body).toBeUndefined();
  });
});

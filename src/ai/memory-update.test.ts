import { describe, expect, it } from 'vitest';
import { buildMemoryEvent } from './memory-update';
import type { EmailTriage } from './triage-schema';

const triage = (overrides: Partial<EmailTriage> = {}): EmailTriage => ({
  emailId: 'imap:INBOX:1',
  visibility: { type: 'feed' },
  draftReply: { type: 'none' },
  suspicious: { type: 'no' },
  ...overrides,
});

describe('buildMemoryEvent', () => {
  it('includes the sender name and address, subject, AI read, and the action taken', () => {
    const event = buildMemoryEvent(
      { from: { name: 'Jane Doe', address: 'jane@example.com' }, subject: 'Weekly deals', body: {} },
      triage({ visibility: { type: 'filtered' } }),
      'dismissed without acting on it',
    );

    expect(event).toContain('Jane Doe <jane@example.com>');
    expect(event).toContain('Weekly deals');
    expect(event).toContain('visibility=filtered');
    expect(event).toContain('suspicious=no');
    expect(event).toContain('draftReply=none');
    expect(event).toContain('dismissed without acting on it');
  });

  it('falls back to just the address when there is no display name', () => {
    const event = buildMemoryEvent(
      { from: { address: 'noreply@example.com' }, subject: 'Receipt', body: {} },
      triage(),
      'dismissed without acting on it',
    );

    expect(event).toContain('noreply@example.com');
    expect(event).not.toContain('<noreply@example.com>');
  });

  it('falls back to a placeholder for a missing subject', () => {
    const event = buildMemoryEvent(
      { from: { address: 'a@example.com' }, subject: '', body: {} },
      triage(),
      'confirmed',
    );

    expect(event).toContain('(no subject)');
  });

  it('includes a plain-text excerpt of the body — the content needed to spot what makes a dissenting instance different', () => {
    const event = buildMemoryEvent(
      {
        from: { address: 'ups.com' },
        subject: 'Your package has shipped',
        body: { text: 'Your order #123 has shipped and is on its way.' },
      },
      triage(),
      'dismissed without acting on it',
    );

    expect(event).toContain('Excerpt: Your order #123 has shipped and is on its way.');
  });

  it('falls back to a stripped plain-text version of the HTML body when there is no text part', () => {
    const event = buildMemoryEvent(
      {
        from: { address: 'a@example.com' },
        subject: 'Hi',
        body: { html: '<p>Hello <strong>there</strong></p>' },
      },
      triage(),
      'confirmed',
    );

    expect(event).toContain('Excerpt: Hello there');
  });

  it('omits the excerpt line entirely when there is no body content at all', () => {
    const event = buildMemoryEvent(
      { from: { address: 'a@example.com' }, subject: 'Hi', body: {} },
      triage(),
      'confirmed',
    );

    expect(event).not.toContain('Excerpt:');
  });

  it('truncates a long body rather than passing the whole thing through', () => {
    const longBody = 'x'.repeat(1000);
    const event = buildMemoryEvent(
      { from: { address: 'a@example.com' }, subject: 'Hi', body: { text: longBody } },
      triage(),
      'confirmed',
    );

    expect(event).toContain(`Excerpt: ${'x'.repeat(300)}…`);
    expect(event).not.toContain('x'.repeat(301));
  });
});

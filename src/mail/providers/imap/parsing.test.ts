import type { MessageEnvelopeObject } from 'imapflow';
import type { Attachment as MailparserAttachment } from 'mailparser';
import { describe, expect, it } from 'vitest';
import {
  computeThreadId,
  decodeMessageId,
  encodeMessageId,
  folderKindFromSpecialUse,
  parseReferencesHeader,
  resolveInlineImages,
} from './index';

describe('message id encode/decode', () => {
  it('round-trips a folder path and uid', () => {
    const id = encodeMessageId('INBOX', 4213);
    expect(decodeMessageId(id)).toEqual({ folderPath: 'INBOX', uid: 4213 });
  });

  it('survives a folder name containing the delimiter and other awkward chars', () => {
    const folder = 'Archive/2024:Q1 [work]';
    const id = encodeMessageId(folder, 7);
    // The colon in the folder name must not confuse the 3-part split.
    expect(decodeMessageId(id)).toEqual({ folderPath: folder, uid: 7 });
  });

  it('rejects a malformed id, wrong prefix, or non-positive uid', () => {
    expect(() => decodeMessageId('INBOX:1')).toThrow(); // missing prefix / wrong part count
    expect(() => decodeMessageId('notimap:INBOX:1')).toThrow();
    expect(() => decodeMessageId('imap:INBOX:0')).toThrow();
    expect(() => decodeMessageId('imap:INBOX:-3')).toThrow();
    expect(() => decodeMessageId('imap:INBOX:notanumber')).toThrow();
  });
});

describe('parseReferencesHeader', () => {
  it('returns an empty list for missing headers', () => {
    expect(parseReferencesHeader(undefined)).toEqual([]);
  });

  it('extracts message-ids in order with angle brackets stripped', () => {
    const header = Buffer.from('References: <a@x.com> <b@x.com> <c@x.com>\r\n');
    expect(parseReferencesHeader(header)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('joins folded continuation lines instead of truncating at the first fold', () => {
    // RFC 5322 folding: a long References header wrapped across lines, each
    // continuation starting with whitespace. Naively reading one line would
    // drop b@ and c@.
    const header = Buffer.from('References: <a@x.com>\r\n <b@x.com>\r\n\t<c@x.com>\r\n');
    expect(parseReferencesHeader(header)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('stops at the next header and does not swallow following fields', () => {
    const header = Buffer.from('References: <a@x.com>\r\nSubject: <not-a-ref@x.com>\r\n');
    expect(parseReferencesHeader(header)).toEqual(['a@x.com']);
  });
});

describe('computeThreadId', () => {
  const env = (fields: Partial<MessageEnvelopeObject>) => fields as MessageEnvelopeObject;

  it('uses the oldest References ancestor when present (3+ message threads)', () => {
    const headers = Buffer.from('References: <root@x.com> <mid@x.com>\r\n');
    expect(computeThreadId(env({ inReplyTo: '<mid@x.com>' }), headers)).toBe('root@x.com');
  });

  it('falls back to In-Reply-To when there is no References chain', () => {
    expect(computeThreadId(env({ inReplyTo: '<parent@x.com>' }), undefined)).toBe('parent@x.com');
  });

  it("falls back to the message's own id for a thread starter", () => {
    expect(computeThreadId(env({ messageId: '<self@x.com>' }), undefined)).toBe('self@x.com');
  });
});

describe('resolveInlineImages', () => {
  const inline = (cid: string, bytes: string): MailparserAttachment =>
    ({
      cid,
      contentType: 'image/png',
      content: Buffer.from(bytes),
    }) as unknown as MailparserAttachment;

  it('rewrites a cid: reference into a data URI from the already-fetched bytes', () => {
    const html = '<img src="cid:logo123">';
    const out = resolveInlineImages(html, [inline('logo123', 'PNGDATA')]);
    expect(out).toBe(`<img src="data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}">`);
  });

  it('leaves an unresolvable cid untouched', () => {
    const html = '<img src="cid:missing">';
    expect(resolveInlineImages(html, [inline('other', 'x')])).toBe(html);
  });

  it('returns the html unchanged when there are no inline images', () => {
    const html = '<img src="cid:whatever"><p>hi</p>';
    expect(resolveInlineImages(html, [])).toBe(html);
  });
});

describe('folderKindFromSpecialUse', () => {
  it('maps IMAP SPECIAL-USE flags directly', () => {
    expect(folderKindFromSpecialUse('\\Sent', 'Whatever')).toBe('sent');
    expect(folderKindFromSpecialUse('\\Drafts', 'Whatever')).toBe('drafts');
    expect(folderKindFromSpecialUse('\\Junk', 'Whatever')).toBe('spam');
    expect(folderKindFromSpecialUse('\\Trash', 'Whatever')).toBe('trash');
    expect(folderKindFromSpecialUse('\\Archive', 'Whatever')).toBe('archive');
  });

  it('falls back to case-insensitive name heuristics when no flag is set', () => {
    expect(folderKindFromSpecialUse(undefined, 'INBOX')).toBe('inbox');
    expect(folderKindFromSpecialUse(undefined, 'Sent Items')).toBe('sent');
    expect(folderKindFromSpecialUse(undefined, 'My Drafts')).toBe('drafts');
    expect(folderKindFromSpecialUse(undefined, 'Deleted Messages')).toBe('trash');
  });

  it('returns custom for anything unrecognized', () => {
    expect(folderKindFromSpecialUse(undefined, 'Project Alpha')).toBe('custom');
  });
});

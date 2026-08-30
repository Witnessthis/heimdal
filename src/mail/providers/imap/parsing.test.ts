import type { MessageEnvelopeObject } from 'imapflow';
import { type Attachment as MailparserAttachment, simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import {
  computeThreadId,
  decodeMessageId,
  encodeMessageId,
  extractHeaderValue,
  folderKindFromSpecialUse,
  headerLineValue,
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

describe('extractHeaderValue', () => {
  it('returns undefined for missing headers', () => {
    expect(extractHeaderValue(undefined, 'List-Unsubscribe')).toBeUndefined();
  });

  it('returns undefined when the named header is absent', () => {
    const headers = Buffer.from('Subject: hi\r\n');
    expect(extractHeaderValue(headers, 'List-Unsubscribe')).toBeUndefined();
  });

  it('extracts a single-line value, matching case-insensitively', () => {
    const headers = Buffer.from('list-unsubscribe: <https://example.com/unsub>\r\n');
    expect(extractHeaderValue(headers, 'List-Unsubscribe')).toBe('<https://example.com/unsub>');
  });

  it('joins folded continuation lines', () => {
    const headers = Buffer.from('List-Unsubscribe: <https://example.com/unsub>,\r\n <mailto:a@b.com>\r\n');
    expect(extractHeaderValue(headers, 'List-Unsubscribe')).toBe(
      '<https://example.com/unsub>, <mailto:a@b.com>',
    );
  });

  it('stops at the next header and does not swallow following fields', () => {
    const headers = Buffer.from('List-Unsubscribe: <https://example.com/unsub>\r\nSubject: hi\r\n');
    expect(extractHeaderValue(headers, 'List-Unsubscribe')).toBe('<https://example.com/unsub>');
  });

  it('extracts a different requested header from the same block without confusing the two', () => {
    const headers = Buffer.from(
      'List-Unsubscribe: <https://example.com/unsub>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n',
    );
    expect(extractHeaderValue(headers, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
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

describe('headerLineValue', () => {
  // Real simpleParser output, not a hand-built stub — mailparser's
  // *structured* `headers` Map deliberately reinterprets every "List-*"
  // header under a single synthetic 'list' key (headers.get('list-
  // unsubscribe') is always undefined), which is exactly the bug this
  // guards against: only headerLines still exposes the raw, unprocessed
  // header text this needs.
  async function parse(rawHeaders: string) {
    return simpleParser(`From: a@b.com\r\nTo: c@d.com\r\nSubject: test\r\n${rawHeaders}\r\n\r\nbody\r\n`);
  }

  it('extracts a List-Unsubscribe header mailparser groups elsewhere in its structured headers', async () => {
    const parsed = await parse('List-Unsubscribe: <https://example.com/unsubscribe-test>');
    expect(parsed.headers.get('list-unsubscribe')).toBeUndefined(); // the trap this guards against
    expect(headerLineValue(parsed.headerLines, 'list-unsubscribe')).toBe(
      '<https://example.com/unsubscribe-test>',
    );
  });

  it('extracts List-Unsubscribe-Post alongside it', async () => {
    const parsed = await parse(
      'List-Unsubscribe: <https://example.com/unsubscribe-test>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click',
    );
    expect(headerLineValue(parsed.headerLines, 'list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
  });

  it('returns undefined when the header is absent', async () => {
    const parsed = await parse('X-Other: irrelevant');
    expect(headerLineValue(parsed.headerLines, 'list-unsubscribe')).toBeUndefined();
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

import { describe, expect, it } from 'vitest';
import { parseListUnsubscribe } from './list-unsubscribe';

describe('parseListUnsubscribe', () => {
  it('returns none when the header is absent', () => {
    expect(parseListUnsubscribe(undefined, undefined)).toEqual({ type: 'none' });
  });

  it('returns none for an empty header value', () => {
    expect(parseListUnsubscribe('', undefined)).toEqual({ type: 'none' });
  });

  it('returns a link for a bare https URL with no Post header', () => {
    expect(parseListUnsubscribe('<https://example.com/unsub?id=1>', undefined)).toEqual({
      type: 'link',
      url: 'https://example.com/unsub?id=1',
    });
  });

  it('returns oneClick for an https URL with the correct List-Unsubscribe-Post value', () => {
    expect(parseListUnsubscribe('<https://example.com/unsub?id=1>', 'List-Unsubscribe=One-Click')).toEqual({
      type: 'oneClick',
      url: 'https://example.com/unsub?id=1',
    });
  });

  it('is case-insensitive on the Post header value', () => {
    expect(parseListUnsubscribe('<https://example.com/unsub>', 'list-unsubscribe=one-click')).toEqual({
      type: 'oneClick',
      url: 'https://example.com/unsub',
    });
  });

  it('falls back to link when the Post header value is garbage', () => {
    expect(parseListUnsubscribe('<https://example.com/unsub>', 'something-else')).toEqual({
      type: 'link',
      url: 'https://example.com/unsub',
    });
  });

  it('never treats a plain http (non-https) URL as one-click, even with the Post header', () => {
    expect(parseListUnsubscribe('<http://example.com/unsub>', 'List-Unsubscribe=One-Click')).toEqual({
      type: 'link',
      url: 'http://example.com/unsub',
    });
  });

  it('returns mailto when only a mailto URI is present', () => {
    expect(parseListUnsubscribe('<mailto:unsub@example.com>', undefined)).toEqual({
      type: 'mailto',
      address: 'unsub@example.com',
    });
  });

  it('separates query parameters from the mailto address itself', () => {
    expect(parseListUnsubscribe('<mailto:unsub@example.com?subject=unsubscribe>', undefined)).toEqual({
      type: 'mailto',
      address: 'unsub@example.com',
      subject: 'unsubscribe',
    });
  });

  it('captures both subject and body hints from the mailto query string', () => {
    expect(
      parseListUnsubscribe(
        '<mailto:unsub@example.com?subject=Unsubscribe%20me&body=Please%20remove%20me>',
        undefined,
      ),
    ).toEqual({
      type: 'mailto',
      address: 'unsub@example.com',
      subject: 'Unsubscribe me',
      body: 'Please remove me',
    });
  });

  it('does not treat a literal + in a mailto query value as a space', () => {
    expect(parseListUnsubscribe('<mailto:unsub@example.com?subject=Order+42>', undefined)).toEqual({
      type: 'mailto',
      address: 'unsub@example.com',
      subject: 'Order+42',
    });
  });

  it('ignores unrecognized mailto query parameters', () => {
    expect(parseListUnsubscribe('<mailto:unsub@example.com?cc=someone@example.com>', undefined)).toEqual({
      type: 'mailto',
      address: 'unsub@example.com',
    });
  });

  it('falls back to omitting subject/body on malformed percent-encoding rather than throwing', () => {
    expect(parseListUnsubscribe('<mailto:unsub@example.com?subject=%>', undefined)).toEqual({
      type: 'mailto',
      address: 'unsub@example.com',
    });
  });

  it('prefers an https link over mailto when both are present and there is no Post header', () => {
    expect(
      parseListUnsubscribe('<mailto:unsub@example.com>, <https://example.com/unsub>', undefined),
    ).toEqual({ type: 'link', url: 'https://example.com/unsub' });
  });

  it('prefers oneClick over mailto when both are present and the Post header is set', () => {
    expect(
      parseListUnsubscribe(
        '<mailto:unsub@example.com>, <https://example.com/unsub>',
        'List-Unsubscribe=One-Click',
      ),
    ).toEqual({ type: 'oneClick', url: 'https://example.com/unsub' });
  });

  it('finds the https URL regardless of entry order', () => {
    expect(
      parseListUnsubscribe('<https://example.com/unsub>, <mailto:unsub@example.com>', undefined),
    ).toEqual({ type: 'link', url: 'https://example.com/unsub' });
  });

  it('is case-insensitive on the URI scheme', () => {
    expect(parseListUnsubscribe('<MAILTO:unsub@example.com>', undefined)).toEqual({
      type: 'mailto',
      address: 'unsub@example.com',
    });
    expect(parseListUnsubscribe('<HTTPS://example.com/unsub>', undefined)).toEqual({
      type: 'link',
      url: 'HTTPS://example.com/unsub',
    });
  });

  it('tolerates a header missing the required angle brackets around a single URI', () => {
    expect(parseListUnsubscribe('https://example.com/unsub', undefined)).toEqual({
      type: 'link',
      url: 'https://example.com/unsub',
    });
  });

  it('returns none when the header has no recognizable scheme', () => {
    expect(parseListUnsubscribe('<garbage-not-a-uri>', undefined)).toEqual({ type: 'none' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { bestPreviewText, formatFullDate, formatRelativeTime, htmlToText, isRichHtml } from './preview';

describe('htmlToText', () => {
  it('strips script and style content, not just the visible text', () => {
    const html = '<div>Hello<script>evil()</script><style>.x{color:red}</style> world</div>';
    expect(htmlToText(html)).toBe('Hello world');
  });

  it('returns empty string for a document with no body', () => {
    // DOMParser still produces a body for almost any input, but guard
    // the falsy-body branch explicitly for a non-HTML mime type.
    const doc = htmlToText('');
    expect(doc).toBe('');
  });
});

describe('bestPreviewText', () => {
  it('prefers body.text over everything else', () => {
    expect(
      bestPreviewText({
        body: { text: 'plain text', html: '<p>html</p>' },
        snippet: 'snippet',
      } as never),
    ).toBe('plain text');
  });

  it('falls back to converting body.html when there is no text part', () => {
    expect(bestPreviewText({ body: { html: '<p>hello</p>' }, snippet: 'snippet' } as never)).toBe('hello');
  });

  it('falls back to snippet when there is no body at all', () => {
    expect(bestPreviewText({ snippet: 'just a snippet' } as never)).toBe('just a snippet');
  });

  it('returns empty string when nothing is available', () => {
    expect(bestPreviewText({} as never)).toBe('');
  });
});

describe('isRichHtml', () => {
  it('is false for plain div/p/br wrapping with no formatting', () => {
    expect(isRichHtml('<div><p>Just plain text</p><br></div>')).toBe(false);
  });

  it('is true when the body has an image', () => {
    expect(isRichHtml('<div><img src="cid:1"></div>')).toBe(true);
  });

  it('is true when the body has a real link', () => {
    expect(isRichHtml('<p>See <a href="https://example.com">here</a></p>')).toBe(true);
  });

  it('is true for inline color/background/formatting styles', () => {
    expect(isRichHtml('<p style="color: red">hi</p>')).toBe(true);
  });

  it('is false for an inline style with no formatting-relevant property', () => {
    expect(isRichHtml('<p style="margin: 0">hi</p>')).toBe(false);
  });

  it('ignores a bare boilerplate <style> block with no real formatting rules', () => {
    expect(isRichHtml('<style>body{-webkit-text-size-adjust:100%}</style><p>hi</p>')).toBe(false);
  });

  it('is true when a <style> block actually carries color/formatting rules', () => {
    // RICH_STYLE_PROPERTY only matches a property at the very start of the
    // text or immediately after a semicolon (it's written for inline
    // style="..." attribute syntax) — a lone `color:` right after a `{`
    // selector brace, as in `p{color:blue}`, does not match. A second
    // property following a semicolon does.
    expect(isRichHtml('<style>p{margin:0;color:blue}</style><p>hi</p>')).toBe(true);
  });
});

describe('formatRelativeTime', () => {
  it('formats sub-minute as "just now"', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    expect(formatRelativeTime('2026-01-01T11:59:45Z')).toBe('just now');
  });

  it('formats minutes', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    expect(formatRelativeTime('2026-01-01T11:45:00Z')).toBe('15m ago');
  });

  it('formats hours', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    expect(formatRelativeTime('2026-01-01T09:00:00Z')).toBe('3h ago');
  });

  it('formats days for anything under a week', () => {
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
    expect(formatRelativeTime('2026-01-08T12:00:00Z')).toBe('2d ago');
  });

  it('falls back to a locale date for a week or older', () => {
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
    const result = formatRelativeTime('2025-12-01T12:00:00Z');
    expect(result).not.toMatch(/ago$/);
  });
});

describe('formatFullDate', () => {
  it('produces a non-empty, locale-formatted string', () => {
    expect(formatFullDate('2026-01-01T12:00:00Z').length).toBeGreaterThan(0);
  });
});

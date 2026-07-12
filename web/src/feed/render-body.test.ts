import { describe, expect, it } from 'vitest';
import { prepareHtmlForRender } from './render-body';

// Parses prepareHtmlForRender's output back into a document so assertions
// check real elements/attributes rather than raw substrings.
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('prepareHtmlForRender', () => {
  it('blocks a remote http(s) image by default — the tracking-pixel defense', () => {
    const { html, blockedCount } = prepareHtmlForRender('<img src="https://evil.example/pixel.gif">', false);
    expect(blockedCount).toBe(1);
    const img = parse(html).querySelector('img')!;
    expect(img.getAttribute('src')).toBeNull();
    expect(img.classList.contains('heimdal-blocked-image')).toBe(true);
  });

  it('blocks plain http (not just https) remote images too', () => {
    const { blockedCount } = prepareHtmlForRender('<img src="http://evil.example/pixel.gif">', false);
    expect(blockedCount).toBe(1);
  });

  it('does NOT block inline data: URI images (already-resolved cid: references)', () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const { html, blockedCount } = prepareHtmlForRender(`<img src="${src}">`, false);
    expect(blockedCount).toBe(0);
    const img = parse(html).querySelector('img')!;
    expect(img.getAttribute('src')).toBe(src);
    expect(img.classList.contains('heimdal-blocked-image')).toBe(false);
  });

  it('does not block anything with no src attribute at all', () => {
    const { blockedCount } = prepareHtmlForRender('<img alt="no src">', false);
    expect(blockedCount).toBe(0);
  });

  it('allowImages: true leaves <img src> untouched', () => {
    const { html, blockedCount } = prepareHtmlForRender('<img src="https://evil.example/pixel.gif">', true);
    expect(blockedCount).toBe(0);
    const img = parse(html).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://evil.example/pixel.gif');
  });

  it('counts multiple blocked images independently', () => {
    const { blockedCount } = prepareHtmlForRender(
      '<img src="https://a.example/1.gif"><img src="https://b.example/2.gif">',
      false,
    );
    expect(blockedCount).toBe(2);
  });

  it('forces every link to open in a new tab via an injected <base target>', () => {
    const { html } = prepareHtmlForRender('<a href="https://example.com">link</a>', false);
    const base = parse(html).querySelector('base');
    expect(base?.target).toBe('_blank');
  });

  it("never lets the email's own onerror/onclick handlers execute during preparation", () => {
    // prepareHtmlForRender doesn't strip event-handler attributes itself
    // — that's the sandbox iframe's job (no allow-scripts) — but it must
    // not introduce a NEW execution path, e.g. by evaluating the
    // document it builds. DOMParser-created documents are inert (no
    // script/handler execution), and this function only ever reads from
    // `doc`, never assigns into a live page via innerHTML.
    const { html } = prepareHtmlForRender('<img src="x" onerror="window.evil=true">', false);
    expect((globalThis as { evil?: boolean }).evil).toBeUndefined();
    const img = parse(html).querySelector('img')!;
    expect(img.getAttribute('onerror')).toBe('window.evil=true');
  });

  it('is idempotent-safe on a body with no images at all', () => {
    const { html, blockedCount } = prepareHtmlForRender('<p>Just plain text</p>', false);
    expect(blockedCount).toBe(0);
    expect(parse(html).body.textContent).toContain('Just plain text');
  });

  it('preserves a declared pixel width/height on a blocked image to avoid layout reflow', () => {
    const { html } = prepareHtmlForRender(
      '<img src="https://evil.example/1.gif" width="100" height="50">',
      false,
    );
    const img = parse(html).querySelector('img')!;
    expect(img.style.width).toBe('100px');
    expect(img.style.height).toBe('50px');
  });

  it('returns a full HTML document with the doctype prepended', () => {
    const { html } = prepareHtmlForRender('<p>hi</p>', false);
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  describe('injected CSP meta tag — the vectors beyond plain <img src>', () => {
    function cspContent(html: string): string {
      return (
        parse(html).querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
      );
    }

    it('is present and is the first element in <head>, so it governs the whole document', () => {
      const { html } = prepareHtmlForRender('<p>hi</p>', false);
      const head = parse(html).head;
      expect(head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    });

    it('blocks everything by default (default-src none) except inline styles', () => {
      const content = cspContent(prepareHtmlForRender('<p>hi</p>', false).html);
      expect(content).toContain("default-src 'none'");
      expect(content).toContain("style-src 'unsafe-inline'");
    });

    it('when blocking images, img-src only allows data: — not http/https', () => {
      const content = cspContent(prepareHtmlForRender('<p>hi</p>', false).html);
      expect(content).toContain('img-src data:');
      expect(content).not.toContain('http:');
      expect(content).not.toContain('https:');
    });

    it('when images are allowed, img-src opens up to http/https too', () => {
      const content = cspContent(prepareHtmlForRender('<p>hi</p>', true).html);
      expect(content).toContain('img-src data: http: https:');
    });

    it('this is what actually closes srcset/background-image/@import/poster — not attribute stripping', () => {
      // None of these are touched by prepareHtmlForRender at all (no
      // enumeration/stripping) — the CSP meta tag is the only thing
      // blocking the underlying fetch for any of them.
      const html =
        '<img srcset="https://evil.example/tracker.gif 1x">' +
        '<picture><source srcset="https://evil.example/tracker.gif"></picture>' +
        '<div style="background-image:url(https://evil.example/tracker.gif)"></div>' +
        '<video poster="https://evil.example/tracker.gif"></video>';
      const { html: prepared } = prepareHtmlForRender(html, false);
      // Untouched in the DOM — the point is that CSP blocks the fetch
      // regardless of the HTML/CSS mechanism carrying the URL, not that
      // this function rewrites each one.
      expect(prepared).toContain('srcset="https://evil.example/tracker.gif 1x"');
      expect(prepared).toContain('background-image:url(https://evil.example/tracker.gif)');
      expect(prepared).toContain('poster="https://evil.example/tracker.gif"');
      expect(cspContent(prepared)).toContain("default-src 'none'");
    });
  });
});

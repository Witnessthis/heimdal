import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareHtmlForRender } from './render-body';

const AUTO_LOAD_IMAGES_KEY = 'heimdal-auto-load-images';

// Parses prepareHtmlForRender's output back into a document so assertions
// check real elements/attributes rather than raw substrings — a naive
// `.toContain('src="...')` check, for example, also matches inside
// `data-blocked-src="..."`, since that attribute name itself ends in
// `src=`.
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('prepareHtmlForRender', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('blocks a remote http(s) image by default — the tracking-pixel defense', () => {
    const { html, blockedCount } = prepareHtmlForRender('<img src="https://evil.example/pixel.gif">');
    expect(blockedCount).toBe(1);
    const img = parse(html).querySelector('img')!;
    expect(img.getAttribute('src')).toBeNull();
    expect(img.dataset.blockedSrc).toBe('https://evil.example/pixel.gif');
    expect(img.classList.contains('heimdal-blocked-image')).toBe(true);
  });

  it('blocks plain http (not just https) remote images too', () => {
    const { blockedCount } = prepareHtmlForRender('<img src="http://evil.example/pixel.gif">');
    expect(blockedCount).toBe(1);
  });

  it('does NOT block inline data: URI images (already-resolved cid: references)', () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const { html, blockedCount } = prepareHtmlForRender(`<img src="${src}">`);
    expect(blockedCount).toBe(0);
    const img = parse(html).querySelector('img')!;
    expect(img.getAttribute('src')).toBe(src);
    expect(img.classList.contains('heimdal-blocked-image')).toBe(false);
  });

  it('does not block anything with no src attribute at all', () => {
    const { blockedCount } = prepareHtmlForRender('<img alt="no src">');
    expect(blockedCount).toBe(0);
  });

  it('respects the auto-load-images setting once enabled', () => {
    localStorage.setItem(AUTO_LOAD_IMAGES_KEY, 'true');
    const { html, blockedCount } = prepareHtmlForRender('<img src="https://evil.example/pixel.gif">');
    expect(blockedCount).toBe(0);
    const img = parse(html).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://evil.example/pixel.gif');
  });

  it('counts multiple blocked images independently', () => {
    const { blockedCount } = prepareHtmlForRender(
      '<img src="https://a.example/1.gif"><img src="https://b.example/2.gif">',
    );
    expect(blockedCount).toBe(2);
  });

  it('forces every link to open in a new tab via an injected <base target>', () => {
    const { html } = prepareHtmlForRender('<a href="https://example.com">link</a>');
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
    const { html } = prepareHtmlForRender('<img src="x" onerror="window.evil=true">');
    expect((globalThis as { evil?: boolean }).evil).toBeUndefined();
    const img = parse(html).querySelector('img')!;
    expect(img.getAttribute('onerror')).toBe('window.evil=true');
  });

  it('is idempotent-safe on a body with no images at all', () => {
    const { html, blockedCount } = prepareHtmlForRender('<p>Just plain text</p>');
    expect(blockedCount).toBe(0);
    expect(parse(html).body.textContent).toContain('Just plain text');
  });

  it('preserves a declared pixel width/height on a blocked image to avoid layout reflow', () => {
    const { html } = prepareHtmlForRender('<img src="https://evil.example/1.gif" width="100" height="50">');
    const img = parse(html).querySelector('img')!;
    expect(img.style.width).toBe('100px');
    expect(img.style.height).toBe('50px');
  });

  it('returns a full HTML document with the doctype prepended', () => {
    const { html } = prepareHtmlForRender('<p>hi</p>');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });
});

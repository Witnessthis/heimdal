// Settings > Reading toggles, persisted locally rather than server-side —
// these affect only how *this* client renders messages, not anything the
// backend needs to know about.

const AUTO_LOAD_IMAGES_STORAGE_KEY = 'heimdal-auto-load-images';

// Off by default — a remote image is also a tracking pixel (see
// render-body.ts's prepareHtmlForRender for where this is enforced).
export function isAutoLoadImagesEnabled(): boolean {
  return localStorage.getItem(AUTO_LOAD_IMAGES_STORAGE_KEY) === 'true';
}

export function setAutoLoadImagesEnabled(enabled: boolean): void {
  localStorage.setItem(AUTO_LOAD_IMAGES_STORAGE_KEY, String(enabled));
}

const RICH_HTML_STORAGE_KEY = 'heimdal-rich-html-enabled';

// On by default (absence of the key, or any value other than the literal
// string 'false', means enabled).
export function isRichHtmlEnabled(): boolean {
  return localStorage.getItem(RICH_HTML_STORAGE_KEY) !== 'false';
}

export function setRichHtmlEnabled(enabled: boolean): void {
  localStorage.setItem(RICH_HTML_STORAGE_KEY, String(enabled));
}

// Combines every Reading setting that affects how a body renders into one
// string, so ensureFullBodyLoaded() (render-body.ts) can tell "nothing
// relevant changed since last time" from "re-render, the user flipped a
// setting" with a single comparison instead of one per setting.
export function readingSettingsSignature(): string {
  return `${isRichHtmlEnabled()}:${isAutoLoadImagesEnabled()}`;
}

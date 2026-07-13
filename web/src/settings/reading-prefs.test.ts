import { beforeEach, describe, expect, it } from 'vitest';
import {
  isAutoLoadImagesEnabled,
  isRichHtmlEnabled,
  readingSettingsSignature,
  setAutoLoadImagesEnabled,
  setRichHtmlEnabled,
} from './reading-prefs';

beforeEach(() => localStorage.clear());

describe('defaults (nothing stored yet)', () => {
  it('auto-load-images is OFF by default — the tracking-pixel-safe default', () => {
    expect(isAutoLoadImagesEnabled()).toBe(false);
  });

  it('rich HTML is ON by default', () => {
    expect(isRichHtmlEnabled()).toBe(true);
  });
});

describe('round-trips', () => {
  it('persists auto-load-images both ways', () => {
    setAutoLoadImagesEnabled(true);
    expect(isAutoLoadImagesEnabled()).toBe(true);
    setAutoLoadImagesEnabled(false);
    expect(isAutoLoadImagesEnabled()).toBe(false);
  });

  it('persists rich HTML both ways', () => {
    setRichHtmlEnabled(false);
    expect(isRichHtmlEnabled()).toBe(false);
    setRichHtmlEnabled(true);
    expect(isRichHtmlEnabled()).toBe(true);
  });

  it('treats only the literal string "false" as off for rich HTML', () => {
    // The getter is `!== 'false'`, so any other stored value reads as on.
    localStorage.setItem('heimdal-rich-html-enabled', 'anything-else');
    expect(isRichHtmlEnabled()).toBe(true);
  });
});

describe('readingSettingsSignature (drives the re-render cache)', () => {
  it('changes whenever either setting flips, so a stale render is detected', () => {
    const base = readingSettingsSignature();

    setRichHtmlEnabled(false);
    const afterRich = readingSettingsSignature();
    expect(afterRich).not.toBe(base);

    setAutoLoadImagesEnabled(true);
    const afterImages = readingSettingsSignature();
    expect(afterImages).not.toBe(afterRich);
  });

  it('is stable when nothing changed', () => {
    expect(readingSettingsSignature()).toBe(readingSettingsSignature());
  });
});

import { describe, expect, it } from 'vitest';
import { shouldSnapToBoundary } from './reveal-snap';

// boundary (hiddenScrollTop) fixed at 100 for readability.
const H = 100;

describe('shouldSnapToBoundary', () => {
  describe('regression: resting exactly at the boundary must not trap the view', () => {
    it('does not snap when departing upward from a fresh snap (prev === boundary)', () => {
      expect(shouldSnapToBoundary(false, H, H - 5, H)).toBe(false);
    });

    it('does not snap when departing downward from a fresh snap (prev === boundary)', () => {
      expect(shouldSnapToBoundary(false, H, H + 5, H)).toBe(false);
    });
  });

  describe('genuine momentum flings are caught crossing from either side', () => {
    it('arrests a fling coming up out of the list', () => {
      expect(shouldSnapToBoundary(false, 120, 90, H)).toBe(true);
    });

    it('arrests a fling that lands exactly on the boundary', () => {
      expect(shouldSnapToBoundary(false, 120, H, H)).toBe(true);
    });

    it('arrests a fling coming down from revealed', () => {
      expect(shouldSnapToBoundary(false, 80, 110, H)).toBe(true);
    });
  });

  describe('non-crossing scrolls are left alone', () => {
    it('does not snap while scrolling within the list (both sides below boundary)', () => {
      expect(shouldSnapToBoundary(false, 130, 110, H)).toBe(false);
    });

    it('does not snap while scrolling within the revealed region (both above)', () => {
      expect(shouldSnapToBoundary(false, 60, 80, H)).toBe(false);
    });
  });

  it('never snaps while a finger is down (a deliberate pull opens the button)', () => {
    // Same crossing that would snap under momentum must be allowed mid-drag.
    expect(shouldSnapToBoundary(true, 120, 90, H)).toBe(false);
    expect(shouldSnapToBoundary(true, 80, 110, H)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { computeRowMenuPosition } from './row-menu-position.js';

const opts = { gap: 4, maxHeight: 220 };
const viewport = { width: 1200, height: 800 };

describe('computeRowMenuPosition', () => {
  it('opens downward below the trigger when there is room', () => {
    const pos = computeRowMenuPosition({ top: 100, bottom: 130, right: 1100 }, viewport, opts);
    expect(pos.opensUpward).toBe(false);
    expect(pos.top).toBe(134);
    expect(pos.bottom).toBe('auto');
    expect(pos.right).toBe(100);
  });

  it('flips upward when less than maxHeight remains below the trigger', () => {
    // 800 - 760 - 4 = 36 px free below → must open upward.
    const pos = computeRowMenuPosition({ top: 730, bottom: 760, right: 1100 }, viewport, opts);
    expect(pos.opensUpward).toBe(true);
    expect(pos.top).toBe('auto');
    // Anchored just above the trigger: 800 - 730 + 4.
    expect(pos.bottom).toBe(74);
  });

  it('never leaves the unused side unset so a stylesheet top/bottom cannot leak through', () => {
    // Regression: the upward branch once omitted `top`, letting the CSS rule
    // `top:100%` apply to the fixed list and push it below the viewport.
    for (const top of [0, 200, 400, 600, 780]) {
      const pos = computeRowMenuPosition({ top, bottom: top + 30, right: 1100 }, viewport, opts);
      const numeric = [pos.top, pos.bottom].filter((v) => typeof v === 'number');
      const auto = [pos.top, pos.bottom].filter((v) => v === 'auto');
      expect(numeric).toHaveLength(1);
      expect(auto).toHaveLength(1);
    }
  });

  it('keeps the upward bottom offset non-negative for any trigger inside the viewport', () => {
    for (const top of [0, 300, 600, 790]) {
      const pos = computeRowMenuPosition({ top, bottom: top + 10, right: 1100 }, viewport, opts);
      if (pos.opensUpward) expect(pos.bottom as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('flips exactly at the maxHeight threshold', () => {
    // spaceBelow == maxHeight → still downward; one px less → upward.
    const atLimit = computeRowMenuPosition({ top: 546, bottom: 576, right: 1100 }, viewport, opts); // 800-576-4 = 220
    expect(atLimit.opensUpward).toBe(false);
    const justUnder = computeRowMenuPosition({ top: 547, bottom: 577, right: 1100 }, viewport, opts); // 219
    expect(justUnder.opensUpward).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { barScale, codeParts, errorHeadline } from './model';

describe('model', () => {
  it('scales bars to the larger of the value and the frame budget, with headroom', () => {
    const s = barScale([20.4], 16.7);
    expect(s.pct(20.4)).toBeCloseTo(100 / 1.15, 0);
    expect(s.budgetPct).toBeCloseTo((16.7 / (20.4 * 1.15)) * 100, 0);
    const small = barScale([0.1], 16.7);
    expect(small.budgetPct).toBeCloseTo(100 / 1.15, 0);
    expect(small.pct(-1)).toBe(0);
  });

  it('splits backtick code spans', () => {
    expect(codeParts('use `useMemo` here')).toEqual([
      { code: false, text: 'use ' },
      { code: true, text: 'useMemo' },
      { code: false, text: ' here' },
    ]);
  });

  it('has a headline for every error kind', () => {
    for (const kind of ['input', 'bundle', 'browser', 'mount', 'step', 'timeout', 'internal'] as const) {
      expect(errorHeadline(kind).length).toBeGreaterThan(10);
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Comparison, Finding, FindingRef, KeystrokeView, TreeRow } from '../../src/shared/types';
import {
  applyCancelled,
  applyToolResult,
  barScale,
  budgetSentence,
  codeParts,
  comparisonVerdict,
  EMPTY_STATE,
  errorHeadline,
  openedTracker,
  parseOutput,
  treeRowMs,
} from './model';

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

  it('keeps only the screen-refresh sentence of the subline', () => {
    expect(
      budgetSentence('Each keystroke takes 0.1 ms. Typing feels smooth when an update fits in one screen refresh (about 16.7 ms), so this should feel smooth.'),
    ).toBe('Typing feels smooth when an update fits in one screen refresh (about 16.7 ms), so this should feel smooth.');
    expect(budgetSentence('Each click takes under 0.1 ms. A click feels instant.')).toBe('A click feels instant.');
    expect(budgetSentence('Something else entirely')).toBe('Something else entirely');
  });
});

const TOP: FindingRef = { id: 'unstable-prop:ResultsList:filters', rule: 'unstable-prop', component: 'ResultsList', summary: 'top' };
const SECOND: FindingRef = { id: 'state-in-effect:SearchBox:setCharCount', rule: 'state-in-effect', component: 'SearchBox', summary: 'second' };
const OTHER: FindingRef = { id: 'unstable-prop:Other:x', rule: 'unstable-prop', component: 'Other', summary: 'other' };

function cmp(before: number, after: number, parts: Partial<Pick<Comparison, 'resolved' | 'stillThere' | 'new'>>): Comparison {
  return {
    baselineRunId: 'r_base01',
    found: true,
    checked: true,
    message: '',
    before: { msPerStep: before, rendersPerStep: 206, steps: 5 },
    after: { msPerStep: after, rendersPerStep: 5, steps: 5 },
    resolved: parts.resolved ?? [],
    stillThere: parts.stillThere ?? [],
    new: parts.new ?? [],
    sameInteraction: true,
    changedFiles: [],
    baselineTopFindingId: TOP.id,
    baselineFiles: [],
  };
}

describe('comparisonVerdict', () => {
  it('fixed: the top finding resolved, nothing new, within the screen refresh (a smaller one may be left)', () => {
    expect(comparisonVerdict(cmp(20.4, 0.1, { resolved: [TOP], stillThere: [SECOND] }), 16.7)).toBe('fixed');
    expect(comparisonVerdict(cmp(20.4, 16.7, { resolved: [TOP, SECOND] }), 16.7)).toBe('fixed');
  });

  it('partly: only a smaller finding resolved plus noise, while the top one is still there and over budget', () => {
    expect(comparisonVerdict(cmp(20.4, 20.2, { resolved: [SECOND], stillThere: [TOP] }), 16.7)).toBe('partly');
    // Reverse noise: still "partly", never "not fixed" next to a Resolved line.
    expect(comparisonVerdict(cmp(20.2, 20.4, { resolved: [SECOND], stillThere: [TOP] }), 16.7)).toBe('partly');
  });

  it('partly: the top one resolved but something new, or still over the screen refresh', () => {
    expect(comparisonVerdict(cmp(20.4, 0.1, { resolved: [TOP], new: [OTHER] }), 16.7)).toBe('partly');
    expect(comparisonVerdict(cmp(40, 18, { resolved: [TOP] }), 16.7)).toBe('partly');
  });

  it('faster: nothing resolved but at least 10 % and 0.5 ms faster', () => {
    expect(comparisonVerdict(cmp(20.4, 18.3, { stillThere: [TOP] }), 16.7)).toBe('faster');
    expect(comparisonVerdict(cmp(3, 2.5, { stillThere: [TOP] }), 16.7)).toBe('faster');
  });

  it('not fixed: nothing resolved and only noise, compared in tenths so 20.4 → 20.3 is not faster', () => {
    expect(comparisonVerdict(cmp(20.4, 20.3, { stillThere: [TOP] }), 16.7)).toBe('not-fixed');
    expect(comparisonVerdict(cmp(20.4, 18.5, { stillThere: [TOP] }), 16.7)).toBe('not-fixed'); // 9 %
    expect(comparisonVerdict(cmp(3, 2.6, { stillThere: [TOP] }), 16.7)).toBe('not-fixed'); // 0.4 ms
  });

  it('unchecked when the fix could not be checked', () => {
    expect(comparisonVerdict({ ...cmp(1, 1, {}), checked: false }, 16.7)).toBe('unchecked');
  });
});

describe('tool results the card cannot draw', () => {
  it('an error result or a result without structuredContent becomes a problem with its text', () => {
    const s = applyToolResult(EMPTY_STATE, { isError: true, content: [{ type: 'text', text: 'Request timed out' }] });
    expect(s.problem).toEqual({ kind: 'failed', text: 'Request timed out' });
    expect(applyToolResult(EMPTY_STATE, { content: [] }).problem).toEqual({ kind: 'failed', text: '' });
  });

  it('a result with our structuredContent is drawn', () => {
    const out = { schemaVersion: 1, error: { kind: 'mount', message: 'x', details: [], stubs: [] } };
    const s = applyToolResult(EMPTY_STATE, { structuredContent: out, content: [] });
    expect(s.output).toEqual(parseOutput(out));
    expect(s.problem).toBeNull();
  });

  it('a cancel becomes a problem, but never hides a result that already arrived', () => {
    expect(applyCancelled(EMPTY_STATE, 'user action').problem).toEqual({ kind: 'cancelled', text: 'user action' });
    expect(applyCancelled(EMPTY_STATE).problem).toEqual({ kind: 'cancelled', text: '' });
    const done = applyToolResult(EMPTY_STATE, { structuredContent: { schemaVersion: 1, error: { message: 'x', kind: 'mount', details: [], stubs: [] } } });
    expect(applyCancelled(done)).toBe(done);
  });
});

describe('openedTracker', () => {
  it('sends everything opened so far each time, once per item, because each update replaces the last', () => {
    const send = vi.fn();
    const note = openedTracker(send);
    note('“Why does it happen?”');
    note('“Show me the line”');
    note('“Why does it happen?”');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('In the Rendertrail card, the user opened: “Why does it happen?”; “Show me the line”.');
  });
});

describe('treeRowMs', () => {
  const k = { wastedMsPerStep: 20.2 } as KeystrokeView;
  const row = (label: TreeRow['label'], name = 'ResultsList', ms = 20.1): TreeRow => ({ name, depth: 2, label, memo: true, count: 1, below: {}, ms });
  const top = { rule: 'unstable-prop', component: 'ResultsList' } as Finding;

  it("shows the top finding's row with the bar's wasted time, and no time on other rows", () => {
    expect(treeRowMs(row('memo-broken'), k, top)).toBe(20.2);
    expect(treeRowMs(row('state-origin', 'SearchPage'), k, top)).toBeNull();
    expect(treeRowMs(row('memo-broken', 'Other', 3.2), k, top)).toBe(3.2);
    expect(treeRowMs(row('memo-broken', 'Other', 0.01), k, top)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { RecordedCommit, RecordedTrace, RenderedComponent } from '../shared/types.js';
import { compareRuns, groupRendered, median, rendersAfterMount, summarize } from './summarize.js';

function comp(name: string, extra: Partial<RenderedComponent> = {}): RenderedComponent {
  return {
    name,
    phase: 'update',
    memo: false,
    parent: null,
    selfMs: 0,
    totalMs: 0,
    changedProps: [],
    changedState: [],
    changedContext: [],
    ...extra,
  };
}

function commit(index: number, trigger: RecordedCommit['trigger'], renderMs: number, rendered: RenderedComponent[]): RecordedCommit {
  return { index, at: index * 100, doneAt: index * 100 + 1, inputSeq: index, trigger, renderMs, rendered };
}

function rows(n: number, phase: RenderedComponent['phase']): RenderedComponent[] {
  return Array.from({ length: n }, () => comp('Row', { phase }));
}

function trace(inputMs: number, rowCount = 2): RecordedTrace {
  return {
    errors: [],
    truncated: false,
    commits: [
      commit(0, 'mount', 10, [comp('Page', { phase: 'mount' }), comp('Side', { phase: 'mount', memo: true }), ...rows(rowCount, 'mount')]),
      commit(1, 'input', inputMs, [comp('Page', { changedState: [{ hook: 0, from: '""', to: '"h"' }] }), ...rows(rowCount, 'update')]),
      commit(2, 'follow-up', 0.1, [
        comp('Box', {
          changedProps: [
            { name: 'filters', sameValue: true, type: 'object' },
            { name: 'children', sameValue: false, type: 'element' },
          ],
        }),
      ]),
    ],
  };
}

const meta = { entry: 'Page.tsx', exportName: 'default', reactVersion: '19.3.1', browser: 'Chrome', steps: [], stubs: [], pageErrors: [] };

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('groupRendered', () => {
  it('groups by name and writes notes, skipping children', () => {
    expect(groupRendered(trace(5).commits[2]!)).toEqual([
      { name: 'Box', count: 1, memo: false, notes: ['filters changed (new reference, same value)'] },
    ]);
    expect(groupRendered(trace(5).commits[1]!).map((g) => [g.name, g.count, g.notes])).toEqual([
      ['Page', 1, ['state #0 "" → "h"']],
      ['Row', 2, []],
    ]);
  });
});

describe('compareRuns', () => {
  it('is empty when render counts match, whatever the timings', () => {
    expect(compareRuns([trace(5), trace(9), trace(7)])).toEqual([]);
  });

  it('names the commits whose counts differ', () => {
    const problems = compareRuns([trace(5), trace(5, 3)]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('Commit #0 differs');
  });

  it('notices a different number of commits', () => {
    const short = trace(5);
    short.commits.pop();
    expect(compareRuns([trace(5), short])).toEqual(['Run 2 recorded 2 commits, run 1 recorded 3.']);
  });
});

describe('summarize', () => {
  it('takes per-commit medians and counts renders after mount, including zeros', () => {
    const summary = summarize([trace(5), trace(9), trace(7)], meta);
    expect(summary.stable).toBe(true);
    expect(summary.commitCount).toBe(3);
    expect(summary.commits[1]?.renderMsRuns).toEqual([5, 9, 7]);
    expect(summary.timings.inputMedianMs).toBe(7);
    expect(summary.timings.mountMs).toBe(10);
    expect(summary.timings.followUpCommits).toBe(1);
    expect(rendersAfterMount(trace(5))).toEqual({ Page: 1, Side: 0, Row: 2, Box: 1 });
  });

  it('reports truncation from any run', () => {
    const cut = { ...trace(5), truncated: true };
    expect(summarize([trace(5), cut], meta).truncated).toBe(true);
    expect(summarize([trace(5)], meta).truncated).toBe(false);
  });

  it('marks unstable runs', () => {
    const summary = summarize([trace(5), trace(5, 3), trace(5)], meta);
    expect(summary.stable).toBe(false);
    expect(summary.instability.length).toBeGreaterThan(0);
  });
});

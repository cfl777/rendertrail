import { describe, expect, it } from 'vitest';
import type { TraceSummary } from '../shared/types.js';
import { describeSteps, formatError, formatSummary } from './format.js';

const summary: TraceSummary = {
  entry: 'SearchPage.tsx',
  exportName: 'default',
  reactVersion: '19.3.1',
  browser: 'Chrome 157',
  steps: [
    { action: 'type', target: 'input', text: 'hi', delayMs: 100 },
    { action: 'wait', ms: 600 },
  ],
  runs: 3,
  stable: true,
  instability: [],
  commitCount: 1,
  truncated: false,
  commits: [
    { index: 0, trigger: 'mount', renderMs: 25.5, renderMsRuns: [25, 25.5, 26], rendered: [{ name: 'Row', count: 200, memo: false, notes: [] }] },
  ],
  rendersAfterMount: { Row: 0 },
  timings: { mountMs: 25.5, inputCommits: 0, inputMedianMs: 0, followUpCommits: 0, laterCommits: 0, frameBudgetMs: 16.7 },
  stubs: ['lib (imported by SearchPage.tsx)'],
  timerResolutionMs: 0.1,
  pageErrors: [],
};

describe('format', () => {
  it('describes steps', () => {
    expect(describeSteps(summary.steps)).toBe('type "hi" into input (100 ms between letters); wait 600 ms');
  });

  it('writes a standalone summary with the commit table, renders, stubs and stability', () => {
    const text = formatSummary(summary);
    expect(text).toContain('Recorded SearchPage.tsx (default export) 3 times in headless Chrome 157, React 19.3.1.');
    expect(text).toContain('Render counts were identical in all 3 runs.');
    expect(text).toMatch(/#0 {3}mount +25\.50 ms {3}Row ×200/);
    expect(text).toContain('Renders after mount: Row 0.');
    expect(text).toContain('  - lib (imported by SearchPage.tsx)');
  });

  it('flags unstable results', () => {
    const text = formatSummary({ ...summary, stable: false, instability: ['Commit #0 differs'] });
    expect(text).toContain('UNSTABLE');
    expect(text).toContain('  - Commit #0 differs');
  });

  it('lists at most 40 commit lines and says when recording was truncated', () => {
    const commit = summary.commits[0]!;
    const commits = Array.from({ length: 45 }, (_, index) => ({ ...commit, index }));
    const text = formatSummary({ ...summary, commits, commitCount: 45, truncated: true });
    expect(text).toContain('#39 ');
    expect(text).not.toContain('#40 ');
    expect(text).toContain('… 5 more commits');
    expect(text).toContain('Recording stopped after 45 commits');
  });

  it('explains errors and lists stubs', () => {
    const text = formatError({ kind: 'step', message: 'Step 1 failed.', details: ['Uncaught: boom'], stubs: [] });
    expect(text).toContain("Couldn't record the component: Step 1 failed.");
    expect(text).toContain('Stubbed imports: none.');
  });
});

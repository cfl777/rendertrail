import { describe, expect, it } from 'vitest';
import type { RecordedCommit, RecordedTrace, RenderedComponent, TraceSummary } from '../shared/types.js';
import { analyze } from './index.js';
import { groupSteps } from './steps.js';
import { formatAnalysis } from './text.js';
import { laggyFiles, savedTrace } from './testing.js';

describe('laggy-search, from saved recorder traces', () => {
  const files = laggyFiles();

  it('unfixed: groups 5 steps (input + follow-up) and leaves the debounce update out', () => {
    const { summary, traces } = savedTrace('SearchPage');
    const steps = groupSteps(traces[0]!, (i) => summary.commits[i]!.renderMs);
    expect(steps.map((s) => s.commits)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
      [9, 10],
    ]);
    expect(steps.every((s) => s.renders === 206)).toBe(true);
  });

  it('unfixed: reports rule 1 for ResultsList.filters, then rule 2 for SearchBox, and nothing else', () => {
    const { summary, traces } = savedTrace('SearchPage');
    const a = analyze({ summary, traces, files });
    expect(a.findings.map((f) => f.id)).toEqual(['unstable-prop:ResultsList', 'state-in-effect:SearchBox:setCharCount']);

    const [rule1, rule2] = a.findings;
    expect(rule1).toMatchObject({
      rank: 1,
      component: 'ResultsList',
      prop: { name: 'filters', type: 'object' },
      location: { file: 'SearchPage.tsx', line: 19, snippet: "filters={{ sort: 'recent', tags }}" },
      stepsAffected: 5,
      steps: 5,
      commits: [1, 3, 5, 7, 9],
      rendersPerStep: 201,
      below: { ResultRow: 200 },
      fix: { kind: 'useMemo', compilerFixes: true },
    });
    expect(rule1!.msPerStep).toBeGreaterThan(10);
    expect(rule1!.texts.fix).toContain("const filters = useMemo(() => ({ sort: 'recent', tags }), [tags]);");
    expect(rule1!.texts.fix).toContain('React Compiler would do this automatically');
    expect(rule1!.texts.why).toContain('memo only skips a render when every prop is the same object as last time');

    expect(rule2).toMatchObject({
      rank: 2,
      component: 'SearchBox',
      hook: { index: 0, state: 'charCount', setter: 'setCharCount', owner: 'SearchBox' },
      location: { file: 'SearchBox.tsx', line: 10 },
      stepsAffected: 5,
      extraUpdatesPerStep: 1,
      fix: { kind: 'compute-in-render', compilerFixes: false },
    });
    expect(rule2!.texts.fix).toContain('const charCount = value.length;');
    expect(rule2!.texts.fix).toContain("React Compiler doesn't fix this one");

    const k = a.keystroke;
    expect(k).toMatchObject({ unit: 'letter', label: 'Typing "hello" (5 letters)', caption: 'typed “hello” into SearchPage', steps: 5, overBudget: true });
    expect(k.headline).toBe("Every letter you type re-renders 201 components that didn't change: ResultsList and 200 × ResultRow.");
    expect(k.subline).toMatch(/^Each keystroke takes [\d.]+ ms\. Typing feels smooth .* so this feels laggy\.$/);
    expect(k.wastedMsPerStep).toBeGreaterThan(10);
    expect(k.wastedMsPerStep + k.restMsPerStep).toBeCloseTo(k.msPerStep, 1);
    expect(k.tree.map((r) => [r.name, r.label])).toEqual([
      ['SearchPage', 'state-origin'],
      ['Header', 'nothing-changed'],
      ['SearchBox', 'needed'],
      ['ResultsList', 'memo-broken'],
      ['Sidebar', 'skipped'],
    ]);
    expect(k.tree.find((r) => r.name === 'ResultsList')?.below).toEqual({ ResultRow: 200 });
  });

  it('fixed: rule 1 is gone, rule 2 is still there', () => {
    const { summary, traces } = savedTrace('SearchPage.fixed');
    const a = analyze({ summary, traces, files });
    expect(a.findings.map((f) => f.id)).toEqual(['state-in-effect:SearchBox:setCharCount']);
    expect(a.keystroke.overBudget).toBe(false);
    expect(a.keystroke.wastedMsPerStep).toBe(0);
    expect(a.keystroke.tree.filter((r) => r.label === 'skipped').map((r) => r.name)).toEqual(['ResultsList', 'Sidebar']);
  });

  it('writes a text result that stands alone', () => {
    const { summary, traces } = savedTrace('SearchPage');
    const a = analyze({ summary, traces, files });
    const text = formatAnalysis({ summary, steps: a.steps, findings: a.allFindings, keystroke: a.keystroke, runId: 'r_abc123' });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Typing "hello" \(5 letters\): [\d.]+ ms per letter, over the 16\.7 ms frame budget\.$/);
    expect(lines[1]).toMatch(/^1\. ResultsList \(memo\) re-renders with 200 ResultRow below it on every letter: prop `filters` is a new object each render with the same value, created at SearchPage\.tsx:19\. Wasted: about [\d.]+ ms per letter\. Fix: wrap it in useMemo/);
    expect(text).toMatch(/\n2\. SearchBox sets state inside useEffect \(SearchBox\.tsx:10\): one extra update per letter/);
    expect(text).toContain('Run id: r_abc123. To check a fix, call inspect_render again with the changed files and baselineRunId "r_abc123".');
    expect(text).toContain('Render counts were identical in all 3 runs.');
    expect(text).toContain('12 updates: 1 mount, 5 steps after input (10 updates), 1 later');
    expect(text.slice(0, text.indexOf('Run id:'))).not.toMatch(/Header|Layout|Sidebar|useDebounce|setDebounced/);
  });
});

// ---------------------------------------------------------------------------
// Synthetic traces: thresholds, function props and the no-finding text
// ---------------------------------------------------------------------------

function r(name: string, parent: string | null, extra: Partial<RenderedComponent> = {}): RenderedComponent {
  return { name, phase: 'update', memo: false, parent, selfMs: 0, totalMs: 0, changedProps: [], changedState: [], changedContext: [], ...extra };
}

function commit(index: number, inputSeq: number, rendered: RenderedComponent[]): RecordedCommit {
  const renderMs = rendered[0]?.totalMs ?? 0;
  return { index, at: index * 100, doneAt: index * 100 + 1, inputSeq, trigger: index === 0 ? 'mount' : 'input', renderMs, rendered };
}

function summaryOf(trace: RecordedTrace, steps: TraceSummary['steps']): TraceSummary {
  return {
    entry: 'App.tsx',
    exportName: 'App',
    reactVersion: '19.3.1',
    browser: 'Chrome',
    steps,
    runs: 1,
    stable: true,
    instability: [],
    commitCount: trace.commits.length,
    truncated: false,
    commits: trace.commits.map((c) => ({ index: c.index, trigger: c.trigger, renderMs: c.renderMs, renderMsRuns: [c.renderMs], rendered: [] })),
    rendersAfterMount: {},
    timings: { mountMs: 0, inputCommits: 0, inputMedianMs: 0, followUpCommits: 0, laterCommits: 0, frameBudgetMs: 16.7 },
    stubs: [],
    timerResolutionMs: 0.1,
    pageErrors: [],
  };
}

const APP = [
  "import { memo, useState } from 'react';",
  'const Row = memo(function Row(props: { onPick: () => void; label: string }) { return <li>{props.label}</li>; });',
  'export function App() {',
  '  const [n, setN] = useState(0);',
  '  return <ul onClick={() => setN(n + 1)}><Row onPick={() => console.log(n)} label="a" />{FN}</ul>;',
  '}',
].join('\n');

function clickTrace(rowMs: number, clicks: number, propType = 'function'): RecordedTrace {
  const commits = [commit(0, 0, [r('App', null, { phase: 'mount', totalMs: 1 }), r('Row', 'App', { phase: 'mount', memo: true })])];
  for (let i = 1; i <= clicks; i += 1) {
    commits.push(
      commit(i, i * 2, [
        r('App', null, { totalMs: rowMs + 0.1, changedState: [{ hook: 0, from: String(i - 1), to: String(i) }] }),
        r('Row', 'App', { memo: true, totalMs: rowMs, changedProps: [{ name: 'onPick', sameValue: true, type: propType }] }),
      ]),
    );
  }
  return { commits, errors: [], truncated: false };
}

const clicks = (n: number): TraceSummary['steps'] => Array.from({ length: n }, () => ({ action: 'click' as const, target: 'ul' }));

describe('thresholds and function props', () => {
  it('reports an inline function prop (confirmed from source) at 1 ms or more per step', () => {
    const trace = clickTrace(2, 3);
    const a = analyze({ summary: summaryOf(trace, clicks(3)), traces: [trace], files: [{ path: 'App.tsx', content: APP.replace('{FN}', '') }] });
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ component: 'Row', prop: { name: 'onPick', type: 'function' }, fix: { kind: 'useCallback' }, location: { line: 5 } });
    expect(a.keystroke.unit).toBe('click');
    expect(a.keystroke.headline).toBe("Every click re-renders Row, which didn't change.");
  });

  it('skips it under 1 ms per step', () => {
    const trace = clickTrace(0.5, 3);
    const a = analyze({ summary: summaryOf(trace, clicks(3)), traces: [trace], files: [{ path: 'App.tsx', content: APP.replace('{FN}', '') }] });
    expect(a.findings).toEqual([]);
    const text = formatAnalysis({ summary: summaryOf(trace, clicks(3)), steps: a.steps, findings: a.allFindings, keystroke: a.keystroke, runId: 'r_aaaa' });
    expect(text).toContain('No problem passed the thresholds');
    expect(text).toMatch(/Raw cost per click \(median of 3 clicks\): 0\.6 ms, 2 component renders\./);
  });

  it('skips a function prop the source does not show as created in the render (it may capture new values)', () => {
    const trace = clickTrace(2, 3);
    const passed = APP.replace('<Row onPick={() => console.log(n)}', '<Row onPick={handler}').replace('export function App() {', 'export function App({ handler }: { handler: () => void }) {').replace('{FN}', '');
    const a = analyze({ summary: summaryOf(trace, clicks(3)), traces: [trace], files: [{ path: 'App.tsx', content: passed }] });
    expect(a.findings).toEqual([]);
  });

  it('counts rule 2 only on at least half of the steps', () => {
    const files = [
      {
        path: 'App.tsx',
        content: [
          "import { useEffect, useState } from 'react';",
          'export function App() {',
          '  const [n, setN] = useState(0);',
          '  const [m, setM] = useState(0);',
          '  useEffect(() => { if (n % 3 === 0) setM(n); }, [n]);',
          '  return <button onClick={() => setN(n + 1)}>{m}</button>;',
          '}',
        ].join('\n'),
      },
    ];
    const build = (followUps: number[]): RecordedTrace => {
      const commits: RecordedCommit[] = [commit(0, 0, [r('App', null, { phase: 'mount' })])];
      for (let i = 1; i <= 4; i += 1) {
        commits.push(commit(commits.length, i * 2, [r('App', null, { changedState: [{ hook: 0, from: '0', to: '1' }] })]));
        if (followUps.includes(i)) commits.push(commit(commits.length, i * 2, [r('App', null, { changedState: [{ hook: 1, from: '0', to: '1' }] })]));
      }
      return { commits, errors: [], truncated: false };
    };
    const once = build([1]);
    expect(analyze({ summary: summaryOf(once, clicks(4)), traces: [once], files }).findings).toEqual([]);
    const twice = build([1, 3]);
    const found = analyze({ summary: summaryOf(twice, clicks(4)), traces: [twice], files }).findings;
    expect(found.map((f) => [f.id, f.stepsAffected, f.steps])).toEqual([['state-in-effect:App:setM', 2, 4]]);
  });

  it('says so when no input update was recorded', () => {
    const trace: RecordedTrace = { commits: [commit(0, 0, [r('App', null, { phase: 'mount' })])], errors: [], truncated: false };
    const summary = summaryOf(trace, [{ action: 'wait', ms: 100 }]);
    const a = analyze({ summary, traces: [trace], files: [] });
    expect(a.steps).toEqual([]);
    expect(a.keystroke.headline).toContain('No updates after input');
    const text = formatAnalysis({ summary, steps: a.steps, findings: a.allFindings, keystroke: a.keystroke, runId: 'r_aaaa' });
    expect(text.split('\n')[0]).toBe('wait 100 ms: no update followed an input event, so there is no cost per step to report.');
  });
});

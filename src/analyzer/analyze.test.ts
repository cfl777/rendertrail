import { describe, expect, it } from 'vitest';
import type { RecordedCommit, RecordedTrace, RenderedComponent, TraceSummary } from '../shared/types.js';
import { laggyFiles, savedTrace } from '../../test/helpers/laggy.js';
import { analyze } from './index.js';
import { groupSteps } from './steps.js';
import { formatAnalysis } from './text.js';

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

  it('unfixed: reports rule 1 for ResultsList.filters, then rule 2 for SearchBox, and nothing else', async () => {
    const { summary, traces } = savedTrace('SearchPage');
    const a = await analyze({ summary, traces, files });
    expect(a.findings.map((f) => f.id)).toEqual(['unstable-prop:ResultsList:filters', 'state-in-effect:SearchBox:setCharCount']);

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
      rendersPerAffectedStep: 201,
      below: { ResultRow: 200 },
      fix: { kind: 'useMemo', compilerFixes: true },
    });
    expect(rule1!.otherLocations).toBeUndefined();
    expect(rule1!.msPerStep).toBeGreaterThan(10);
    expect(rule1!.texts.fix).toContain("const filters = useMemo(() => ({ sort: 'recent', tags }), [tags]);");
    expect(rule1!.texts.fix).toContain('then pass `filters={filters}`');
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
    // The time bar: waste and the rest come from the same per-run numbers, so the rest isn't hidden.
    expect(k.wastedMsPerStep).toBeGreaterThan(10);
    expect(k.restMsPerStep).toBeGreaterThan(0);
    expect(k.wastedMsPerStep + k.restMsPerStep).toBeCloseTo(k.msPerStep, 1);
    expect(k.tree.map((r) => [r.name, r.label])).toEqual([
      ['SearchPage', 'state-origin'],
      ['Header', 'nothing-changed'],
      ['SearchBox', 'needed'],
      ['ResultsList', 'memo-broken'],
      ['Sidebar', 'skipped'],
    ]);
    expect(k.tree.find((r) => r.name === 'ResultsList')).toMatchObject({ depth: 2, below: { ResultRow: 200 } });
  });

  it('fixed: rule 1 is gone, rule 2 is still there', async () => {
    const { summary, traces } = savedTrace('SearchPage.fixed');
    const a = await analyze({ summary, traces, files });
    expect(a.findings.map((f) => f.id)).toEqual(['state-in-effect:SearchBox:setCharCount']);
    expect(a.keystroke.overBudget).toBe(false);
    expect(a.keystroke.wastedMsPerStep).toBe(0);
    expect(a.keystroke.tree.filter((r) => r.label === 'skipped').map((r) => r.name)).toEqual(['ResultsList', 'Sidebar']);
  });

  it('writes a text result that stands alone', async () => {
    const { summary, traces } = savedTrace('SearchPage');
    const a = await analyze({ summary, traces, files });
    const text = formatAnalysis({ summary, steps: a.steps, findings: a.allFindings, keystroke: a.keystroke, runId: 'r_abc123' });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Typing "hello" \(5 letters\): [\d.]+ ms per letter, over the 16\.7 ms frame budget\.$/);
    expect(lines[1]).toMatch(
      /^1\. ResultsList \(memo\) re-renders with 200 ResultRow below it on every letter: prop `filters` is a new object each render with the same value, created at SearchPage\.tsx:19\. Wasted: about [\d.]+ ms per letter\. Fix: wrap it in useMemo/,
    );
    expect(text).toMatch(/\n2\. SearchBox sets state inside useEffect \(SearchBox\.tsx:10\): one extra update per letter/);
    expect(text).toContain('Run id: r_abc123. To check a fix, call inspect_render again with the changed files and baselineRunId "r_abc123".');
    expect(text).toContain('Render counts were identical in all 3 runs.');
    expect(text).toContain('12 updates: 1 mount, 5 steps after input (10 updates), 1 later');
    expect(text.slice(0, text.indexOf('Run id:'))).not.toMatch(/Header|Layout|Sidebar|useDebounce|setDebounced/);
  });

  it('drops the baseline hint when the run could not be saved', async () => {
    const { summary, traces } = savedTrace('SearchPage');
    const a = await analyze({ summary, traces, files });
    const text = formatAnalysis({ summary, steps: a.steps, findings: a.allFindings, keystroke: a.keystroke, runId: 'r_abc123', saveError: 'EACCES' });
    expect(text).toContain("This run couldn't be saved (EACCES), so it can't be used as a baseline");
    expect(text).not.toContain('r_abc123');
  });
});

// ---------------------------------------------------------------------------
// Synthetic traces
// ---------------------------------------------------------------------------

function r(name: string, parentIndex: number | null, extra: Partial<RenderedComponent> = {}): RenderedComponent {
  return { name, phase: 'update', memo: false, parent: null, parentIndex, selfMs: 0, totalMs: 0, changedProps: [], changedState: [], changedContext: [], ...extra };
}

/** Fills in `parent` names from parentIndex. */
function commit(index: number, inputSeq: number, rendered: RenderedComponent[], renderMs = rendered[0]?.totalMs ?? 0): RecordedCommit {
  const named = rendered.map((x) => ({ ...x, parent: x.parentIndex === null ? null : (rendered[x.parentIndex]?.name ?? null) }));
  return { index, at: index * 100, doneAt: index * 100 + 1, inputSeq, trigger: index === 0 ? 'mount' : 'input', renderMs, rendered: named };
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

const clicks = (n: number): TraceSummary['steps'] => Array.from({ length: n }, () => ({ action: 'click' as const, target: 'ul' }));
const file = (lines: string[], path = 'App.tsx') => ({ path, content: lines.join('\n') });
const origin = (hook = 0) => ({ changedState: [{ hook, from: '0', to: '1' }] });
const unchanged = (name: string, type = 'object') => ({ memo: true, changedProps: [{ name, sameValue: true, type }] });

async function run(trace: RecordedTrace, steps: TraceSummary['steps'], files: { path: string; content: string }[]) {
  const summary = summaryOf(trace, steps);
  const a = await analyze({ summary, traces: [trace], files });
  return { a, text: formatAnalysis({ summary, steps: a.steps, findings: a.allFindings, keystroke: a.keystroke, runId: 'r_aaaa' }) };
}

const APP = file([
  "import { memo, useState } from 'react';",
  'const Row = memo(function Row(props: { onPick: () => void; label: string }) { return <li>{props.label}</li>; });',
  'export function App() {',
  '  const [n, setN] = useState(0);',
  '  return <ul onClick={() => setN(n + 1)}><Row onPick={() => console.log(n)} label="a" /></ul>;',
  '}',
]);

/** App re-renders on each click; Row (memo) gets `wasteOn(i)` ms of waste on click i. */
function clickTrace(clickCount: number, wasteOn: (i: number) => number, propType = 'function'): RecordedTrace {
  const commits = [commit(0, 0, [r('App', null, { phase: 'mount', totalMs: 1 }), r('Row', 0, { phase: 'mount', memo: true })])];
  for (let i = 1; i <= clickCount; i += 1) {
    const ms = wasteOn(i);
    commits.push(
      commit(
        i,
        i * 2,
        ms > 0
          ? [r('App', null, { totalMs: ms + 0.1, ...origin() }), r('Row', 0, { totalMs: ms, ...unchanged('onPick', propType) })]
          : [r('App', null, { totalMs: 0.1, ...origin() })],
      ),
    );
  }
  return { commits, errors: [], truncated: false };
}

describe('rule 1', () => {
  it('reports an inline function prop (confirmed from source) at 1 ms or more per step', async () => {
    const { a } = await run(clickTrace(3, () => 2), clicks(3), [APP]);
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ id: 'unstable-prop:Row:onPick', component: 'Row', prop: { name: 'onPick', type: 'function' }, fix: { kind: 'useCallback' }, location: { line: 5 } });
    expect(a.keystroke.unit).toBe('click');
    expect(a.keystroke.headline).toBe("Every click re-renders Row, which didn't change.");
  });

  it('skips it under 1 ms per step and says so', async () => {
    const { a, text } = await run(clickTrace(3, () => 0.5), clicks(3), [APP]);
    expect(a.findings).toEqual([]);
    expect(text).toContain('No problem passed the thresholds');
    expect(text).toMatch(/Raw cost per click \(median of 3 clicks\): 0\.6 ms, 2 component renders\./);
  });

  it('thresholds on the mean: 40 ms on 2 of 5 clicks is reported, with the cost of an affected click', async () => {
    const { a, text } = await run(clickTrace(5, (i) => (i === 2 || i === 4 ? 40 : 0)), clicks(5), [APP]);
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ stepsAffected: 2, steps: 5, msPerStep: 16, msPerAffectedStep: 40 });
    expect(text).toContain('Wasted: on 2 of 5 clicks, about 40 ms each.');
    expect(a.keystroke.headline).toBe("On 2 of 5 clicks, it re-renders Row, which didn't change.");
  });

  it('skips a function prop the source does not show as created in a render (it may capture new values)', async () => {
    const passed = file([
      "import { memo, useState } from 'react';",
      'const Row = memo(function Row(props: { onPick: () => void }) { return <li />; });',
      'export function App({ handler }: { handler: () => void }) {',
      '  const [n, setN] = useState(0);',
      '  return <ul onClick={() => setN(n + 1)}><Row onPick={handler} /></ul>;',
      '}',
    ]);
    const { a } = await run(clickTrace(3, () => 2), clicks(3), [passed]);
    expect(a.findings).toEqual([]);
  });

  it('counts a recursive memo tree once: nested hits are inside their ancestor, siblings are separate', async () => {
    const tree = file([
      "import { memo, useState } from 'react';",
      'const Leaf = () => <i />;',
      'const TreeNode = memo(function TreeNode({ depth, style }: { depth: number; style: object }) {',
      '  return <b>{depth > 0 && <TreeNode depth={depth - 1} style={{ a: 1 }} />}<Leaf /></b>;',
      '});',
      'export function App() {',
      '  const [n, setN] = useState(0);',
      '  return <div onClick={() => setN(n + 1)}><TreeNode depth={2} style={{ a: 1 }} /><TreeNode depth={1} style={{ a: 1 }} /></div>;',
      '}',
    ]);
    // App → TreeNode a → TreeNode b → Leaf; App → TreeNode c → Leaf. a and c each re-render for nothing; b is inside a.
    const step = (i: number) =>
      commit(
        i,
        i * 2,
        [
          r('App', null, { totalMs: 10, ...origin() }),
          r('TreeNode', 0, { totalMs: 6, ...unchanged('style') }),
          r('TreeNode', 1, { totalMs: 3, ...unchanged('style') }),
          r('Leaf', 2, { totalMs: 1 }),
          r('TreeNode', 0, { totalMs: 3, ...unchanged('style') }),
          r('Leaf', 4, { totalMs: 1 }),
        ],
        10,
      );
    const trace: RecordedTrace = { commits: [commit(0, 0, [r('App', null, { phase: 'mount' })]), step(1), step(2)], errors: [], truncated: false };
    const { a } = await run(trace, clicks(2), [tree]);
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]).toMatchObject({ component: 'TreeNode', msPerStep: 9, rendersPerStep: 5, below: { TreeNode: 1, Leaf: 2 } });
  });

  it('follows a prop passed through a component up to where it is created', async () => {
    const files = [
      file([
        "import { useState } from 'react';",
        "import { Mid } from './Mid';",
        'export function App() {',
        '  const [n, setN] = useState(0);',
        '  return <div onClick={() => setN(n + 1)}><Mid filters={{ a: 1 }} n={n} /></div>;',
        '}',
      ]),
      file(
        [
          "import { memo } from 'react';",
          "const List = memo(function List({ filters }: { filters: object }) { return <ul />; });",
          'export function Mid({ filters, n }: { filters: object; n: number }) {',
          '  return <section>{n}<List filters={filters} /></section>;',
          '}',
        ],
        'Mid.tsx',
      ),
    ];
    const step = (i: number) =>
      commit(i, i * 2, [
        r('App', null, { totalMs: 5, ...origin() }),
        r('Mid', 0, { totalMs: 4.9, changedProps: [{ name: 'n', sameValue: false, type: 'number' }, { name: 'filters', sameValue: true, type: 'object' }] }),
        r('List', 1, { totalMs: 4.8, ...unchanged('filters') }),
      ]);
    const trace: RecordedTrace = { commits: [commit(0, 0, [r('App', null, { phase: 'mount' })]), step(1), step(2)], errors: [], truncated: false };
    const { a } = await run(trace, clicks(2), files);
    expect(a.findings[0]).toMatchObject({ component: 'List', location: { file: 'App.tsx', line: 5, snippet: 'filters={{ a: 1 }}' }, fix: { kind: 'useMemo' } });
    expect(a.findings[0]!.texts.summary).toContain('created at App.tsx:5 and passed down through Mid');
    expect(a.findings[0]!.texts.fix).toContain('const filters = useMemo(() => ({ a: 1 }), []);');

    // Without App.tsx, the files can't show where it's created.
    const midOnly = { ...summaryOf(trace, clicks(2)), entry: 'Mid.tsx', exportName: 'Mid' };
    const b = await analyze({ summary: midOnly, traces: [trace], files: [files[1]!] });
    expect(b.findings[0]).toMatchObject({ component: 'List', location: { file: 'Mid.tsx', line: 4 }, fix: { kind: 'useMemo' } });
    expect(b.findings[0]!.texts.summary).toContain("passed in from Mid's parent");
    expect(b.findings[0]!.texts.fix).toContain('Make it stable where it is created');
    expect(b.findings[0]!.texts.fix).not.toContain('const filters');
  });

  it('prefers the inline use when a component is used twice (one memoized, one inline) and lists the other place', async () => {
    const twice = file([
      "import { memo, useMemo, useState } from 'react';",
      'const Row = memo(function Row({ style }: { style: object }) { return <li />; });',
      'export function App() {',
      '  const [n, setN] = useState(0);',
      '  const memoed = useMemo(() => ({ a: 1 }), []);',
      '  return <ul onClick={() => setN(n + 1)}><Row style={memoed} /><Row style={{ a: 2 }} /></ul>;',
      '}',
    ]);
    const { a } = await run(retarget(clickTrace(3, () => 2, 'object'), 'style'), clicks(3), [twice]);
    expect(a.findings[0]).toMatchObject({ fix: { kind: 'useMemo' }, location: { line: 6, snippet: 'style={{ a: 2 }}' } });
    expect(a.findings[0]!.otherLocations).toEqual([{ file: 'App.tsx', line: 6, snippet: 'style={memoed}' }]);
  });
});

/** The click trace with Row's changed prop renamed. */
function retarget(trace: RecordedTrace, prop: string): RecordedTrace {
  return {
    ...trace,
    commits: trace.commits.map((c) => ({ ...c, rendered: c.rendered.map((x) => ({ ...x, changedProps: x.changedProps.map((p) => ({ ...p, name: prop })) })) })),
  };
}

describe('rule 2', () => {
  function followUps(onSteps: number[], extra: (i: number) => RenderedComponent[]): RecordedTrace {
    const commits: RecordedCommit[] = [commit(0, 0, [r('App', null, { phase: 'mount' })])];
    for (let i = 1; i <= 4; i += 1) {
      commits.push(commit(commits.length, i * 2, [r('App', null, { totalMs: 1, ...origin() }), ...extra(i).map((x) => ({ ...x, changedState: [] }))]));
      if (onSteps.includes(i)) commits.push(commit(commits.length, i * 2, extra(i), extra(i).reduce((s, x) => s + x.totalMs, 0)));
    }
    return { commits, errors: [], truncated: false };
  }

  it('counts only on at least half of the steps', async () => {
    const files = [
      file([
        "import { useEffect, useState } from 'react';",
        'export function App() {',
        '  const [n, setN] = useState(0);',
        '  const [m, setM] = useState(0);',
        '  useEffect(() => { if (n % 3 === 0) setM(n); }, [n]);',
        '  return <button onClick={() => setN(n + 1)}>{m}</button>;',
        '}',
      ]),
    ];
    const extra = () => [r('App', null, { totalMs: 0.5, changedState: [{ hook: 1, from: '0', to: '1' }] })];
    expect((await run(followUps([1], extra), clicks(4), files)).a.findings).toEqual([]);
    const found = (await run(followUps([1, 3], extra), clicks(4), files)).a.findings;
    expect(found.map((f) => [f.id, f.stepsAffected, f.steps])).toEqual([['state-in-effect:App:setM', 2, 4]]);
  });

  it('charges two components that set state in the same update only for their own re-render', async () => {
    const files = [
      file([
        "import { useEffect, useState } from 'react';",
        'function A({ v }: { v: number }) { const [x, setX] = useState(0); useEffect(() => setX(v), [v]); return <i>{x}</i>; }',
        'function B({ v }: { v: number }) { const [y, setY] = useState(0); useEffect(() => setY(v), [v]); return <b>{y}</b>; }',
        'export function App() { const [v, setV] = useState(0); return <p onClick={() => setV(v + 1)}><A v={v} /><B v={v} /></p>; }',
      ]),
    ];
    const extra = () => [
      r('A', null, { totalMs: 1, changedState: [{ hook: 0, from: '0', to: '1' }] }),
      r('B', null, { totalMs: 3, changedState: [{ hook: 0, from: '0', to: '1' }] }),
    ];
    const { a } = await run(followUps([1, 2, 3, 4], extra), clicks(4), files);
    const byComponent = Object.fromEntries(a.findings.map((f) => [f.component, f.msPerStep]));
    expect(byComponent).toEqual({ A: 1, B: 3 });
  });

  it('gives no `const s = …` code for a useReducer dispatch, and says to derive it instead', async () => {
    const files = [
      file([
        "import { useEffect, useReducer, useState } from 'react';",
        'export function App() {',
        '  const [v, setV] = useState(0);',
        '  const [s, dispatch] = useReducer(reducer, { v: 0 });',
        "  useEffect(() => { dispatch({ type: 'set', v }); }, [v]);",
        '  return <button onClick={() => setV(v + 1)}>{s.v}</button>;',
        '}',
      ]),
    ];
    const extra = () => [r('App', null, { totalMs: 0.5, changedState: [{ hook: 1, from: '0', to: '1' }] })];
    const { a } = await run(followUps([1, 2, 3, 4], extra), clicks(4), files);
    const f = a.findings[0]!;
    expect(f).toMatchObject({ id: 'state-in-effect:App:dispatch', hook: { setter: 'dispatch', state: 's' } });
    expect(f.texts.fix).toContain('Derive `s` during render instead of dispatching from useEffect');
    expect(f.texts.fix).not.toContain('const s =');
    expect(f.texts.summary).toContain('dispatches to its reducer inside useEffect');
  });
});

describe('no input', () => {
  it('says so when no input update was recorded', async () => {
    const trace: RecordedTrace = { commits: [commit(0, 0, [r('App', null, { phase: 'mount' })])], errors: [], truncated: false };
    const { a, text } = await run(trace, [{ action: 'wait', ms: 100 }], []);
    expect(a.steps).toEqual([]);
    expect(a.keystroke.headline).toContain('No updates after input');
    expect(text.split('\n')[0]).toBe('wait 100 ms: no update followed an input event, so there is no cost per step to report.');
  });
});

/**
 * The analyzer on every golden fixture's saved trace (test/fixtures/traces, from
 * `RT_SAVE_TRACES=1 npm run test:golden`), no browser: the findings must match each expected.json
 * `findings` section (a copy of EXPECTED.md), the re-run comparison must match, and the texts must
 * say what EXPECTED.md says. Each analyzer fix found by running all fixtures has a test here.
 */
import { describe, expect, it } from 'vitest';
import { analyze, type Analysis } from '../src/analyzer/index.js';
import { formatAnalysis } from '../src/analyzer/text.js';
import { SCHEMA_VERSION, type InspectRenderOutput } from '../src/shared/types.js';
import { compareRuns } from '../src/store/compare.js';
import { comparisonHeadline, treeRowMs } from '../ui/src/model.js';
import {
  KNOWN_FIXTURES,
  findingView,
  fixtureExpected,
  fixtureFiles,
  fixtureTest,
  matchesMustNot,
  savedFixtureTrace,
  type Files,
} from './helpers/fixtures.js';

/** Analyze the trace recorded for `entry`; `as` is the entry path the files use (the baseline's, after an edit in place). */
async function analyzed(name: string, entry: string, files: Files = fixtureFiles(name), as = entry): Promise<{ a: Analysis; text: string }> {
  const saved = savedFixtureTrace(name, entry);
  const summary = { ...saved.summary, entry: as };
  const a = await analyze({ summary, traces: saved.traces, files });
  return { a, text: formatAnalysis({ summary, steps: a.steps, findings: a.allFindings, keystroke: a.keystroke, runId: 'r_unit01' }) };
}

/** The fixed variant as Claude sends it after a fix: the fixed content under the baseline's path. */
function editedFiles(name: string, baseline: string, fixed: string): Files {
  const files = fixtureFiles(name);
  const content = files.find((f) => f.path === fixed)!.content;
  return files.filter((f) => f.path !== fixed).map((f) => (f.path === baseline ? { ...f, content } : f));
}

describe('every fixture, from its saved trace', () => {
  for (const name of KNOWN_FIXTURES) {
    const section = fixtureExpected(name).findings;
    it(`${name} has a findings section`, () => expect(section).toBeDefined());
    if (!section) continue;

    for (const [entry, want] of Object.entries(section.variants)) {
      it(`${name}/${entry}: findings match expected.json`, async () => {
        const { a } = await analyzed(name, entry);
        expect(a.allFindings.map(findingView)).toEqual(want.report.map((w) => expect.objectContaining(w)));
        expect(a.allFindings).toHaveLength(want.report.length);
        for (const m of want.mustNotReport) expect(a.allFindings.filter((f) => matchesMustNot(f, m)), JSON.stringify(m)).toEqual([]);
      });
    }

    const cmp = section.comparison;
    if (!cmp) continue;
    it(`${name}: comparison ${cmp.baseline} → ${cmp.fixed} matches expected.json`, async () => {
      const steps = fixtureTest(name).steps;
      const before = await analyzed(name, cmp.baseline);
      const files = editedFiles(name, cmp.baseline, cmp.fixed);
      const after = await analyzed(name, cmp.fixed, files, cmp.baseline);
      const input = (f: Files) => ({ files: f, entry: cmp.baseline, exportName: 'default', steps: steps as never });
      const c = compareRuns(
        'r_base01',
        { input: input(fixtureFiles(name)), findings: before.a.allFindings, keystroke: before.a.keystroke },
        { input: input(files), findings: after.a.allFindings, keystroke: after.a.keystroke },
      );
      expect(c.resolved.map((f) => f.id)).toEqual(cmp.resolved);
      expect(c.stillThere.map((f) => f.id)).toEqual(cmp.stillThere);
      expect(c.new.map((f) => f.id)).toEqual(cmp.new);
      const { summary } = savedFixtureTrace(name, cmp.fixed);
      const output = { schemaVersion: SCHEMA_VERSION, run: { id: 'r_fix001', createdAt: '', summary, steps: after.a.steps }, findings: after.a.findings, keystroke: after.a.keystroke, comparison: c } as Extract<InspectRenderOutput, { run: unknown }>;
      // All five fixed variants fix the top finding and add nothing: the card says "Fixed."
      if (name !== 'laggy-search') expect(comparisonHeadline(c, output)).toMatch(/^Fixed\. Each (click|step) now takes [\d.]+ ms\.$/);
    });
  }
});

describe('cart-summary (rule 2 by clicks, with a look-alike in .then)', () => {
  it('points at the useEffect line and names the setter line', async () => {
    const f = (await analyzed('cart-summary', 'Cart.tsx')).a.findings[0]!;
    expect(f.location).toMatchObject({ file: 'CartSummary.tsx', line: 28 });
    expect(f.location!.snippet).toMatch(/^useEffect\(\(\) => \{ setTotal\(/);
    expect(f.texts.line).toContain('at CartSummary.tsx:28 (it calls `setTotal` on line 29)');
  });

  it('gives the during-render code although the value contains an arrow (only the updater form has none)', async () => {
    const f = (await analyzed('cart-summary', 'Cart.tsx')).a.findings[0]!;
    expect(f.texts.fix).toContain('`const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);`');
    expect(f.texts.summary).toContain('Fix: compute total during render: `const total = items.reduce(');
  });

  it('lists only the updates inside a step, not the mount follow-up that also changed `total`', async () => {
    const f = (await analyzed('cart-summary', 'Cart.tsx')).a.findings[0]!;
    expect(f.commits).toEqual([4, 7, 10, 13]);
    expect(f).toMatchObject({ extraUpdatesPerStep: 1, stepsAffected: 4 });
  });

  it('stays right when a run records an extra mount follow-up (seen on React 18): only the indexes move', async () => {
    const saved = savedFixtureTrace('cart-summary', 'Cart.tsx');
    const first = saved.traces[0]!;
    const commits = [...first.commits.slice(0, 2), first.commits[1]!, ...first.commits.slice(2)].map((c, index) => ({ ...c, index }));
    const summaryCommits = [...saved.summary.commits.slice(0, 2), saved.summary.commits[1]!, ...saved.summary.commits.slice(2)].map((c, index) => ({ ...c, index }));
    const summary = { ...saved.summary, commitCount: commits.length, commits: summaryCommits };
    const a = await analyze({ summary, traces: [{ ...first, commits }], files: fixtureFiles('cart-summary') });
    expect(a.allFindings.map((f) => [f.id, f.location?.line, f.stepsAffected])).toEqual([['state-in-effect:CartSummary:setTotal', 28, 4]]);
    expect(a.allFindings[0]!.commits).toEqual([5, 8, 11, 14]);
  });

  it('groups both follow-ups (setTotal, then setQuote a microtask later) into the click that caused them', async () => {
    const { a } = await analyzed('cart-summary', 'Cart.tsx');
    expect(a.steps.map((s) => s.commits)).toEqual([
      [3, 4, 5],
      [6, 7, 8],
      [9, 10, 11],
      [12, 13, 14],
    ]);
    expect(a.keystroke.headline).toBe('Every click causes an extra update: CartSummary sets state inside an effect.');
  });
});

describe('pricing-toggle (rules 1 and 2 together)', () => {
  it('ranks rule 1 (both updates of a click) above rule 2 (the extra update)', async () => {
    const [r1, r2] = (await analyzed('pricing-toggle', 'PricingPage.tsx')).a.findings;
    expect(r1!.commits).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r2!.commits).toEqual([2, 4, 6, 8]);
    expect(r1!.msPerStep).toBeGreaterThan(r2!.msPerStep);
  });

  it('describes one update and says it happens twice, so the numbers match the tree (80 rows, not 160)', async () => {
    const { a } = await analyzed('pricing-toggle', 'PricingPage.tsx');
    expect(a.keystroke.headline).toBe("Every click re-renders 81 components that didn't change, twice: FeatureMatrix and 80 × FeatureRow.");
    expect(a.findings[0]!.texts.summary).toMatch(/^FeatureMatrix \(memo\) re-renders with 80 FeatureRow below it twice on every click: /);
    const row = a.keystroke.tree.find((r) => r.name === 'FeatureMatrix')!;
    expect(row).toMatchObject({ label: 'memo-broken', below: { FeatureRow: 80 } });
    // The card shows that row's own time (one update), not the bar's two-update waste.
    expect(treeRowMs(row, a.keystroke, a.findings[0])).toBe(row.ms);
    expect(a.keystroke.wastedMsPerStep).toBeGreaterThan(row.ms * 1.5);
  });

  it("says the extra update's cost overlaps with the matrix waste, and the headline doesn't add them up", async () => {
    const { a, text } = await analyzed('pricing-toggle', 'PricingPage.tsx');
    const r2 = a.findings[1]!;
    expect(r2.location).toMatchObject({ file: 'PricingPage.tsx', line: 8 });
    expect(r2.texts.summary).toContain("That extra update also re-renders FeatureMatrix for nothing, so part of this time is the same waste: don't add the two up.");
    expect(text).toContain('`const discount = billing === \'yearly\' ? 0.2 : 0;`');
    expect(a.keystroke.wastedMsPerStep).toBeLessThanOrEqual(a.keystroke.msPerStep);
  });

  it('suggests moving `labels` out of the component, as the fixed file does', async () => {
    const f = (await analyzed('pricing-toggle', 'PricingPage.tsx')).a.findings[0]!;
    expect(f.texts.fix).toContain("`const LABELS = { included: 'Included', missing: 'Not included' };`, then pass `labels={LABELS}`");
    expect(f.texts.fix).toContain('Wrapping it in useMemo also works');
  });
});

describe('theme-storefront (the decoy: nothing to fix)', () => {
  it('reports nothing, says so, and labels the context renders as needed', async () => {
    const { a, text } = await analyzed('theme-storefront', 'Storefront.tsx');
    expect(a.allFindings).toEqual([]);
    expect(a.keystroke.headline).toMatch(/^Nothing to fix: each click takes [\d.]+ ms\.$/);
    expect(text).toContain('No problem passed the thresholds');
    expect(a.keystroke.tree.map((r) => [r.name, r.label])).toEqual([
      ['Storefront', 'state-origin'],
      ['ProductGrid', 'needed'],
      ['ProductCard', 'needed'],
      ['PromoBanner', 'skipped'],
    ]);
  });
});

describe('todo-toggle (rule 1, function prop, 100 rows)', () => {
  it('says 100 rows re-render, not one component', async () => {
    const { a } = await analyzed('todo-toggle', 'TodoApp.tsx');
    expect(a.keystroke.headline).toBe("Every step of the interaction re-renders 100 components that didn't change: 100 × TodoItem.");
    expect(a.findings[0]!.texts.summary).toMatch(/^100 × TodoItem \(memo\) re-render on every step: /);
  });

  it('lists each update once (it held one entry per row before)', async () => {
    const f = (await analyzed('todo-toggle', 'TodoApp.tsx')).a.findings[0]!;
    expect(f.commits).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('leaves out the clicked row (needed) and the new row (a mount)', async () => {
    const f = (await analyzed('todo-toggle', 'TodoApp.tsx')).a.findings[0]!;
    // 100 on each letter, 99 on the toggle click, 100 on the add click (the mount of Task 101 isn't counted).
    expect(f.rendersPerStep).toBeCloseTo((4 * 100 + 99 + 100) / 6, 2);
  });

  it('passes at line 29 and points at the declaration on line 9, with useCallback and an empty list', async () => {
    const f = (await analyzed('todo-toggle', 'TodoApp.tsx')).a.findings[0]!;
    expect(f.location).toMatchObject({ file: 'TodoApp.tsx', line: 29, snippet: 'onToggle={handleToggle}' });
    expect(f.texts.line).toContain('`handleToggle` is declared at TodoApp.tsx:9: `function handleToggle(id: number) { … }`.');
    expect(f.texts.fix).toContain('`const handleToggle = useCallback((id: number) => { … }, []);`');
    expect(f.texts.fix).toContain('The dependency list can stay empty');
  });

  it('words a mixed interaction without "keystroke" or "letter"', async () => {
    const { a, text } = await analyzed('todo-toggle', 'TodoApp.tsx');
    expect(a.keystroke.unit).toBe('step');
    expect(a.keystroke.caption).toBe('typed “milk” and clicked 2 times in TodoApp');
    expect(a.keystroke.subline).toMatch(/^Each step takes [\d.]+ ms\. It feels smooth when an update fits in one screen refresh/);
    // The findings part; the recording note below the run id quotes the raw steps ("100 ms between letters").
    expect(`${a.keystroke.headline} ${a.keystroke.subline} ${text.slice(0, text.indexOf('Run id:'))}`).not.toMatch(/keystroke|letter/);
  });
});

describe('user-table (rule 1, array prop, clicks)', () => {
  it('suggests moving `columns` out of the component first, useMemo second', async () => {
    const f = (await analyzed('user-table', 'UserAdmin.tsx')).a.findings[0]!;
    expect(f.texts.fix).toContain("move it outside, to the top of the file: `const COLUMNS = ['name', 'email', 'role'];`, then pass `columns={COLUMNS}`");
    expect(f.texts.fix).toContain("`const columns = useMemo(() => ['name', 'email', 'role'], []);`");
    expect(f.texts.summary).toContain('Fix: move it out of the component, since it uses nothing from it, or wrap it in useMemo');
  });

  it('says click, never keystroke or letter', async () => {
    const { a, text } = await analyzed('user-table', 'UserAdmin.tsx');
    expect(a.keystroke.headline).toBe("Every click re-renders 151 components that didn't change: UserTable and 150 × UserRow.");
    // The findings part; the recording note below the run id quotes the raw steps ("100 ms between letters").
    expect(`${a.keystroke.headline} ${a.keystroke.subline} ${text.slice(0, text.indexOf('Run id:'))}`).not.toMatch(/keystroke|letter/);
  });
});

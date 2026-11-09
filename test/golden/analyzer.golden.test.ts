/**
 * Golden test for the analyzer: records every fixture whose expected.json has a `findings` section
 * through the real recorder (headless Chrome), analyzes it and checks the findings against that
 * section (a copy of EXPECTED.md's "must report" and "must NOT be reported"). Then the full tool
 * runs twice through inspectRender: the baseline variant, and the fixed variant sent under the
 * baseline's entry path with baselineRunId, as Claude would after a fix. Runs are stored in a
 * temporary folder, never the real home.
 *
 * `RT_SAVE_TRACES=1 npm run test:golden` also rewrites the analyzer's unit-test inputs in
 * test/fixtures/traces/ (<fixture>.<variant>.json: the summary and the first run's trace).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyzer/index.js';
import { recordRender } from '../../src/recorder/index.js';
import { inspectRender } from '../../src/server/inspect-render.js';
import { InspectRenderInputSchema, type Finding, type InspectRenderOutput } from '../../src/shared/types.js';
import { listRunIds, loadRun } from '../../src/store/runs.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = path.join(ROOT, 'fixtures');
const TRACES = path.join(ROOT, 'test', 'fixtures', 'traces');

interface ExpectedFinding {
  rule: string;
  component: string;
  prop?: string;
  setter?: string;
  location?: string;
  fix?: string;
  compilerFixes?: boolean;
  stepsAffected?: number;
  steps?: number;
}
interface MustNot {
  component?: string;
  prop?: string;
  setter?: string;
  hookOwner?: string;
  file?: string;
  commit?: number;
}
interface FindingsSection {
  variants: Record<string, { report: ExpectedFinding[]; mustNotReport: MustNot[] }>;
  comparison?: { baseline: string; fixed: string; resolved: string[]; stillThere: string[]; new: string[] };
}

function view(f: Finding): Required<Omit<ExpectedFinding, 'prop' | 'setter'>> & { prop?: string; setter?: string } {
  return {
    rule: f.rule,
    component: f.component,
    ...(f.prop ? { prop: f.prop.name } : {}),
    ...(f.hook ? { setter: f.hook.setter } : {}),
    location: f.location ? `${f.location.file}:${f.location.line}` : '',
    fix: f.fix.kind,
    compilerFixes: f.fix.compilerFixes,
    stepsAffected: f.stepsAffected,
    steps: f.steps,
  };
}

function matches(f: Finding, m: MustNot): boolean {
  return (
    (m.component === undefined || f.component === m.component) &&
    (m.prop === undefined || f.prop?.name === m.prop) &&
    (m.setter === undefined || f.hook?.setter === m.setter) &&
    (m.hookOwner === undefined || f.hook?.owner === m.hookOwner) &&
    (m.file === undefined || f.location?.file === m.file) &&
    (m.commit === undefined || f.commits.includes(m.commit))
  );
}

async function fixturesWithFindings() {
  const found: { name: string; dir: string; section: FindingsSection }[] = [];
  for (const name of (await readdir(FIXTURES)).sort()) {
    const file = path.join(FIXTURES, name, 'expected.json');
    if (!existsSync(file)) continue;
    const expected = JSON.parse(await readFile(file, 'utf8')) as { findings?: FindingsSection };
    if (expected.findings) found.push({ name, dir: path.join(FIXTURES, name), section: expected.findings });
  }
  return found;
}

async function load(dir: string) {
  const names = (await readdir(dir)).filter((n) => /\.[cm]?[jt]sx?$/.test(n));
  const files = await Promise.all(names.map(async (n) => ({ path: n, content: await readFile(path.join(dir, n), 'utf8') })));
  const test = JSON.parse(await readFile(path.join(dir, 'test.json'), 'utf8')) as Record<string, unknown>;
  return { files, test };
}

const runsDir = await mkdtemp(path.join(os.tmpdir(), 'rt-golden-runs-'));
afterAll(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

describe('analyzer golden test', async () => {
  const fixtures = await fixturesWithFindings();

  for (const { name, dir, section } of fixtures) {
    const { files, test } = await load(dir);

    for (const [entry, want] of Object.entries(section.variants)) {
      it(`${name}/${entry}: findings match EXPECTED.md`, async () => {
        const input = InspectRenderInputSchema.parse({ ...test, files, entry });
        const result = await recordRender(input);
        if (!result.ok) throw new Error(`Recording failed: ${JSON.stringify(result.error, null, 2)}`);
        if (process.env.RT_SAVE_TRACES) {
          const variant = entry.replace(/\.[cm]?[jt]sx?$/, '');
          await writeFile(path.join(TRACES, `${name}.${variant}.json`), `${JSON.stringify({ summary: result.summary, traces: result.traces.slice(0, 1) })}\n`);
        }
        const analysis = analyze({ summary: result.summary, traces: result.traces, files });
        console.log(
          `${name}/${entry}: ${analysis.keystroke.msPerStep} ms per ${analysis.keystroke.unit}; findings: ` +
            (analysis.allFindings.map((f) => `${f.id} (${f.msPerStep} ms/step, ${f.stepsAffected}/${f.steps} steps)`).join('; ') || 'none'),
        );
        expect(analysis.allFindings.map(view)).toEqual(want.report.map((w) => expect.objectContaining(w)));
        expect(analysis.allFindings).toHaveLength(want.report.length);
        for (const m of want.mustNotReport) {
          expect(analysis.allFindings.filter((f) => matches(f, m)), `must not report ${JSON.stringify(m)}`).toEqual([]);
        }
      });
    }

    const cmp = section.comparison;
    if (!cmp) continue;
    it(`${name}: re-run with baselineRunId (${cmp.baseline} → ${cmp.fixed})`, async () => {
      const before = await inspectRender(InspectRenderInputSchema.parse({ ...test, files, entry: cmp.baseline }), runsDir);
      const first = before.structuredContent as InspectRenderOutput;
      if ('error' in first) throw new Error(JSON.stringify(first.error));
      expect(await listRunIds(runsDir)).toContain(first.run.id);
      expect((await loadRun(first.run.id, runsDir))?.input.entry).toBe(cmp.baseline);

      // Claude edits the file in place: the fixed content under the baseline's path.
      const fixedContent = files.find((f) => f.path === cmp.fixed)!.content;
      const edited = files.filter((f) => f.path !== cmp.fixed).map((f) => (f.path === cmp.baseline ? { ...f, content: fixedContent } : f));
      const after = await inspectRender(
        InspectRenderInputSchema.parse({ ...test, files: edited, entry: cmp.baseline, baselineRunId: first.run.id }),
        runsDir,
      );
      const second = after.structuredContent as InspectRenderOutput;
      if ('error' in second) throw new Error(JSON.stringify(second.error));
      const text = after.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      console.log(text);
      const c = second.comparison!;
      expect(c.found).toBe(true);
      expect(c.baselineRunId).toBe(first.run.id);
      expect(c.resolved.map((f) => f.id)).toEqual(cmp.resolved);
      expect(c.stillThere.map((f) => f.id)).toEqual(cmp.stillThere);
      expect(c.new.map((f) => f.id)).toEqual(cmp.new);
      expect(c.sameInteraction).toBe(true);
      expect(c.changedFiles).toEqual([cmp.baseline, cmp.fixed].sort());
      expect(text).toContain(`Compared with run ${first.run.id}`);
      expect(await listRunIds(runsDir)).toEqual(expect.arrayContaining([first.run.id, second.run.id]));
    });
  }
});

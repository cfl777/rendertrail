/**
 * Golden test for the analyzer: records every fixture through the real recorder (headless Chrome),
 * analyzes it and checks the findings against the `findings` section of its expected.json (a copy
 * of EXPECTED.md's "must report" and "must NOT be reported"). Every known fixture must have one, so
 * none drops out silently. Then, for each fixture with a fixed variant, the full tool runs twice
 * through inspectRender: the baseline variant, and the fixed variant sent under the baseline's entry
 * path with baselineRunId, as Claude would after a fix. Runs are stored in a temporary folder, never
 * the real home.
 *
 * `RT_SAVE_TRACES=1 npm run test:golden` also rewrites the analyzer's unit-test inputs in
 * test/fixtures/traces/ (<fixture>.<variant>.json: the summary and the first run's trace).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../../src/analyzer/index.js';
import { formatAnalysis } from '../../src/analyzer/text.js';
import { recordRender } from '../../src/recorder/index.js';
import { inspectRender } from '../../src/server/inspect-render.js';
import { InspectRenderInputSchema, type InspectRenderOutput } from '../../src/shared/types.js';
import { listRunIds, loadRun } from '../../src/store/runs.js';
import { comparisonHeadline } from '../../ui/src/model.js';
import {
  FIXTURES_DIR,
  KNOWN_FIXTURES,
  findingView,
  fixtureExpected,
  fixtureFiles,
  fixtureTest,
  matchesMustNot,
  traceFile,
} from '../helpers/fixtures.js';

const runsDir = await mkdtemp(path.join(os.tmpdir(), 'rt-golden-runs-'));
afterAll(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

const names = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && existsSync(path.join(FIXTURES_DIR, d.name, 'expected.json')))
  .map((d) => d.name)
  .sort();

describe('analyzer golden test', () => {
  it('covers every known fixture, each with a findings section for every variant', () => {
    expect(names).toEqual(KNOWN_FIXTURES);
    for (const name of names) {
      const expected = fixtureExpected(name);
      const entries = [fixtureTest(name).entry, ...(expected.fixedEntry ? [expected.fixedEntry] : [])];
      expect(expected.findings, `fixtures/${name}/expected.json has no findings section`).toBeDefined();
      expect(Object.keys(expected.findings!.variants).sort(), name).toEqual(entries.sort());
      expect(Boolean(expected.findings!.comparison), `${name}: a comparison exactly when there is a fixed variant`).toBe(Boolean(expected.fixedEntry));
    }
  });

  for (const name of names) {
    const section = fixtureExpected(name).findings;
    if (!section) continue; // the coverage test above fails instead
    const files = fixtureFiles(name);
    const test = fixtureTest(name);

    for (const [entry, want] of Object.entries(section.variants)) {
      it(`${name}/${entry}: findings match EXPECTED.md`, async () => {
        const input = InspectRenderInputSchema.parse({ ...test, files, entry });
        // `commit` entries below are indexes into EXPECTED.md's commit table, so they only mean
        // something when run 1 recorded that many updates. On React 18 one run has occasionally
        // recorded one more update than EXPECTED.md lists (cause not investigated yet): record once
        // more, then fail loudly rather than skip those checks.
        const wantCount = fixtureExpected(name).variants?.[entry]?.commitCount;
        const record = async () => {
          const r = await recordRender(input);
          if (!r.ok) throw new Error(`Recording failed: ${JSON.stringify(r.error, null, 2)}`);
          return r;
        };
        let result = await record();
        if (result.traces[0]!.commits.length !== wantCount) {
          console.log(`${name}/${entry}: run 1 recorded ${result.traces[0]!.commits.length} updates, EXPECTED.md has ${wantCount}; recording again`);
          result = await record();
        }
        const n = result.traces[0]!.commits.length;
        expect(n === wantCount, `run 1 recorded ${n} updates, EXPECTED.md has ${wantCount}: recorder flake`).toBe(true);
        if (process.env.RT_SAVE_TRACES) {
          await writeFile(traceFile(name, entry), `${JSON.stringify({ summary: result.summary, traces: result.traces.slice(0, 1) })}\n`);
        }
        const analysis = await analyze({ summary: result.summary, traces: result.traces, files });
        console.log(
          `${name}/${entry}: ${analysis.keystroke.msPerStep} ms per ${analysis.keystroke.unit}; findings: ` +
            (analysis.allFindings.map((f) => `${f.id} (${f.msPerStep} ms/step, ${f.stepsAffected}/${f.steps} steps)`).join('; ') || 'none'),
        );
        expect(analysis.allFindings.map(findingView)).toEqual(want.report.map((w) => expect.objectContaining(w)));
        expect(analysis.allFindings).toHaveLength(want.report.length);
        for (const m of want.mustNotReport) {
          expect(analysis.allFindings.filter((f) => matchesMustNot(f, m)), `must not report ${JSON.stringify(m)}`).toEqual([]);
        }
        if (want.report.length === 0) {
          // "No main problem was found": the card's no-findings state and the text result say so.
          expect(analysis.findings).toEqual([]);
          expect(analysis.keystroke.headline).toMatch(/^Nothing to fix: each \w+ takes [\d.]+ ms\.$/);
          const text = formatAnalysis({ summary: result.summary, steps: analysis.steps, findings: analysis.allFindings, keystroke: analysis.keystroke, runId: 'r_golden' });
          expect(text).toContain('No main problem found: ');
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
      const stored = await loadRun(first.run.id, runsDir);
      expect(stored.ok && stored.run.input.entry).toBe(cmp.baseline);

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
      expect(c.baselineFiles.map((f) => f.path).sort()).toEqual([cmp.baseline, cmp.fixed].sort());
      expect(text).toContain(`Compared with run ${first.run.id}`);
      // The card's headline (ui/src/model.ts): "Fixed." when the baseline's top finding is resolved and nothing is new.
      const top = section.variants[cmp.baseline]!.report[0];
      const topId = top ? `${top.rule}:${top.component}:${top.prop ?? top.setter}` : undefined;
      expect(comparisonHeadline(c, second)).toMatch(topId && cmp.resolved.includes(topId) && cmp.new.length === 0 ? /^Fixed\. / : /^(Partly fixed|Faster|Not fixed yet)\. /);
      expect(await listRunIds(runsDir)).toEqual(expect.arrayContaining([first.run.id, second.run.id]));
    });
  }
});

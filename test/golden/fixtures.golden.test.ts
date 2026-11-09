/**
 * Golden tests: records every fixtures/<name>/ that has an expected.json through the real recorder
 * (headless Chrome) and checks render and commit counts exactly against it (a copy of the fixture's
 * EXPECTED.md). Each fixture runs its test.json entry and, when expected.json names a `fixedEntry`,
 * the fixed variant too. Timings are only checked against each variant's loose `inputMedianMsRange`.
 * Triggers: mount and input are exact (counted input events); follow-up and later come from a flaky
 * gap heuristic, so they're only checked not to be input (Phase 2 tightens this).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recordRender } from '../../src/recorder/index.js';
import { InspectRenderInputSchema } from '../../src/shared/types.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

interface ExpectedVariant {
  commitCount: number;
  commits: { index: number; trigger: string; renders: Record<string, number> }[];
  rendersAfterMount: Record<string, number>;
  /** Loose [low, high] range for the median input commit, in ms. */
  inputMedianMsRange?: [number, number];
}

interface Expected {
  test: string;
  /** The fixed variant's entry file, recorded with the same steps. */
  fixedEntry?: string;
  variants: Record<string, ExpectedVariant>;
}

async function fixtureNames(): Promise<string[]> {
  const dirs = await readdir(FIXTURES, { withFileTypes: true });
  const names: string[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const files = await readdir(path.join(FIXTURES, dir.name));
    if (files.includes('expected.json')) names.push(dir.name);
  }
  return names.sort();
}

async function loadFixture(name: string) {
  const dir = path.join(FIXTURES, name);
  const names = (await readdir(dir)).filter((file) => /\.tsx?$/.test(file));
  const files = await Promise.all(
    names.map(async (file) => ({ path: file, content: await readFile(path.join(dir, file), 'utf8') })),
  );
  const expected = JSON.parse(await readFile(path.join(dir, 'expected.json'), 'utf8')) as Expected;
  const test = JSON.parse(await readFile(path.join(dir, expected.test), 'utf8')) as Record<string, unknown> & {
    entry: string;
  };
  return { files, test, expected };
}

function countsByName(rendered: { name: string; count: number }[]): Record<string, number> {
  return Object.fromEntries(rendered.map((g) => [g.name, g.count]));
}

const names = await fixtureNames();

describe('fixture golden tests', () => {
  it('finds the fixtures', () => {
    expect(names).toContain('laggy-search');
  });
});

for (const name of names) {
  describe(`${name} golden test`, async () => {
    const { files, test, expected } = await loadFixture(name);
    const entries = [test.entry, ...(expected.fixedEntry ? [expected.fixedEntry] : [])];

    it('expected.json has one variant per entry', () => {
      expect(Object.keys(expected.variants).sort()).toEqual([...entries].sort());
    });

    for (const entry of entries) {
      const want = expected.variants[entry]!;

      it(`${entry} matches EXPECTED.md`, async () => {
        const input = InspectRenderInputSchema.parse({ ...test, files, entry });
        const result = await recordRender(input);
        if (!result.ok) throw new Error(`Recording failed: ${JSON.stringify(result.error, null, 2)}`);
        const { summary, traces } = result;

        console.log(
          `${name}/${entry}: React ${summary.reactVersion}, ${summary.browser}, ${summary.commitCount} commits, ` +
            `input median ${summary.timings.inputMedianMs} ms, mount ${summary.timings.mountMs} ms, ` +
            `renders after mount ${JSON.stringify(summary.rendersAfterMount)}, stable ${summary.stable}`,
        );

        if (process.env.EXPECT_REACT_VERSION) expect(summary.reactVersion).toBe(process.env.EXPECT_REACT_VERSION);
        expect(summary.stubs).toEqual([]);
        expect(summary.pageErrors).toEqual([]);
        expect(summary.instability).toEqual([]);
        expect(summary.stable).toBe(true);
        expect(summary.truncated).toBe(false);

        // Every run, not only the first, must match exactly.
        expect(traces).toHaveLength(3);
        for (const trace of traces) {
          expect(trace.commits).toHaveLength(want.commitCount);
        }
        expect(summary.commitCount).toBe(want.commitCount);
        expect(summary.commits.map((c) => ({ index: c.index, renders: countsByName(c.rendered) }))).toEqual(
          want.commits.map(({ index, renders }) => ({ index, renders })),
        );
        for (const trace of traces) {
          trace.commits.forEach((commit, i) => {
            const wanted = want.commits[i]!.trigger;
            if (wanted === 'mount' || wanted === 'input') expect(commit.trigger, `commit #${i}`).toBe(wanted);
            else expect(['follow-up', 'later'], `commit #${i}`).toContain(commit.trigger);
          });
        }
        expect(summary.rendersAfterMount).toEqual(want.rendersAfterMount);

        const [low, high] = want.inputMedianMsRange ?? [0, Infinity];
        expect(summary.timings.inputMedianMs).toBeGreaterThanOrEqual(low);
        expect(summary.timings.inputMedianMs).toBeLessThanOrEqual(high);
      });
    }
  });
}

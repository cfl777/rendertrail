/**
 * Golden test: records fixtures/laggy-search through the real recorder (headless Chrome) and checks
 * render and commit counts exactly against expected.json (a copy of EXPECTED.md). Timings are only
 * checked as loose ranges; triggers aren't checked (the follow-up/later gap heuristic is flaky).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recordRender } from '../../src/recorder/index.js';
import { InspectRenderInputSchema } from '../../src/shared/types.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/laggy-search/', import.meta.url));

interface ExpectedVariant {
  commitCount: number;
  commits: { index: number; renders: Record<string, number> }[];
  rendersAfterMount: Record<string, number>;
}

// Loose ranges for the median input commit (EXPECTED.md: about 20.5 ms before, 0.1–0.2 ms after).
// ResultRow busy-waits 0.06 ms, so 200 rows cost at least 12 ms on any machine.
const INPUT_MEDIAN_MS: Record<string, [number, number]> = {
  'SearchPage.tsx': [10, 200],
  'SearchPage.fixed.tsx': [0, 3],
};

async function loadFixture() {
  const names = (await readdir(FIXTURE)).filter((name) => /\.tsx?$/.test(name));
  const files = await Promise.all(
    names.map(async (name) => ({ path: name, content: await readFile(path.join(FIXTURE, name), 'utf8') })),
  );
  const test = JSON.parse(await readFile(path.join(FIXTURE, 'test.json'), 'utf8')) as Record<string, unknown>;
  const expected = JSON.parse(await readFile(path.join(FIXTURE, 'expected.json'), 'utf8')) as {
    variants: Record<string, ExpectedVariant>;
  };
  return { files, test, expected };
}

function countsByName(rendered: { name: string; count: number }[]): Record<string, number> {
  return Object.fromEntries(rendered.map((g) => [g.name, g.count]));
}

describe('laggy-search golden test', async () => {
  const { files, test, expected } = await loadFixture();

  for (const [entry, want] of Object.entries(expected.variants)) {
    it(`${entry} matches EXPECTED.md`, async () => {
      const input = InspectRenderInputSchema.parse({ ...test, files, entry });
      const result = await recordRender(input);
      if (!result.ok) throw new Error(`Recording failed: ${JSON.stringify(result.error, null, 2)}`);
      const { summary, traces } = result;

      console.log(
        `${entry}: React ${summary.reactVersion}, ${summary.browser}, ${summary.commitCount} commits, ` +
          `input median ${summary.timings.inputMedianMs} ms, mount ${summary.timings.mountMs} ms, ` +
          `renders after mount ${JSON.stringify(summary.rendersAfterMount)}, stable ${summary.stable}`,
      );

      if (process.env.EXPECT_REACT_VERSION) expect(summary.reactVersion).toBe(process.env.EXPECT_REACT_VERSION);
      expect(summary.stubs).toEqual([]);
      expect(summary.pageErrors).toEqual([]);
      expect(summary.instability).toEqual([]);
      expect(summary.stable).toBe(true);

      // Every run, not only the first, must match exactly.
      expect(traces).toHaveLength(3);
      for (const trace of traces) {
        expect(trace.commits).toHaveLength(want.commitCount);
      }
      expect(summary.commitCount).toBe(want.commitCount);
      expect(summary.commits.map((c) => ({ index: c.index, renders: countsByName(c.rendered) }))).toEqual(want.commits);
      expect(summary.rendersAfterMount).toEqual(want.rendersAfterMount);

      const [low, high] = INPUT_MEDIAN_MS[entry] ?? [0, Infinity];
      expect(summary.timings.inputMedianMs).toBeGreaterThanOrEqual(low);
      expect(summary.timings.inputMedianMs).toBeLessThanOrEqual(high);
    });
  }
});

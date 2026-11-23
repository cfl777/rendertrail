import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { laggyFiles, savedTrace } from '../../test/helpers/laggy.js';
import { BRAND } from '../brand.js';
import { SCHEMA_VERSION, type CallTiming, type InspectRenderOutput } from '../shared/types.js';
import { inspectRender } from './inspect-render.js';

// Counting is replaced with a stand-in the tests control (see the last test).
const counts = vi.hoisted(() => ({ recordCounts: vi.fn(async () => false) }));
vi.mock('../store/counts.js', () => counts);

// Which steps of each call ran, in order (the turn test).
const events = vi.hoisted(() => [] as string[]);

// No browser here: the recorder returns the saved laggy-search trace. The turn (withRecordingLock)
// and the input check are the real ones.
vi.mock('../recorder/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../recorder/index.js')>();
  return {
    ...actual,
    recordHoldingLock: async (_input: unknown, _options: unknown, queueMs = 0) => {
      events.push('record');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { summary, traces } = savedTrace('SearchPage');
      const run = { contextMs: 1, loadMountMs: 1, stepsMs: 1, scriptedMs: 0, collectMs: 1, closeMs: 1, totalMs: 5 };
      const timing = { queueMs, bundleMs: 1, instrumentationMs: 0, launchMs: 0, browserReused: true, runs: [run, run, run], summarizeMs: 1 };
      return { ok: true, summary, traces, timing };
    },
  };
});
vi.mock('../store/runs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/runs.js')>();
  return {
    ...actual,
    saveRun: async (...args: Parameters<typeof actual.saveRun>) => {
      await actual.saveRun(...args);
      events.push('store');
    },
  };
});

const input = {
  files: laggyFiles().filter((f) => !f.path.includes('.fixed')),
  entry: 'SearchPage.tsx',
  exportName: 'default',
  steps: savedTrace('SearchPage').summary.steps,
};

function textOf(result: Awaited<ReturnType<typeof inspectRender>>): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('inspectRender', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rt-inspect-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the findings when the baseline file is damaged, and says the baseline could not be read', async () => {
    await writeFile(path.join(dir, 'r_bad000.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, id: 'r_bad000', findings: [], keystroke: {} }));
    const result = await inspectRender({ ...input, baselineRunId: 'r_bad000' }, dir);
    const output = result.structuredContent as InspectRenderOutput;
    expect('error' in output).toBe(false);
    if ('error' in output) return;
    expect(output.findings.map((f) => f.id)).toEqual(['unstable-prop:ResultsList:filters', 'state-in-effect:SearchBox:setCharCount']);
    expect(output.comparison).toMatchObject({ found: false, baselineRunId: 'r_bad000' });
    const text = textOf(result);
    expect(text).toContain('The stored run "r_bad000" couldn\'t be read');
    expect(text).toContain('1. ResultsList (memo)');
    expect(text).toContain(`Run id: ${output.run.id}.`);
  });

  it("puts where the time went in the result's _meta, not in structuredContent or the text", async () => {
    const result = await inspectRender(input, dir);
    const output = result.structuredContent as InspectRenderOutput;
    if ('error' in output) throw new Error(output.error.message);
    expect(JSON.stringify(output)).not.toMatch(/analyzeMs|queueMs|browserReused/);
    const timing = result._meta?.[BRAND.timingMetaKey] as CallTiming | undefined;
    expect(timing).toMatchObject({ queueMs: 0, bundleMs: 1, launchMs: 0, browserReused: true, summarizeMs: 1 });
    expect(timing?.runs).toHaveLength(3);
    for (const key of ['analyzeMs', 'storeMs', 'totalMs'] as const) expect(timing?.[key]).toBeGreaterThanOrEqual(0);
    expect(timing!.totalMs).toBeGreaterThanOrEqual(timing!.analyzeMs + timing!.storeMs);
    expect(textOf(result)).not.toMatch(/analyzeMs|timing/);
  });

  it('holds the turn through analysis and the store write, so the next call records only after them', async () => {
    events.length = 0;
    const [a, b] = await Promise.all([inspectRender(input, dir), inspectRender(input, dir)]);
    expect(events).toEqual(['record', 'store', 'record', 'store']);
    const waited = (b._meta?.[BRAND.timingMetaKey] as CallTiming).queueMs;
    expect(waited).toBeGreaterThanOrEqual((a._meta?.[BRAND.timingMetaKey] as CallTiming).totalMs - 1);
  });

  it('refuses invalid input at once, without waiting for its turn', async () => {
    const twice = { ...input, files: [...input.files, input.files[0]!] };
    const result = await inspectRender(twice, dir);
    expect((result.structuredContent as InspectRenderOutput & { error?: { kind: string } }).error?.kind).toBe('input');
  });

  it('says the run could not be saved, without offering its id as a baseline', async () => {
    const notADir = path.join(dir, 'file');
    await writeFile(notADir, 'x');
    const result = await inspectRender(input, notADir);
    const text = textOf(result);
    expect(text).toContain("This run couldn't be saved");
    expect(text).not.toContain('Run id:');
    expect(text).toContain('1. ResultsList (memo)');
  });

  it('returns the result whatever counting does: throws, rejects or never finishes', async () => {
    const baseline = textOf(await inspectRender(input, dir));
    for (const misbehave of [
      () => {
        throw new Error('disk full');
      },
      () => Promise.reject(new Error('disk full')),
      () => new Promise<boolean>(() => {}),
    ]) {
      counts.recordCounts.mockImplementationOnce(misbehave as () => Promise<boolean>);
      const result = await inspectRender(input, dir);
      const beforeRunId = (text: string): string => text.slice(0, text.indexOf('Run id'));
      expect(beforeRunId(textOf(result))).toBe(beforeRunId(baseline));
      expect('error' in (result.structuredContent as InspectRenderOutput)).toBe(false);
    }
    expect(counts.recordCounts).toHaveBeenCalled();
  });
});

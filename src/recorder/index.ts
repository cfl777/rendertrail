/**
 * The recorder: bundle → run in headless Chrome (LIMITS.runs times, a fresh browser context each)
 * → summarize. Never throws; problems come back as a RecordError. The browser stays warm between
 * calls (browser.ts); recordings never overlap, so one can't slow down another's measured timings.
 */
import type { CallTiming, InspectRenderInput, RecordError, RecordedTrace, RunTiming, TraceSummary } from '../shared/types.js';
import { bundleApp, loadInstrumentation, normalizePath, reactVersion } from './bundle.js';
import { LIMITS } from './limits.js';
import { warmBrowser, type Lease } from './browser.js';
import { RecorderError, runOnce, since } from './run.js';
import { summarize } from './summarize.js';

export type RecordInput = Pick<InspectRenderInput, 'files' | 'entry' | 'exportName' | 'props' | 'steps'>;

/** The recorder's part of CallTiming. */
export type RecordTiming = Omit<CallTiming, 'analyzeMs' | 'storeMs' | 'totalMs'>;

export type RecordResult =
  | { ok: true; summary: TraceSummary; traces: RecordedTrace[]; timing: RecordTiming }
  | { ok: false; error: RecordError };

/** Checks the limits zod can't express. */
export function checkInput(input: RecordInput): RecordError | null {
  const fail = (message: string, details: string[] = []): RecordError => ({ kind: 'input', message, details, stubs: [] });
  if (input.files.length > LIMITS.maxFiles) return fail(`Too many files: ${input.files.length} (at most ${LIMITS.maxFiles}).`);
  const bytes = input.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
  if (bytes > LIMITS.maxSourceBytes) {
    return fail(`Too much source: ${Math.round(bytes / 1024)} KB (at most ${LIMITS.maxSourceBytes / 1024} KB). Send only the files needed to render the component.`);
  }
  const seen = new Set<string>();
  for (const file of input.files) {
    const key = normalizePath(file.path);
    if (seen.has(key)) return fail(`The file "${file.path}" was sent twice.`);
    seen.add(key);
  }
  return null;
}

let queue: Promise<unknown> = Promise.resolve();

export function recordRender(input: RecordInput): Promise<RecordResult> {
  const queued = performance.now();
  const result = queue.then(() => recordNow(input, since(queued)));
  queue = result.catch(() => {});
  return result;
}

async function recordNow(input: RecordInput, queueMs: number): Promise<RecordResult> {
  const invalid = checkInput(input);
  if (invalid) return { ok: false, error: invalid };

  let start = performance.now();
  const bundled = await bundleApp(input);
  const bundleMs = since(start);
  if (!bundled.ok) {
    return { ok: false, error: { kind: 'bundle', message: bundled.message, details: bundled.details, stubs: bundled.stubs } };
  }

  let lease: Lease | undefined;
  let discard = false;
  try {
    start = performance.now();
    const instrumentation = await loadInstrumentation();
    const instrumentationMs = since(start);
    start = performance.now();
    lease = await warmBrowser.acquire();
    const launchMs = since(start);
    const { launched, reused } = lease;
    const traces: RecordedTrace[] = [];
    const pageErrors: string[] = [];
    const runs: RunTiming[] = [];
    for (let run = 0; run < LIMITS.runs; run += 1) {
      const output = await runOnce(launched.browser, bundled.code, instrumentation, input.steps);
      traces.push(output.trace);
      pageErrors.push(...output.pageErrors);
      runs.push(output.timing);
    }
    start = performance.now();
    const summary = summarize(traces, {
      entry: input.entry,
      exportName: input.exportName,
      reactVersion: reactVersion(),
      browser: launched.label,
      steps: input.steps,
      stubs: bundled.stubs,
      pageErrors,
    });
    const summarizeMs = since(start);
    return {
      ok: true,
      summary,
      traces,
      timing: { queueMs, bundleMs, instrumentationMs, launchMs, browserReused: reused, runs, summarizeMs },
    };
  } catch (err) {
    // A run that timed out may have left a page busy in a loop; anything unexpected may have left the
    // browser in a bad state. Don't keep that browser for the next call.
    discard = !(err instanceof RecorderError) || err.kind === 'timeout' || err.kind === 'browser';
    if (err instanceof RecorderError) {
      return { ok: false, error: { kind: err.kind, message: err.message, details: err.details, stubs: bundled.stubs } };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: { kind: 'internal', message: `The recorder failed: ${message}`, details: [], stubs: bundled.stubs } };
  } finally {
    lease?.release(discard);
  }
}

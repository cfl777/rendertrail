/**
 * The recorder: bundle → run in headless Chrome (LIMITS.runs times, a fresh browser context each)
 * → summarize. Never throws; problems come back as a RecordError. The browser stays warm between
 * calls (browser.ts).
 *
 * Calls take turns (withRecordingLock): a recording never overlaps another call's recording, and
 * inspect_render also holds the turn through its analysis and store write, so no work of one call
 * (the analyzer's first TypeScript load blocks Node for a few hundred ms) can stretch the typing
 * delays of another call's recording. A recording has a deadline (RECORDING_DEADLINE_MS), so a
 * stuck one can't hold up the calls behind it.
 */
import type { CallTiming, InspectRenderInput, RecordError, RecordedTrace, RunTiming, TraceSummary } from '../shared/types.js';
import { bundleApp, loadInstrumentation, normalizePath, reactVersion } from './bundle.js';
import { LIMITS, RECORDING_DEADLINE_MS } from './limits.js';
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

let turn: Promise<void> = Promise.resolve();

/** Runs `work` when the previous call's turn is over; `work` gets how long it waited. */
export async function withRecordingLock<T>(work: (queueMs: number) => Promise<T>): Promise<T> {
  const queued = performance.now();
  const previous = turn;
  let done!: () => void;
  turn = new Promise<void>((resolve) => {
    done = resolve;
  });
  await previous;
  try {
    return await work(since(queued));
  } finally {
    done();
  }
}

export interface RecordOptions {
  /** The MCP request's cancel signal: a call cancelled while queued is skipped, a running one stops. */
  signal?: AbortSignal;
}

function cancelled(): RecordResult {
  return {
    ok: false,
    error: { kind: 'timeout', message: 'The call was cancelled before the recording finished.', details: [], stubs: [] },
  };
}

/** Checks the input, then records in turn (withRecordingLock). */
export function recordRender(input: RecordInput, options: RecordOptions = {}): Promise<RecordResult> {
  const invalid = checkInput(input);
  if (invalid) return Promise.resolve({ ok: false, error: invalid });
  return withRecordingLock((queueMs) => recordHoldingLock(input, options, queueMs));
}

/**
 * Records now: for a caller that already holds the turn and has checked the input. Gives up at
 * RECORDING_DEADLINE_MS: then the browser is closed (killed if need be) and the result is a timeout.
 */
export async function recordHoldingLock(input: RecordInput, options: RecordOptions, queueMs = 0): Promise<RecordResult> {
  if (options.signal?.aborted) return cancelled();
  const deadline = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<RecordResult>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      void warmBrowser.close();
      resolve({
        ok: false,
        error: {
          kind: 'timeout',
          message: `The recording took longer than ${RECORDING_DEADLINE_MS / 1000} s, so the browser was closed.`,
          details: [],
          stubs: [],
        },
      });
    }, RECORDING_DEADLINE_MS);
  });
  try {
    return await Promise.race([recordNow(input, queueMs, signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function recordNow(input: RecordInput, queueMs: number, signal: AbortSignal): Promise<RecordResult> {
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
    if (signal.aborted) return cancelled();
    start = performance.now();
    lease = await warmBrowser.acquire();
    const launchMs = since(start);
    const { launched, reused } = lease;
    const traces: RecordedTrace[] = [];
    const pageErrors: string[] = [];
    const runs: RunTiming[] = [];
    for (let run = 0; run < LIMITS.runs; run += 1) {
      if (signal.aborted) return cancelled();
      const output = await runOnce(launched.browser, bundled.code, instrumentation, input.steps, signal);
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
    // A run that timed out may have left a page busy in a loop, a page may not have closed, anything
    // unexpected may have left the browser in a bad state: don't keep that browser for the next call.
    discard = !(err instanceof RecorderError) || err.kind === 'browser' || err.browserBroken;
    if (err instanceof RecorderError) {
      return { ok: false, error: { kind: err.kind, message: err.message, details: err.details, stubs: bundled.stubs } };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: { kind: 'internal', message: `The recorder failed: ${message}`, details: [], stubs: bundled.stubs } };
  } finally {
    lease?.release(discard);
  }
}

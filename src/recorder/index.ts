/**
 * The recorder: bundle → run in headless Chrome (LIMITS.runs times, fresh page each) → summarize.
 * Never throws; problems come back as a RecordError.
 */
import type { InspectRenderInput, RecordError, RecordedTrace, TraceSummary } from '../shared/types.js';
import { bundleApp, loadInstrumentation, normalizePath, reactVersion } from './bundle.js';
import { LIMITS } from './limits.js';
import { launchBrowser, RecorderError, runOnce } from './run.js';
import { summarize } from './summarize.js';

export type RecordInput = Pick<InspectRenderInput, 'files' | 'entry' | 'exportName' | 'props' | 'steps'>;

export type RecordResult =
  | { ok: true; summary: TraceSummary; traces: RecordedTrace[] }
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

export async function recordRender(input: RecordInput): Promise<RecordResult> {
  const invalid = checkInput(input);
  if (invalid) return { ok: false, error: invalid };

  const bundled = await bundleApp(input);
  if (!bundled.ok) {
    return { ok: false, error: { kind: 'bundle', message: bundled.message, details: bundled.details, stubs: bundled.stubs } };
  }

  let launched: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const instrumentation = await loadInstrumentation();
    launched = await launchBrowser();
    const traces: RecordedTrace[] = [];
    const pageErrors: string[] = [];
    for (let run = 0; run < LIMITS.runs; run += 1) {
      const output = await runOnce(launched.browser, bundled.code, instrumentation, input.steps);
      traces.push(output.trace);
      pageErrors.push(...output.pageErrors);
    }
    const summary = summarize(traces, {
      entry: input.entry,
      exportName: input.exportName,
      reactVersion: reactVersion(),
      browser: launched.label,
      steps: input.steps,
      stubs: bundled.stubs,
      pageErrors,
    });
    return { ok: true, summary, traces };
  } catch (err) {
    if (err instanceof RecorderError) {
      return { ok: false, error: { kind: err.kind, message: err.message, details: err.details, stubs: bundled.stubs } };
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: { kind: 'internal', message: `The recorder failed: ${message}`, details: [], stubs: bundled.stubs } };
  } finally {
    await launched?.browser.close().catch(() => {});
  }
}

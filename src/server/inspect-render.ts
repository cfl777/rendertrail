import type { CallToolResult } from '@modelcontextprotocol/server';
import { analyze } from '../analyzer/index.js';
import { formatAnalysis } from '../analyzer/text.js';
import { formatError } from '../recorder/format.js';
import { recordRender } from '../recorder/index.js';
import {
  SCHEMA_VERSION,
  type Comparison,
  type InspectRenderInput,
  type InspectRenderOutput,
  type RecordError,
  type StoredRun,
} from '../shared/types.js';
import { compareRuns, missingBaseline } from '../store/compare.js';
import { listRunIds, loadRun, newRunId, resolveRunsDir, saveRun } from '../store/runs.js';

export const INSPECT_RENDER_DESCRIPTION =
  'Record how a React component renders while someone interacts with it, and explain the main performance problem. ' +
  'Use it when a React UI feels slow or re-renders too often. Pass only the files needed to render the component ' +
  '(replace data fetching with static data), the file to mount, and a short interaction, such as typing into an input. ' +
  'Returns the main problem, what it costs and the line to change. To check a fix, call it again with the changed files and `baselineRunId`.';

function errorResult(error: RecordError): CallToolResult {
  const output: InspectRenderOutput = { schemaVersion: SCHEMA_VERSION, error };
  return { content: [{ type: 'text', text: formatError(error) }], structuredContent: { ...output } };
}

/**
 * The inspect_render handler: record, analyze, compare with the baseline, store the run. Never
 * throws: problems are normal results that explain what to fix.
 */
export async function inspectRender(input: InspectRenderInput, runsDirOverride?: string): Promise<CallToolResult> {
  const notes: string[] = [];
  const resolved = resolveRunsDir();
  const dir = runsDirOverride ?? resolved.dir;
  if (!runsDirOverride && resolved.warning) notes.push(`Note: ${resolved.warning}`);
  try {
    const result = await recordRender(input);
    if (!result.ok) return errorResult(result.error);
    const analysis = await analyze({ summary: result.summary, traces: result.traces, files: input.files });

    const id = newRunId(new Set(await listRunIds(dir)));
    const run: StoredRun = {
      schemaVersion: SCHEMA_VERSION,
      id,
      createdAt: new Date().toISOString(),
      input: { files: input.files, entry: input.entry, exportName: input.exportName, props: input.props, steps: input.steps },
      summary: result.summary,
      steps: analysis.steps,
      findings: analysis.allFindings,
      keystroke: analysis.keystroke,
    };

    let comparison: Comparison | undefined;
    if (input.baselineRunId) {
      // A broken baseline must never cost the user this run's findings.
      try {
        const baseline = await loadRun(input.baselineRunId, dir);
        comparison = baseline.ok ? compareRuns(input.baselineRunId, baseline.run, run) : missingBaseline(input.baselineRunId, baseline.reason);
      } catch {
        comparison = missingBaseline(input.baselineRunId, 'unreadable');
      }
    }

    let saveError: string | undefined;
    try {
      await saveRun(run, dir);
    } catch (err) {
      saveError = err instanceof Error ? err.message : 'Unknown error';
    }

    const output: InspectRenderOutput = {
      schemaVersion: SCHEMA_VERSION,
      run: { id, createdAt: run.createdAt, summary: result.summary, steps: analysis.steps },
      findings: analysis.findings,
      keystroke: analysis.keystroke,
      ...(comparison ? { comparison } : {}),
    };
    const text = formatAnalysis({
      summary: result.summary,
      steps: analysis.steps,
      findings: analysis.allFindings,
      keystroke: analysis.keystroke,
      runId: id,
      comparison,
      saveError,
    });
    return {
      content: [{ type: 'text', text: [text, ...notes].join('\n') }],
      structuredContent: { ...output },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return errorResult({ kind: 'internal', message: `The analysis failed: ${message}`, details: [], stubs: [] });
  }
}

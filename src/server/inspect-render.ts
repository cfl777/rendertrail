import type { CallToolResult } from '@modelcontextprotocol/server';
import { formatError, formatSummary } from '../recorder/format.js';
import { recordRender } from '../recorder/index.js';
import { SCHEMA_VERSION, type InspectRenderInput, type InspectRenderOutput, type RecordError } from '../shared/types.js';

export const INSPECT_RENDER_DESCRIPTION =
  'Record how a React component renders while someone interacts with it, and explain the main performance problem. ' +
  'Use it when a React UI feels slow or re-renders too often. Pass only the files needed to render the component ' +
  '(replace data fetching with static data), the file to mount, and a short interaction, such as typing into an input. ' +
  'Returns the main problem, what it costs and the line to change. To check a fix, call it again with the changed files and `baselineRunId`.';

function errorResult(error: RecordError): CallToolResult {
  const output: InspectRenderOutput = { schemaVersion: SCHEMA_VERSION, error };
  return { content: [{ type: 'text', text: formatError(error) }], structuredContent: { ...output } };
}

/** The inspect_render handler. Never throws: problems are normal results that explain what to fix. */
export async function inspectRender(input: InspectRenderInput): Promise<CallToolResult> {
  try {
    const result = await recordRender(input);
    if (!result.ok) return errorResult(result.error);
    const notes = input.baselineRunId
      ? [`baselineRunId "${input.baselineRunId}" was ignored: comparing with an earlier run is not built yet.`]
      : [];
    const output: InspectRenderOutput = { schemaVersion: SCHEMA_VERSION, run: result.summary };
    return {
      content: [{ type: 'text', text: formatSummary(result.summary, notes) }],
      structuredContent: { ...output },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return errorResult({ kind: 'internal', message: `The recorder failed: ${message}`, details: [], stubs: [] });
  }
}

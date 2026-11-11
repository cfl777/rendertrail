/**
 * Card harness data: real inspect_render results (structuredContent plus the tool input the host
 * sends) built from the saved laggy-search traces by the real analyzer and comparison. Written to
 * ui/dev/results/ by `npm run card:results`; test/card-results.test.ts fails when they drift.
 *
 * Every result runs through analyze() and compareRuns(). A few are derived from the saved traces
 * to reach states the fixture can't produce on its own; each says how in `note`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../../src/analyzer/index.js';
import {
  SCHEMA_VERSION,
  type Comparison,
  type InspectRenderInput,
  type InspectRenderOutput,
  type RecordError,
  type RecordedTrace,
  type TraceSummary,
} from '../../src/shared/types.js';
import { compareRuns, missingBaseline } from '../../src/store/compare.js';
import type { CardResult } from '../../ui/dev/result-types.js';
import { laggyFiles, savedTrace } from './laggy.js';

export type { CardResult };

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CARD_RESULTS_DIR = path.join(ROOT, 'ui', 'dev', 'results');
const CREATED_AT = '2026-11-11T09:00:00.000Z';

type Files = { path: string; content: string }[];

/** The fixture as Claude would send it: SearchPage.tsx is the file to mount, no `.fixed` variant. */
function unfixedFiles(): Files {
  return lfFiles().filter((f) => !f.path.includes('.fixed'));
}

/** LF line endings, so the results are the same on a Windows checkout (autocrlf) and in CI. */
function lfFiles(): Files {
  return laggyFiles().map((f) => ({ path: f.path, content: f.content.replace(/\r\n/g, '\n') }));
}

/** After Claude's first fix: SearchPage.tsx now holds SearchPage.fixed.tsx's content. */
function fixedFiles(): Files {
  const all = lfFiles();
  const fixed = all.find((f) => f.path === 'SearchPage.fixed.tsx')!.content;
  return unfixedFiles().map((f) => (f.path === 'SearchPage.tsx' ? { ...f, content: fixed } : f));
}

/** After both fixes: SearchBox computes charCount during render. */
function allFixedFiles(): Files {
  return fixedFiles().map((f) =>
    f.path === 'SearchBox.tsx'
      ? {
          ...f,
          content: f.content
            .replace("import { useEffect, useState } from 'react';", '')
            .replace(/  const \[charCount, setCharCount\] = useState\(0\);\n  useEffect\(\(\) => setCharCount\(value\.length\), \[value\]\);\n/, '  const charCount = value.length;\n')
            .replace(/^\n/, ''),
        }
      : f,
  );
}

function inputFor(files: Files, summary: TraceSummary, baselineRunId?: string): InspectRenderInput {
  return {
    files,
    entry: 'SearchPage.tsx',
    exportName: 'default',
    steps: summary.steps,
    ...(baselineRunId ? { baselineRunId } : {}),
  };
}

interface Analyzed {
  input: InspectRenderInput;
  output: Extract<InspectRenderOutput, { run: unknown }>;
  allFindings: Awaited<ReturnType<typeof analyze>>['allFindings'];
}

async function run(id: string, variant: 'SearchPage' | 'SearchPage.fixed', files: Files, tweak?: (t: { summary: TraceSummary; traces: RecordedTrace[] }) => void): Promise<Analyzed> {
  const saved = savedTrace(variant);
  // The fixed trace was recorded with SearchPage.fixed.tsx as the entry; here it stands for a
  // re-run of SearchPage.tsx with the fixed content, which is what Claude would send.
  saved.summary = { ...saved.summary, entry: 'SearchPage.tsx' };
  tweak?.(saved);
  const a = await analyze({ summary: saved.summary, traces: saved.traces, files });
  return {
    input: inputFor(files, saved.summary),
    output: {
      schemaVersion: SCHEMA_VERSION,
      run: { id, createdAt: CREATED_AT, summary: saved.summary, steps: a.steps },
      findings: a.findings,
      keystroke: a.keystroke,
    },
    allFindings: a.allFindings,
  };
}

function withComparison(current: Analyzed, baseline: Analyzed, baselineId: string, comparison?: Comparison): { input: InspectRenderInput; output: InspectRenderOutput } {
  const c =
    comparison ??
    compareRuns(
      baselineId,
      { input: { ...baseline.input, steps: baseline.input.steps }, findings: baseline.allFindings, keystroke: baseline.output.keystroke },
      { input: current.input, findings: current.allFindings, keystroke: current.output.keystroke },
    );
  return {
    input: { ...current.input, baselineRunId: baselineId },
    output: { ...current.output, comparison: c },
  };
}

const ERROR: RecordError = {
  kind: 'mount',
  message: 'The component threw an error while mounting.',
  details: ["TypeError: Cannot read properties of undefined (reading 'filter')\n    at ResultsList (ResultsList.tsx:12:24)"],
  stubs: ['./api (imported by SearchPage.tsx)', '@acme/ui/Spinner (imported by ResultsList.tsx)'],
};

export async function buildCardResults(): Promise<Record<string, CardResult>> {
  const unfixed = await run('r_8f2k1a', 'SearchPage', unfixedFiles());
  const fixed = await run('r_q7m3cd', 'SearchPage.fixed', fixedFiles());
  const allFixed = await run('r_t5w9xe', 'SearchPage.fixed', allFixedFiles());
  const noUpdates = await run('r_n0u4pd', 'SearchPage.fixed', fixedFiles(), (t) => {
    // Only the mount: as if the typing no longer changed anything.
    t.traces = t.traces.map((tr) => ({ ...tr, commits: tr.commits.slice(0, 1) }));
    t.summary = { ...t.summary, commitCount: 1, commits: t.summary.commits.slice(0, 1) };
  });
  const unstable = await run('r_u2s8tb', 'SearchPage', unfixedFiles(), (t) => {
    t.summary = {
      ...t.summary,
      stable: false,
      truncated: true,
      instability: ['Run 3 recorded 13 commits, run 1 recorded 12.'],
      stubs: ['./analytics (imported by SearchPage.tsx)'],
    };
  });

  return {
    unfixed: { title: 'Answer: laggy search, 2 findings', ...pick(unfixed) },
    'rerun-fixed': {
      title: 'Re-run: first fix applied (1 resolved, 1 still there)',
      ...withComparison(fixed, unfixed, unfixed.output.run.id),
    },
    'rerun-all-fixed': {
      title: 'Re-run: both fixes applied (2 resolved)',
      note: 'SearchBox.tsx also computes charCount during render, so the source check drops rule 2.',
      ...withComparison(allFixed, unfixed, unfixed.output.run.id),
    },
    'rerun-not-fixed': {
      title: 'Re-run: nothing changed (2 still there)',
      ...withComparison({ ...unfixed, output: { ...unfixed.output, run: { ...unfixed.output.run, id: 'r_v3b6nf' } } }, unfixed, unfixed.output.run.id),
    },
    'no-findings': {
      title: 'Answer: no findings (both fixes applied, no baseline)',
      note: 'The fixed trace analysed with SearchBox.tsx fixed too.',
      ...pick(allFixed),
    },
    'rerun-unchecked': {
      title: "Re-run: couldn't check (no update after input)",
      note: 'The fixed trace cut to its mount, as if the typing no longer changed anything.',
      ...withComparison(noUpdates, unfixed, unfixed.output.run.id),
    },
    'baseline-missing': {
      title: 'Re-run: baseline id not found',
      ...withComparison(fixed, unfixed, 'r_zz99zz', missingBaseline('r_zz99zz')),
    },
    unstable: {
      title: 'Answer: unstable and truncated recording, with a stub',
      note: 'The unfixed result with stable, truncated, instability and stubs set by hand.',
      ...pick(unstable),
    },
    error: {
      title: "Couldn't record (component threw while mounting)",
      note: 'Hand-made RecordError in the shape the recorder returns.',
      input: inputFor(unfixedFiles(), savedTrace('SearchPage').summary),
      output: { schemaVersion: SCHEMA_VERSION, error: ERROR },
    },
  };
}

function pick(a: Analyzed): { input: InspectRenderInput; output: InspectRenderOutput } {
  return { input: a.input, output: a.output };
}

export function serialize(result: CardResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export async function writeCardResults(): Promise<string[]> {
  const results = await buildCardResults();
  await mkdir(CARD_RESULTS_DIR, { recursive: true });
  const written: string[] = [];
  for (const [name, result] of Object.entries(results)) {
    const file = path.join(CARD_RESULTS_DIR, `${name}.json`);
    await writeFile(file, serialize(result));
    written.push(file);
  }
  return written;
}

export async function readCardResult(name: string): Promise<string> {
  return readFile(path.join(CARD_RESULTS_DIR, `${name}.json`), 'utf8');
}

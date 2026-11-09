/**
 * Pure: compare a run with its baseline (HANDOFF.md §7): cost and renders per step before and
 * after, and which findings were resolved, are still there or are new.
 */
import type { Comparison, Finding, FindingRef, StoredRun } from '../shared/types.js';
import { msText } from '../analyzer/words.js';

export interface RunForComparison {
  input: StoredRun['input'];
  findings: Finding[];
  keystroke: StoredRun['keystroke'];
}

function shortSummary(f: Finding): string {
  if (f.rule === 'unstable-prop') return `${f.component} re-rendered for nothing (unstable prop \`${f.prop?.name ?? '?'}\`)`;
  const owner = f.hook && f.hook.owner !== f.component ? ` in ${f.hook.owner}` : '';
  return `${f.component} sets state inside an effect (\`${f.hook?.setter ?? '?'}\`${owner})`;
}

function ref(f: Finding): FindingRef {
  return { id: f.id, rule: f.rule, component: f.component, summary: shortSummary(f) };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function changedFiles(before: StoredRun['input']['files'], after: StoredRun['input']['files']): string[] {
  const old = new Map(before.map((f) => [f.path, f.content]));
  const now = new Map(after.map((f) => [f.path, f.content]));
  const paths = [...new Set([...old.keys(), ...now.keys()])];
  return paths.filter((p) => old.get(p) !== now.get(p)).sort();
}

export function missingBaseline(baselineRunId: string): Comparison {
  return {
    baselineRunId,
    found: false,
    message:
      `No stored run has the id "${baselineRunId}", so there is nothing to compare with. Runs are kept on this computer (the last 50); ` +
      'use the run id from an earlier result. This run is shown on its own.',
    resolved: [],
    stillThere: [],
    new: [],
    sameInteraction: false,
    changedFiles: [],
  };
}

export function compareRuns(baselineRunId: string, baseline: RunForComparison, current: RunForComparison): Comparison {
  const beforeIds = new Set(baseline.findings.map((f) => f.id));
  const nowIds = new Set(current.findings.map((f) => f.id));
  const b = baseline.keystroke;
  const a = current.keystroke;
  const sameInteraction =
    baseline.input.entry === current.input.entry &&
    baseline.input.exportName === current.input.exportName &&
    sameJson(baseline.input.props, current.input.props) &&
    sameJson(baseline.input.steps, current.input.steps);
  const unit = a.unit;
  const verdict =
    a.steps === 0 || b.steps === 0
      ? `Compared with run ${baselineRunId}.`
      : a.msPerStep < b.msPerStep
        ? `Compared with run ${baselineRunId}: each ${unit} now takes ${msText(a.msPerStep)}, down from ${msText(b.msPerStep)}.`
        : `Compared with run ${baselineRunId}: each ${unit} now takes ${msText(a.msPerStep)} (it took ${msText(b.msPerStep)}).`;
  return {
    baselineRunId,
    found: true,
    message: verdict,
    before: { msPerStep: b.msPerStep, rendersPerStep: b.rendersPerStep, steps: b.steps },
    after: { msPerStep: a.msPerStep, rendersPerStep: a.rendersPerStep, steps: a.steps },
    resolved: baseline.findings.filter((f) => !nowIds.has(f.id)).map(ref),
    stillThere: current.findings.filter((f) => beforeIds.has(f.id)).map(ref),
    new: current.findings.filter((f) => !beforeIds.has(f.id)).map(ref),
    sameInteraction,
    changedFiles: changedFiles(baseline.input.files, current.input.files),
  };
}

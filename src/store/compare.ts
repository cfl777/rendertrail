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

/** No stored run with that id, or its file can't be read: a normal result that says so. */
export function missingBaseline(baselineRunId: string, reason: 'missing' | 'unreadable' = 'missing'): Comparison {
  const what =
    reason === 'missing'
      ? `No stored run has the id "${baselineRunId}", so there is nothing to compare with. Runs are kept on this computer (the last 50); use the run id from an earlier result.`
      : `The stored run "${baselineRunId}" couldn't be read (its file is damaged or from another version), so there is nothing to compare with.`;
  return {
    baselineRunId,
    found: false,
    checked: false,
    message: `${what} This run is shown on its own.`,
    resolved: [],
    stillThere: [],
    new: [],
    sameInteraction: false,
    changedFiles: [],
    baselineFiles: [],
  };
}

export function compareRuns(baselineRunId: string, baseline: RunForComparison, current: RunForComparison): Comparison {
  const b = baseline.keystroke;
  const a = current.keystroke;
  const sameInteraction =
    baseline.input.entry === current.input.entry &&
    baseline.input.exportName === current.input.exportName &&
    sameJson(baseline.input.props, current.input.props) &&
    sameJson(baseline.input.steps, current.input.steps);
  const changed = changedFiles(baseline.input.files, current.input.files);
  const baselineFiles = baseline.input.files.filter((f) => changed.includes(f.path)).map((f) => ({ path: f.path, content: f.content }));
  const top = baseline.findings.find((f) => f.rank === 1);
  const common = { baselineRunId, found: true, sameInteraction, changedFiles: changed, ...(top ? { baselineTopFindingId: top.id } : {}), baselineFiles };

  // With no update after input in either run there's no cost per step to compare, and "no
  // findings" would only mean nothing was measured.
  if (a.steps === 0 || b.steps === 0) {
    const which = a.steps === 0 ? 'The new run' : `The baseline run ${baselineRunId}`;
    return {
      ...common,
      checked: false,
      message:
        `${which} recorded no update after input, so the fix can't be checked. ` +
        'Make sure the interaction still changes the component (for example, that the input or button still works), then run it again.',
      resolved: [],
      stillThere: [],
      new: [],
    };
  }

  const beforeIds = new Set(baseline.findings.map((f) => f.id));
  const nowIds = new Set(current.findings.map((f) => f.id));
  const unit = a.unit;
  const message =
    a.msPerStep < b.msPerStep
      ? `Compared with run ${baselineRunId}: each ${unit} now takes ${msText(a.msPerStep)}, down from ${msText(b.msPerStep)}.`
      : `Compared with run ${baselineRunId}: each ${unit} now takes ${msText(a.msPerStep)} (it took ${msText(b.msPerStep)}).`;
  return {
    ...common,
    checked: true,
    message,
    before: { msPerStep: b.msPerStep, rendersPerStep: b.rendersPerStep, steps: b.steps },
    after: { msPerStep: a.msPerStep, rendersPerStep: a.rendersPerStep, steps: a.steps },
    resolved: baseline.findings.filter((f) => !nowIds.has(f.id)).map(ref),
    stillThere: current.findings.filter((f) => beforeIds.has(f.id)).map(ref),
    new: current.findings.filter((f) => !beforeIds.has(f.id)).map(ref),
  };
}

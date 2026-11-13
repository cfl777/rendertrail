/**
 * Pure functions: turn the traces of repeated runs into one summary, with median timings and a
 * stability check on the render counts.
 */
import type {
  CommitSummary,
  ComponentGroup,
  RecordedCommit,
  RecordedTrace,
  Step,
  TraceSummary,
} from '../shared/types.js';
import { FRAME_BUDGET_MS, TIMER_RESOLUTION_MS } from './limits.js';

const MAX_NOTES_PER_GROUP = 6;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(value * 100) / 100;
}

/** Components that rendered in a commit, grouped by name in order of first appearance. */
export function groupRendered(commit: RecordedCommit): ComponentGroup[] {
  const groups = new Map<string, { group: ComponentGroup; notes: Set<string> }>();
  for (const r of commit.rendered) {
    let entry = groups.get(r.name);
    if (!entry) {
      entry = { group: { name: r.name, count: 0, memo: r.memo, notes: [] }, notes: new Set() };
      groups.set(r.name, entry);
    }
    entry.group.count += 1;
    for (const p of r.changedProps) {
      if (p.name === 'children') continue;
      entry.notes.add(`${p.name} changed${p.sameValue ? ' (new reference, same value)' : ''}`);
    }
    for (const s of r.changedState) entry.notes.add(`state #${s.hook} ${s.from} → ${s.to}`);
    for (const c of r.changedContext) {
      entry.notes.add(`context ${c.name} changed${c.sameValue ? ' (new reference, same value)' : ''}`);
    }
  }
  return [...groups.values()].map(({ group, notes }) => ({ ...group, notes: [...notes].slice(0, MAX_NOTES_PER_GROUP) }));
}

function signature(commit: RecordedCommit): string {
  return groupRendered(commit)
    .map((g) => `${g.name}×${g.count}`)
    .join(', ');
}

/** Differences in render counts between runs; empty when every run rendered the same. */
export function compareRuns(traces: readonly RecordedTrace[]): string[] {
  const [first, ...rest] = traces;
  if (!first) return [];
  const problems: string[] = [];
  rest.forEach((trace, i) => {
    const run = i + 2;
    if (trace.commits.length !== first.commits.length) {
      problems.push(`Run ${run} recorded ${trace.commits.length} commits, run 1 recorded ${first.commits.length}.`);
      return;
    }
    trace.commits.forEach((commit, index) => {
      const a = signature(first.commits[index]!);
      const b = signature(commit);
      if (a !== b) problems.push(`Commit #${index} differs: run 1 rendered ${a || 'nothing'}; run ${run} rendered ${b || 'nothing'}.`);
    });
  });
  return problems;
}

/**
 * Run 1 and the runs that rendered the same as it, commit for commit. Timings are taken per commit
 * index, so only these line up: in a run with one extra commit, every later index holds a
 * different update (an input update where run 1 has its follow-up).
 */
export function matchingRuns(traces: readonly RecordedTrace[]): RecordedTrace[] {
  const [first, ...rest] = traces;
  if (!first) return [];
  const want = first.commits.map(signature);
  return [first, ...rest.filter((t) => t.commits.length === want.length && t.commits.every((c, i) => signature(c) === want[i]))];
}

export function rendersAfterMount(trace: RecordedTrace): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const commit of trace.commits) {
    for (const r of commit.rendered) {
      counts[r.name] = (counts[r.name] ?? 0) + (commit.index > 0 ? 1 : 0);
    }
  }
  return counts;
}

export interface SummaryMeta {
  entry: string;
  exportName: string;
  reactVersion: string;
  browser: string;
  steps: Step[];
  stubs: string[];
  pageErrors: string[];
}

export function summarize(traces: readonly RecordedTrace[], meta: SummaryMeta): TraceSummary {
  const first = traces[0];
  if (!first) throw new Error('summarize needs at least one trace');
  const instability = compareRuns(traces);
  const matching = matchingRuns(traces);

  const commits: CommitSummary[] = first.commits.map((commit) => {
    const renderMsRuns = matching.flatMap((trace) => {
      const same = trace.commits[commit.index];
      return same ? [same.renderMs] : [];
    });
    return {
      index: commit.index,
      trigger: commit.trigger,
      renderMs: median(renderMsRuns),
      renderMsRuns,
      rendered: groupRendered(commit),
    };
  });

  const byTrigger = (trigger: CommitSummary['trigger']): CommitSummary[] => commits.filter((c) => c.trigger === trigger);
  const inputs = byTrigger('input');
  const errors = [...meta.pageErrors, ...traces.flatMap((trace) => trace.errors.map((e) => `Instrumentation: ${e}`))];

  return {
    entry: meta.entry,
    exportName: meta.exportName,
    reactVersion: meta.reactVersion,
    browser: meta.browser,
    steps: meta.steps,
    runs: traces.length,
    stable: instability.length === 0,
    instability,
    commitCount: first.commits.length,
    truncated: traces.some((trace) => trace.truncated),
    commits,
    rendersAfterMount: rendersAfterMount(first),
    timings: {
      mountMs: commits[0]?.renderMs ?? 0,
      inputCommits: inputs.length,
      inputMedianMs: median(inputs.map((c) => c.renderMs)),
      followUpCommits: byTrigger('follow-up').length,
      laterCommits: byTrigger('later').length,
      frameBudgetMs: FRAME_BUDGET_MS,
    },
    stubs: meta.stubs,
    timerResolutionMs: TIMER_RESOLUTION_MS,
    pageErrors: [...new Set(errors)],
  };
}

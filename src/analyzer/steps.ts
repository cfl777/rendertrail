/**
 * Pure: split a recorded trace into the steps of the interaction (HANDOFF.md §7).
 *
 * A step is an input commit (the count of input events went up since the previous commit) plus
 * its follow-up commits. A follow-up is a commit with no input since the previous one, in which a
 * component that rendered in the previous commit changed its own state: the update was started by
 * that render (an effect or layout effect), not by a timer or data arriving later. This replaces
 * the recorder's 20 ms gap labels, which the analyzer does not read.
 */
import type { InteractionStep, RecordedCommit, RecordedTrace } from '../shared/types.js';

/** True when `commit` came from an input event (the first commit is the mount, never input). */
export function isInputCommit(trace: RecordedTrace, index: number): boolean {
  const commit = trace.commits[index];
  const prev = trace.commits[index - 1];
  return Boolean(commit && prev && commit.inputSeq !== prev.inputSeq);
}

/** Names of the components that rendered (mount or update) in a commit. */
export function renderedNames(commit: RecordedCommit): Set<string> {
  return new Set(commit.rendered.map((r) => r.name));
}

/**
 * True when commit `index` directly follows the previous commit: no input in between, and a
 * component that rendered there changed its own state here.
 */
export function isFollowUp(trace: RecordedTrace, index: number): boolean {
  const commit = trace.commits[index];
  const prev = trace.commits[index - 1];
  if (!commit || !prev || commit.inputSeq !== prev.inputSeq) return false;
  const before = renderedNames(prev);
  return commit.rendered.some((r) => r.phase === 'update' && r.changedState.length > 0 && before.has(r.name));
}

/**
 * The steps of the first trace. `commitMs(i)` gives a commit's render time (the summary's median
 * over the runs), so the steps' costs are medians too.
 */
export function groupSteps(trace: RecordedTrace, commitMs: (index: number) => number): InteractionStep[] {
  const steps: InteractionStep[] = [];
  let current: InteractionStep | null = null;
  trace.commits.forEach((_commit, index) => {
    if (isInputCommit(trace, index)) {
      current = { index: steps.length, commits: [index], renderMs: 0, renders: 0 };
      steps.push(current);
    } else if (current && current.commits.at(-1) === index - 1 && isFollowUp(trace, index)) {
      current.commits.push(index);
    } else {
      current = null;
    }
  });
  for (const step of steps) {
    step.renderMs = round(step.commits.reduce((sum, i) => sum + commitMs(i), 0));
    step.renders = step.commits.reduce((sum, i) => sum + (trace.commits[i]?.rendered.length ?? 0), 0);
  }
  return steps;
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

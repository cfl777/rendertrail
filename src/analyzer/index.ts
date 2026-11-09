/**
 * The analyzer (HANDOFF.md §7): pure functions from the recorder's traces and summary plus the
 * files Claude sent to ranked findings and the card's keystroke view. No I/O, no browser, no
 * logging, and the inputs are never changed. analyze() is async only because it loads the
 * TypeScript compiler lazily on first use.
 */
import type { Finding, InteractionStep, KeystrokeView, RecordedTrace, TraceSummary } from '../shared/types.js';
import { median } from '../recorder/summarize.js';
import { ANALYZER, RULE_ORDER } from './constants.js';
import { isMemoBreak, stateInEffectCandidates, unstablePropCandidates, type Candidate, type Timing } from './rules.js';
import { loadTypeScript, parseFiles, reachableFrom } from './source.js';
import { groupSteps, round } from './steps.js';
import { buildTree } from './tree.js';
import { componentLabel, interactionLabels, msText, unitFor, type UnitWords } from './words.js';

export interface AnalyzeInput {
  summary: TraceSummary;
  /** The runs' raw traces; structure comes from the first, timings are medians over all. */
  traces: readonly RecordedTrace[];
  files: readonly { path: string; content: string }[];
}

export interface Analysis {
  steps: InteractionStep[];
  /** Every finding that passed the thresholds, ranked. */
  allFindings: Finding[];
  /** The top ANALYZER.maxFindings. */
  findings: Finding[];
  keystroke: KeystrokeView;
}

/** median() rounds to 0.01 ms; shares (0–1) need the exact value. */
function exactMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Timings from the summary (commit medians) and the traces (component medians, where the runs line up). */
export function timingFrom(summary: TraceSummary, traces: readonly RecordedTrace[]): Timing {
  const first = traces[0];
  return {
    commitMs: (commit) => summary.commits[commit]?.renderMs ?? first?.commits[commit]?.renderMs ?? 0,
    componentMs: (commit, rendered) => {
      const name = first?.commits[commit]?.rendered[rendered]?.name;
      const values = traces.flatMap((t) => {
        const r = t.commits[commit]?.rendered[rendered];
        return r && r.name === name ? [r.totalMs] : [];
      });
      return median(values);
    },
    componentShareMs: (commit, rendered) => {
      const name = first?.commits[commit]?.rendered[rendered]?.name;
      const shares = traces.flatMap((t) => {
        const c = t.commits[commit];
        const r = c?.rendered[rendered];
        if (!c || !r || r.name !== name) return [];
        return [c.renderMs > 0 ? Math.min(1, r.totalMs / c.renderMs) : 0];
      });
      const commitMs = summary.commits[commit]?.renderMs ?? first?.commits[commit]?.renderMs ?? 0;
      return round(commitMs * (shares.length ? exactMedian(shares) : 0));
    },
  };
}

/** Rule 1 counts at ≥ 1 ms wasted per step (mean over all steps); rule 2 on at least half the steps. */
export function passesThreshold(c: Candidate): boolean {
  if (c.steps === 0) return false;
  if (c.rule === 'unstable-prop') return c.msPerStep >= ANALYZER.unstablePropMinMsPerStep;
  return c.stepsAffected >= c.steps * ANALYZER.stateInEffectMinStepShare;
}

export function rank(candidates: readonly Candidate[]): Finding[] {
  return candidates
    .filter(passesThreshold)
    .sort((a, b) => b.msPerStep - a.msPerStep || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) || a.id.localeCompare(b.id))
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

function wasteInStep(trace: RecordedTrace, step: InteractionStep, component: string, timing: Timing): number {
  let ms = 0;
  for (const ci of step.commits) {
    trace.commits[ci]?.rendered.forEach((r, ri) => {
      if (r.name === component && isMemoBreak(r)) ms += timing.componentShareMs(ci, ri);
    });
  }
  return ms;
}

function medianStep(steps: readonly InteractionStep[]): InteractionStep | undefined {
  const sorted = [...steps].sort((a, b) => a.renderMs - b.renderMs || a.index - b.index);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function headlineFor(top: Finding | undefined, unit: UnitWords, msPerStep: number, overBudget: boolean, stepCount: number): string {
  const one = unit.one;
  const every = top && top.stepsAffected < top.steps ? `On ${top.stepsAffected} of ${top.steps} ${unit.many}, it` : unit.every;
  if (stepCount === 0) return 'No updates after input were recorded, so there is nothing to measure per step.';
  if (!top) {
    return overBudget
      ? `Each ${one} takes ${msText(msPerStep)}, but no single cause stands out.`
      : `Nothing to fix: each ${one} takes ${msText(msPerStep)}.`;
  }
  if (top.rule === 'unstable-prop') {
    const below = Object.entries(top.below ?? {}).filter(([, k]) => k >= 1);
    const total = Math.round(top.rendersPerAffectedStep);
    const parts = below.map(([name, k]) => `${Math.round(k)} × ${name}`).join(', ');
    return below.length
      ? `${every} re-renders ${total} components that didn't change: ${top.component} and ${parts}.`
      : `${every} re-renders ${top.component}, which didn't change.`;
  }
  return `${every} causes an extra update: ${top.component} sets state inside an effect.`;
}

export async function analyze(input: AnalyzeInput): Promise<Analysis> {
  await loadTypeScript();
  const trace = input.traces[0];
  if (!trace) throw new Error('analyze needs at least one trace');
  const timing = timingFrom(input.summary, input.traces);
  const steps = groupSteps(trace, timing.commitMs);
  const unit = unitFor(input.summary.steps, steps.length);
  const files = reachableFrom(parseFiles(input.files), input.summary.entry);
  const ctx = { trace, steps, files, timing, unit };

  const allFindings = rank([...unstablePropCandidates(ctx), ...stateInEffectCandidates(ctx)]);
  const findings = allFindings.slice(0, ANALYZER.maxFindings);

  const msPerStep = median(steps.map((s) => s.renderMs));
  const rendersPerStep = median(steps.map((s) => s.renders));
  const overBudget = msPerStep > ANALYZER.frameBudgetMs;
  const { label, caption } = interactionLabels(input.summary.steps, unit, steps.length, componentLabel(input.summary.entry, input.summary.exportName));
  const typical = medianStep(steps);
  // The time bar splits the typical step's time by the median share the top rule 1 finding wasted
  // per step: waste and step time come from the same per-step numbers, so the rest stays visible.
  const topWaste = findings.find((f) => f.rule === 'unstable-prop');
  const shares = topWaste ? steps.map((s) => (s.renderMs > 0 ? Math.min(1, wasteInStep(trace, s, topWaste.component, timing) / s.renderMs) : 0)) : [];
  const wasted = round(msPerStep * (shares.length ? exactMedian(shares) : 0));
  const smooth = unit.unit === 'letter' ? 'Typing feels smooth' : unit.unit === 'click' ? 'A click feels instant' : 'An update feels smooth';

  const keystroke: KeystrokeView = {
    unit: unit.unit,
    label,
    caption,
    steps: steps.length,
    msPerStep,
    rendersPerStep,
    frameBudgetMs: ANALYZER.frameBudgetMs,
    overBudget,
    wastedMsPerStep: wasted,
    restMsPerStep: round(Math.max(0, msPerStep - wasted)),
    headline: headlineFor(findings[0], unit, msPerStep, overBudget, steps.length),
    subline:
      steps.length === 0
        ? 'Try an interaction that changes what the component shows, such as typing into an input.'
        : `${unit.each} takes ${msText(msPerStep)}. ${smooth} when an update fits in one screen refresh (about ${ANALYZER.frameBudgetMs} ms), ` +
          `so this ${overBudget ? 'feels laggy' : 'should feel smooth'}.`,
    tree: typical ? buildTree(trace, typical.commits[0]!, timing) : [],
  };
  return { steps, allFindings, findings, keystroke };
}

/**
 * Pure: the text result for Claude (HANDOFF.md §5). It must stand alone, because Claude Code shows
 * nothing else: cost per step against the frame budget, numbered findings with the line and the
 * fix, the comparison, the run id, and a short note on the raw recording.
 */
import { describeSteps } from '../recorder/format.js';
import type { Comparison, Finding, InteractionStep, KeystrokeView, TraceSummary } from '../shared/types.js';
import { ANALYZER } from './constants.js';
import { msText } from './words.js';

export interface TextInput {
  summary: TraceSummary;
  steps: InteractionStep[];
  /** Every finding that passed the thresholds, ranked; the first ANALYZER.maxFindings are listed. */
  findings: Finding[];
  keystroke: KeystrokeView;
  runId: string;
  comparison?: Comparison;
  /** Set when the run couldn't be stored: the reason. Then there is no run id to use as a baseline. */
  saveError?: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function rounded(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function comparisonLines(c: Comparison, k: KeystrokeView): string[] {
  if (!c.found) return [c.message];
  const lines = [c.message];
  if (!c.checked) {
    if (c.changedFiles.length) lines.push(`Files changed since the baseline: ${c.changedFiles.join(', ')}.`);
    return lines;
  }
  if (c.before && c.after) {
    lines.push(
      `Before → now, per ${k.unit}: ${msText(c.before.msPerStep)} → ${msText(c.after.msPerStep)}; ` +
        `${rounded(c.before.rendersPerStep)} → ${rounded(c.after.rendersPerStep)} renders.`,
    );
  }
  const list = (refs: Comparison['resolved']): string => (refs.length ? refs.map((r) => r.summary).join('; ') : 'none');
  lines.push(`Resolved: ${list(c.resolved)}.`, `Still there: ${list(c.stillThere)}.`, `New: ${list(c.new)}.`);
  if (!c.sameInteraction) lines.push('Note: the interaction (entry, props or steps) differs from the baseline run, so the numbers may not be comparable.');
  if (c.changedFiles.length) lines.push(`Files changed since the baseline: ${c.changedFiles.join(', ')}.`);
  return lines;
}

export function formatAnalysis(input: TextInput): string {
  const { summary, keystroke: k, findings } = input;
  const lines: string[] = [];
  const budget = `${k.frameBudgetMs} ms frame budget`;

  if (k.steps === 0) {
    lines.push(
      `${describeSteps(summary.steps)}: no update followed an input event, so there is no cost per step to report.`,
      'No findings. Try an interaction that changes what the component shows, such as typing into an input or clicking a button.',
    );
  } else {
    lines.push(`${k.label}: ${msText(k.msPerStep)} per ${k.unit}, ${k.overBudget ? 'over' : 'within'} the ${budget}.`);
    const shown = findings.slice(0, ANALYZER.maxFindings);
    if (shown.length === 0) {
      lines.push(
        `No problem passed the thresholds: no memo component re-rendered with only unchanged props for ${ANALYZER.unstablePropMinMsPerStep} ms or more per ${k.unit}, ` +
          `and no component set state inside an effect on at least half of the ${k.unit}s.`,
        `Raw cost per ${k.unit} (median of ${plural(k.steps, k.unit)}): ${msText(k.msPerStep)}, ${rounded(k.rendersPerStep)} component renders.`,
      );
    }
    shown.forEach((f, i) => {
      lines.push(`${i + 1}. ${f.texts.summary}`, `   Why: ${f.texts.why}`);
    });
    const more = findings.length - shown.length;
    if (more > 0) lines.push(`(${plural(more, 'smaller finding')} not listed.)`);
  }

  if (input.comparison) lines.push('', ...comparisonLines(input.comparison, k));

  const exportLabel = summary.exportName === 'default' ? 'default export' : `export ${summary.exportName}`;
  const renders = Object.entries(summary.rendersAfterMount).map(([name, n]) => `${name} ${n}`);
  const inSteps = input.steps.reduce((sum, s) => sum + s.commits.length, 0);
  lines.push(
    '',
    input.saveError
      ? `This run couldn't be saved (${input.saveError}), so it can't be used as a baseline for a later run.`
      : `Run id: ${input.runId}. To check a fix, call inspect_render again with the changed files and baselineRunId "${input.runId}".`,
    '',
    `Recording: ${summary.entry} (${exportLabel}), ${summary.runs} runs in headless ${summary.browser}, React ${summary.reactVersion}. ` +
      `Interaction: ${describeSteps(summary.steps)}.`,
    summary.stable
      ? `Render counts were identical in all ${summary.runs} runs.`
      : `UNSTABLE: render counts differed between runs; the findings come from run 1. ${summary.instability.slice(0, 3).join(' ')}`,
    `${summary.commitCount} updates: 1 mount, ${plural(k.steps, 'step')} after input (${inSteps} updates), ${summary.commitCount - 1 - inSteps} later (timers or other non-input updates).`,
    `Renders after mount: ${renders.join(', ') || 'none'}.`,
    summary.stubs.length
      ? `Stubbed imports (not in the files; replaced with stand-ins, send these files if they matter): ${summary.stubs.join('; ')}.`
      : 'Stubbed imports: none.',
  );
  if (summary.truncated) lines.push(`Recording stopped after ${summary.commitCount} updates; later ones were not recorded.`);
  if (summary.pageErrors.length) lines.push(`Errors in the page: ${summary.pageErrors.slice(0, 5).join(' | ')}`);
  lines.push(`Timer resolution is about ${summary.timerResolutionMs} ms; smaller differences are noise.`);
  return lines.join('\n');
}

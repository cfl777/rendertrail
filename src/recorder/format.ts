/**
 * Plain-text results for Claude. They must make sense on their own: Claude Code shows nothing else.
 */
import type { RecordError, Step, TraceSummary } from '../shared/types.js';

/** Commit lines listed in the text; the rest are only counted. */
const MAX_COMMIT_LINES = 40;

function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}

export function describeSteps(steps: readonly Step[]): string {
  return steps
    .map((step) => {
      if (step.action === 'type') {
        const delay = step.delayMs === undefined ? '' : ` (${step.delayMs} ms between letters)`;
        return `type ${JSON.stringify(step.text)} into ${step.target}${delay}`;
      }
      if (step.action === 'click') return `click ${step.target}`;
      return `wait ${step.ms} ms`;
    })
    .join('; ');
}

function stubLines(stubs: readonly string[]): string[] {
  if (stubs.length === 0) return ['Stubbed imports: none.'];
  return [
    `Stubbed imports (not in the files; replaced with stand-ins: a component renders only its children, a hook returns an empty stand-in; send these files if they matter):`,
    ...stubs.map((stub) => `  - ${stub}`),
  ];
}

export function formatSummary(summary: TraceSummary, notes: readonly string[] = []): string {
  const exportLabel = summary.exportName === 'default' ? 'default export' : `export ${summary.exportName}`;
  const lines: string[] = [
    `Recorded ${summary.entry} (${exportLabel}) ${summary.runs} times in headless ${summary.browser}, React ${summary.reactVersion}.`,
    `Interaction: ${describeSteps(summary.steps)}.`,
    summary.stable
      ? `Render counts were identical in all ${summary.runs} runs.`
      : `UNSTABLE: render counts differed between runs, so treat the counts below (from run 1) with care:`,
    ...summary.instability.map((line) => `  - ${line}`),
    '',
    `${summary.commitCount} commits (render time is the median of ${summary.runs} runs):`,
  ];

  for (const commit of summary.commits.slice(0, MAX_COMMIT_LINES)) {
    const parts = commit.rendered.map((g) => {
      const name = `${g.name}${g.count > 1 ? ` ×${g.count}` : ''}${g.memo ? ' [memo]' : ''}`;
      return g.notes.length ? `${name} {${g.notes.join('; ')}}` : name;
    });
    lines.push(
      `#${String(commit.index).padEnd(3)} ${commit.trigger.padEnd(9)} ${ms(commit.renderMs).padStart(10)}   ${parts.join(', ') || '(nothing rendered)'}`,
    );
  }

  const hidden = summary.commits.length - MAX_COMMIT_LINES;
  if (hidden > 0) lines.push(`… ${hidden} more commits (counted below, not listed)`);
  if (summary.truncated) {
    lines.push(`Recording stopped after ${summary.commitCount} commits; later commits were not recorded.`);
  }

  const renders = Object.entries(summary.rendersAfterMount).map(([name, n]) => `${name} ${n}`);
  const t = summary.timings;
  lines.push(
    '',
    `Renders after mount: ${renders.join(', ') || 'none'}.`,
    `Mount: ${ms(t.mountMs)}. Input commits: ${t.inputCommits}, median ${ms(t.inputMedianMs)} each (frame budget ${t.frameBudgetMs} ms). Follow-up commits: ${t.followUpCommits}. Later commits: ${t.laterCommits}.`,
    ...stubLines(summary.stubs),
  );
  if (summary.pageErrors.length) lines.push('Errors in the page:', ...summary.pageErrors.map((e) => `  - ${e}`));
  lines.push(
    '',
    `Notes: timer resolution is about ${summary.timerResolutionMs} ms, so differences smaller than that are noise. ` +
      `"input" means a commit after a user input event; "follow-up" (within 20 ms of the previous commit) and "later" are approximate labels.`,
    'This is the raw recording. Naming the main problem and the line to change is not built yet.',
    ...notes,
  );
  return lines.join('\n');
}

export function formatError(error: RecordError): string {
  const lines = [`Couldn't record the component: ${error.message}`];
  if (error.details.length) lines.push(...error.details.map((d) => `  ${d.replace(/\n/g, '\n  ')}`));
  lines.push(...stubLines(error.stubs));
  lines.push('Fix the input and call inspect_render again.');
  return lines.join('\n');
}

/**
 * Plain-text pieces for Claude: the steps in words and recording errors. The analysis text is in
 * src/analyzer/text.ts. They must make sense on their own: Claude Code shows nothing else.
 */
import type { RecordError, Step } from '../shared/types.js';

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

export function formatError(error: RecordError): string {
  const lines = [`Couldn't record the component: ${error.message}`];
  if (error.details.length) lines.push(...error.details.map((d) => `  ${d.replace(/\n/g, '\n  ')}`));
  lines.push(...stubLines(error.stubs));
  // A missing browser isn't the input's fault: its details already say what to do.
  if (error.kind !== 'browser') lines.push('Fix the input and call inspect_render again.');
  return lines.join('\n');
}

import { describe, expect, it } from 'vitest';
import { describeSteps, formatError } from './format.js';

const steps = [
  { action: 'type' as const, target: 'input', text: 'hi', delayMs: 100 },
  { action: 'wait' as const, ms: 600 },
];

describe('format', () => {
  it('describes steps', () => {
    expect(describeSteps(steps)).toBe('type "hi" into input (100 ms between letters); wait 600 ms');
  });

  it('explains errors and lists stubs', () => {
    const text = formatError({ kind: 'step', message: 'Step 1 failed.', details: ['Uncaught: boom'], stubs: [] });
    expect(text).toContain("Couldn't record the component: Step 1 failed.");
    expect(text).toContain('Stubbed imports: none.');
  });
});

import { describe, expect, it } from 'vitest';
import { describeSteps, formatError } from './format.js';
import { noBrowserError } from './run.js';

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

  it('tells someone without Chrome the one command that installs the matching Chromium', () => {
    const err = noBrowserError('Chromium distribution "chrome" is not found', "Executable doesn't exist");
    const text = formatError({ kind: err.kind, message: err.message, details: err.details, stubs: [] });
    expect(text).toContain("Couldn't record the component: No browser to record in.");
    expect(text).toMatch(/running this in a terminal: npx playwright-core@\d+\.\d+\.\d+ install chromium/);
    expect(text).toContain('https://www.google.com/chrome/');
    expect(text).not.toContain('Fix the input');
  });
});

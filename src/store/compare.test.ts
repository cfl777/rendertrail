import { describe, expect, it } from 'vitest';
import { analyze } from '../analyzer/index.js';
import { formatAnalysis } from '../analyzer/text.js';
import { laggyFiles, savedTrace } from '../analyzer/testing.js';
import { compareRuns, missingBaseline } from './compare.js';

const files = laggyFiles();
const test = { exportName: 'default', steps: savedTrace('SearchPage').summary.steps };

function runFor(variant: 'SearchPage' | 'SearchPage.fixed') {
  const { summary, traces } = savedTrace(variant);
  const a = analyze({ summary, traces, files });
  // As in real use: the fixed file is sent under the same path as before.
  const content = files.find((f) => f.path === `${variant}.tsx`)!.content;
  const sent = [...files.filter((f) => !f.path.startsWith('SearchPage')), { path: 'SearchPage.tsx', content }];
  return { a, summary, input: { ...test, files: sent, entry: 'SearchPage.tsx' }, findings: a.allFindings, keystroke: a.keystroke };
}

describe('compareRuns', () => {
  it('unfixed → fixed: rule 1 resolved, rule 2 still there, nothing new', () => {
    const before = runFor('SearchPage');
    const after = runFor('SearchPage.fixed');
    const c = compareRuns('r_base01', before, after);
    expect(c.found).toBe(true);
    expect(c.resolved.map((f) => f.id)).toEqual(['unstable-prop:ResultsList']);
    expect(c.stillThere.map((f) => f.id)).toEqual(['state-in-effect:SearchBox:setCharCount']);
    expect(c.new).toEqual([]);
    expect(c.sameInteraction).toBe(true);
    expect(c.changedFiles).toEqual(['SearchPage.tsx']);
    expect(c.before!.msPerStep).toBeGreaterThan(10);
    expect(c.after!.msPerStep).toBeLessThan(3);
    expect(c.message).toMatch(/^Compared with run r_base01: each letter now takes [\d.]+ ms, down from [\d.]+ ms\.$/);

    const text = formatAnalysis({ summary: after.summary, steps: after.a.steps, findings: after.findings, keystroke: after.keystroke, runId: 'r_new001', comparison: c });
    expect(text).toContain('Resolved: ResultsList re-rendered for nothing (unstable prop `filters`).');
    expect(text).toContain('Still there: SearchBox sets state inside an effect (`setCharCount`).');
    expect(text).toContain('New: none.');
    expect(text).not.toContain('differs from the baseline');
  });

  it('says when the interaction differs', () => {
    const before = runFor('SearchPage');
    const after = runFor('SearchPage.fixed');
    const c = compareRuns('r_base01', before, { ...after, input: { ...after.input, steps: [{ action: 'wait', ms: 1 }] } });
    expect(c.sameInteraction).toBe(false);
  });

  it('explains an unknown baseline id as a normal result', () => {
    const c = missingBaseline('r_nope00');
    expect(c.found).toBe(false);
    expect(c.message).toContain('No stored run has the id "r_nope00"');
  });
});

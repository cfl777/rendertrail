import { describe, expect, it } from 'vitest';
import { laggyFiles, savedTrace } from '../../test/helpers/laggy.js';
import { analyze } from '../analyzer/index.js';
import { formatAnalysis } from '../analyzer/text.js';
import { compareRuns, missingBaseline } from './compare.js';

const files = laggyFiles();
const test = { exportName: 'default', steps: savedTrace('SearchPage').summary.steps };

async function runFor(variant: 'SearchPage' | 'SearchPage.fixed') {
  const { summary, traces } = savedTrace(variant);
  const a = await analyze({ summary, traces, files });
  // As in real use: the fixed file is sent under the same path as before.
  const content = files.find((f) => f.path === `${variant}.tsx`)!.content;
  const sent = [...files.filter((f) => !f.path.startsWith('SearchPage')), { path: 'SearchPage.tsx', content }];
  return { a, summary, input: { ...test, files: sent, entry: 'SearchPage.tsx' }, findings: a.allFindings, keystroke: a.keystroke };
}

describe('compareRuns', () => {
  it('unfixed → fixed: rule 1 resolved, rule 2 still there, nothing new; carries the old file for the diff', async () => {
    const before = await runFor('SearchPage');
    const after = await runFor('SearchPage.fixed');
    const c = compareRuns('r_base01', before, after);
    expect(c).toMatchObject({ found: true, checked: true, sameInteraction: true, changedFiles: ['SearchPage.tsx'] });
    expect(c.resolved.map((f) => f.id)).toEqual(['unstable-prop:ResultsList:filters']);
    expect(c.stillThere.map((f) => f.id)).toEqual(['state-in-effect:SearchBox:setCharCount']);
    expect(c.new).toEqual([]);
    expect(c.baselineFiles).toEqual([{ path: 'SearchPage.tsx', content: files.find((f) => f.path === 'SearchPage.tsx')!.content }]);
    expect(c.before!.msPerStep).toBeGreaterThan(10);
    expect(c.after!.msPerStep).toBeLessThan(3);
    expect(c.message).toMatch(/^Compared with run r_base01: each letter now takes [\d.]+ ms, down from [\d.]+ ms\.$/);

    const text = formatAnalysis({ summary: after.summary, steps: after.a.steps, findings: after.findings, keystroke: after.keystroke, runId: 'r_new001', comparison: c });
    expect(text).toContain('Resolved: ResultsList re-rendered for nothing (unstable prop `filters`).');
    expect(text).toContain('Still there: SearchBox sets state inside an effect (`setCharCount`).');
    expect(text).toContain('New: none.');
    expect(text).not.toContain('differs from the baseline');
  });

  it('says when the interaction differs', async () => {
    const before = await runFor('SearchPage');
    const after = await runFor('SearchPage.fixed');
    const c = compareRuns('r_base01', before, { ...after, input: { ...after.input, steps: [{ action: 'wait', ms: 1 }] } });
    expect(c.sameInteraction).toBe(false);
  });

  it("does not call a fix checked when the new run recorded no update after input (a broken handler isn't a fix)", async () => {
    const before = await runFor('SearchPage');
    const after = await runFor('SearchPage.fixed');
    const broken = { ...after, findings: [], keystroke: { ...after.keystroke, steps: 0, msPerStep: 0, rendersPerStep: 0 } };
    const c = compareRuns('r_base01', before, broken);
    expect(c).toMatchObject({ found: true, checked: false, resolved: [], stillThere: [], new: [] });
    expect(c.before).toBeUndefined();
    expect(c.message).toContain("The new run recorded no update after input, so the fix can't be checked");
    const text = formatAnalysis({ summary: after.summary, steps: [], findings: [], keystroke: broken.keystroke, runId: 'r_new001', comparison: c });
    expect(text).not.toContain('Resolved:');
    expect(text).not.toContain('→');
  });

  it('explains an unknown or unreadable baseline id as a normal result', () => {
    expect(missingBaseline('r_nope00')).toMatchObject({ found: false, checked: false });
    expect(missingBaseline('r_nope00').message).toContain('No stored run has the id "r_nope00"');
    expect(missingBaseline('r_bad000', 'unreadable').message).toContain("couldn't be read");
  });
});

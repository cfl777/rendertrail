// @vitest-environment jsdom
/**
 * The card in every state, from the saved real results in ui/dev/results/ (npm run card:results).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TREE_LABEL_TEXT } from '../../src/shared/types';
import type { CardResult } from '../dev/result-types';
import { Card } from './Card';
import { EMPTY_STATE, applyCancelled, applyToolResult, parseOutput, parseToolInput, type CardState, type HostActions, type ResultOutput } from './model';

function result(name: string): CardResult {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'ui', 'dev', 'results', `${name}.json`), 'utf8')) as CardResult;
}

function stateOf(name: string): CardState {
  const r = result(name);
  return { ...EMPTY_STATE, input: parseToolInput(r.input), recording: true, output: parseOutput(r.output) };
}

function host(): HostActions & { sent: string[]; copied: string[]; noted: string[] } {
  const sent: string[] = [];
  const copied: string[] = [];
  const noted: string[] = [];
  return {
    sent,
    copied,
    noted,
    sendMessage: vi.fn(async (text: string) => {
      sent.push(text);
      return true;
    }),
    copyText: vi.fn(async (text: string) => {
      copied.push(text);
      return true;
    }),
    noteOpened: (text: string) => noted.push(text),
  };
}

function resultOutput(name: string): ResultOutput {
  const out = parseOutput(result(name).output);
  if (!out || 'error' in out) throw new Error(`${name} is not a result`);
  return out;
}

afterEach(cleanup);

describe('waiting and receiving', () => {
  it('shows a skeleton before anything arrives', () => {
    const { container } = render(<Card state={EMPTY_STATE} host={host()} />);
    expect(container.querySelector('[data-state="waiting"]')).not.toBeNull();
    expect(container.querySelector('.skeleton')).not.toBeNull();
    expect(screen.getByText(/waiting for the code/)).toBeTruthy();
  });

  it('shows the files and the component being recorded once the arguments arrive', () => {
    const input = parseToolInput(result('unfixed').input);
    render(<Card state={{ ...EMPTY_STATE, input, recording: true }} host={host()} />);
    expect(screen.getByText('Rendertrail · recording SearchPage…')).toBeTruthy();
    const files = within(screen.getByRole('list', { name: 'Files sent' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(files).toEqual(['data.ts', 'hooks.ts', 'ResultRow.tsx', 'ResultsList.tsx', 'SearchBox.tsx', 'SearchPage.tsx', 'ui.tsx']);
  });

  it('reads partial arguments that only have paths so far', () => {
    expect(parseToolInput({ files: [{ path: 'A.tsx' }, { path: 'B.tsx', content: 'x' }] })).toEqual({
      files: [{ path: 'B.tsx', content: 'x' }],
      paths: ['A.tsx', 'B.tsx'],
      entry: null,
    });
    expect(parseToolInput({})).toBeNull();
  });
});

describe('answer (laggy search, unfixed)', () => {
  const out = resultOutput('unfixed');

  it('has the caption, headline and subline from structuredContent', () => {
    render(<Card state={stateOf('unfixed')} host={host()} />);
    expect(screen.getByText('Rendertrail · typed “hello” into SearchPage')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      "Every letter you type re-renders 201 components that didn't change: ResultsList and 200 × ResultRow.",
    );
    expect(screen.getByText(out.keystroke.subline)).toBeTruthy();
    expect(out.keystroke.subline).toMatch(/^Each keystroke takes [\d.]+ ms\. Typing feels smooth when an update fits in one screen refresh \(about 16\.7 ms\), so this feels laggy\.$/);
  });

  it('draws the time bar in proportion: wasted vs the rest, and the 16.7 ms marker', () => {
    render(<Card state={stateOf('unfixed')} host={host()} />);
    const bar = screen.getByRole('img', { name: /^Time per keystroke:/ });
    const k = out.keystroke;
    const max = Math.max(k.frameBudgetMs, k.wastedMsPerStep + k.restMsPerStep, k.msPerStep) * 1.15;
    expect(Number(bar.dataset.wastedPct)).toBeCloseTo((k.wastedMsPerStep / max) * 100, 0);
    expect(Number(bar.dataset.restPct)).toBeCloseTo((k.restMsPerStep / max) * 100, 0);
    expect(Number(bar.dataset.budgetPct)).toBeCloseTo((16.7 / max) * 100, 0);
    // Over budget: the wasted part alone runs past the marker.
    expect(Number(bar.dataset.wastedPct)).toBeGreaterThan(Number(bar.dataset.budgetPct));
    expect(bar.getAttribute('aria-label')).toContain(`${k.wastedMsPerStep} ms wasted`);
    expect(within(bar).getByText(/^Wasted /)).toBeTruthy();
    expect(within(bar).getByText(/^Everything else /)).toBeTruthy();
    expect(within(bar).getByText('Screen refresh 16.7 ms')).toBeTruthy();
  });

  it('shows "What one keystroke does" with at most 5 rows and the §8 labels', () => {
    render(<Card state={stateOf('unfixed')} host={host()} />);
    const tree = screen.getByRole('region', { name: 'What one keystroke does' });
    const rows = within(tree).getAllByRole('listitem');
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows.map((r) => [r.querySelector('code')?.textContent, r.dataset.label])).toEqual([
      ['SearchPage', 'state-origin'],
      ['Header', 'nothing-changed'],
      ['SearchBox', 'needed'],
      ['ResultsList', 'memo-broken'],
      ['Sidebar', 'skipped'],
    ]);
    expect(rows.map((r) => r.querySelector('.row-label')?.textContent)).toEqual([
      'Your state changed here',
      'Re-rendered · nothing changed',
      'Re-rendered · needed',
      "Re-rendered · memo couldn't skip it",
      'Skipped · memo worked',
    ]);
    expect(rows[3]!.textContent).toContain('with 200 × ResultRow');
  });

  it('"Watch it again" replays the rows', async () => {
    render(<Card state={stateOf('unfixed')} host={host()} />);
    const list = () => screen.getByRole('region', { name: 'What one keystroke does' }).querySelector('ol')!;
    const before = list();
    expect(before.dataset.replay).toBe('0');
    await userEvent.click(screen.getByRole('button', { name: 'Watch it again' }));
    expect(list().dataset.replay).toBe('1');
    expect(list()).not.toBe(before);
  });

  it('opens why, line and fix in place, and tells the host what was opened', async () => {
    const h = host();
    render(<Card state={stateOf('unfixed')} host={h} />);
    const why = screen.getByRole('button', { name: 'Why does it happen?' });
    expect(why.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Why does it happen?' })).toBeNull();

    await userEvent.click(why);
    expect(why.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Why does it happen?' }).textContent).toBe(out.findings[0]!.texts.why.replace(/`/g, ''));

    await userEvent.click(screen.getByRole('button', { name: 'Show me the line' }));
    const line = screen.getByRole('region', { name: 'Show me the line' });
    expect(line.textContent).toContain('SearchPage.tsx, line 19');
    expect(line.textContent).toContain("filters={{ sort: 'recent', tags }}");

    await userEvent.click(screen.getByRole('button', { name: 'How do I fix it?' }));
    expect(screen.getByRole('region', { name: 'How do I fix it?' }).textContent).toContain(
      "const filters = useMemo(() => ({ sort: 'recent', tags }), [tags]);",
    );

    await userEvent.click(why);
    expect(screen.queryByRole('region', { name: 'Why does it happen?' })).toBeNull();
    expect(h.noted).toHaveLength(3);
    expect(h.noted[0]).toContain('“Why does it happen?”');
  });

  it('lists the second finding under "Also found"', async () => {
    render(<Card state={stateOf('unfixed')} host={host()} />);
    const more = screen.getByRole('region', { name: 'Also found' });
    const toggle = within(more).getByRole('button', { name: /SearchBox sets state inside an effect\s*·\s*SearchBox\.tsx:10/ });
    await userEvent.click(toggle);
    expect(more.textContent).toContain('const charCount = value.length;');
  });

  it('"Fix it and check" puts the §8 message in the chat', async () => {
    const h = host();
    render(<Card state={stateOf('unfixed')} host={h} />);
    expect(screen.queryByRole('button', { name: 'Copy for PR' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Fix it and check' }));
    expect(h.sent).toEqual(['Fix it and check it again with the same typing.']);
    expect(screen.getByRole('status').textContent).toContain('Added to the message box');
  });

  it('says so when the host refuses the message', async () => {
    const h = { ...host(), sendMessage: async () => false };
    render(<Card state={stateOf('unfixed')} host={h} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix it and check' }));
    expect(screen.getByRole('status').textContent).toContain('Fix it and check it again with the same typing.');
  });

  it('never uses the words the card avoids', () => {
    const { container } = render(<Card state={stateOf('unfixed')} host={host()} />);
    expect(container.textContent).not.toMatch(/\b(commit|fiber|reconciliation|effect cascade)/i);
  });
});

describe('no findings', () => {
  it('shows the raw cost per keystroke, says nothing stands out, and offers no fix', () => {
    const out = resultOutput('no-findings');
    const { container } = render(<Card state={stateOf('no-findings')} host={host()} />);
    expect(container.querySelector('[data-state="no-findings"]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(out.keystroke.headline);
    expect(out.keystroke.headline).toMatch(/^Nothing to fix: each letter takes/);
    // The time is in the headline and subline already; this line adds the render count only.
    expect(screen.getByTestId('raw-cost').textContent).toBe(
      `${out.keystroke.rendersPerStep} component renders per keystroke (median of 5 keystrokes). Nothing else stands out.`,
    );
    expect(screen.getByTestId('raw-cost').textContent).not.toContain(' ms');
    const bar = screen.getByRole('img', { name: /^Time per keystroke:/ });
    expect(bar.dataset.wastedPct).toBe('0');
    expect(within(bar).queryByText(/^Wasted/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fix it and check' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Why does it happen?' })).toBeNull();
  });
});

describe('unstable and truncated recording', () => {
  it('shows the caveats', () => {
    render(<Card state={stateOf('unstable')} host={host()} />);
    expect(screen.getByText("The 3 recordings didn't match exactly, so the numbers come from the first one and may be off.")).toBeTruthy();
    expect(screen.getByText("The recording stopped after 12 updates; later ones weren't recorded.")).toBeTruthy();
    expect(screen.getByText(/Stand-ins were used for imports that weren't sent: \.\/analytics/)).toBeTruthy();
  });
});

describe('comparison (re-run with a baseline)', () => {
  it('first fix: Fixed, before → now bars, resolved and still there', () => {
    const out = resultOutput('rerun-fixed');
    const c = out.comparison!;
    render(<Card state={stateOf('rerun-fixed')} host={host()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`Fixed. Each keystroke now takes ${c.after!.msPerStep} ms.`);
    const before = screen.getByRole('img', { name: /^Before:/ });
    const now = screen.getByRole('img', { name: /^Now:/ });
    expect(before.getAttribute('aria-label')).toBe(`Before: ${c.before!.msPerStep} ms and 206 renders per keystroke.`);
    expect(now.getAttribute('aria-label')).toBe(`Now: ${c.after!.msPerStep} ms and 5 renders per keystroke.`);
    expect(Number(before.dataset.pct)).toBeGreaterThan(Number(now.dataset.pct) * 50);
    expect(before.dataset.over).toBe('true');
    expect(now.dataset.over).toBe('false');
    const items = screen.getAllByRole('listitem').filter((li) => li.dataset.status);
    expect(items.map((li) => [li.dataset.status, li.textContent])).toEqual([
      ['resolved', 'Resolved: ResultsList re-rendered for nothing (unstable prop filters)'],
      ['still', 'Still there: SearchBox sets state inside an effect (setCharCount) · SearchBox.tsx:10'],
    ]);
  });

  it('"What changed in my code?" shows a compact diff of the baseline and current files', async () => {
    const h = host();
    render(<Card state={stateOf('rerun-fixed')} host={h} />);
    const toggle = screen.getByRole('button', { name: 'What changed in my code?' });
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('· 3 added, 2 removed')).toBeTruthy();
    const diff = screen.getByRole('table', { name: 'Changes in SearchPage.tsx' });
    const rows = within(diff).getAllByRole('row');
    const changed = rows.filter((r) => r.dataset.kind !== 'same').map((r) => `${r.dataset.kind} ${r.querySelector('.dl-text')!.textContent!.trim()}`);
    expect(changed).toEqual([
      "del import { useState } from 'react';",
      "add import { useMemo, useState } from 'react';",
      "add const filters = useMemo(() => ({ sort: 'recent' as const, tags }), [tags]);",
      "del filters={{ sort: 'recent', tags }}",
      'add filters={filters}',
    ]);
    // Compact: only the changes and a little context, not the whole file.
    expect(rows.length).toBeLessThan(20);
    await userEvent.click(toggle);
    expect(screen.queryByRole('table')).toBeNull();
    expect(h.noted).toHaveLength(1);
  });

  it('without the current files (no tool input), lists the changed file names only', async () => {
    const s = stateOf('rerun-fixed');
    render(<Card state={{ ...s, input: null }} host={host()} />);
    await userEvent.click(screen.getByRole('button', { name: 'What changed in my code?' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('SearchPage.tsx')).toBeTruthy();
    expect(screen.getByText(/The new version of the files isn't available here/)).toBeTruthy();
  });

  it('offers "Fix it and check" while a problem is left, and "Copy for PR" with a before/after summary', async () => {
    const h = host();
    render(<Card state={stateOf('rerun-fixed')} host={h} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy for PR' }));
    expect(h.copied).toHaveLength(1);
    const text = h.copied[0]!;
    expect(text).toContain('Render check (Rendertrail): typed “hello” into SearchPage');
    expect(text).toMatch(/Time per keystroke: [\d.]+ ms → [\d.]+ ms \(one screen refresh is 16\.7 ms\)/);
    expect(text).toContain('Renders per keystroke: 206 → 5');
    expect(text).toContain('Resolved: ResultsList re-rendered for nothing (unstable prop `filters`)');
    expect(text).toContain('Still there: SearchBox sets state inside an effect (`setCharCount`)');
    expect(text).toMatch(/Recorded in headless Chrome .* with React 19\.3\.1, median of 3 runs\./);
    await userEvent.click(screen.getByRole('button', { name: 'Fix it and check' }));
    expect(h.sent).toEqual(['Fix it and check it again with the same typing.']);
  });

  it('shows the text to copy by hand when copying fails', async () => {
    const h = { ...host(), copyText: async () => false };
    const { container } = render(<Card state={stateOf('rerun-fixed')} host={h} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy for PR' }));
    expect(screen.getByRole('status').textContent).toContain("Couldn't copy here");
    expect(container.querySelector('.copy-text')?.textContent).toContain('Renders per keystroke: 206 → 5');
  });

  it('both fixes: two resolved, only "Copy for PR" left', () => {
    render(<Card state={stateOf('rerun-all-fixed')} host={host()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Fixed\. Each keystroke now takes [\d.]+ ms\.$/);
    expect(screen.getAllByRole('listitem').filter((li) => li.dataset.status === 'resolved')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Fix it and check' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy for PR' }).className).toContain('primary');
  });

  it('nothing changed: not fixed yet, both still there, no files changed', () => {
    render(<Card state={stateOf('rerun-not-fixed')} host={host()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Not fixed yet\. Each keystroke takes [\d.]+ ms \(it took [\d.]+ ms\)\.$/);
    expect(screen.getAllByRole('listitem').filter((li) => li.dataset.status === 'still')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'What changed in my code?' })).toBeNull();
    expect(screen.getByText('No files changed since the last run.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('r_8f2k1a');
  });

  it("couldn't check (checked: false): says why, no bars, a retry action and the file toggle", async () => {
    const h = host();
    const out = resultOutput('rerun-unchecked');
    const { container } = render(<Card state={stateOf('rerun-unchecked')} host={h} />);
    expect(container.querySelector('[data-state="unchecked"]')).not.toBeNull();
    expect(screen.getByText('Rendertrail · typed “hello” into SearchPage')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Couldn't check the fix.");
    expect(screen.getByText(out.comparison!.message)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy for PR' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fix it and check' })).toBeNull();
    expect(screen.getByRole('button', { name: 'What changed in my code?' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Fix the input and try again' }));
    expect(h.sent).toEqual(['Fix the input and record it again.']);
  });

  it('a missing baseline shows the answer with a note', () => {
    const out = resultOutput('baseline-missing');
    render(<Card state={stateOf('baseline-missing')} host={host()} />);
    expect(screen.getByText(out.comparison!.message)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(out.keystroke.headline);
  });

  it('warns when the interaction differs from the baseline', () => {
    const s = stateOf('rerun-fixed');
    const out = s.output as ResultOutput;
    const changed: CardState = { ...s, output: { ...out, comparison: { ...out.comparison!, sameInteraction: false } } };
    render(<Card state={changed} host={host()} />);
    expect(screen.getByText('The interaction differs from the earlier run, so the numbers may not be comparable.')).toBeTruthy();
  });
});

describe("couldn't record", () => {
  it('explains the problem and lists the stubbed imports', async () => {
    const h = host();
    const { container } = render(<Card state={stateOf('error')} host={h} />);
    expect(container.querySelector('[data-state="error"]')).not.toBeNull();
    expect(screen.getByText("Rendertrail · couldn't record")).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("The component didn't render.");
    expect(screen.getByText('The component threw an error while mounting.')).toBeTruthy();
    const stubs = within(screen.getByRole('region', { name: 'Imports that were stubbed' })).getAllByRole('listitem');
    expect(stubs.map((s) => s.textContent)).toEqual(['./api (imported by SearchPage.tsx)', '@acme/ui/Spinner (imported by ResultsList.tsx)']);
    await userEvent.click(screen.getByRole('button', { name: 'Fix the input and try again' }));
    expect(h.sent).toEqual(['Fix the input and record it again.']);
  });

  it('accepts only structuredContent of this schema version', () => {
    expect(parseOutput({ schemaVersion: 2, error: { message: 'x' } })).toBeNull();
    expect(parseOutput('text')).toBeNull();
    expect(parseOutput(result('error').output)).not.toBeNull();
  });
});

describe('review fixes', () => {
  it('an error result from the host shows "couldn\'t record" with its text, not a skeleton forever', async () => {
    const h = host();
    const s = applyToolResult({ ...EMPTY_STATE, recording: true }, { isError: true, content: [{ type: 'text', text: 'Request timed out' }] });
    const { container } = render(<Card state={s} host={h} />);
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Couldn't record the component.");
    expect(screen.getByText('Request timed out')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Fix the input and try again' }));
    expect(h.sent).toEqual(['Fix the input and record it again.']);
  });

  it('a cancel says the recording was cancelled', () => {
    render(<Card state={applyCancelled({ ...EMPTY_STATE, recording: true })} host={host()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Recording was cancelled.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the top finding\'s tree row shows the same wasted time as the bar; other rows show none', () => {
    const k = resultOutput('unfixed').keystroke;
    render(<Card state={stateOf('unfixed')} host={host()} />);
    const rows = within(screen.getByRole('region', { name: 'What one keystroke does' })).getAllByRole('listitem');
    const ms = rows.map((r) => r.querySelector('.row-ms')?.textContent ?? null);
    expect(ms).toEqual([null, null, null, `${k.wastedMsPerStep} ms`, null]);
    expect(within(screen.getByRole('img', { name: /^Time per keystroke:/ })).getByText(`Wasted ${k.wastedMsPerStep} ms`)).toBeTruthy();
  });

  it('a re-run gives the time once: the subline keeps only the screen-refresh sentence', () => {
    const k = resultOutput('rerun-fixed').keystroke;
    render(<Card state={stateOf('rerun-fixed')} host={host()} />);
    const subline = document.querySelector('.subline')!.textContent!;
    expect(subline).toMatch(/^Typing feels smooth when an update fits in one screen refresh/);
    expect(k.subline.startsWith('Each keystroke takes')).toBe(true);
  });

  it('a re-run with problems left shows why / line / fix for the first one left', async () => {
    render(<Card state={stateOf('rerun-not-fixed')} host={host()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show me the line' }));
    expect(screen.getByRole('region', { name: 'Show me the line' }).textContent).toContain('SearchPage.tsx, line 19');
  });

  it('closed toggles point at no panel; open ones point at their panel', async () => {
    render(<Card state={stateOf('unfixed')} host={host()} />);
    const why = screen.getByRole('button', { name: 'Why does it happen?' });
    expect(why.getAttribute('aria-controls')).toBeNull();
    await userEvent.click(why);
    expect(document.getElementById(why.getAttribute('aria-controls')!)).not.toBeNull();
    const more = within(screen.getByRole('region', { name: 'Also found' })).getByRole('button');
    expect(more.getAttribute('aria-controls')).toBeNull();
  });

  it('"Fix it and check" can only be sent once from a card', async () => {
    const h = host();
    render(<Card state={stateOf('unfixed')} host={h} />);
    const button = screen.getByRole('button', { name: 'Fix it and check' });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(h.sent).toHaveLength(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('a file that changed only in whitespace says so, with no empty diff box', async () => {
    const s = stateOf('rerun-fixed');
    const out = s.output as ResultOutput;
    const current = s.input!.files.map((f) => (f.path === 'SearchPage.tsx' ? { ...f, content: out.comparison!.baselineFiles[0]!.content.replace(/\n/g, '\r\n') + '\n\n' } : f));
    render(<Card state={{ ...s, input: { ...s.input!, files: current } }} host={host()} />);
    await userEvent.click(screen.getByRole('button', { name: 'What changed in my code?' }));
    expect(screen.getByText('· only line endings or whitespace changed')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('marks hidden lines above the first change, and says "more changes" only when some are cut', async () => {
    render(<Card state={stateOf('rerun-fixed')} host={host()} />);
    await userEvent.click(screen.getByRole('button', { name: 'What changed in my code?' }));
    expect(document.querySelector('.more-changes')).toBeNull();

    const s = stateOf('rerun-fixed');
    const out = s.output as ResultOutput;
    const old = out.comparison!.baselineFiles[0]!.content;
    const many = old + Array.from({ length: 60 }, (_, i) => `// line ${i}`).join('\n') + '\n';
    const current = s.input!.files.map((f) => (f.path === 'SearchPage.tsx' ? { ...f, content: many } : f));
    cleanup();
    render(<Card state={{ ...s, input: { ...s.input!, files: current } }} host={host()} />);
    await userEvent.click(screen.getByRole('button', { name: 'What changed in my code?' }));
    expect(document.querySelector('.more-changes')).not.toBeNull();
    expect(document.querySelector('.hunk-gap')).not.toBeNull();
  });
});

describe('tree label copy', () => {
  it('matches HANDOFF.md §8 word for word', () => {
    expect(Object.values(TREE_LABEL_TEXT)).toEqual([
      'Your state changed here',
      'Re-rendered · needed',
      "Re-rendered · memo couldn't skip it",
      'Re-rendered · nothing changed',
      'Skipped · memo worked',
    ]);
  });
});

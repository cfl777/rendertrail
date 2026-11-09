/**
 * Recorder behaviour in a real browser that the laggy-search fixture doesn't cover: context
 * tracking, click steps, stubbed imports and step errors.
 */
import { describe, expect, it } from 'vitest';
import { recordRender } from '../../src/recorder/index.js';
import { InspectRenderInputSchema, type Step } from '../../src/shared/types.js';

const APP = `
import { createContext, memo, useContext, useState } from 'react';
import { Chart } from 'chart-lib';
import { helper } from './missing';
import './styles.css';

const Theme = createContext({ dark: false });
Theme.displayName = 'Theme';

const Label = memo(function Label() {
  const theme = useContext(Theme);
  return <span>{theme.dark ? 'dark' : 'light'}</span>;
});

export function App() {
  const [dark, setDark] = useState(false);
  const [bumps, setBumps] = useState(0);
  return (
    <Theme.Provider value={{ dark }}>
      <button id="bump" onClick={() => setBumps(bumps + 1)}>bump</button>
      <button id="toggle" onClick={() => setDark(!dark)}>toggle</button>
      <Label />
      <Chart data={[1, 2]} />
      {helper()}
    </Theme.Provider>
  );
}
`;

function input(steps: Step[]) {
  return InspectRenderInputSchema.parse({
    files: [{ path: 'App.tsx', content: APP }],
    entry: 'App.tsx',
    exportName: 'App',
    steps,
  });
}

describe('recorder behaviour', () => {
  it('tells a context change by value from one by reference, and lists stubbed imports', async () => {
    const result = await recordRender(
      input([
        { action: 'click', target: '#bump' },
        { action: 'click', target: '#toggle' },
      ]),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error, null, 2));
    const { summary, traces } = result;

    expect(summary.stubs).toEqual(['./missing (imported by App.tsx)', 'chart-lib (imported by App.tsx)']);
    expect(summary.stable).toBe(true);
    expect(summary.commitCount).toBe(3);

    const label = (index: number) => traces[0]!.commits[index]!.rendered.find((r) => r.name === 'Label');
    // #bump: the provider value is a new object with the same contents.
    expect(label(1)?.memo).toBe(true);
    expect(label(1)?.changedProps).toEqual([]);
    expect(label(1)?.changedContext).toEqual([{ name: 'Theme', sameValue: true, from: '{"dark":false}', to: '{"dark":false}' }]);
    // #toggle: the value really changed.
    expect(label(2)?.changedContext).toEqual([{ name: 'Theme', sameValue: false, from: '{"dark":false}', to: '{"dark":true}' }]);
    expect(summary.commits[1]?.rendered.find((g) => g.name === 'Label')?.notes).toEqual([
      'context Theme changed (new reference, same value)',
    ]);
    // The stub renders as a component that renders nothing.
    expect(summary.commits[0]?.rendered.map((g) => g.name)).toContain('Stub(chart-lib).Chart');
    // Clicks count as input.
    expect(summary.commits.map((c) => c.trigger)).toEqual(['mount', 'input', 'input']);
  });

  it('returns a step error when a selector matches nothing', async () => {
    const result = await recordRender(input([{ action: 'click', target: '#nope' }]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('step');
    expect(result.error.message).toContain('Step 1 (click #nope) failed');
    expect(result.error.stubs).toHaveLength(2);
  });
});

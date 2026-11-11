/**
 * Card harness: renders the card with saved real results (ui/dev/results/, from
 * `npm run card:results`) in a plain browser, no host needed. A state picker on the left; the URL
 * keeps the choice: ?state=unfixed&theme=dark&width=400. `&bare=1` hides the picker (screenshots).
 * Host style variables come from the ext-apps basic-host, applied the way useHostStyles does.
 */
import { applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Card } from '../src/Card';
import { copyText } from '../src/clipboard';
import { parseToolInput, type CardState, type HostActions } from '../src/model';
import '../src/card.css';
import './harness.css';
import { HOST_STYLE_VARIABLES } from './host-styles';
import type { CardResult } from './result-types';

const modules = import.meta.glob<CardResult>('./results/*.json', { eager: true, import: 'default' });
const RESULTS: Record<string, CardResult> = Object.fromEntries(
  Object.entries(modules).map(([file, result]) => [file.replace(/^\.\/results\/(.*)\.json$/, '$1'), result]),
);

/** Results first in a sensible order, then the two states before a result arrives. */
const ORDER = ['unfixed', 'no-findings', 'unstable', 'rerun-fixed', 'rerun-all-fixed', 'rerun-not-fixed', 'rerun-unchecked', 'baseline-missing', 'error'];
const STATES: { id: string; title: string; note?: string }[] = [
  { id: 'waiting', title: 'Waiting: nothing received yet' },
  { id: 'receiving', title: 'Receiving: files arrived, recording' },
  ...[...ORDER.filter((id) => RESULTS[id]), ...Object.keys(RESULTS).filter((id) => !ORDER.includes(id))].map((id) => ({
    id,
    title: RESULTS[id]!.title,
    note: RESULTS[id]!.note,
  })),
];

function stateFor(id: string): CardState {
  if (id === 'waiting') return { input: null, recording: false, output: null };
  if (id === 'receiving') return { input: parseToolInput(RESULTS.unfixed?.input), recording: true, output: null };
  const r = RESULTS[id];
  return { input: r ? parseToolInput(r.input) : null, recording: true, output: r?.output ?? null };
}

type Theme = 'light' | 'dark';

function readParams(): { state: string; theme: Theme; width: number; bare: boolean } {
  const p = new URLSearchParams(location.search);
  const theme = p.get('theme') === 'dark' ? 'dark' : p.get('theme') === 'light' ? 'light' : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return { state: p.get('state') ?? 'unfixed', theme, width: Number(p.get('width')) || 560, bare: p.get('bare') === '1' };
}

function Harness() {
  const initial = useMemo(readParams, []);
  const [stateId, setStateId] = useState(initial.state);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [width, setWidth] = useState(initial.width);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    applyDocumentTheme(theme);
    applyHostStyleVariables(HOST_STYLE_VARIABLES);
  }, [theme]);

  useEffect(() => {
    if (initial.bare) return;
    const p = new URLSearchParams({ state: stateId, theme, width: String(width) });
    history.replaceState(null, '', `?${p.toString()}`);
  }, [stateId, theme, width, initial.bare]);

  const host: HostActions = useMemo(
    () => ({
      sendMessage: async (text) => {
        setLog((l) => [...l, `sendMessage: ${text}`]);
        return true;
      },
      copyText: async (text) => {
        const ok = await copyText(text);
        setLog((l) => [...l, `copyText (${ok ? 'copied' : 'failed'}):\n${text}`]);
        return ok;
      },
      noteOpened: (text) => setLog((l) => [...l, `updateModelContext: ${text}`]),
    }),
    [],
  );

  const card = (
    <div className="frame" style={{ ['--frame-width' as string]: `${width}px` }} data-testid="frame">
      {/* key: a new state mounts a fresh card, as a new tool call would. */}
      <Card key={`${stateId}-${theme}`} state={stateFor(stateId)} host={host} />
    </div>
  );
  if (initial.bare) return <div className="harness">{card}</div>;

  return (
    <div className="harness">
      <aside className="picker">
        <h1>Card harness</h1>
        <fieldset>
          <legend>State</legend>
          {STATES.map((s) => (
            <label key={s.id}>
              <input type="radio" name="state" checked={stateId === s.id} onChange={() => setStateId(s.id)} />
              <span>
                {s.title}
                {s.note && <span className="note"> ({s.note})</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <label>
          <input type="checkbox" checked={theme === 'dark'} onChange={(e) => setTheme(e.target.checked ? 'dark' : 'light')} />
          Dark theme
        </label>
        <label>
          Width
          <select value={width} onChange={(e) => setWidth(Number(e.target.value))}>
            {[320, 400, 560, 720].map((w) => (
              <option key={w} value={w}>
                {w} px
              </option>
            ))}
          </select>
        </label>
        <pre className="log" aria-label="Host calls">
          {log.join('\n\n') || 'Host calls (sendMessage, copy, updateModelContext) show up here.'}
        </pre>
      </aside>
      {card}
    </div>
  );
}

if (readParams().bare) document.documentElement.classList.add('bare');
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);

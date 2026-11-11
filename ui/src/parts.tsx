/** The card's building blocks (HANDOFF.md §8). Presentational: data in, no host calls. */
import { useState, type ReactNode } from 'react';
import { TREE_LABEL_TEXT, type Finding, type KeystrokeView, type TreeLabel } from '../../src/shared/types';
import { countChanges, hunks, lineDiff } from './diff';
import { barScale, codeParts, msText, stepWords, type SourceFile } from './model';

/** The analyzer's texts mark code with backticks. */
export function CodeText({ text }: { text: string }) {
  return (
    <>
      {codeParts(text).map((part, i) => (part.code ? <code key={i}>{part.text}</code> : <span key={i}>{part.text}</span>))}
    </>
  );
}

export function Caption({ children }: { children: ReactNode }) {
  return <p className="caption">{children}</p>;
}

/** A toggle that opens its panel in place, right below it. */
export function Disclosure(props: { id: string; label: string; onOpen?: () => void; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const panelId = `${props.id}-panel`;
  return (
    <div className={props.className ?? 'disclosure'}>
      <button
        type="button"
        className="chip"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (!open) props.onOpen?.();
          setOpen(!open);
        }}
      >
        <span className="chip-mark" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
        {props.label}
      </button>
      {open && (
        <div className="panel" id={panelId}>
          {props.children}
        </div>
      )}
    </div>
  );
}

/** One keystroke's time: wasted vs everything else, with the screen-refresh marker. */
export function TimeBar({ k }: { k: KeystrokeView }) {
  const { per } = stepWords(k);
  const wasted = k.wastedMsPerStep;
  const rest = k.restMsPerStep;
  const scale = barScale([wasted + rest, k.msPerStep], k.frameBudgetMs);
  const wastedPct = scale.pct(wasted);
  const restPct = scale.pct(rest);
  const label =
    wasted > 0
      ? `Time ${per}: ${msText(wasted)} wasted, ${msText(rest)} everything else. One screen refresh is about ${k.frameBudgetMs} ms.`
      : `Time ${per}: ${msText(k.msPerStep)}. One screen refresh is about ${k.frameBudgetMs} ms.`;
  return (
    <figure className="timebar" aria-label={label} role="img" data-wasted-pct={wastedPct} data-rest-pct={restPct} data-budget-pct={scale.budgetPct}>
      <div className="track">
        {wasted > 0 && <div className="seg seg-wasted" style={{ width: `${wastedPct}%` }} />}
        <div className="seg seg-rest" style={{ width: `${restPct}%` }} />
        <div className="budget" style={{ left: `${scale.budgetPct}%` }} />
      </div>
      <figcaption className="legend" aria-hidden="true">
        {wasted > 0 ? (
          <>
            <span className="key">
              <span className="swatch swatch-wasted" />
              Wasted {msText(wasted)}
            </span>
            <span className="key">
              <span className="swatch swatch-rest" />
              Everything else {msText(rest)}
            </span>
          </>
        ) : (
          <span className="key">
            <span className="swatch swatch-rest" />
            Time {per} {msText(k.msPerStep)}
          </span>
        )}
        <span className="key">
          <span className="swatch swatch-budget" />
          Screen refresh {k.frameBudgetMs} ms
        </span>
      </figcaption>
    </figure>
  );
}

/** Before and after, on one scale, for a re-run. */
export function BeforeAfter(props: { before: number; after: number; beforeRenders: number; afterRenders: number; k: KeystrokeView }) {
  const { k } = props;
  const scale = barScale([props.before, props.after], k.frameBudgetMs);
  const rows = [
    { key: 'before', name: 'Before', ms: props.before, renders: props.beforeRenders, over: props.before > k.frameBudgetMs },
    { key: 'after', name: 'Now', ms: props.after, renders: props.afterRenders, over: props.after > k.frameBudgetMs },
  ];
  const renders = (n: number): string => `${Math.round(n * 10) / 10} ${n === 1 ? 'render' : 'renders'}`;
  return (
    <div className="beforeafter">
      {rows.map((r) => (
        <figure
          key={r.key}
          className={`ba-row ba-${r.key}`}
          role="img"
          aria-label={`${r.name}: ${msText(r.ms)} and ${renders(r.renders)} ${stepWords(k).per}.`}
          data-pct={scale.pct(r.ms)}
          data-over={r.over}
        >
          <figcaption className="ba-label" aria-hidden="true">
            <span className="ba-name">{r.name}</span>
            <span className="ba-value">
              {msText(r.ms)} · {renders(r.renders)}
            </span>
          </figcaption>
          <div className="track">
            <div className={`seg ${r.key === 'after' && !r.over ? 'seg-good' : r.over ? 'seg-wasted' : 'seg-rest'}`} style={{ width: `${scale.pct(r.ms)}%` }} />
            <div className="budget" style={{ left: `${scale.budgetPct}%` }} />
          </div>
        </figure>
      ))}
      <p className="legend" aria-hidden="true">
        <span className="key">
          <span className="swatch swatch-budget" />
          Screen refresh {k.frameBudgetMs} ms
        </span>
      </p>
    </div>
  );
}

const DOT: Record<TreeLabel, string> = {
  'state-origin': 'dot-origin',
  needed: 'dot-info',
  'memo-broken': 'dot-warning',
  'nothing-changed': 'dot-warning',
  skipped: 'dot-muted',
};

/** "What one keystroke does": at most 5 rows. "Watch it again" replays the rows appearing. */
export function Tree({ k }: { k: KeystrokeView }) {
  const [replay, setReplay] = useState(0);
  if (k.tree.length === 0) return null;
  const { treeTitle } = stepWords(k);
  const minDepth = Math.min(...k.tree.map((r) => r.depth));
  return (
    <section className="tree" aria-label={treeTitle}>
      <div className="section-head">
        <h2>{treeTitle}</h2>
        <button type="button" className="link-button replay" onClick={() => setReplay(replay + 1)}>
          Watch it again
        </button>
      </div>
      <ol className="tree-rows" key={replay} data-replay={replay}>
        {k.tree.map((row, i) => {
          const below = Object.entries(row.below);
          return (
            <li
              key={`${row.name}-${row.label}-${i}`}
              className={`tree-row label-${row.label}`}
              data-label={row.label}
              style={{ ['--i' as string]: i, ['--depth' as string]: Math.min(row.depth - minDepth, 4) }}
            >
              <span className="row-name">
                <code>{row.name}</code>
                {row.count > 1 && <span className="row-count"> × {row.count}</span>}
                {below.length > 0 && <span className="row-below"> with {below.map(([name, n]) => `${n} × ${name}`).join(', ')}</span>}
              </span>
              {row.ms >= 0.05 && <span className="row-ms">{msText(row.ms)}</span>}
              <span className="row-label">
                <span className={`dot ${DOT[row.label]}`} aria-hidden="true" />
                {TREE_LABEL_TEXT[row.label]}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type ChipKey = 'why' | 'line' | 'fix';
const CHIPS: { key: ChipKey; label: string }[] = [
  { key: 'why', label: 'Why does it happen?' },
  { key: 'line', label: 'Show me the line' },
  { key: 'fix', label: 'How do I fix it?' },
];

/**
 * "Why does it happen?", "Show me the line", "How do I fix it?" for one finding: a row of
 * toggles, and the open ones' panels below it in the same order.
 */
export function FindingChips({ finding, onOpen, idPrefix }: { finding: Finding; onOpen: (what: string) => void; idPrefix: string }) {
  const [open, setOpen] = useState<Record<ChipKey, boolean>>({ why: false, line: false, fix: false });
  const panel = (key: ChipKey): ReactNode => {
    if (key === 'why') {
      return (
        <p>
          <CodeText text={finding.texts.why} />
        </p>
      );
    }
    if (key === 'fix') {
      return (
        <p>
          <CodeText text={finding.texts.fix} />
        </p>
      );
    }
    if (!finding.location) {
      return (
        <p>
          <CodeText text={finding.texts.line} />
        </p>
      );
    }
    return (
      <>
        <p className="where">
          {finding.location.file}, line {finding.location.line}
        </p>
        <pre className="snippet">
          <code>{finding.location.snippet}</code>
        </pre>
        {finding.otherLocations && finding.otherLocations.length > 0 && (
          <p className="muted">Also passed at {finding.otherLocations.map((l) => `${l.file}:${l.line}`).join(', ')}.</p>
        )}
      </>
    );
  };
  return (
    <div className="chips">
      <div className="chip-row">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            className="chip"
            aria-expanded={open[c.key]}
            aria-controls={`${idPrefix}-${c.key}-panel`}
            onClick={() => {
              if (!open[c.key]) onOpen(c.label);
              setOpen({ ...open, [c.key]: !open[c.key] });
            }}
          >
            <span className="chip-mark" aria-hidden="true">
              {open[c.key] ? '−' : '+'}
            </span>
            {c.label}
          </button>
        ))}
      </div>
      {CHIPS.filter((c) => open[c.key]).map((c) => (
        <div key={c.key} className="panel" id={`${idPrefix}-${c.key}-panel`} role="region" aria-label={c.label}>
          {panel(c.key)}
        </div>
      ))}
    </div>
  );
}

/** Lines per file shown in "What changed in my code?"; the card never scrolls inside. */
const MAX_DIFF_LINES = 40;

export function CodeChanges(props: { changedFiles: string[]; baselineFiles: SourceFile[]; currentFiles: SourceFile[] | null }) {
  return (
    <div className="changes">
      {props.changedFiles.map((path) => {
        const before = props.baselineFiles.find((f) => f.path === path);
        const after = props.currentFiles?.find((f) => f.path === path);
        if (!props.currentFiles) {
          return (
            <div key={path} className="file">
              <p className="file-head">
                <code>{path}</code>
                <span className="muted"> · changed</span>
              </p>
            </div>
          );
        }
        const lines = lineDiff(before?.content ?? '', after?.content ?? '');
        const { added, removed } = countChanges(lines);
        const status = !before ? 'new file' : !after ? 'removed' : `${added} added, ${removed} removed`;
        let shown = 0;
        const groups = hunks(lines);
        return (
          <div key={path} className="file" data-file={path}>
            <p className="file-head">
              <code>{path}</code>
              <span className="muted"> · {status}</span>
            </p>
            {before && after && (
              <div className="diff" role="table" aria-label={`Changes in ${path}`}>
                {groups.map((h, hi) => {
                  if (shown >= MAX_DIFF_LINES) return null;
                  const visible = h.lines.slice(0, MAX_DIFF_LINES - shown);
                  shown += visible.length;
                  return (
                    <div key={hi} className="hunk" role="rowgroup">
                      {hi > 0 && <div className="hunk-gap" aria-hidden="true">⋯</div>}
                      {visible.map((l, li) => (
                        <div key={li} className={`dl dl-${l.kind}`} role="row" data-kind={l.kind}>
                          <span className="dl-no" role="cell" aria-label={l.kind === 'del' ? 'removed' : l.kind === 'add' ? 'added' : 'unchanged'}>
                            {l.kind === 'del' ? '−' : l.kind === 'add' ? '+' : ' '}
                          </span>
                          <span className="dl-text" role="cell">
                            {l.text || ' '}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
                {added + removed > 0 && shown >= MAX_DIFF_LINES && <p className="muted">More changes not shown.</p>}
              </div>
            )}
          </div>
        );
      })}
      {!props.currentFiles && <p className="muted">The new version of the files isn't available here, so only the names are shown.</p>}
    </div>
  );
}

export function Notes({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="notes">
      {items.map((text) => (
        <li key={text}>
          <span className="dot dot-warning" aria-hidden="true" />
          <span>{text}</span>
        </li>
      ))}
    </ul>
  );
}

export function Skeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <div className="sk sk-headline" />
      <div className="sk sk-line" />
      <div className="sk sk-bar" />
      <div className="sk sk-row" />
      <div className="sk sk-row" />
      <div className="sk sk-row" />
    </div>
  );
}

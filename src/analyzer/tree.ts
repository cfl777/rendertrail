/**
 * Pure: the card's "What one keystroke does" tree (HANDOFF.md §8) for one step's input update.
 */
import type { RecordedCommit, RecordedTrace, TreeLabel, TreeRow } from '../shared/types.js';
import { ANALYZER } from './constants.js';
import { descendantsOf, isMemoBreak, type Timing } from './rules.js';

interface Row extends TreeRow {
  order: number;
  priority: number;
}

/** Lower is kept first when there are more rows than fit. */
const PRIORITY: Record<TreeLabel, number> = {
  'state-origin': 0,
  'memo-broken': 1,
  skipped: 2,
  'nothing-changed': 3,
  needed: 4,
};
/** A component whose only change is new `children` elements is passing its parent's render along. */
const PASS_THROUGH_PRIORITY = 5;

function labelOf(r: RecordedCommit['rendered'][number]): TreeLabel {
  if (r.changedState.length > 0) return 'state-origin';
  if (isMemoBreak(r)) return 'memo-broken';
  if (r.changedProps.some((p) => !p.sameValue) || r.changedContext.some((c) => !c.sameValue)) return 'needed';
  return 'nothing-changed';
}

export function buildTree(trace: RecordedTrace, commitIndex: number, timing: Timing): TreeRow[] {
  const commit = trace.commits[commitIndex];
  const mount = trace.commits[0];
  if (!commit) return [];
  const rows: Row[] = [];
  const depthOf = new Map<string, number>();
  const depths: number[] = [];
  let skipUntil = -1;

  commit.rendered.forEach((r, i) => {
    const depth = r.parentIndex === null ? 0 : (depths[r.parentIndex] ?? 0) + 1;
    depths[i] = depth;
    if (!depthOf.has(r.name)) depthOf.set(r.name, depth);
    if (i <= skipUntil) return; // folded into a memo-broken row above

    const label = labelOf(r);
    const below: Record<string, number> = {};
    if (label === 'memo-broken') {
      const descendants = descendantsOf(commit, i);
      for (const d of descendants) below[d.name] = (below[d.name] ?? 0) + 1;
      skipUntil = i + descendants.length;
    }
    const same = rows.find((row) => row.name === r.name && row.label === label && row.depth === depth);
    if (same) {
      same.count += 1;
      same.ms = Math.round((same.ms + timing.componentMs(commitIndex, i)) * 100) / 100;
      return;
    }
    const passThrough = label === 'needed' && r.changedProps.every((p) => p.name === 'children') && r.changedContext.length === 0;
    rows.push({
      name: r.name,
      depth,
      label,
      memo: r.memo,
      count: 1,
      below,
      ms: timing.componentMs(commitIndex, i),
      order: i,
      priority: passThrough ? PASS_THROUGH_PRIORITY : PRIORITY[label],
    });
  });

  // Memo components that were there at mount, whose parent rendered now, but which didn't render: memo worked.
  const renderedNow = new Set(commit.rendered.map((r) => r.name));
  for (const m of mount?.rendered ?? []) {
    if (!m.memo || renderedNow.has(m.name) || m.parent === null || !renderedNow.has(m.parent)) continue;
    if (rows.some((row) => row.name === m.name)) continue;
    const parentIndex = commit.rendered.findIndex((r) => r.name === m.parent);
    const subtreeEnd = parentIndex + descendantsOf(commit, parentIndex).length;
    rows.push({
      name: m.name,
      depth: (depthOf.get(m.parent) ?? 0) + 1,
      label: 'skipped',
      memo: true,
      count: 1,
      below: {},
      ms: 0,
      order: subtreeEnd + 0.5,
      priority: PRIORITY.skipped,
    });
  }

  return rows
    .sort((a, b) => a.priority - b.priority || a.order - b.order)
    .slice(0, ANALYZER.maxTreeRows)
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, priority: _priority, ...row }) => row);
}

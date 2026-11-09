// Runs inside the recorded page before React loads (injected with Playwright's addInitScript).
// For every React commit it records which components rendered, how long they took and why:
// which props changed (by reference only, or by value), which state hooks and which context
// values changed. Bundled with bippy into one IIFE (dist/instrument.js, or at runtime from source).
import {
  getDisplayName,
  getReactWorkTagsForFiber,
  getType,
  instrument,
  isCompositeFiber,
  traverseRenderedFibers,
  type Fiber,
} from 'bippy';
import type {
  ChangedContext,
  ChangedProp,
  ChangedState,
  RecordedCommit,
  RecordedTrace,
  RenderedComponent,
} from '../../shared/types';

/** The few fiber fields we read. bippy's own Fiber type leans on react-reconciler's types. */
interface HookNode {
  memoizedState: unknown;
  queue?: unknown;
  next: HookNode | null;
}
interface ContextNode {
  context: { displayName?: string };
  memoizedValue: unknown;
  next: ContextNode | null;
}
interface RtFiber {
  tag: number;
  type: unknown;
  return: RtFiber | null;
  child: RtFiber | null;
  sibling: RtFiber | null;
  alternate: RtFiber | null;
  actualDuration?: number;
  memoizedProps: Record<string, unknown> | null;
  memoizedState: unknown;
  dependencies: { firstContext: ContextNode | null } | null;
}

declare global {
  interface Window {
    __RT__: RecordedTrace;
  }
}

/** A commit closer than this to the previous one counts as a follow-up (spike heuristic, Phase 2 replaces it). */
const FOLLOW_UP_GAP_MS = 20;
const PREVIEW_CHARS = 40;

const RT: RecordedTrace = { commits: [], errors: [] };
window.__RT__ = RT;

// Count user input so each commit can be tagged as caused by input or not.
// Capture phase on window runs before React's own listeners on the root.
let inputSeq = 0;
const countInput = (): void => {
  inputSeq += 1;
};
window.addEventListener('input', countInput, true);
window.addEventListener('click', countInput, true);

let lastInputSeq = 0;
let lastDoneAt = -Infinity;

instrument({
  onCommitFiberRoot(_rendererID, root) {
    try {
      const at = performance.now();
      const fibers: { fiber: RtFiber; phase: 'mount' | 'update' }[] = [];
      traverseRenderedFibers(root, (fiber, phase) => {
        if (phase !== 'unmount' && isCompositeFiber(fiber)) fibers.push({ fiber: asRt(fiber), phase });
      });

      const renderedSet = new Set(fibers.map(({ fiber }) => fiber));
      let renderMs = 0;
      const rendered: RenderedComponent[] = fibers.map(({ fiber, phase }) => {
        const tags = getReactWorkTagsForFiber(fiber as unknown as Fiber);
        const parentFiber = nearestComposite(fiber.return);
        const prev = phase === 'update' ? fiber.alternate : null;
        // Time for the topmost rendered components adds up to the commit's render time.
        if (!parentFiber || !renderedSet.has(parentFiber)) renderMs += fiber.actualDuration ?? 0;
        return {
          name: nameOf(fiber),
          phase,
          memo: fiber.tag === tags.MemoComponent || fiber.tag === tags.SimpleMemoComponent,
          parent: parentFiber ? nameOf(parentFiber) : null,
          selfMs: round(selfDuration(fiber)),
          totalMs: round(fiber.actualDuration ?? 0),
          changedProps: prev ? diffProps(prev.memoizedProps, fiber.memoizedProps) : [],
          changedState: prev ? diffHooks(prev.memoizedState, fiber.memoizedState) : [],
          changedContext: prev ? diffContext(prev, fiber) : [],
        };
      });

      const isFirst = RT.commits.length === 0;
      const isInput = inputSeq !== lastInputSeq;
      const commit: RecordedCommit = {
        index: RT.commits.length,
        at,
        doneAt: at,
        inputSeq,
        trigger: isFirst ? 'mount' : isInput ? 'input' : at - lastDoneAt < FOLLOW_UP_GAP_MS ? 'follow-up' : 'later',
        renderMs: round(renderMs),
        rendered,
      };
      RT.commits.push(commit);
      lastInputSeq = inputSeq;
      commit.doneAt = performance.now();
      lastDoneAt = commit.doneAt;
    } catch (error) {
      RT.errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
  },
});

function asRt(fiber: Fiber): RtFiber {
  return fiber as unknown as RtFiber;
}

function nameOf(fiber: RtFiber): string {
  return getDisplayName(getType(fiber.type)) || getDisplayName(fiber.type) || 'Anonymous';
}

function nearestComposite(start: RtFiber | null): RtFiber | null {
  let fiber = start;
  while (fiber && !isCompositeFiber(fiber as unknown as Fiber)) fiber = fiber.return;
  return fiber;
}

// actualDuration covers the fiber and everything below it that rendered in this commit.
function selfDuration(fiber: RtFiber): number {
  let self = fiber.actualDuration ?? 0;
  for (let child = fiber.child; child; child = child.sibling) self -= child.actualDuration ?? 0;
  return Math.max(0, self);
}

function diffProps(prev: Record<string, unknown> | null, next: Record<string, unknown> | null): ChangedProp[] {
  const changed: ChangedProp[] = [];
  if (!prev || !next || prev === next) return changed;
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (Object.is(prev[key], next[key])) continue;
    changed.push({ name: key, sameValue: sameValue(prev[key], next[key]), type: typeLabel(next[key]) });
  }
  return changed;
}

function isHookNode(value: unknown): value is HookNode {
  return typeof value === 'object' && value !== null && 'next' in value && 'memoizedState' in value;
}

// Walk the hooks list; only state-like hooks (useState, useReducer) have a queue.
function diffHooks(prevState: unknown, nextState: unknown): ChangedState[] {
  const changed: ChangedState[] = [];
  let prevHook = isHookNode(prevState) ? prevState : null;
  let nextHook = isHookNode(nextState) ? nextState : null;
  let index = 0;
  while (prevHook && nextHook) {
    if (nextHook.queue && !Object.is(prevHook.memoizedState, nextHook.memoizedState)) {
      changed.push({ hook: index, from: preview(prevHook.memoizedState), to: preview(nextHook.memoizedState) });
    }
    prevHook = prevHook.next;
    nextHook = nextHook.next;
    index += 1;
  }
  return changed;
}

// fiber.dependencies lists the contexts read in the last render, with the value read.
// The previous fiber (alternate) keeps the list from the render before.
function diffContext(prev: RtFiber, next: RtFiber): ChangedContext[] {
  const changed: ChangedContext[] = [];
  for (let dep = next.dependencies?.firstContext ?? null; dep; dep = dep.next) {
    let old = prev.dependencies?.firstContext ?? null;
    while (old && old.context !== dep.context) old = old.next;
    if (!old || Object.is(old.memoizedValue, dep.memoizedValue)) continue;
    changed.push({
      name: dep.context.displayName || 'Context',
      sameValue: sameValue(old.memoizedValue, dep.memoizedValue),
      from: preview(old.memoizedValue),
      to: preview(dep.memoizedValue),
    });
  }
  return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Props are compared up to depth 3, and functions by their source text (spike shortcut).
function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a === 'function' && typeof b === 'function') return a.toString() === b.toString();
  if (!isRecord(a) || !isRecord(b) || depth > 3) return false;
  if ('$$typeof' in a || '$$typeof' in b) return false; // React elements: treat as changed
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => sameValue(a[key], b[key], depth + 1));
}

function typeLabel(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (isRecord(value) && '$$typeof' in value) return 'element';
  return value === null ? 'null' : typeof value;
}

function preview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 3)}...` : text;
  } catch {
    return String(value);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

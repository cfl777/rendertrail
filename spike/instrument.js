// Runs inside the page before React loads (injected with Playwright's addInitScript).
// For every React commit it records which components rendered, how long they took
// and why: which props changed (by reference only, or by value) and which state changed.
import {
  getDisplayName,
  getReactWorkTagsForFiber,
  getType,
  instrument,
  isCompositeFiber,
  traverseRenderedFibers,
} from 'bippy';

const RT = (window.__RT__ = { commits: [], inputSeq: 0, errors: [] });

// Count user input so each commit can be tagged as caused by input or not.
// Capture phase on window runs before React's own listeners.
window.addEventListener('input', () => {
  RT.inputSeq += 1;
}, true);

let lastInputSeq = 0;
let lastCommitAt = -Infinity;

instrument({
  onCommitFiberRoot(_rendererID, root) {
    try {
      const at = performance.now();
      const fibers = [];
      traverseRenderedFibers(root, (fiber, phase) => {
        if (phase !== 'unmount' && isCompositeFiber(fiber)) fibers.push({ fiber, phase });
      });

      const renderedSet = new Set(fibers.map(({ fiber }) => fiber));
      let renderMs = 0;
      const rendered = fibers.map(({ fiber, phase }) => {
        const tags = getReactWorkTagsForFiber(fiber);
        const parentFiber = nearestComposite(fiber.return);
        const prev = fiber.alternate;
        // Time for the topmost rendered components adds up to the commit's render time.
        if (!parentFiber || !renderedSet.has(parentFiber)) renderMs += fiber.actualDuration ?? 0;
        return {
          name: nameOf(fiber),
          phase,
          memo: fiber.tag === tags.MemoComponent || fiber.tag === tags.SimpleMemoComponent,
          parent: parentFiber ? nameOf(parentFiber) : null,
          selfMs: round(selfDuration(fiber)),
          totalMs: round(fiber.actualDuration ?? 0),
          changedProps: phase === 'update' && prev ? diffProps(prev.memoizedProps, fiber.memoizedProps) : [],
          changedState: phase === 'update' && prev ? diffHooks(prev.memoizedState, fiber.memoizedState) : [],
        };
      });

      const isFirst = RT.commits.length === 0;
      const isInput = RT.inputSeq !== lastInputSeq;
      RT.commits.push({
        index: RT.commits.length,
        at: round(at),
        // follow-up: a commit right after another one with no input in between (e.g. setState in an effect)
        // later: a commit after a pause with no input (e.g. a timer such as a debounce)
        trigger: isFirst ? 'mount' : isInput ? 'input' : at - lastCommitAt < 20 ? 'follow-up' : 'later',
        renderMs: round(renderMs),
        rendered,
      });
      lastInputSeq = RT.inputSeq;
      lastCommitAt = performance.now();
    } catch (error) {
      RT.errors.push(String((error && error.stack) || error));
    }
  },
});

function nameOf(fiber) {
  return getDisplayName(getType(fiber.type)) || getDisplayName(fiber.type) || 'Anonymous';
}

function nearestComposite(fiber) {
  while (fiber && !isCompositeFiber(fiber)) fiber = fiber.return;
  return fiber || null;
}

// actualDuration covers the fiber and everything below it that rendered in this commit.
function selfDuration(fiber) {
  let self = fiber.actualDuration ?? 0;
  for (let child = fiber.child; child; child = child.sibling) self -= child.actualDuration ?? 0;
  return Math.max(0, self);
}

function diffProps(prev, next) {
  const changed = [];
  if (!prev || !next || prev === next) return changed;
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (Object.is(prev[key], next[key])) continue;
    changed.push({ name: key, sameValue: sameValue(prev[key], next[key]), type: typeLabel(next[key]) });
  }
  return changed;
}

// Walk the hooks list; only state-like hooks (useState, useReducer) have a queue.
function diffHooks(prevHook, nextHook) {
  const changed = [];
  let index = 0;
  while (prevHook && nextHook && typeof nextHook === 'object' && 'next' in nextHook) {
    if (nextHook.queue && !Object.is(prevHook.memoizedState, nextHook.memoizedState)) {
      changed.push({ hook: index, from: preview(prevHook.memoizedState), to: preview(nextHook.memoizedState) });
    }
    prevHook = prevHook.next;
    nextHook = nextHook.next;
    index += 1;
  }
  return changed;
}

function sameValue(a, b, depth = 0) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a === 'function') return a.toString() === b.toString();
  if (typeof a !== 'object' || depth > 3) return false;
  if (a.$$typeof || b.$$typeof) return false; // React elements: treat as changed
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => sameValue(a[key], b[key], depth + 1));
}

function typeLabel(value) {
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object' && value.$$typeof) return 'element';
  return value === null ? 'null' : typeof value;
}

function preview(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 40 ? `${text.slice(0, 37)}...` : text;
  } catch {
    return String(value);
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}

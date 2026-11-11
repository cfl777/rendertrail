# Todo toggle: expected results

A golden test for rule 1 with a **function** prop. A todo list of 100 memoised rows with a "new todo" input on top: every keystroke re-renders all 100 rows, because `TodoApp` passes `onToggle={handleToggle}` and `handleToggle` is a new function on every render.

Verified on 2026-11-09 with the Phase 1 recorder on React 19.3.1 and 18.3.1. Both versions gave identical commit counts, identical across 3 runs each.
Numbers produced by the recorder; the owner still checks each finding by hand in React DevTools (HANDOFF §9 Phase 2).

## The interaction (`test.json`)

Type "milk" into the "New todo" input with 100 ms between letters, wait 200 ms, click the checkbox of "Task 3", wait 200 ms, click "Add", wait 200 ms. There are no effects and no timers, so every commit is an input commit.

## Commits: these must match exactly

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | Everything: TodoApp, TodoItem ×100, TodoFooter |
| 1, 2, 3, 4 | input (one per letter of "milk") | TodoApp, TodoItem ×100 (`onToggle` new reference, same value). TodoFooter does **not** render (its memo holds). |
| 5 | input (click the "Task 3" checkbox) | TodoApp, TodoItem ×100 (Task 3's `todo` changed; the other 99 only got a new `onToggle`), TodoFooter (`remaining` 75 → 74) |
| 6 | input (click "Add") | TodoApp, TodoItem ×101 (100 re-renders plus the new "Task 101" mounting), TodoFooter (`remaining` 74 → 75) |

Renders after mount: TodoApp 6, TodoItem 601, TodoFooter 2.

The recorder counts the mount of "Task 101" in commit 6 as a TodoItem render like the others; it is a mount, not a re-render.

**After the fix** (`TodoApp.fixed.tsx`, `handleToggle` wrapped in `useCallback` with an empty dependency list): the same 7 commits. Commits 1–4 render only TodoApp; commit 5 renders TodoApp, TodoItem ×1 (Task 3) and TodoFooter; commit 6 renders TodoApp, TodoItem ×1 (the new row mounting) and TodoFooter. Renders after mount: TodoApp 6, TodoItem 2, TodoFooter 2.

## Timings (depend on the machine; for orientation only)

On the Windows 11 dev machine used for verification (installed Chrome, headless):

- Input commits: median 10.35 ms (React 19) and 10.55 ms (React 18) before the fix, single commits 10.1–12.1 ms; 0.3 ms after.
- Mount: 13.4–16.8 ms.

`TodoItem` busy-waits 0.05 ms on purpose (about 0.1 ms per row with Chrome's timer rounding), so the wasted renders cost real time but one step still fits inside a 16.7 ms frame. Chrome's timer resolution here is about 0.1 ms, so treat differences smaller than that as noise.

## Findings the analyzer must report

1. **Rule 1: an unstable prop breaks memo.** `TodoItem` gets a new `onToggle` function on every render with the same behaviour. The prop is passed by name at `TodoApp.tsx:29` (`<TodoItem key={todo.id} todo={todo} onToggle={handleToggle} />`); the function is declared at `TodoApp.tsx:9`. The 100 instances group into one finding. Waste: TodoItem ×100 on each of the 4 letters, and ×99 on the toggle click and ×100 on the add click, about 10 ms per step here, under the 16.7 ms frame budget. Fix: `useCallback`, as in `TodoApp.fixed.tsx`; it only works with an empty dependency list because the setter uses the functional updater. React Compiler would also fix this automatically.

## Must NOT be reported

- **Inline arrows on DOM elements**: `onChange={(e) => setDraft(...)}` on the `<input>` (`TodoApp.tsx:24`) and `onChange={() => onToggle(todo.id)}` on the checkbox (`TodoItem.tsx:25`). Host elements aren't memo components.
- **TodoFooter**: its memo holds while typing (`remaining` doesn't change). In commits 5 and 6 it renders because `remaining` changed by value: needed.
- **The clicked row (Task 3) in commit 5**: its `todo` changed by value, so this render is needed. Its `onToggle` also changed by reference, but the render would have happened anyway. Only the other 99 rows are wasted.
- **The new row (Task 101) in commit 6**: a mount, not a re-render.
- **Rule 2**: there is no effect anywhere, and there are no follow-up commits.

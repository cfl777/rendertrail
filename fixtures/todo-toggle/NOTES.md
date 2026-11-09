# todo-toggle: candidate notes

Draft notes kept for provenance. EXPECTED.md and expected.json hold the recorder-verified counts; the sections below are the hand reasoning that preceded them.

## What it does

A todo list of 100 memoised rows with a "new todo" input on top, where every keystroke in the input re-renders all 100 rows because the toggle handler is a new function each render.

## Origin

The exact shape of the React docs example for `useCallback`: a parent passes a plain function declared in its body to a `memo` child, so `memo` never skips
(https://react.dev/reference/react/useCallback#skipping-re-rendering-of-components). The todo list form is the classic teaching app (TodoMVC). Synthesised from that well-known pattern; no single repo copied. eslint-plugin-react-perf's `jsx-no-new-function-as-prop` rule targets the same mistake (https://github.com/cvazac/eslint-plugin-react-perf).

## Rule it should trigger

**Rule 1, prop type: function.** `TodoItem` (memo) gets `onToggle={handleToggle}`; `handleToggle` is declared with `function` inside `TodoApp`, so it is a new function on every render. JSX element at `TodoApp.tsx:29` (`<TodoItem key={todo.id} todo={todo} onToggle={handleToggle} />`). The prop is a named identifier, not an inline arrow, so line lookup has to report the JSX attribute line and ideally also point at the declaration (`TodoApp.tsx:9`).

Fix: `useCallback` with an empty dependency list, which only works because the setter uses the functional updater (`setTodos(prev => …)`). See `TodoApp.fixed.tsx`. React Compiler would do this automatically.

What this adds: the memo component is the list item itself (100 instances of one component, inside `.map`), so the finding must group instances by component and line, not report 100 findings.

## Must NOT be reported

- **Inline arrows on DOM elements**: `onChange={(e) => setDraft(...)}` on `<input>` (`TodoApp.tsx:24`) and `onChange={() => onToggle(todo.id)}` on the checkbox (`TodoItem.tsx:25`). Host elements are not memo components; rule 1 only applies to `MemoComponent` / `SimpleMemoComponent` fibers.
- **`TodoFooter`** on the keystrokes: memo holds (prop `remaining` is a number that does not change while typing). On the two clicks it re-renders because `remaining` changed by value (75 → 74, then 74 → 75): needed.
- **The clicked row (`Task 3`) in the toggle step**: its `todo` prop changed by value. Only the other 99 rows are wasted.
- **The new row (`Task 101`)** in the add step: a mount, not a re-render.
- **Rule 2**: there is no effect anywhere; no follow-up commits should appear.

## Expected commits (hand-reasoned draft, before recording)

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | TodoApp, TodoItem ×100, TodoFooter |
| 1–4 | input (one per letter of "milk") | TodoApp, TodoItem ×100 (all wasted). TodoFooter skipped. |
| 5 | input (click checkbox Task 3) | TodoApp, TodoItem ×100 (1 needed, 99 wasted), TodoFooter |
| 6 | input (click Add) | TodoApp, TodoItem ×100 update (all wasted) + 1 mount, TodoFooter |

No follow-up or later commits. Renders after mount: TodoApp 6, TodoItem 600 updates + 1 mount, TodoFooter 2.

Rough cost: 100 × 0.1 ms ≈ 10 ms wasted per step, under the 16.7 ms budget, so the headline is "wasted" rather than "laggy". Worth checking that the card copy works when the step fits in a frame.

After the fix: commits 1–4 render only TodoApp; commit 5 renders TodoApp, TodoItem ×1, TodoFooter; commit 6 renders TodoApp, TodoItem ×1 (mount), TodoFooter.

## Open questions

- In commit 5 the clicked row also gets a new `onToggle`, but its `todo` changed by value, so it is not wasted. Same logic as laggy-search commit 11; the analyzer must apply it per instance.

## Recorder results (2026-11-09)

Recorded with the Phase 1 recorder on React 19.3.1 and 18.3.1, 3 runs each: the commit shapes above match exactly (7 commits; renders after mount TodoApp 6, TodoItem 601, TodoFooter 2, where 601 is 600 re-renders plus the mount of Task 101 in commit 6). The fixed variant matches too. See EXPECTED.md.

**Changed:** `TodoItem` busy-waits 0.05 ms instead of 0.1 ms. With 0.1 ms one step measured about 17.4 ms on React 19, just over the 16.7 ms frame budget, because Chrome's 0.1 ms timer rounding stretches each wait to about 0.17 ms. That broke this fixture's stated intent (one step fits inside a frame). With 0.05 ms a step measures about 10.4 ms on both React versions. Render counts are unaffected.

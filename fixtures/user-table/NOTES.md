# user-table: candidate notes

Not an EXPECTED.md: the counts below are worked out by hand and must be replaced by recorder output.

## What it does

An admin page with a memoised 150-row user table and a "Show filters" button, where opening or closing the filter panel re-renders the whole table because its `columns` list is a new array literal on every render.

## Origin

Table libraries document this exact trap. TanStack Table's data guide has a section "Give Data a 'Stable' Reference" saying `data` and `columns` must keep their identity across renders (https://tanstack.com/table/latest/docs/guide/data). The React docs list it under "My component re-renders when a prop is an object, array, or function" (https://react.dev/reference/react/memo#my-component-rerenders-when-a-prop-is-an-object-or-array). eslint-plugin-react-perf has `jsx-no-new-array-as-prop` for it (https://github.com/cvazac/eslint-plugin-react-perf). The component itself is synthesised; it is not copied from a repo.

## Rule it should trigger

**Rule 1, prop type: array.** `UserTable` (memo) gets `columns={['name', 'email', 'role']}` at `UserAdmin.tsx:14`. On every click the array is new but holds the same three strings. `users` is the module constant `USERS`, so it is stable. Cost per click: UserTable plus 150 × UserRow (≈ 0.06 ms each), about 9 ms.

Fix: the array uses no state or props, so hoisting it to a module constant is the better fix (see `UserAdmin.fixed.tsx`). `useMemo(() => [...], [])` also works. Suggested addition to the fix text: "if the literal uses no variables from the component, move it outside the component". React Compiler would also fix this.

What this adds: the first fixture driven only by **click** steps, and the first **array** prop. The waste is carried by non-memo children (`UserRow`) under the memo parent, so the cost must be the memo component's `totalMs`, not its self time.

## Must NOT be reported

- **`FilterPanel`** re-renders on every click because `open` changed by value: needed. Its `roles` prop is the module constant `ROLES` and stays stable.
- **`UserRow` as its own finding**: it is not memoised and re-renders only because `UserTable` did. It belongs in rule 1's cost, not in a separate row.
- **The button's inline `onClick` arrow** (`UserAdmin.tsx:10`): a DOM element, not a memo component.
- **Rule 2**: there are no effects.

## Expected commits (hand-reasoned)

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | UserAdmin, FilterPanel (returns null), UserTable, UserRow ×150 |
| 1, 2, 3, 4 | input (one per click) | UserAdmin, FilterPanel (needed), UserTable + UserRow ×150 (wasted) |

No follow-up or later commits. Renders after mount: UserAdmin 4, FilterPanel 4, UserTable 4, UserRow 600.

After the fix: commits 1–4 render only UserAdmin and FilterPanel; UserTable and UserRow 0.

## Open questions

- "Same contents" is easy for an array of strings. A common real-world variant is `columns={[{ key: 'name', label: 'Name' }, …]}`, where the array **and** each element are new. Should rule 1 compare deeply (and with what depth limit) or only one level? Worth a follow-up fixture once the comparison depth is decided.

## Recorder results (2026-11-09)

Recorded with the Phase 1 recorder on React 19.3.1 and 18.3.1, 3 runs each: the commit shapes above match exactly, and so does the fixed variant. No changes to the draft. One step costs about 15.5–16 ms here, not the 9 ms estimated above (timer rounding stretches each 0.06 ms wait to about 0.1 ms), which is close to the 16.7 ms frame budget. See EXPECTED.md.

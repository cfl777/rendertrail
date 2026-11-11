# User table: expected results

A golden test for rule 1 with an **array** prop, driven only by clicks. An admin page with a memoised 150-row user table and a "Show filters" button: opening or closing the filter panel re-renders the whole table, because `columns` is a new array literal on every render.

Verified on 2026-11-09 with the Phase 1 recorder on React 19.3.1 and 18.3.1. Both versions gave identical commit counts, identical across 3 runs each.
Numbers produced by the recorder; the owner still checks each finding by hand in React DevTools (HANDOFF §9 Phase 2).

## The interaction (`test.json`)

Click "Toggle filters" 4 times, waiting 150 ms after each click. The panel opens, closes, opens and closes. There are no effects, so every commit is an input commit.

## Commits: these must match exactly

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | Everything: UserAdmin, FilterPanel (returns null), UserTable, UserRow ×150 |
| 1, 2, 3, 4 | input (one per click) | UserAdmin, FilterPanel (`open` changed), UserTable (`columns` new reference, same value), UserRow ×150 |

Renders after mount: UserAdmin 4, FilterPanel 4, UserTable 4, UserRow 600.

**After the fix** (`UserAdmin.fixed.tsx`, `columns` hoisted to the module constant `COLUMNS`): the same 5 commits, but the input commits render only UserAdmin and FilterPanel. UserTable and UserRow render 0 times after mount.

## Timings (depend on the machine; for orientation only)

On the Windows 11 dev machine used for verification (installed Chrome, headless):

- Input commits: median 15.5 ms (React 19) and 16.0 ms (React 18) before the fix, single commits 15.1–17.7 ms; 0.15 ms after.
- Mount: 17.3–27.1 ms.

`UserRow` busy-waits 0.06 ms on purpose, like laggy-search's `ResultRow` (about 0.1 ms per row with timer rounding). Note that one step sits close to the 16.7 ms frame budget on this machine. Chrome's timer resolution here is about 0.1 ms, so treat differences smaller than that as noise.

## Findings the analyzer must report

1. **Rule 1: an unstable prop breaks memo.** `UserTable` gets a new `columns` array on every render with the same contents (`['name', 'email', 'role']`), created at `UserAdmin.tsx:14` (`<UserTable users={USERS} columns={['name', 'email', 'role']} />`). Waste: UserTable plus 150 UserRow renders on each of the 4 clicks, about 15 ms per click here. The cost is UserTable's total time: the waste sits in the non-memo `UserRow` children. Fix: the array uses no state or props, so moving it out of the component (as in `UserAdmin.fixed.tsx`) is the better fix; `useMemo(() => [...], [])` also works. React Compiler would also fix this automatically.

## Must NOT be reported

- **FilterPanel** re-renders on every click because `open` changed by value: needed. Its `roles` prop is the module constant `ROLES` and stays stable.
- **UserRow as its own finding**: it isn't memoised and re-renders only because `UserTable` did. It belongs in rule 1's cost, not in a separate finding. (The recorder notes its `columns` changed by reference, because UserTable passes the same new array down.)
- **The button's inline `onClick` arrow** (`UserAdmin.tsx:10`): a DOM element, not a memo component.
- **Rule 2**: there are no effects.

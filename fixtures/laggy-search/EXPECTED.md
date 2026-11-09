# Laggy search: expected results

The golden test for the recorder and the analyzer. It's the same example as the mockups: typing in a search box re-renders 200 rows that didn't change.

Verified on 2026-10-31 with `../../spike` on React 19.3.1 and React 18.3.1. Both versions gave identical commit counts.

## The interaction (`test.json`)

Type "hello" into the search box with 100 ms between letters, then wait 600 ms. The search debounce is 300 ms, so it fires once, after the last letter.

## Commits: these must match exactly

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | Everything: SearchPage, Layout, Header, SearchBox, ResultsList, ResultRow ×200, Sidebar |
| 1, 3, 5, 7, 9 | input (one per letter) | SearchPage, Layout, Header, SearchBox, ResultsList, ResultRow ×200. Sidebar does **not** render (its memo holds). |
| 2, 4, 6, 8, 10 | follow-up (right after each letter) | SearchBox only: its `charCount` state goes 0 → 1, 1 → 2, … |
| 11 | later (the debounce fires) | SearchPage, Layout, Header, SearchBox, ResultsList (`items` changed), ResultRow ×50 |

Renders after mount: SearchPage 6, Layout 6, Header 6, SearchBox 11, ResultsList 6, ResultRow 1,050, Sidebar 0.

**After the fix** (`SearchPage.fixed.tsx`, `filters` wrapped in `useMemo`): the same 12 commits, but the input commits render only SearchPage, Layout, Header and SearchBox. ResultsList renders once (commit 11) and ResultRow 50 times.

## Timings (depend on the machine; for orientation only)

On the cloud dev container used for verification:

- Input commits: median about 20.5 ms before the fix and 0.1–0.2 ms after.
- Follow-up commits: about 0.1 ms. Mount: 26–34 ms. Commit 11: about 5.5 ms.

`ResultRow` busy-waits about 0.06 ms on purpose so the wasted renders cost real time. Chrome's timer resolution here is about 0.1 ms, so treat differences smaller than that as noise.

## Findings the analyzer must report

1. **Rule 1: an unstable prop breaks memo.** `ResultsList` gets a new `filters` object on every render with the same contents, created at `SearchPage.tsx:19` (`filters={{ sort: 'recent', tags }}`). Waste: ResultsList plus 200 ResultRow renders on each of the 5 letters, about 20 ms per letter here. Fix: `useMemo`, as in `SearchPage.fixed.tsx`. React Compiler would also fix this automatically.
2. **Rule 2: state set inside an effect.** `SearchBox` copies a prop into state with `useEffect(() => setCharCount(value.length), [value])` at `SearchBox.tsx:10`. Cost: one extra commit per letter (5 in total). Fix: `const charCount = value.length;`. React Compiler doesn't fix this one.

## Must NOT be reported

- **Header** re-renders because its parent rendered. It costs well under 1 ms, so it isn't worth a finding.
- **Layout** re-renders because its `children` are new elements every time. That's expected, and it isn't memoized.
- **ResultsList in commit 11**: `items` changed by value (the debounced query), so this render is needed. Its `filters` also changed by reference, but the render would have happened anyway.
- **`useDebounce`** calls `setDebounced` inside a `setTimeout` started by an effect (`hooks.ts:8`). That's the normal debounce pattern, not the rule 2 problem: the state isn't set synchronously in the effect.
- **Sidebar**: its memo holds because `tags` is a stable array.

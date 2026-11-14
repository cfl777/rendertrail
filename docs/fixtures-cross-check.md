# Fixtures: independent cross-check

HANDOFF §9 Phase 2 asks for every finding in `fixtures/*/EXPECTED.md` to be checked by hand in React DevTools. This page is a second opinion that shrinks that hand check to a spot check.

## What was checked, and how it differs from the recorder

`scripts/cross-check-fixtures.mjs` recounts every fixture without the recorder and without bippy: it adds one counter call at the top of every component function (one call is one render) and counts updates with React's own public `<Profiler onRender>`. It plays the same steps from `test.json` in the installed Chrome, 3 runs per variant, and compares the counts with `expected.json`.

Run it with `node scripts/cross-check-fixtures.mjs` (no build needed). Options: `--runs N`, `--fixture NAME`, `--json FILE`. It exits with an error on any count that differs, or when runs disagree with each other.

Checked on 2026-11-13 with Chrome 157 (headless), on React 19.3.1 (three full runs of the script, 3 runs per variant each time) and React 18.3.1 (one full run, 3 runs per variant). **No disagreement.** Every number below matched in every run, on both versions, including the order of updates, what rendered in each update, and which updates came from a click or a key press.

An "update" is one time React applied changes to the page. "Renders after mount" counts every render after the first update.

## The numbers

✔ means the independent count equals `expected.json`, on React 18 and on React 19.

### laggy-search

| | Before the fix: expected | counted | After the fix: expected | counted | |
|---|---|---|---|---|---|
| Updates | 12 | 12 | 12 | 12 | ✔ |
| SearchPage | 6 | 6 | 6 | 6 | ✔ |
| Layout | 6 | 6 | 6 | 6 | ✔ |
| Header | 6 | 6 | 6 | 6 | ✔ |
| SearchBox | 11 | 11 | 11 | 11 | ✔ |
| ResultsList | 6 | 6 | 1 | 1 | ✔ |
| ResultRow | 1050 | 1050 | 50 | 50 | ✔ |
| Sidebar | 0 | 0 | 0 | 0 | ✔ |

### cart-summary

| | Before: expected | counted | After: expected | counted | |
|---|---|---|---|---|---|
| Updates | 15 | 15 | 10 | 10 | ✔ |
| Cart | 4 | 4 | 4 | 4 | ✔ |
| CartLine | 12 | 12 | 12 | 12 | ✔ |
| CartSummary | 14 | 14 | 9 | 9 | ✔ |

### pricing-toggle

| | Before: expected | counted | After: expected | counted | |
|---|---|---|---|---|---|
| Updates | 9 | 9 | 5 | 5 | ✔ |
| PricingPage | 8 | 8 | 4 | 4 | ✔ |
| PlanCard | 24 | 24 | 12 | 12 | ✔ |
| FeatureMatrix | 8 | 8 | 0 | 0 | ✔ |
| FeatureRow | 640 | 640 | 0 | 0 | ✔ |

### theme-storefront (no fixed version)

| | Expected | counted | |
|---|---|---|---|
| Updates | 5 | 5 | ✔ |
| Storefront | 4 | 4 | ✔ |
| PromoBanner | 0 | 0 | ✔ |
| ProductGrid | 4 | 4 | ✔ |
| ProductCard | 160 | 160 | ✔ |

### todo-toggle

| | Before: expected | counted | After: expected | counted | |
|---|---|---|---|---|---|
| Updates | 7 | 7 | 7 | 7 | ✔ |
| TodoApp | 6 | 6 | 6 | 6 | ✔ |
| TodoItem | 601 | 601 | 2 | 2 | ✔ |
| TodoFooter | 2 | 2 | 2 | 2 | ✔ |

### user-table

| | Before: expected | counted | After: expected | counted | |
|---|---|---|---|---|---|
| Updates | 5 | 5 | 5 | 5 | ✔ |
| UserAdmin | 4 | 4 | 4 | 4 | ✔ |
| FilterPanel | 4 | 4 | 4 | 4 | ✔ |
| UserTable | 4 | 4 | 0 | 0 | ✔ |
| UserRow | 600 | 600 | 0 | 0 | ✔ |

Timings were not compared (they depend on the machine), but they fall where EXPECTED.md says. Median input update on React 19: laggy-search 20.5–21.3 ms before the fix and 0.1–0.2 ms after; pricing-toggle 13.6–14.8 ms and 0.1–0.15 ms; user-table 15.5–16.8 ms and 0.05–0.15 ms; todo-toggle 10.2–10.5 ms and 0.2–0.3 ms; theme-storefront 7.0–7.7 ms; cart-summary 0.4–0.55 ms before and after.

## What the independent data shows, per finding

**laggy-search**
- Rule 1, ResultsList / `filters`: ResultsList re-rendered on all 5 letters, each time with SearchPage, plus 200 ResultRow each time. After the fix it rendered on none of the 5 letters. ✔ Agrees.
- Rule 2, SearchBox / `setCharCount`: each of the 5 letters is followed by exactly 1 extra update in which only SearchBox renders, a few ms later. The Profiler calls it a plain `update` (not `nested-update`; that label is only for updates started from layout effects, and this one comes from `useEffect`). Still there after the fix, as expected: that fix only touches `filters`. ✔ Agrees.
- Not reported: Header renders on every letter, but after the fix a whole letter (SearchPage, Layout, Header, SearchBox together) takes 0.1–0.2 ms, so Header costs less than that. Layout never renders without SearchPage. ResultsList renders in update 11 both before and after the fix, so that render is needed. Update 11 arrives about 305–325 ms after the last letter (the 300 ms debounce), not right after an update. Sidebar renders 0 times.

**cart-summary**
- Rule 2, CartSummary / `setTotal`: each click is followed by 2 updates that render only CartSummary; after the fix, by 1. So the fix removes exactly one extra update per click, on all 4 clicks. ✔ Agrees.
- Not reported: the update that stays after the fix fits the shipping quote (`setQuote`), but the counter can't see which piece of state changed. Mount is followed by 2 CartSummary-only updates before the fix and 1 after. CartLine renders 3 times per click and never outside a click.

**pricing-toggle**
- Rule 1, FeatureMatrix / `labels`: FeatureMatrix (with 80 FeatureRow) rendered in every update where PricingPage rendered: 4 from clicks and 4 extra ones. After the fix: 0. ✔ Agrees.
- Rule 2, PricingPage / `setDiscount`: each click is followed by exactly 1 extra update (PricingPage, PlanCard ×3, FeatureMatrix, FeatureRow ×80), a plain `update` in the Profiler, as expensive as the click's own update. After the fix: 0. ✔ Agrees.
- Not reported: PlanCard renders 3 times per update before and still 3 times per click after the fix, so it is needed. FeatureRow never renders without FeatureMatrix. There is no extra update after mount, and no render that was thrown away without an update.

**theme-storefront** (nothing must be reported)
- The decoy (`layout` on ProductGrid): ProductGrid rendered 4 times. In an extra test run, with `layout` turned into a constant outside the component, it **still** rendered 4 times (ProductCard still 160). So the new `layout` object never caused a render; by elimination the theme context did. The counts can't name the context themselves. ✔ Agrees with "stabilising `layout` would save nothing".
- ProductCard renders 40 times per click; its props come from a constant, so the context is the remaining cause. PromoBanner renders 0 times. No extra updates (no effects).

**todo-toggle**
- Rule 1, TodoItem / `onToggle`: TodoItem rendered 100 times on each of the 4 letters, 100 on the toggle click and 101 on "Add". After the fix: 0, 0, 0, 0, then 1 and 1. So 99 rows were wasted on the toggle and 100 on "Add". ✔ Agrees.
- Not reported: TodoFooter renders only on the toggle and "Add" clicks. The one row that still renders on the toggle after the fix is presumably Task 3, and on "Add" the new row, but the counter can't tell which row it is, or a first render from a re-render. No extra updates.

**user-table**
- Rule 1, UserTable / `columns`: UserTable (with 150 UserRow) rendered on all 4 clicks; after the fix, on none. ✔ Agrees.
- Not reported: FilterPanel renders 4 times before and after the fix (needed). UserRow never renders without UserTable. No extra updates.

## What is left for a human

The independent check confirms the counts. It can't confirm these, so they are what the hand check should look at:

1. **Why a component rendered.** The counter sees that ResultsList rendered, not that `filters` was the prop that changed. React DevTools' "Why did this render?" shows the changed prop or hook. (The `layout` decoy is covered by the extra test run above.)
2. **That the file and line in each finding point at the right JSX** (`SearchPage.tsx:19`, `PricingPage.tsx:26`, `UserAdmin.tsx:14`, `TodoApp.tsx:29`, `SearchBox.tsx:10`, `CartSummary.tsx:28`). That is a source lookup, done with your eyes.
3. **Which state hook changed in an extra update** (cart-summary: `total` in the first extra update, `quote` in the second). DevTools names the changed hook by its position, so expect the first hook for `total` and the third for `quote`.

### Five-minute spot check: laggy-search

1. In a scratch Vite React app (React 19, development build, which React DevTools needs), copy in the files of `fixtures/laggy-search/` and render `SearchPage` from `SearchPage.tsx` without `<StrictMode>` (StrictMode renders twice).
2. Open Chrome DevTools, then **Profiler** (from React DevTools). Click the gear icon, and under **Profiler** turn on "Record why each component rendered while profiling".
3. Click the blue record button, type `hello` into the search box at a normal pace, wait one second, stop recording.
4. Expect **11 updates** in the bar at the top right (the 12th is the first render, which happened before recording). The "1 / 11" counter shows this.
5. Click the first tall update. Expect ResultsList to be highlighted; select it: "Why did this render?" should say **Props changed: (filters)**. 200 ResultRow appear under it.
6. Click the next, tiny update. Expect only **SearchBox**, with "Why did this render?" naming its **first hook** as changed (the `charCount` state).
7. Optional: switch the import to `SearchPage.fixed.tsx` and repeat. The tall updates should be gone; ResultsList renders only in the last update.

## How the check works, and what it can't see

- **Counting renders.** Before bundling, every component function in the fixture files gets `globalThis.__xc.render('Name')` as its first line (TypeScript parser, no type checking). A component is a capitalised function at the top of a file, or a function passed to `memo()` / `forwardRef()`. For `memo(function X() {...})` the name is `X`, the name React DevTools shows. Hooks and helpers are lowercase and are not counted. In production React without StrictMode a component function runs once per render, so calls equal renders.
- **Counting updates.** The app is wrapped in one `<Profiler>` (production React's profiling build, as the recorder uses). Its `onRender` fires once per update and hands over the counts collected since the previous update. An update counts as a click or key press when a `click` or `input` event reached the page since the previous update.
- **Same setup as the recorder, otherwise:** esbuild with the same production settings, `react-dom/profiling`, no StrictMode, headless Chrome with no network access, the same step timings.
- **What it can't see:** why a component rendered; which prop or hook changed; whether a render was a first render or a re-render; per-component timings (only whole updates are timed). A render that React threw away without applying it would be counted in the next update; none happened (the script checks for renders with no update after them).
- **The findings checks** are questions written by hand from each EXPECTED.md (inside the script, `CLAIMS`) and answered from the counts only.

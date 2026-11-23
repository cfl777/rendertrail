# The analyzer on all six fixtures

Written 2026-11-23 on branch `analyzer-all-fixtures`, and revised the same day after a fresh-eyes review (see "Review fixes"). Until now only laggy-search had its findings machine-checked. I ran the real recorder and analyzer on the other five fixtures (unfixed, fixed, and the re-run comparison from unfixed to fixed) and checked each result line by line against its EXPECTED.md.

**Where the checks live now**
- Each `fixtures/*/expected.json` has a `findings` section in laggy-search's format: what must be reported, what must not be, and the comparison.
- `test/golden/analyzer.golden.test.ts` runs every fixture in a real browser and fails if any known fixture has no `findings` section.
- `test/analyzer-fixtures.test.ts` runs the same checks on the saved traces in `test/fixtures/traces/`, plus one test for each bug below. It's part of `npm test` and needs no browser.
- The card harness (`npm run dev:card`) has one new state per fixture, named `fixture-<name>`.

## What the tool reports now

Numbers come from the saved traces on the Windows dev machine. Timings change from machine to machine; the findings don't.

| Fixture | Headline, then findings in rank order | Matches EXPECTED.md |
|---|---|---|
| cart-summary | "Every click causes an extra update: CartSummary sets state inside an effect." 1. Rule 2: `setTotal` at `CartSummary.tsx:28`, one extra update per click (0.5 ms), 4 of 4 clicks. Fix: `const total = items.reduce(…)`. `setQuote` (in `.then`) and the mount updates are not reported. In the card's tree, CartSummary's row says "Then sets its own state in an effect: 1 extra update". | ✔ |
| cart-summary, fixed | "Nothing to fix: each click takes 0.9 ms." Re-run: "Fixed." `setTotal` resolved, nothing new. | ✔ |
| pricing-toggle | "Every click re-renders 81 components that didn't change, twice: FeatureMatrix and 80 × FeatureRow." 1. Rule 1: `labels` at `PricingPage.tsx:26`, about 27 ms per click (both updates). Fix: move it out of the component (`const LABELS = …`); useMemo also works. 2. Rule 2: `setDiscount` at `PricingPage.tsx:8`, 14 ms per click; the text says this time overlaps with finding 1. PlanCard, FeatureRow and mount are not reported. | ✔ |
| pricing-toggle, fixed | "Nothing to fix: each click takes 0.1 ms." Re-run: "Fixed." Both findings resolved. | ✔ |
| theme-storefront | "Nothing to fix: each click takes 6.9 ms." No findings. The text says "No main problem found: …". Card state is no-findings. Tree: ProductGrid and ProductCard ×40 are "needed", PromoBanner is "skipped". | ✔ |
| todo-toggle | "Every step of the interaction re-renders 100 components that didn't change: 100 × TodoItem." 1. Rule 1: `onToggle` passed at `TodoApp.tsx:29`, declared at `TodoApp.tsx:9`, about 10 ms per step, 6 of 6 steps. Fix: `useCallback` with an empty list, because it only calls `setTodos` with an updater. The clicked row and the new row are not counted. | ✔ |
| todo-toggle, fixed | "Nothing to fix: each step takes 0.2 ms." Re-run: "Fixed." | ✔ |
| user-table | "Every click re-renders 151 components that didn't change: UserTable and 150 × UserRow." 1. Rule 1: `columns` at `UserAdmin.tsx:14`, about 15 ms per click. Fix: move it out of the component (`const COLUMNS = […]`); useMemo also works. | ✔ (the fix kind stays `useMemo`: your decision) |
| user-table, fixed | "Nothing to fix: each click takes 0.2 ms." Re-run: "Fixed." | ✔ |
| laggy-search (re-checked) | No change except the rule 2 snippet: it now shows the whole `useEffect(…)` line (still line 10). | ✔ |

No threshold dropped anything real. Every expected finding clears its threshold by a wide margin. The smallest is cart-summary's rule 2 at 0.5 ms per click; rule 2 is measured by how many steps it happens on, not by time.

## Bugs found and fixed

Each item: what the tool did before → what it does now. The test is in `test/analyzer-fixtures.test.ts` unless another file is named.

1. **Rule 2 pointed at the setter's line, not the effect's.** cart-summary said `:29` and pricing-toggle `:9`; EXPECTED.md says `:28` and `:8` → the finding now points at the `useEffect(` line, and the "Show me the line" text adds "it calls `setTotal` on line 29". (`src/analyzer/rules.ts`, `stateInEffectCandidates`; `source.ts` keeps the effect call.)
2. **Rule 2 left out the fix code when the value contained an arrow.** "Fix: compute total during render." → "…: `const total = items.reduce((sum, item) => …, 0);`". Only the updater form `setX((prev) => …)` has no code now.
3. **Rule 2 listed the mount follow-up (commit 1) among its updates** → it lists only updates inside a step (`[4, 7, 10, 13]`), as EXPECTED.md asks ("mount isn't a step").
4. **Rule 1 listed each update once per row**: 600 entries for todo-toggle → one entry per update (`[1…6]`).
5. **Rule 1 ignored how many instances re-rendered.** "re-renders TodoItem, which didn't change" → "re-renders 100 components that didn't change: 100 × TodoItem". The text result now starts with "100 × TodoItem (memo) re-render…".
6. **Rule 1 added up both updates of a click as if they were one.** "re-renders 162 components…: FeatureMatrix and 160 × FeatureRow", while the tree showed 80 → "81 components that didn't change, twice: FeatureMatrix and 80 × FeatureRow". The text and tree now agree.
7. **The card's tree row showed the bar's two-update time.** FeatureMatrix's row said 27 ms although the tree shows one update (13.4 ms) → when the top finding happens more than once per step, the row shows its own time. (`ui/src/model.ts` `treeRowMs`; tests in `ui/src/model.test.ts` and `ui/src/card.test.tsx`)
8. **No hoisting advice for literals that use nothing from the component.** "Wrap it in useMemo" → "move it outside, to the top of the file: `const COLUMNS = ['name', 'email', 'role'];`, then pass `columns={COLUMNS}`. Wrapping it in useMemo also works: …". The same applies to `LABELS` in pricing-toggle; this is what both fixed files do. Review fix 1 tightened when this advice is given.
9. **A function declared with `function name() {}` and passed by name had no fix code and no pointer to its declaration.** Now the finding says it's declared at `TodoApp.tsx:9`, gives `const handleToggle = useCallback((id: number) => { … }, []);`, and says why the list can stay empty: it only calls `setTodos`, with an updater.
10. **pricing-toggle's two costs looked like they add up** (27 + 14 ms against a 27.6 ms click). Rule 2's text now ends with "Its extra update also re-renders FeatureMatrix (finding 1) for nothing, so part of its time is the same waste: don't add the two up." It only names findings that are listed. The headline still names only the top finding. (`src/analyzer/index.ts` `noteOverlaps`; also tested in `analyze.test.ts`)
11. **Wording.** The subline said "An update feels smooth when an update fits…" → "A step feels instant when an update fits…". todo-toggle's caption said "played 3 actions in TodoApp" next to "6 steps" → "typed “milk” and clicked 2 times in TodoApp". (`src/analyzer/words.ts`; test in `words.test.ts`)

I found no recorder bugs in the code (but see the React 18 flake at the end).

## Review fixes

A fresh-eyes review of this branch found these. All are fixed, with tests.

1. **Hoisting advice for values that read component data (critical).** `items.map((item) => <Row style={{ color: item.color }} />)` was told "move it outside: `const STYLE = { color: item.color };`", and so was a value that read state inside a render helper. Now hoisting is decided by scope: a value is moved out only if it reads nothing declared in any function around it (parameters, variables, local functions, a `.map` item) and doesn't use `this`. useMemo/useCallback code is only offered in a component's or custom hook's own body, never inside a callback, and local functions count as dependencies. (`src/analyzer/source.ts` `canHoist`, `inComponentBody`, `dependenciesOf`; tests in `source.test.ts` and `analyze.test.ts`.) user-table and pricing-toggle still get the hoisting advice.
2. **The golden test could skip its commit-index checks silently.** Now, if run 1's update count differs from EXPECTED.md, the test records once more, then fails with "run 1 recorded N updates, EXPECTED.md has M: recorder flake".
3. **Comments stated the flake's cause as fact.** They now say only what was seen: one run recorded one more update.
4. **cart-summary's card pointed at the wrong component.** The headline is about CartSummary, but the only warning dot in the tree was "CartLine × 2 · nothing changed", and EXPECTED.md says CartLine must not be reported. Now, when rule 2 is the main problem, the tree keeps that component's row. The card adds "Then sets its own state in an effect: 1 extra update" to it, with the warning dot, and "nothing changed" rows get the neutral dot. Trees whose main problem is rule 1 (laggy-search, pricing-toggle) are unchanged. (`src/analyzer/tree.ts` `focus`; `ui/src/parts.tsx` `Tree`; tests in `ui/src/card.test.tsx`.)
5. **Nits:**
   - The dependency note now says what the function actually reads (bug 9).
   - The step subline no longer repeats "smooth".
   - The overlap note (bug 10) is added at the end of the text instead of being inserted before a fixed phrase, so it no longer depends on the exact wording.
   - Each fixed variant's `$comment` in expected.json says its empty `report` and the comparison come from EXPECTED.md's "After the fix" section.
   - The screenshot clean-up regex in `scripts/card-screenshots.mjs` is fixed, so stale screenshots are deleted.
6. **Your decision, applied:** with no findings, the text result now starts "No main problem found: …" instead of "No problem passed the thresholds".

## Open cases

You decided to keep these as they are: rule 2 points at the effect line (1), there's no `hoist` fix kind (3), the no-findings wording (4, now changed as above), and laggy-search's re-run says "Fixed." (5). Case 2 is still open.

1. **Which line rule 2 points at.** EXPECTED.md for cart-summary and pricing-toggle says "at `:28` (the setter is on line 29)". I read that as the effect's line and changed the tool to match (bug 1). laggy-search is the same either way, because its effect fits on one line.
2. **todo-toggle: the JSX line or the declaration line?** EXPECTED.md makes `TodoApp.tsx:29`, where the prop is passed, the main location, and the tool follows it. But for `const handleToggle = (id) => {…}` (an arrow assigned to a const) the tool has always pointed at the declaration line, where the value is created. Both are the same mistake, so they should point at the same kind of line. My recommendation: make the main location the line where the value is created (`:9`) and keep the JSX line in the text. That means changing EXPECTED.md, so it's your call.
3. **There's no fix kind for "move it out of the component".** user-table and pricing-toggle report `fix: useMemo` although the text recommends hoisting first. A new `FixKind` value (`'hoist'`) would change the shared output types.
4. **What theme-storefront says.** EXPECTED.md: "The text result should say that no main problem was found." The text result now starts "No main problem found: …".
5. **laggy-search's re-run says "Fixed." while SearchBox's rule 2 is still there.** That's the card's rule in `ui/src/model.ts`: "Fixed" means the top finding is resolved. The "Still there" line shows below it.
6. **"Must NOT be reported" items the expected.json format can't express.** These are todo-toggle's clicked row (Task 3, commit 5) and new row (Task 101, commit 6). The finding legitimately includes those updates for the other rows, so a `commit` entry can't single out one row. The unit test checks the count instead: 99 rows on the toggle click, and the new row isn't counted.
7. **cart-summary's text counts the 2 mount follow-ups as "later (timers or other non-input updates)".** That's accurate ("other"), but a reader may look for a timer. Low priority.

## Wording a junior could trip over

- **"(memo)" and "100 × TodoItem (memo) re-render"** assume the reader knows `memo`. The "Why does it happen?" text explains it, but the headline doesn't.
- **"twice"** (pricing-toggle) means "in both updates of one click". Without rule 2's text next to it, a junior may not know why there are two updates. The two findings explain each other only when read together.
- **cart-summary's headline is a 0.5 ms problem on a click that takes 1.4 ms and "should feel smooth".** It's correct by the spec (rule 2 has no time threshold), but a junior may ask why it matters. The why text answers it: "two updates where one would do".
- **"step"** (todo-toggle mixes typing and clicks) is the least concrete unit. The caption says what was done, but the tree title is still "What one step does".

## Not fixed (outside this task)

- In theme-storefront's tree data, the ProductCard ×40 row holds 7.9 ms, more than its parent ProductGrid's 6.8 ms, because 40 rounded per-card medians are summed. The card only shows times on "memo couldn't skip it" rows, so nobody sees it today.
- **A recorder flake on React 18, not caused by this branch.** In 2 of 3 full golden runs on React 18.3.1, one of the three runs recorded one more update: cart-summary had 16 instead of 15, laggy-search 13 instead of 12. That made `fixtures.golden.test.ts` fail with "Run N recorded 16 commits, run 1 recorded 15". The third run passed, and React 19.3.1 passed 3 times in a row. When run 1 is the odd one, the analyzer's findings are still right, but the update numbers move by one. The analyzer golden test then records once more and fails loudly if it happens again. A unit test covers that recording shape. Nobody has looked at what the extra update is yet; the recorder needs a look.

# cart-summary: candidate notes

Not an EXPECTED.md: the counts below are worked out by hand and must be replaced by recorder output.

## What it does

A three-line shopping cart with +/− buttons, where the summary copies the cart total into state from an effect and then fetches a (fake, network-free) shipping quote for that total.

## Origin

The first rule-2 example in React's "You Might Not Need an Effect", "Updating state based on props or state" (https://react.dev/learn/you-might-not-need-an-effect#updating-state-based-on-props-or-state): `useEffect(() => setFullName(...), [...])`. `useShippingQuote` is the "Fetching data" pattern from the same page (https://react.dev/learn/you-might-not-need-an-effect#fetching-data), with an `ignore` flag and the setter inside `.then`. The page names that pattern as a legitimate effect. The cart itself is synthesised from that pattern; it is not copied from a repo.

## Rule it should trigger

**Rule 2 only.** `CartSummary` calls `setTotal(...)` synchronously in `useEffect` at `CartSummary.tsx:28-30` (the setter is on line 29). Every click causes one extra commit in which only CartSummary renders (≈ 0.3 ms busy-wait). It happens on 4 of 4 steps.

Fix: `const total = items.reduce(...)` during render (`CartSummary.fixed.tsx`). React Compiler doesn't fix this.

What this adds: rule 2 driven by **clicks**, not typing. It also tests the **source-confirm step**, because a second follow-up commit comes from a setter inside a custom hook's `.then`. The runtime check alone flags both.

## Must NOT be reported

- **`useShippingQuote`'s `setQuote`** (`CartSummary.tsx:17`). Its commit looks like rule 2 at runtime: a follow-up commit with no input before it, CartSummary's own state changed, and CartSummary rendered in the previous commit. The source check must reject it because the setter runs inside `.then`, not synchronously. Mapping the hook index needs the custom-hook expansion from §7. CartSummary's hook order is `useState(total)` #0, `useEffect` #1, then `useShippingQuote`'s `useState(quote)` #2 and `useEffect` #3. Commit B changes #0 (report it); commit C changes #2 (ignore it). The "fall back to the only synchronous setter" rule must **not** fire for commit C, because the mapping is unambiguous. Otherwise commit C would be counted as rule-2 cost under `setTotal`.
- **Rule 1**: nothing is memoised. `CartLine` gets a new `onChange` function every render, but without `memo` that is not rule 1 and must stay silent.
- **`CartLine` renders**: each input commit re-renders all 3 lines, but only one line's `item` changed. They are cheap (<< 1 ms) and not memoised, so no finding.

## Expected commits (hand-reasoned)

Per click (the event is discrete, so React 18+ flushes the passive effects synchronously; see the React 18 changelog, "Consistent useEffect timing", https://github.com/facebook/react/blob/main/CHANGELOG.md#1800-march-29-2022):

| Commit | Trigger | What renders |
|---|---|---|
| A | input (click) | Cart, CartLine ×3, CartSummary (shows the **old** total) |
| B | follow-up (sync, `setTotal`) | CartSummary only: hook #0 changes, e.g. 100.00 → 139.00 |
| C | follow-up (microtask, `.then` → `setQuote`) | CartSummary only: hook #2 changes, e.g. 5.00 → 6.95 |

Totals and quotes per step: 139.00 / 6.95, 178.00 / 8.90, 153.50 / 7.68, 165.50 / 8.28. Every quote differs, so commit C always happens.

Mount: commit 0 renders everything, then 1–2 follow-up commits. The total goes 0 → 100 and the quote null → 5.00, and the first quote may be batched with the total because mount effects are passive and not flushed synchronously. Mount isn't a step; the recorder will decide the exact count.

Interaction total: 4 steps × 3 commits = 12 commits after mount. Renders after mount: Cart 4, CartLine 12, CartSummary 12.

After the fix: 2 commits per step (A, then C). Rule 2 is resolved, and commits per step drop from 3 to 2, so the comparison should show "1 fewer update per click", not "no follow-ups".

## Open questions

- Commit C is scheduled outside the click task. If the recorder's "follow-up" window is time-based, check that C still lands in the same step and doesn't become "later".
- With `ignore`, a quote that resolves after the next click is dropped. With 150 ms waits that never happens here.

## Recorder results (2026-11-09)

Recorded with the Phase 1 recorder on React 19.3.1 and 18.3.1, 3 runs each: the per-click shape above (input, setTotal follow-up, setQuote follow-up) matches exactly. Mount gives exactly 2 follow-up commits on both versions: the first batches `total` 0 → 100 with `quote` null → 0 (the quote for the initial total of 0), the second sets `quote` 0 → 5. So CartSummary renders 14 times after mount, not 12. The setQuote commit is labelled follow-up in almost every run (once `later`) and always stays inside its click's step. See EXPECTED.md.

**Changed:** added `Cart.fixed.tsx`, a copy of `Cart.tsx` that imports `./CartSummary.fixed`. The recorder mounts the entry file's default export, and `CartSummary.fixed.tsx` only exports the named `CartSummary`, so it couldn't be recorded as the fixed variant on its own. After the fix: 10 commits, CartSummary 9 renders after mount.

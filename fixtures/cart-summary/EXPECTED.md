# Cart summary: expected results

A golden test for rule 2 driven by clicks, with a legitimate look-alike. A three-line shopping cart with +/− buttons: `CartSummary` copies the cart total into state from an effect, then fetches a (fake, network-free) shipping quote for that total in a custom hook.

Verified on 2026-11-09 with the Phase 1 recorder on React 19.3.1 and 18.3.1. Both versions gave identical commit counts, identical across 3 runs each.
Numbers produced by the recorder; the owner still checks each finding by hand in React DevTools (HANDOFF §9 Phase 2).

## The interaction (`test.json`)

Click "Add one Yoga mat" twice, "Remove one Foam roller" once and "Add one Resistance band" once, waiting 150 ms after each click. `quoteShipping` returns a resolved promise, so each quote lands one microtask after the effect that asked for it.

## Commits: these must match exactly

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | Everything: Cart, CartLine ×3, CartSummary |
| 1 | follow-up (after mount) | CartSummary only: `total` (hook #0) 0 → 100 and `quote` (hook #2) null → 0, batched |
| 2 | follow-up (after mount) | CartSummary only: `quote` (hook #2) 0 → 5 |
| 3, 6, 9, 12 | input (one per click) | Cart, CartLine ×3, CartSummary (`items` changed; it still shows the **old** total) |
| 4, 7, 10, 13 | follow-up (right after each click) | CartSummary only: `total` (hook #0) changes, 100 → 139 → 178 → 153.5 → 165.5 |
| 5, 8, 11, 14 | follow-up (one microtask later) | CartSummary only: `quote` (hook #2) changes, 5 → 6.95 → 8.9 → 7.68 → 8.28 |

Renders after mount: Cart 4, CartLine 12, CartSummary 14.

The trigger heuristic occasionally labels one of these follow-up commits `later` (seen once in 9 React 19 runs, on commit 4); only "not input" is asserted for them.

**After the fix** (`Cart.fixed.tsx`, which imports `CartSummary.fixed.tsx`: `const total = items.reduce(...)` during render): 10 commits. Mount, then one follow-up (`quote` null → 5); then per click an input commit (Cart, CartLine ×3, CartSummary) and one follow-up (CartSummary, the quote). Commits per click drop from 3 to 2, not to 1. Renders after mount: Cart 4, CartLine 12, CartSummary 9.

## Timings (depend on the machine; for orientation only)

On the Windows 11 dev machine used for verification (installed Chrome, headless):

- Input commits: median 0.45–0.5 ms before and after the fix (single commits 0.3–0.7 ms).
- Follow-up commits: 0.3–0.7 ms each. Mount: 1.9–3.4 ms.

`CartSummary` busy-waits 0.3 ms on purpose, so each extra commit costs real time. Chrome's timer resolution here is about 0.1 ms, so treat differences smaller than that as noise.

## Findings the analyzer must report

1. **Rule 2: state set inside an effect.** `CartSummary` copies a derived value into state with `useEffect(() => setTotal(items.reduce(...)), [items])` at `CartSummary.tsx:28` (the setter is on line 29). Cost: one extra commit per click (4 of 4 steps), about 0.3–0.5 ms each. Fix: `const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);` during render, as in `CartSummary.fixed.tsx`. React Compiler doesn't fix this one.

## Must NOT be reported

- **`useShippingQuote`'s `setQuote`** (`CartSummary.tsx:17`) and its commits 5, 8, 11 and 14. At runtime they look like rule 2: a follow-up commit with no input before it, CartSummary's own state changed, and CartSummary rendered in the previous commit. The source check must reject it: the setter runs inside `.then`, not synchronously in the effect. CartSummary's hook order is `useState(total)` #0, `useEffect` #1, then, through the custom hook, `useState(quote)` #2 and `useEffect` #3. Commits 4, 7, 10 and 13 change #0 (report it); commits 5, 8, 11 and 14 change #2 (ignore it). The "only synchronous setter" fallback must **not** fire for #2, because the mapping is unambiguous; otherwise those commits would be counted as rule-2 cost under `setTotal`.
- **The mount follow-ups (commits 1 and 2)**: mount isn't a step. Commit 1 changes #0 and #2 together; it is the same `setTotal` problem, but rule 2 is measured per step.
- **Rule 1**: nothing is memoised. `CartLine` gets a new `onChange` function every render, but without `memo` that isn't rule 1.
- **CartLine renders**: each input commit re-renders all 3 lines though only one line's `item` changed. They are cheap (well under 1 ms) and not memoised, so no finding.

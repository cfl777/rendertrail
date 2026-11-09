# pricing-toggle: candidate notes

Not an EXPECTED.md: the counts below are worked out by hand and must be replaced by recorder output.

## What it does

A pricing page with a Monthly/Yearly toggle, three plan cards and an 80-row feature matrix. Each toggle derives the discount in an effect, so the page renders twice, and the memoised matrix re-renders both times because its `labels` object is new on every render.

## Origin

Synthesised from two well-known anti-patterns stacked in one component:
- Derived state in an effect: "Updating state based on props or state" and "Chains of computations" (https://react.dev/learn/you-might-not-need-an-effect#chains-of-computations). The page warns that each `set` in an effect costs an extra render pass for the whole tree below.
- An inline object literal passed to a memo child: "Minimizing props changes" (https://react.dev/reference/react/memo#minimizing-props-changes) and eslint-plugin-react-perf `jsx-no-new-object-as-prop` (https://github.com/cvazac/eslint-plugin-react-perf).

No concrete open-source repo was found that has exactly this combination; the pricing-toggle form is a common marketing-page widget.

## Rules it should trigger

1. **Rule 1, prop type: object.** `FeatureMatrix` (memo) gets `labels={{ included: 'Included', missing: 'Not included' }}`. The element starts at `PricingPage.tsx:23` and the attribute is on line 26 (multi-line JSX, like laggy-search). `features` and `plans` are module constants and stay stable. Waste: FeatureMatrix + 80 × FeatureRow (≈ 0.1 ms each) in **both** commits of every step, ≈ 8 ms × 2 = 16 ms per click.
2. **Rule 2.** `PricingPage` calls `setDiscount(...)` synchronously in `useEffect` (`PricingPage.tsx:8-10`, setter on line 9). One extra commit per click, 4 of 4 steps. That commit costs a lot, about 8 ms, **because of** rule 1: it re-renders the matrix again.

Fixes: `const discount = billing === 'yearly' ? 0.2 : 0;` during render, and hoist `labels` to a module constant (`PricingPage.fixed.tsx`). `useMemo(() => ({…}), [])` would also work for `labels`. React Compiler would fix `labels`, but not the effect.

What this adds beyond laggy-search: the two rules **interact**. In laggy-search the rule-2 follow-up commit renders only SearchBox (about 0.1 ms). Here it re-renders the page root, so the follow-up commit carries rule-1 waste. This tests that:
- rule 1 counts waste across **all** commits of a step (input + follow-up), not only the input commit;
- the headline does not add rule 1's waste and rule 2's cost together into a misleading "32 ms wasted" (they overlap by ≈ 8 ms);
- the fix order matters, and the comparison has to show partial fixes properly. Fixing only `labels` gives 2 cheap commits per step; fixing only the effect gives 1 commit with ≈ 8 ms waste.

## Must NOT be reported

- **`PlanCard` ×3** re-render in both commits because `price` changed by value: needed. The follow-up render exists only because of rule 2 and shows a wrong price for one update (e.g. Team 948 → 758), but PlanCard itself is not to blame.
- **`FeatureRow` as its own finding**: it is not memoised and is part of FeatureMatrix's cost.
- **Mount**: the effect runs once and sets `discount` to 0, which already is its value, so React bails out and there is no follow-up commit after mount. If the recorder does show an extra render here, it has no state change and must not count as rule 2.
- **The button's inline `onClick`**: a DOM element.

## Expected commits (hand-reasoned)

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | PricingPage, PlanCard ×3, FeatureMatrix, FeatureRow ×80 |
| 1, 3, 5, 7 | input (click) | PricingPage, PlanCard ×3 (needed), FeatureMatrix + FeatureRow ×80 (wasted) |
| 2, 4, 6, 8 | follow-up (`setDiscount`) | PricingPage, PlanCard ×3 (needed), FeatureMatrix + FeatureRow ×80 (wasted) |

Prices for Solo/Team/Studio: monthly 18/79/149. After click 1: 216/948/1788 (input), then 173/758/1430 (follow-up). After click 2: 14/63/119, then 18/79/149. Every follow-up changes every price.

Renders after mount: PricingPage 8, PlanCard 24, FeatureMatrix 8, FeatureRow 640.

After the fix: 4 commits, one per click, each rendering PricingPage and PlanCard ×3; FeatureMatrix 0, FeatureRow 0.

## Open questions

- Ranking: by §7 rule 1 (≈ 16 ms/step) outranks rule 2. Should the card say that fixing rule 2 also halves rule 1's waste? Analyzer decision.

## Recorder results (2026-11-09)

Recorded with the Phase 1 recorder on React 19.3.1 and 18.3.1, 3 runs each: the commit shapes above match exactly, including no follow-up after mount, and so does the fixed variant. No changes to the draft. Each commit costs about 14 ms here, not 8 ms (timer rounding stretches each 0.1 ms wait to about 0.17 ms). See EXPECTED.md.

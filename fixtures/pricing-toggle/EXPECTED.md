# Pricing toggle: expected results

A golden test where rules 1 and 2 **interact**. A pricing page with a Monthly/Yearly toggle, three plan cards and an 80-row feature matrix: each toggle derives the discount in an effect, so the page renders twice, and the memoised matrix re-renders both times because its `labels` object is new on every render.

Verified on 2026-11-09 with the Phase 1 recorder on React 19.3.1 and 18.3.1. Both versions gave identical commit counts, identical across 3 runs each.
Numbers produced by the recorder; the owner still checks each finding by hand in React DevTools (HANDOFF §9 Phase 2).

## The interaction (`test.json`)

Click "Toggle yearly billing" 4 times, waiting 150 ms after each click: monthly → yearly → monthly → yearly → monthly.

## Commits: these must match exactly

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | Everything: PricingPage, PlanCard ×3, FeatureMatrix, FeatureRow ×80 |
| 1, 3, 5, 7 | input (one per click) | PricingPage (`billing` changed), PlanCard ×3 (`price` changed), FeatureMatrix (`labels` new reference, same value), FeatureRow ×80 |
| 2, 4, 6, 8 | follow-up (right after each click) | PricingPage (`discount` 0 → 0.2 or 0.2 → 0), PlanCard ×3 (`price` changed), FeatureMatrix (`labels` new reference, same value), FeatureRow ×80 |

Renders after mount: PricingPage 8, PlanCard 24, FeatureMatrix 8, FeatureRow 640.

There is no follow-up commit after mount: the effect sets `discount` to 0, which it already is, so React bails out.

**After the fix** (`PricingPage.fixed.tsx`: `discount` computed during render and `labels` hoisted to the module constant `LABELS`): 5 commits, mount plus one input commit per click rendering PricingPage and PlanCard ×3. FeatureMatrix and FeatureRow render 0 times after mount.

## Timings (depend on the machine; for orientation only)

On the Windows 11 dev machine used for verification (installed Chrome, headless):

- Input commits: median 13.8 ms (React 19) and 13.95 ms (React 18) before the fix, single commits 13.5–16.5 ms; 0.1 ms after.
- Follow-up commits: 13.3–16.7 ms each, as expensive as the input commits because they re-render the matrix too. Mount: 15.3–19.9 ms.

`FeatureRow` busy-waits 0.1 ms on purpose (about 0.17 ms per row with timer rounding). Chrome's timer resolution here is about 0.1 ms, so treat differences smaller than that as noise.

## Findings the analyzer must report

1. **Rule 1: an unstable prop breaks memo.** `FeatureMatrix` gets a new `labels` object on every render with the same contents, created at `PricingPage.tsx:26` (`labels={{ included: 'Included', missing: 'Not included' }}`, in the `<FeatureMatrix` element that starts on line 23). Waste: FeatureMatrix plus 80 FeatureRow renders in **both** commits of each of the 4 clicks, about 2 × 14 ms per click here. Fix: move `labels` out of the component (as in `PricingPage.fixed.tsx`) or `useMemo`. React Compiler would also fix this automatically.
2. **Rule 2: state set inside an effect.** `PricingPage` derives `discount` with `useEffect(() => setDiscount(billing === 'yearly' ? 0.2 : 0), [billing])` at `PricingPage.tsx:8` (the setter is on line 9). Cost: one extra commit per click (4 of 4 steps), about 14 ms each here, because that commit re-renders the matrix again (rule 1). The headline must not add the two costs together: they overlap in the follow-up commit's matrix render. Fix: `const discount = billing === 'yearly' ? 0.2 : 0;`. React Compiler doesn't fix this one.

## Must NOT be reported

- **PlanCard ×3** re-render in both commits of a click because `price` changed by value: needed. The follow-up render exists only because of rule 2, but PlanCard itself isn't to blame.
- **FeatureRow as its own finding**: it isn't memoised and is part of FeatureMatrix's cost.
- **Mount**: there is no follow-up commit after mount, so there is nothing to report there.
- **The button's inline `onClick`**: a DOM element.

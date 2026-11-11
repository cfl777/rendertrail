# theme-storefront: candidate notes (negative / decoy fixture)

Draft notes kept for provenance. EXPECTED.md and expected.json hold the recorder-verified counts; the sections below are the hand reasoning that preceded them.

## What it does

A storefront with a light/dark toggle, where a memoised product grid and its 40 memoised cards re-render on every toggle because they read the theme from context. The grid also happens to receive an inline `layout` object.

## Origin

React docs, "Updating a memoized component using a context": "Even when a component is memoized, it will still re-render when a context that it's using changes" (https://react.dev/reference/react/memo#updating-a-memoized-component-using-a-context). Theme context is the standard example in the React docs (https://react.dev/learn/passing-data-deeply-with-context). The trap, an unstable prop on a component that context re-renders anyway, is synthesised. It mirrors the "ResultsList in commit 11" decoy in laggy-search, with context instead of `items` as the real reason.

## Rule it should trigger

**None.** This is the §6 "Context" to-do as a golden test. A recorder that doesn't read `fiber.dependencies` sees `ProductGrid` (memo) re-render with exactly one changed prop, `layout` (`Storefront.tsx:17`), which is a new object with the same contents. That looks like a textbook rule 1 hit. It isn't: ProductGrid's context (`ThemeContext`) changed in the same commit, and §7 rule 1 requires "its own state and context didn't change". Stabilising `layout` would save nothing here.

Expected analyzer output: no findings. The text result should say that no main problem was found. Per click ≈ 40 × 0.1 ms ≈ 4 ms, well under the 16.7 ms budget.

What this adds: the only fixture with **context**, and the only one where the correct answer is "nothing to fix". It guards against false positives, which hurt a junior-facing tool more than misses do.

## Must NOT be reported

- **`ProductGrid` / rule 1 on `layout`**: context changed, so the render is needed. Reporting it is the main failure this fixture exists to catch.
- **`ProductCard` ×40**: props identical (`product` comes from the module constant `PRODUCTS`), so `memo` would have skipped; they re-render only because they read `ThemeContext`, and their output (`data-theme`) changes. Needed. They must not be labelled "Re-rendered · nothing changed" or "memo couldn't skip it" in the card tree; the right label is "Re-rendered · needed".
- **`PromoBanner`**: memo holds (string prop, no context). It should show as "Skipped · memo worked".
- **The Provider value**: it is a string, so there is no unstable-context-value problem. That would be the later "context fan-out" rule (§11), not the MVP.
- **Rule 2**: there are no effects.

## Expected commits (hand-reasoned draft, before recording)

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | Storefront, PromoBanner, ProductGrid, ProductCard ×40 |
| 1, 2, 3, 4 | input (one per click) | Storefront, ProductGrid (context + `layout` by reference), ProductCard ×40 (context only). PromoBanner skipped. |

No follow-up or later commits. Renders after mount: Storefront 4, ProductGrid 4, ProductCard 160, PromoBanner 0.

There is no fixed version. A useful extra check: wrap `layout` in `useMemo` and re-run against this baseline. Render counts must be identical, which proves the prop never mattered.

## Open questions

- How should the recorder attribute ProductCard's render: as context changed, or as props same and still rendered? `fiber.dependencies` lists the contexts read; compare each `memoizedValue` against `fiber.alternate.dependencies`.
- A variant worth adding later: ProductGrid does **not** read context, only the cards do. ProductGrid then re-renders purely because of `layout` (a real rule-1 hit, though tiny), while the 40 cards re-render because of context. The waste must be ProductGrid's **self** time, not its `totalMs`, because the cards would have re-rendered anyway. That challenges the §7 cost definition ("totalMs … which includes everything below it").

## Recorder results (2026-11-09)

Recorded with the Phase 1 recorder on React 19.3.1 and 18.3.1, 3 runs each: the commit shapes above match exactly. The recorder notes ProductGrid as "layout changed (new reference, same value)" plus "context Context changed", and ProductCard as "context Context changed" only, so the context change is visible to the analyzer. The context has no displayName, so it shows as `Context`. No changes to the draft. One step costs about 7 ms here. See EXPECTED.md.

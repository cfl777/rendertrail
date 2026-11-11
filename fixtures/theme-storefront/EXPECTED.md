# Theme storefront: expected results

The negative golden test: the correct answer is "nothing to fix". A storefront with a light/dark toggle, where a memoised product grid and its 40 memoised cards re-render on every toggle because they read the theme from context. The grid also happens to receive an inline `layout` object, which looks like rule 1 but isn't.

Verified on 2026-11-09 with the Phase 1 recorder on React 19.3.1 and 18.3.1. Both versions gave identical commit counts, identical across 3 runs each.
Numbers produced by the recorder; the owner still checks each finding by hand in React DevTools (HANDOFF §9 Phase 2).

## The interaction (`test.json`)

Click "Toggle theme" 4 times, waiting 150 ms after each click: light → dark → light → dark → light. There are no effects, so every commit is an input commit.

## Commits: these must match exactly

| Commit | Trigger | What renders |
|---|---|---|
| 0 | mount | Everything: Storefront, PromoBanner, ProductGrid, ProductCard ×40 |
| 1, 2, 3, 4 | input (one per click) | Storefront (`theme` changed), ProductGrid (context changed, and `layout` new reference, same value), ProductCard ×40 (context changed only). PromoBanner does **not** render (its memo holds). |

Renders after mount: Storefront 4, PromoBanner 0, ProductGrid 4, ProductCard 160.

The context has no `displayName`, so the recorder calls it `Context` in its notes ("context Context changed").

There is no fixed version: nothing needs fixing. A useful extra check is to wrap `layout` in `useMemo` and re-run against this baseline; the render counts stay the same, which shows the prop never mattered.

## Timings (depend on the machine; for orientation only)

On the Windows 11 dev machine used for verification (installed Chrome, headless):

- Input commits: median 7.0 ms (React 19) and 7.2 ms (React 18), single commits 6.7–8.0 ms, well under the 16.7 ms frame budget.
- Mount: 8.1–11.6 ms.

`ProductCard` busy-waits 0.1 ms on purpose (about 0.17 ms per card with timer rounding). Chrome's timer resolution here is about 0.1 ms, so treat differences smaller than that as noise.

## Findings the analyzer must report

None. The text result should say that no main problem was found.

## Must NOT be reported

- **ProductGrid / rule 1 on `layout`** (`Storefront.tsx:17`, `layout={{ columns: 4, gap: 12 }}`): `layout` is a new object with the same contents on every render, but ProductGrid's context (`ThemeContext`) changed in the same commit, and rule 1 requires that the component's own state and context didn't change. Stabilising `layout` would save nothing. Reporting it is the main failure this fixture exists to catch.
- **ProductCard ×40**: its props are identical (`product` comes from the module constant `PRODUCTS`), but it reads `ThemeContext` and its output (`data-theme`) changes. Needed, not wasted.
- **PromoBanner**: its memo holds (a string prop, no context).
- **The Provider value**: it is a string, so there is no unstable context value.
- **Rule 2**: there are no effects.

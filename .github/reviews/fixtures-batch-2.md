# Review: fixtures-batch-2

Fresh-eyes review on 2026-11-09 by a read-only reviewer agent (no shell), followed by fixes in this branch.
Scope: the five new fixtures (todo-toggle, user-table, cart-summary, pricing-toggle, theme-storefront),
`fixtures/laggy-search/expected.json`, and `test/golden/fixtures.golden.test.ts` (replaces
`laggy-search.golden.test.ts`).

## Findings

1. **Should-fix — fixture discovery only asserted laggy-search.** A dropped or renamed `expected.json`
   would silently shrink the suite. Fixed: the test asserts the full list of shipped fixtures.
2. **Should-fix — malformed `expected.json` failed unclearly** (bare JSON error, `undefined` reads).
   Fixed: the file is validated with a Zod schema and rethrown with the fixture name; a missing variant
   throws a named error instead of a TypeError.
3. **Nit — `inputMedianMsRange` defaulted to unbounded.** Fixed: the field is required.
4. **Nit — timing floors sat exactly at the nominal busy-wait total.** Fixed: floors lowered to about
   60 % of nominal (todo 3, user-table 5, pricing 5, theme 2.5 ms). Ceilings unchanged.
5. **Nit — NOTES.md still called itself a draft to be replaced.** Fixed: wording now says the notes are
   provenance and EXPECTED.md holds the recorder-verified counts. Open-questions sections kept.
6. **Nit — `fixtures/**` is outside `tsconfig.json` `include`, so `strict` is not enforced on fixture
   components.** Predates this branch (laggy-search too); the recorder bundles fixtures with esbuild,
   which does not type-check. Left as is; noted for the owner.

Confirmed clean: laggy-search assertions unchanged in strictness; each laggy variant exhibits the
claimed rule and each fixed variant changes only that cause; no accidental rule 1 / rule 2 patterns;
EXPECTED.md and expected.json agree on every count; no `Math.random` / `Date.now`; selectors unique.

Resolved: items 1–5 fixed in this branch; item 6 deferred (pre-existing, owner's call).

# Review: analyzer-all-fixtures

Fresh-eyes review on 2026-11-23 by an Opus reviewer agent with a shell (typecheck, 222 unit tests,
one golden run on React 19; edge cases probed with scratch scripts against `src/analyzer`),
followed by fixes on this branch (b9025a8, f6c6761, eb45a50, b700f4f). Scope: the analyzer run on
all six fixtures, 11 analyzer/wording fixes, `findings` sections for the five fixtures that had
none, the golden and unit tests, harness results and screenshots, `docs/analyzer-on-all-fixtures.md`.

## Findings

Critical (fixed): "move it outside" advice was given for values that read component data, e.g.
`items.map((item) => <Row style={{ color: item.color }} />)` → `const STYLE = { color: item.color }`,
which breaks the code. Hoisting is now decided by scope (every binding between the value and the
file), useMemo/useCallback code is offered only in a component's own body, local function
declarations count as dependencies. Negative tests added.

Should-fix (fixed): the analyzer golden test silently skipped its commit-index checks when run 1's
update count differed (now: re-record once, then fail with a clear message); the flake's cause was
written into tests as fact (now: only what was observed); the cart-summary card painted CartLine as
the problem while the finding is CartSummary's effect (the rule-2 component's row now carries
"Then sets its own state in an effect: 1 extra update", and wasted rows go neutral when rule 2 is
the main problem).

Nits (fixed): dependency-note wording from what the function reads; step subline without
repetition; overlap note names only shown findings; `$comment` says the fixed-variant findings are
inferred from "After the fix"; screenshot clean-up regex.

Owner-decision items: theme-storefront's text now starts "No main problem found" (matches its
EXPECTED.md; "passed the thresholds" dropped as jargon). Kept as built and put to the owner: rule 2
points at the `useEffect(` line; todo-toggle stays at :29 with :9 in the text; no `hoist` fix kind;
laggy-search's re-run says "Fixed." (HANDOFF §8 uses exactly that).

Confirmed clean by the reviewer: no EXPECTED.md, CLAUDE.md, recorder or shared-type edits; analyzer
stays pure, no `any`; saved traces are real recorder output whose counts match EXPECTED.md; every
`findings` entry traces to an EXPECTED.md sentence; numbers agree across headline, text, bar and
tree; existing screenshots unchanged except the three named.

Not in this branch: the React 18 cart-summary nondeterminism (a fixture issue, owner decision) and
choosing the majority run instead of run 1 as the reference in the recorder.

Resolved: all nine review items fixed; typecheck, 232 unit tests, golden 42/42 on React 19.3.1 and
42/42 once on 18.3.1 green at b700f4f.

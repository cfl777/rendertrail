# Review: phase-1-recorder

Fresh-eyes review of Phase 1 (the recorder: `src/recorder/`, `inspect_render`, golden tests, CI)
against `HANDOFF.md` §5/§6/§7/§10 and `CLAUDE.md`, done 2026-11-09 by a read-only reviewer
subagent before the PR was opened. Phase 0's finding 3 (runtime deps in `dependencies`,
`createRequire` instead of `nodePaths`) is resolved in this branch.

## Findings

1. **Critical: the recorded page could still reach the network.** `page.route` did not cover popups
   (`window.open`, popup blocking is off in Playwright), WebSockets, service workers, WebRTC or DNS
   prefetch. Fix: `context.route` + `context.routeWebSocket` + `serviceWorkers: 'block'`, plus
   `--host-resolver-rules=MAP * ~NOTFOUND` and the WebRTC policy flags on both launch paths. A golden
   test starts a local HTTP server and asserts zero hits from fetch, WebSocket, `window.open`, an image
   and a service-worker registration. Each layer alone keeps the count at zero; with all removed, 6
   requests got through, so the test can fail.
2. **Stubbed components dropped their children**, so a stubbed provider or wrapper hid the whole app,
   and stubbed hooks returned null, so destructuring crashed. Fix: stubs render `props.children`; a
   `useX` stub returns another stub (iterable for array destructuring). Golden case added.
3. **Path aliases (`@/x`, `~/x`) and `.js`-suffixed TS imports were stubbed even when the file was
   sent.** Fix: alias resolution against the in-memory files and `.js → .ts/.tsx` mapping. Unit tests.
4. **`memo(Comp, compare)` and `memo(forwardRef(...))` were counted twice** (MemoComponent fiber plus
   inner fiber). Fix: skip the wrapper fiber, mark the child `memo: true`, take changedProps from the
   wrapper. Golden case added.
5. **No cap on commits or output size.** Fix: 500 commits max with `truncated: true` on the trace and
   summary types (schemaVersion 1); the text lists 40 commit lines then "… M more".
6. **Product name outside `src/brand.ts`** in virtual module ids and the fake origin. Fix: neutral ids
   (`virtual:entry`, `__entry__.tsx`, `http://recorder.local`).
7. **Trigger column not asserted** although EXPECTED.md says the table must match exactly. Fix:
   `mount` and `input` asserted exactly (they come from `inputSeq`, not timing); follow-up/later only
   asserted as not-input until Phase 2 replaces the 20 ms heuristic.
8. Small: `keydown` and `pointerdown` now count as input; a comment marks that Rule 1 must not trust
   source-text equality for functions (behaviour unchanged, Phase 2 decides).
9. The packaged path (`dist/instrument.js`, React resolved from `dist/`) was untested. Fix: a stdio
   smoke test calls `inspect_render` against `dist/server.js`; `test:golden` builds first.

Nothing to report on: zod schema matches §5 exactly, errors are returned not thrown, no `any` or
`@ts-ignore`, card copy avoids "commit"/"fiber", `expected.json` numbers all match EXPECTED.md,
React 18 swap in CI verified by `EXPECT_REACT_VERSION`, bippy pinned exactly.

Phase 2 notes (not fixed here): functions compared by source text read as "same value" even when a
captured variable changed; stubs are stand-ins and code that does arithmetic on stubbed data gets a
function, not a number.

Resolved: all nine findings fixed in commits bc8a677, 7db0587 and 2a205ca; 27 unit tests and 9 golden
tests green locally (golden suite 10/10 before the fixes, 3/3 after) and in CI run 42606826416 on
React 18.3.1 and 19.3.1; the Phase 2 notes are accepted as follow-ups and recorded above.

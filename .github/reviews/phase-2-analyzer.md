# Review: phase-2-analyzer

Fresh-eyes review on 2026-11-09 by an Opus reviewer agent with a shell (typecheck + unit tests run,
edge cases probed with scratch scripts against `src/analyzer`), followed by fixes on this branch
(commits eb1b1c9, bfaebb7, 169eaa9, 441a139). Scope: `src/analyzer`, `src/store`,
`src/server/inspect-render.ts`, `src/shared/types.ts`, the recorder's `parentIndex`, the golden
`findings` section and `test/golden/analyzer.golden.test.ts`.

## Findings

Should-fix (all fixed, each with a unit test):

1. Rule 1 subtree found by parent *name*: recursive/nested memo components pulled siblings into the
   subtree and nested hits were counted on top of their ancestor → recorder now emits `parentIndex`,
   subtree walked by index, nested hits of the same component skipped.
2. A prop passed through from the parent's props got "created at Mid.tsx:N … useMemo" → the value is
   followed up to 3 components to where it is created; otherwise "passed in from Mid's parent", no code.
3. React's name ≠ JSX tag (`memo(function List)`, default import under another name) lost the line or
   the finding → alias map (memo/forwardRef binding, default and `{ X as Y }` imports).
4. A setter returned from a custom hook under a new name was missed → hook return positions mapped
   to the caller's local names, caller's effects searched too.
5. `useReducer` dispatch in an effect produced a nonsense "compute s during render" fix → hook kind
   carried through, no code for reducers.
6. Rule 1 thresholded and ranked on the per-step *median with zeros*, which silently added a
   "> half the steps" gate §7 gives only to rule 2 → mean over all steps for threshold and rank;
   text shows the median over affected steps and the count ("on 2 of 5 clicks, about 40 ms each").
7. A fix that breaks the handler (0 steps) read as fully resolved → `Comparison.checked: false` with
   an explicit sentence.
8. A corrupt baseline file threw inside `compareRuns` and turned the whole result into "analysis
   failed" → run files validated with zod in `loadRun`; comparison has its own try/fallback.
9. Several JSX matches: first one taken blindly (could pick the memoized use) → inline > local > prop
   > other > memoized; other locations listed.
10. `Comparison.changedFiles` held paths only → `baselineFiles { path, content }` for the §8 toggle.

Nits (all fixed): finding id includes the prop (`unstable-prop:ResultsList:filters`); test helper
with file I/O moved out of `src/analyzer`; run-store messages (no baseline hint when saving failed,
prune failure not reported as unsaved, stale `.tmp` cleanup, `RENDERTRAIL_RUNS_DIR` must be
absolute); rule 2 cost split per component with known limitations documented; `typescript` loaded
lazily (`analyze()` async); docs for `RENDERTRAIL_RUNS_DIR` and `RT_SAVE_TRACES`; time-bar rest no
longer 0.

Noted, not changed: commits 63052ff, eb1b1c9, bfaebb7 and 169eaa9 do not type-check on their own
(types land before the code catches up); only the branch tip builds. Squash-merge recommended.

Confirmed clean by the reviewer: analyzer purity (no I/O, Date.now, Math.random, process.env,
logging; sorts and pushes on local copies); run id regex blocks path traversal; temp-file + rename
writes; `useDebounce`/`setDebounced` excluded; hook index arithmetic (`useContext` 0,
`useTransition` 2) matches the recorder; steps replace the 20 ms gap heuristic; text stands alone
and matches §5; React Compiler named for rule 1 only; `formatSummary` removal and `paths.ts`
re-exports clean.

Resolved: all 17 items fixed on this branch; typecheck, 64 unit tests and the golden suite (12/12,
3 runs in a row) green at 441a139.

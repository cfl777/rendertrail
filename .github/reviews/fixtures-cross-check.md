# Review: fixtures-cross-check

Reviewed 2026-11-13 by the orchestrating session. The branch adds a test script and one doc; no
shipped code changes.

## Checked

1. Ran `node scripts/cross-check-fixtures.mjs --runs 1` independently: 114/114 rows OK, exit 0.
2. Mutation check, so the script cannot pass vacuously: changed `ResultRow` 1050 → 1049 in
   `fixtures/laggy-search/expected.json`, ran `--fixture laggy-search`: the row, the per-update
   comparison and the totals all reported DIFF and the script exited 1. File restored.
3. Independence: the checker does not import `src/recorder/page/instrument.ts` or bippy. Renders are
   counted by a source transform (a counter call at the top of each component function); updates by
   React's public `<Profiler onRender>`.
4. The agent ran it 3× on React 19.3.1 and once on 18.3.1; no disagreement with any `expected.json`.

## Findings

- Noted: the per-finding claims are transcribed by hand from each EXPECTED.md into a `CLAIMS` table
  in the script; a changed EXPECTED.md needs that table updated.
- Noted: one unit test failed once in five `npm test` runs on the agent's machine and was not
  captured; unrelated to these files. To watch for in CI.
- Not wired into package.json or CI (package.json is being changed on the Phase 4 branch).

Resolved: no defects found; the two notes are accepted and listed in the PR body.

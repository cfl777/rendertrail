# Review: phase-0

Fresh-eyes review of the Phase 0 scaffold (package setup, MCP server with the temporary `hello`
tool, hello-world card, docs) against `HANDOFF.md` §4/§5/§8/§9 and `CLAUDE.md`, done 2026-11-09
by a read-only reviewer subagent before the PR was opened. `fixtures/`, `spike/` and `HANDOFF.md`
are imported as-is and were out of scope.

## Findings

1. **`--http` mode had no Host or Origin check (DNS rebinding).** `src/server/main.ts` only used
   the local-origin regex to decide whether to add CORS headers and never refused a request. A page
   on another site that re-points its DNS at 127.0.0.1 reaches the port same-origin. Harmless with
   `hello`, a real hole once `inspect_render` runs user code. Fix: `localhostHostValidation()` and
   `localhostOriginValidation()` from `@modelcontextprotocol/node` as the first line of the handler.
2. **Spike command in the docs was POSIX-only.** `RT_CHANNEL=chrome npm run record` fails in
   PowerShell, the owner's shell. Fix: PowerShell form added next to it in `CLAUDE.md` and `README.md`.
3. **Phase 1 note, not fixed here.** `build:server` uses `--packages=external`, so everything the
   recorder imports at runtime (`esbuild`, `react`, `react-dom`, `playwright-core`, exact-pinned
   `bippy`) must move to `dependencies` when it lands, and the spike's `nodePaths` lookup breaks once
   bundled into `dist/`; use `createRequire(import.meta.url).resolve(...)`. Also decide how CI records
   against React 18 without changing the card's React 19.

Nothing to report on: CLAUDE.md rule violations (name only in `src/brand.ts` and `package.json`, no
hard-coded structural colors, no "commit"/"fiber" wording, `schemaVersion` on the shared type), §8
items a hello-world should meet, TypeScript strictness, README/CLAUDE.md commands vs `package.json`.

Resolved: findings 1 and 2 fixed in this branch (guards added, PowerShell command documented, build and
stdio handshake re-run green); finding 3 accepted as a Phase 1 to-do and recorded here and in the PR.

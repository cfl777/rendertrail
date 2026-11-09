# Rendertrail

An open-source MCP App. It records how React components render in headless Chrome and explains the main performance problem in a card inside Claude. Read `HANDOFF.md` first: it's the source of truth for scope, decisions and the plan.

## Rules

- **The runtime records, the AI explains.** Every finding comes from a recorded trace and is computed in code. Never call a language model API from this project.
- **Everything runs on the user's machine.** The recorded page gets no network access. No telemetry unless the user opts in, and never any code or file names.
- **One place for the name.** The product name lives only in `src/brand.ts` and `package.json`.
- **Stay in scope.** The MVP scope is `HANDOFF.md` §3. Ask before building anything from "Not yet".
- **Golden tests.** `fixtures/*/EXPECTED.md` are golden tests. Render and commit counts must match exactly on React 18 and 19; timings only need to fall in a range. Never edit an EXPECTED.md to make a test pass without asking.
- **The text result stands alone.** It must make sense without the card, because Claude Code shows no UI.
- **The card follows `HANDOFF.md` §8.** Use the host's style variables, never hard-coded structural colors. Use plain words: no "commit" or "fiber" in the UI.
- **Version the shared types.** Keep tool input/output and trace types in `src/shared/types.ts`, versioned with `schemaVersion`.
- **Pin bippy.** It reads React internals, so check every upgrade against the fixtures.

## Stack

- TypeScript, ESM, Node 22.
- MCP server: `@modelcontextprotocol/server` v2 and `@modelcontextprotocol/ext-apps`.
- Recorder: esbuild, Playwright (`playwright-core` with the installed Chrome) and bippy 0.7.
- Card: React and Vite, built into a single HTML file.

## Commands

Fill these in during Phase 0: build, test, run the server, run the spike.

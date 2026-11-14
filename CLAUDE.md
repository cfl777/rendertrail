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

- Install: `npm install`
- Build: `npm run build` (type-checks, then builds the card to `dist/card.html`, the command to `dist/server.js`, the servers it starts to `dist/start.js` and the page instrumentation to `dist/instrument.js`)
- Type-check only: `npm run typecheck` (server, page instrumentation in `src/recorder/page/`, card)
- Unit tests: `npm test` (Vitest, no browser) — includes the card component tests (jsdom) in `ui/src/*.test.tsx`
- Card harness: `npm run dev:card` (http://127.0.0.1:5177/) renders the card in every state from saved real results in `ui/dev/results/`, with a state, theme and width picker; no host needed
- Regenerate the harness results from the saved traces: `npm run card:results` (`test/card-results.test.ts` fails when they are stale)
- Card screenshots for review: `npm run card:screenshots` (every state, light and dark, 400 and 720 px, into `.github/screenshots/phase-3/`; also fails on horizontal overflow at 320 px)
- Golden tests: `npm run test:golden` (builds first, then records `fixtures/` in a real browser: the installed Chrome, else Playwright's Chromium from `npx playwright-core install chromium`). Counts come from `fixtures/*/expected.json`, a machine-readable copy of `EXPECTED.md`; keep the two in step. To check React 18: `npm install --no-save react@18.3.1 react-dom@18.3.1`, run it, then `npm install` to go back. Also covered: network isolation of the recorded page, and a stdio smoke test of `dist/server.js`. CI runs both React versions.
- Regenerate the analyzer's unit-test traces (`test/fixtures/traces/`) from the real recorder: `RT_SAVE_TRACES=1 npm run test:golden`
- Runs are stored in `~/.rendertrail/runs` (the last 50). `RENDERTRAIL_RUNS_DIR` overrides the folder and must be an absolute path; both test configs point it at a temp folder.
- Package check: `npm run test:pack` (packs the npm tarball, installs it in a temp folder, runs `--version` and a stdio handshake: the package as a stranger gets it). `npm pack` builds first (`prepack`); the tarball holds only `dist/server.js`, `dist/start.js`, `dist/card.html`, `dist/instrument.js`.
- MCP Bundle: `npm run bundle` (builds, then `dist/rendertrail.mcpb` with `@anthropic-ai/mcpb`; on Windows it writes a Windows-only `dist/rendertrail-win32.mcpb`, so release bundles come from the CI artifact). `manifest.json` mirrors `package.json` and `src/brand.ts`; `test/package.test.ts` fails on drift. Check it with `npx mcpb validate manifest.json`.
- Demo GIF: `npm run demo:gif` (`docs/demo.gif` from the card harness; `RT_DEMO_FRAMES=<existing folder>` also saves PNG frames).
- Command line: `node dist/server.js --version | --help | --telemetry-status`.
- Anonymous counts: off by default and never sent. On with `RENDERTRAIL_TELEMETRY=1` or `{"telemetry": true}` in `~/.rendertrail/config.json`; `DO_NOT_TRACK=1` always turns them off; they live in `~/.rendertrail/counts.json`. Both test configs force them off. `test/no-network.test.ts` is a tripwire against outgoing network code.
- `examples/laggy-search` is a standalone app (its own `npm install`, not part of the root build) and must stay the same as `fixtures/laggy-search`; `test/example.test.ts` fails on drift.
- Runtime `dependencies` are pinned exactly (the published package has no lockfile); `test/package.test.ts` fails on a range.
- Run the server over stdio: `node dist/server.js` (`npm start`). This is what Claude Desktop and Claude Code launch.
- Run the server over HTTP for the ext-apps basic-host: `npm run start:http` (`http://127.0.0.1:3001/mcp`, `PORT` overrides)

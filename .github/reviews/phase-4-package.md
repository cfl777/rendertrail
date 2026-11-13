# Review: phase-4-package

Fresh-eyes review on 2026-11-13 by an Opus reviewer agent with a shell (typecheck, 153 unit tests and
the build run; the tarball packed, installed in a clean folder and exercised over stdio; the bundle
built and validated), followed by fixes on this branch (commits d96e541..cc577d5) and the CLAUDE.md
command list. Scope: the publishable npm package and CLI, the MCP Bundle, the README and demo GIF,
`examples/laggy-search`, and the opt-in counts.

## Findings

No critical findings. Should-fix (all fixed, a unit test per behavioural fix):

1. Privacy: only `RENDERTRAIL_TELEMETRY=0` turned counting off; `false`/`no`/`off` left it on when
   config.json said true. Now `0/false/no/off` = off, `1/true/yes/on` = on, anything else = off with
   an "unrecognised value" reason.
2. Runtime dependencies floated in the published package (a clean install pulled playwright-core
   1.65.1; React would float past the tested internals). All `dependencies` pinned exactly; a test
   fails on a range.
3. CI never tested the package as a stranger gets it. `npm run test:pack` packs, installs the
   tarball in a temp folder, checks `--version` and a stdio handshake; CI runs it. The missing
   instrumentation path now fails with a clear message and is not cached.
4. A Windows-built bundle is broken on macOS (exec bits) yet looked release-ready. Windows now
   writes `rendertrail-win32.mcpb` (win32 only); the Ubuntu CI job builds the real bundle and
   uploads it as a workflow artifact. Shell-less spawns (no DEP0190).
5. Bundle size: `.mcpbignore` trim (29.6 → 26.3 MB zipped for four platforms; 17.4 MB Windows-only).
   esbuild-wasm measured, not adopted (about 0.5 s slower on the first call, about 29 MB smaller).
6. README install: Windows `cmd /c npx` config, `claude mcp add --scope user`, a global-install
   option, and the note that `npx -y` checks the npm registry at launch.
7. README counts how-to: config.json as the reliable switch, env examples, and why a terminal
   `--telemetry-status` cannot see the env Claude gives the server.
8. README "Try it": how to get and open the example; one marked "Not published yet" line.
9. Network tripwire widened: import-level bans (net, tls, http2, dgram, dns, https, http outside
   `src/server/start.ts`, child_process, undici), the `fetch` identifier, and the built files
   including `dist/card.html` (Vite's module-preload polyfill, the one `fetch(` found, is off).

Nits (all fixed): counts temp-file name and cleanup, BOM in config.json, counting no longer awaited;
README Playwright version tested against package.json; manifest drift test covers more fields; fast
`--version` (the CLI is split into `dist/server.js` and `dist/start.js`); GIF caption no longer
overclaims; the example type-checks and builds in CI.

Left for the owner: no bundle icon; no minimum Claude Desktop version in the manifest; the
"one place for the name" rule in CLAUDE.md now has a guarded copy in manifest.json (rule text not
changed here); `npm-shrinkwrap.json` to lock transitive dependencies too.

Confirmed clean by the reviewer: counts off by default in every path, stored data limited to
schemaVersion, ISO week, runs, findings per rule and fixesChecked, no sending code; tarball `files`
exact and self-sufficient; bippy inlined in `dist/instrument.js`; LF shebang; stdout pure JSON-RPC
under `npx -y`; example standalone with matching line numbers; README limits match HANDOFF §3.

Resolved: all 15 review items fixed on this branch; typecheck, 179 unit tests, golden suite 28/28,
`npm run test:pack` and `npm run bundle` green at cc577d5. Nothing was published, tagged or released.

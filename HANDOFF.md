# Rendertrail: handover for the first MVP

> **Rendertrail** is the working name; it hasn't been cleared yet (§12).
> Written 2026-10-31, at the end of the idea and design phase. Nothing is built yet except the recorder spike in `spike/`, which was verified on React 18 and 19.
> This file is the source of truth for the MVP. `CLAUDE.md` has the standing rules for coding sessions.

## 1. What we're building

An open-source MCP App that shows a developer **why** a React component is slow, in words a junior developer understands.

Claude passes in a few component files and a short interaction, for example "type hello into the search box". Rendertrail runs them in headless Chrome and records every React render with real timings. It finds the main problem and shows it as a card inline in the chat: one sentence saying what's wrong, what it costs, which components re-rendered for nothing, and the exact line to change. After Claude applies a fix, the same interaction runs again and the card shows before and after.

**Why it's different.** Existing tools either record renders for a human to dig through (React DevTools Profiler, React Scan, React Render Tracker) or summarize traces for the AI (Chrome DevTools MCP, several React render MCP servers). None take you from "typing feels laggy" to the exact line, and none prove the fix with a re-run.

**The core principle: the runtime records, the AI explains.** Every number and finding comes from a real recording and is computed in code. Claude only explains the findings and writes the fix. This server never calls a language model.

## 2. Decisions so far

| Topic | Decision | Why |
|---|---|---|
| Shape | An MCP App: one tool plus an inline card | It shows up inside Claude, and the user's own Claude does the thinking and pays for it |
| First host | Claude Desktop | It renders MCP App cards and runs local servers |
| Claude Code | Supported, text only | Claude Code doesn't render MCP App UIs. The text result must make sense on its own; it's still a good fit for fix → re-run |
| Input | Snippets: files that Claude passes in, plus a scripted interaction | A controlled sandbox. Recording whole apps comes later |
| Where it runs | On the user's computer, via `npx` and an MCP Bundle | No hosting or AI costs for us, and code never leaves the machine |
| React versions | 18 and 19 | Both verified in the spike |
| Rules in the MVP | 2: an unstable prop breaks memo; state set inside an effect | Common real problems. React Compiler doesn't fix the second one |
| Card audience | Junior developers: one answer first, then they choose what to open | Decided at the design review |
| License | MIT, open source | Adoption first |
| Business (later) | Free local tool; paid pull-request checks for teams | §11 |

**Corrections to the canvas mockups**
- The MVP board says "Claude Desktop and Claude Code". Claude Code gets the text result only.
- Numbers in the mockups (17.7 ms, 204 renders) were made up for illustration. The real numbers for the same example are in `fixtures/laggy-search/EXPECTED.md`: about 20.5 ms per letter before the fix and about 0.1 ms after.

## 3. MVP scope

**In:**
- One tool, `inspect_render`, with the guided card
- `npx rendertrail` and a one-click MCP Bundle for Claude Desktop
- React 18 and 19, function components
- Rules 1 and 2 (§7)
- Re-run to check a fix, compared against an earlier run
- Runs stored locally

**Not yet:**
- The full inspector view (the "Core view" board on the canvas)
- Claude on the web and mobile (needs a hosted server)
- Pull-request checks
- Recording a whole app
- Rules for class components (they're still recorded)
- Other frameworks
- React Compiler mode

## 4. How it works

```
Claude ──(1) files + steps──▶ inspect_render   (MCP server on the user's computer)
                                   │ (2) bundle and run
                                   ▼
                               Recorder: esbuild → headless Chrome → bippy
                                   │ (3) trace
                                   ▼
                               Analyzer: rules, ranking, line lookup
                                   │ (4) findings
                                   ▼
                               Run store: one JSON file per run ◀──(5) baseline for re-runs
                                   │
Claude ◀──(6) text summary + structured data
  │
  └──(7) shows the card (MCP App view)
           └──(8) "Fix it and check" → message to Claude → Claude edits → inspect_render again with baselineRunId
```

**Parts**
- **MCP server.** Use `@modelcontextprotocol/server` (v2, not the v1 `@modelcontextprotocol/sdk`) with `registerAppTool` and `registerAppResource` from `@modelcontextprotocol/ext-apps/server`. The stdio transport comes from `@modelcontextprotocol/server/stdio`. These versions were checked on 2026-10-31: ext-apps 2.0.4, server 2.4.0, Node 20 or later.
- **Recorder.** Start from `spike/` (§6).
- **Analyzer.** Pure functions that take a trace and return findings. No browser is needed, so they're easy to unit test. Save traces from the spike (`--json`) as test inputs.
- **Run store.** `~/.rendertrail/runs/<runId>.json`, keeping the last 50. Each run stores the files, steps, trace summary and findings, so the card can show what changed between runs. Everything stays local.
- **Card.** React and Vite, built into a single HTML file with vite-plugin-singlefile (the same pattern as the ext-apps examples), served as `ui://rendertrail/card.html`.

**Suggested repo layout.** Adapt it to whatever the create-mcp-app scaffold generates.

```
rendertrail/
  src/brand.ts          product name and ids: the only place the name lives
  src/server/           MCP server, tool and resource registration
  src/recorder/         bundle → run → collect (grown from spike/)
  src/analyzer/         rules, ranking, line lookup, text summary
  src/store/            runs on disk, baseline comparison
  src/shared/types.ts   tool input/output and trace types, versioned (schemaVersion: 1)
  ui/                   the card (React + Vite single-file build)
  fixtures/             test components, each with an EXPECTED.md
  spike/                delete after Phase 1
```

## 5. Tool contract: `inspect_render` (proposal)

**Input** (zod 4):

```ts
const Step = z.discriminatedUnion('action', [
  z.object({ action: z.literal('type'), target: z.string(), text: z.string(), delayMs: z.number().int().min(0).max(1000).optional() }),
  z.object({ action: z.literal('click'), target: z.string() }),
  z.object({ action: z.literal('wait'), ms: z.number().int().min(0).max(5000) }),
]);

const InspectRenderInput = {
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1).max(30),
  entry: z.string(),                                   // file that exports the component to mount
  exportName: z.string().default('default'),
  props: z.record(z.string(), z.unknown()).optional(), // JSON props for that component
  steps: z.array(Step).min(1).max(20),                 // the interaction; targets are CSS selectors
  baselineRunId: z.string().optional(),                // compare with an earlier run
};
```

`fixtures/laggy-search/test.json` uses the same step format.

**Tool description.** Claude decides when to call the tool based on this description, so write it carefully. A starting point:

> Record how a React component renders while someone interacts with it, and explain the main performance problem. Use it when a React UI feels slow or re-renders too often. Pass only the files needed to render the component (replace data fetching with static data), the file to mount, and a short interaction, such as typing into an input. Returns the main problem, what it costs and the line to change. To check a fix, call it again with the changed files and `baselineRunId`.

**Output**
- **`content`**: text for Claude that makes sense on its own, because Claude Code shows nothing else. For the fixture:

  ```
  Typing "hello" (5 letters): 20.6 ms per letter, over the 16.7 ms frame budget.
  1. ResultsList (memo) re-renders with its 200 rows on every letter: prop `filters` is a new
     object each render with the same value, created at SearchPage.tsx:19. Wasted: about 20 ms
     per letter. Fix: wrap it in useMemo.
  2. SearchBox sets state inside useEffect (SearchBox.tsx:10): one extra update per letter.
     Fix: compute charCount during render.
  Run id: r_8f2k. To check a fix, call inspect_render again with the changed files and baselineRunId "r_8f2k".
  ```

- **`structuredContent`**: everything the card needs (§8), versioned as `{ schemaVersion: 1, run, findings, keystroke, comparison? }`.
- **`_meta.ui.resourceUri`**: `ui://rendertrail/card.html`, set through `registerAppTool`.
- **Errors** (the component doesn't render, a selector isn't found, a timeout): return a normal result that explains the problem and lists any stubbed imports, so Claude can fix the input. Don't throw.

## 6. Recorder: what the spike proved

These settings were verified on 2026-10-31 with React 19.3.1 and 18.3.1, bippy 0.7.3, esbuild 0.28.2 and Playwright 1.63:

1. **Bundle with esbuild.** Set `define: { 'process.env.NODE_ENV': '"production"' }` and mount with `createRoot` from `react-dom/profiling`. That gives production speed, and React still records `fiber.actualDuration` (the normal production build doesn't). Two settings are required:
   - `minifySyntax: true`. Without it, React logs a dead-code warning.
   - `keepNames: true`. Without it, esbuild renames `ResultsList` to `ResultsList2`.

   Resolve `react` from our own `node_modules` with `nodePaths`.
2. **Run in Playwright.** Use headless Chromium. `page.addInitScript` injects the bippy instrumentation before any page script, `page.route` serves the HTML and bundle from memory, and every other request is aborted.
3. **bippy 0.7 API.** The spike uses `instrument({ onCommitFiberRoot })`, `traverseRenderedFibers(root, (fiber, phase) => …)`, `isCompositeFiber`, `getDisplayName(getType(fiber.type))` and `getReactWorkTagsForFiber(fiber)` (for the memo tags). Version 0.7 has no timing or props helpers: self time is `actualDuration` minus the children's, and props and hooks are diffed against `fiber.alternate` by hand. See `spike/instrument.js`.
4. **Play the steps.** `locator(target).pressSequentially(text, { delay })`, `click()`, `waitForTimeout(ms)`.

**Phase 1 to-dos on top of the spike**
- **Stub unknown imports.** Use an esbuild plugin to stub anything that isn't in `files` and isn't `react` or `react-dom` (a harmless component or object proxy). List the stubs in the result so Claude can send the missing file. Ignore CSS imports.
- **Repeat runs.** Run each test 3 times in fresh pages and report the median time. Render counts must match across runs; if they don't, mark the result as unstable.
- **Limits.** 20 s per run, at most 30 files and 300 KB of source in total. Don't wrap the root in StrictMode, because double renders would distort the counts.
- **Browser.** Use `playwright-core` with the user's installed Chrome (`channel: 'chrome'`) to skip a roughly 150 MB download. Fall back to Playwright's Chromium, with a clear message on how to install it.
- **Context.** The spike doesn't track context yet. Read `fiber.dependencies` and compare context values, so a memo component that re-renders because of context isn't blamed on props.
- **Timer resolution.** It's about 0.1 ms in this setup; ignore differences smaller than that.

## 7. Analyzer: the two MVP rules

**Definitions**
- **One step of the interaction:** an `input` commit plus the follow-up commits right after it. For typing, that's one letter, and the card reports costs per letter.
- **Wasted render:** a component rendered, but its output couldn't have changed. Its props changed only by reference, its own state and context didn't change, and everything below it re-rendered only because of it.

**Rule 1: an unstable prop breaks memo**
- **Detect.** A memo component (`MemoComponent` or `SimpleMemoComponent` tag) re-renders, and every prop that changed has the same value: a new object, array or function with the same contents. Its own state and context didn't change.
- **Cost.** The component's `totalMs` in those commits, which includes everything below it, per step.
- **Line lookup.** Search the given files for the JSX element with that prop, for example `<ResultsList` with a `filters=` attribute, using the TypeScript compiler API (`ts.createSourceFile`, no type checking). One match is the line. With several matches, keep the ones inside components that rendered in the same commit. Don't use the fiber parent: in the fixture it's `Layout`, but the element is created in `SearchPage`. `_debugOwner` isn't available in production builds.
- **Fix text.** Depends on the prop type: `useMemo` for objects and arrays, `useCallback` for functions. Mention that React Compiler would do this automatically.
- **"Why" text for juniors.** "memo only skips a render when every prop is the same object as last time. `filters` looks the same, but it's a new object on every render."

**Rule 2: state set inside an effect**
- **Detect (runtime).** In a follow-up commit (right after another commit, with no input in between), a component's own state hook changed, and that component rendered in the previous commit.
- **Confirm (source).** That component has a `useEffect` or `useLayoutEffect` whose callback calls the state's setter *synchronously*: directly in the effect body, not inside `setTimeout`, `.then` or a handler. To match the changed hook index to its `useState` line, list the component's hook calls in order, expanding custom hooks from the given files; `useContext` doesn't add a hook. If that's ambiguous, fall back to the only setter called synchronously in an effect.
- **Replace the spike's 20 ms gap heuristic** with this runtime check plus source check. The fixture's `useDebounce` (a setter inside `setTimeout`) must not be flagged.
- **Cost.** Extra commits per step, plus their render time.
- **Fix text.** Compute it during render, for example `const charCount = value.length;`. React Compiler doesn't fix this one.

**Ranking and thresholds.** Keep these as constants in one file and tune them on real traces.
- Rule 1 counts if it wastes at least 1 ms per step. Rank it by wasted ms per step.
- Rule 2 counts if it happens on at least half of the steps.
- The card's headline is the top finding; the card shows at most 3 findings.
- Frame budget: 16.7 ms (one frame at 60 Hz).

**Comparison** (when `baselineRunId` is set): median ms per step and renders per step, before and after; findings resolved, still there, or new. If the steps differ from the baseline's, say so.

`fixtures/laggy-search/EXPECTED.md` lists what must be reported and what must **not** be.

## 8. The card

The "Guided card · inline in Claude" board on the canvas shows the design. It's the beginner version: one answer first, and the user decides what to open next.

**States**
1. **Receiving code.** Use `ontoolinputpartial` to show file chips and the code as it streams in. Treat this as optional, because not every host sends partial input.
2. **Recording.** A skeleton of the answer; Claude's guidelines prefer skeletons to spinners.
3. **Answer** (layout below).
4. **Comparison** (a re-run with a baseline): "Fixed. Each keystroke now takes 0.1 ms." Before and after bars, plus a "What changed in my code?" toggle that shows the diff between the two runs' files.
5. **Couldn't record.** What went wrong, and which imports were stubbed.

**Answer layout, top to bottom** (copy for the fixture)
- Caption: "Rendertrail · typed “hello” into SearchPage"
- Headline, one plain sentence: "Every letter you type re-renders 200 rows that didn't change."
- Subline: "Each keystroke takes 20.6 ms. Typing feels smooth when an update fits in one screen refresh (about 16.7 ms), so this feels laggy."
- A time bar (wasted vs everything else) with a 16.7 ms marker and a legend.
- "What one keystroke does": a tree of at most 5 rows. Labels: "Your state changed here", "Re-rendered · needed", "Re-rendered · memo couldn't skip it", "Re-rendered · nothing changed", "Skipped · memo worked". "Watch it again" replays the animation in the card.
- Toggle chips that open in place: "Why does it happen?", "Show me the line", "How do I fix it?"
- Main action: **Fix it and check**. It calls `app.sendMessage(...)` with "Fix it and check it again with the same typing." In Claude this puts the text in the message box for the user to send.
- No "Open full view" in the MVP, because the full view isn't part of it.

**Words.** Avoid "commit", "fiber", "reconciliation" and "effect cascade" in the card. Use "update", "re-render", "skipped" and "screen refresh".

**Claude checklist**, from Claude's MCP Apps docs (links in §14):
- Transparent `html, body` background, and `<meta name="color-scheme" content="light dark">`.
- On the resource: `_meta.ui.prefersBorder: false`, and `csp.resourceDomains: ['https://assets.claude.ai']` for the host font.
- Apply the host's theme, style variables and fonts with `useHostStyles` from `@modelcontextprotocol/ext-apps/react`. Never hard-code structural colors.
- Map our states to host tokens: wasted → warning, needed → info, fixed → success, skipped → tertiary text. Only the "origin" accent is our own color; define it for light and dark.
- Inline card: height fits the content, no inner scrolling, no menus or popovers, at most 2 actions at the bottom, about 4–5 data points.
- 44 px touch targets, WCAG AA contrast, works from 320 px wide, in light and dark.
- Optional: `app.updateModelContext(...)` when the user opens Why, the line or Fix, so Claude knows what they looked at.

## 9. Plan

About 9 weeks at 8–10 hours a week. This is a rough estimate. Don't start a phase until the previous one's "done when" is true.

**Phase 0: Set up (week 1)**
- You:
  - Finish the name check and reserve the names (§12).
  - Check your employment contract's side-work and IP clauses before publishing anything.
  - In Claude Code, install the MCP Apps skills: `/plugin marketplace add modelcontextprotocol/ext-apps`, then `/plugin install mcp-apps@modelcontextprotocol-ext-apps`.
- Dev:
  - Repo: TypeScript, ESM, Node 22, MIT license, `src/brand.ts`.
  - Scaffold the server and card with the create-mcp-app skill (React template).
  - A hello-world tool with a card. Connect it to Claude Desktop in `claude_desktop_config.json` (`"command": "node"`, `"args": ["<absolute path>/dist/server.js"]`), and to Claude Code with `claude mcp add rendertrail -- node <absolute path>/dist/server.js`.
  - To work on the card without Claude, use the reference host in the ext-apps repo (`examples/basic-host`).
  - Run the spike on your machine (`spike/README.md`).
- **Done when:** a test card shows up in a Claude Desktop chat, and the spike's numbers on your machine look like EXPECTED.md.

**Phase 1: Recorder (weeks 2–3)**
- Dev:
  - Move the spike into `src/recorder` and do the to-dos in §6.
  - `inspect_render` accepts the §5 input and returns a plain text summary of the trace.
  - CI runs the fixture on React 18 and 19.
- You: collect 5 small laggy components (from open source or other developers) as more fixtures, each with its own EXPECTED.md.
- **Done when:** laggy-search matches EXPECTED.md exactly on React 18 and 19, 10 runs in a row.

**Phase 2: Analyzer (weeks 4–5)**
- Dev: rules 1 and 2, line lookup, ranking, the text summary, the run store and the baseline comparison.
- You: check every finding by hand in React DevTools.
- **Done when:** the findings are right on every fixture, including everything under "Must NOT be reported".

**Phase 3: Card (weeks 6–7)**
- Dev: the 5 card states, theming, "Fix it and check", and "Copy for PR" (a short before/after summary to paste into a pull request).
- You: watch 3 junior developers use it without help, and note where they get stuck.
- **Done when:** a junior developer gets from "it's laggy" to a checked fix without asking you.

**Phase 4: Package and beta (week 8)**
- Dev:
  - Publish to npm (`npx rendertrail`).
  - Build the MCP Bundle with the `@anthropic-ai/mcpb` CLI (`mcpb init`, `mcpb pack`).
  - README with a 30-second demo GIF, and an example repo with the laggy search box.
  - Opt-in anonymous counts: runs, findings, fixes checked. No code and no file names.
- You: a private beta with 10–20 developers; fix their top 3 complaints.
- **Done when:** a stranger installs it and gets a result in under 5 minutes.

**Phase 5: Launch and learn (week 9)**
- You:
  - Launch on Show HN and r/reactjs, with a dev.to write-up and a short video.
  - A landing page with a waitlist for pull-request checks.
  - Talk to 5–10 teams about pull-request checks and what they'd pay.
- **Done when:** you have waitlist numbers and call notes to decide on the paid product.

## 10. Risks and how to handle them

| Risk | Handling |
|---|---|
| React internals change between versions | Pin bippy. CI on React 18 and 19; optionally a nightly run on React canary |
| Timings jump between runs | Run each test 3 times and take the median. Golden tests assert render and commit counts exactly, and timings only as rough ranges |
| Pasted files import things Claude didn't send | Stub them, and tell Claude which ones in the result |
| A roughly 150 MB browser download puts people off | Use the installed Chrome first |
| Running code someone else wrote | Headless Chrome's sandbox, no network, time limits. It runs on the user's own machine with code they chose to send |
| Claude Code shows no card | The text result must stand on its own (§5) |
| Host limits: inline height is capped and outside origins are blocked | The card only displays results; all the work happens in the server |
| Hosts handle streaming input differently | Treat the "receiving code" state as optional |
| React Compiler makes rule 1 less common | Lead with what the compiler can't fix as rules are added: effects, slow components, context |

## 11. Later (not the MVP)

- **Full inspector view:** the canvas "Core view", opened in fullscreen mode (`app.requestDisplayMode`, where the host supports it).
- **Hosted server for Claude on the web and mobile.** Each run needs a sandboxed browser. Cloudflare Browser Run costs $0.09 per browser hour after 10 free hours a month, roughly $0.00025 per 10-second run.
- **Paid pull-request checks for teams.** A GitHub Action replays the tests on every pull request and comments, for example "this PR adds 12 ms per keystroke in SearchBox", with history and limits that can fail the build. The model is Chromatic's: Storybook is free, and teams pay for the testing service. To keep this possible, version the trace format and keep the analyzer pure.
- **More rules:** context fan-out, unstable keys that cause remounts, expensive renders, layout thrashing.
- **Whole-app recording in Claude Code:** pass file paths instead of file contents.
- **React Compiler mode:** show what's left after the compiler runs.

## 12. Name status

Working name: **Rendertrail**. Checked on 2026-10-29:
- npm `rendertrail`: free. The GitHub org name looked free.
- rendertrail.com: registered in October 2025. What's on it is unknown, because the site blocks automated access.
- No product with the same name found, and no US trademark.
- **Still to do:** search TMview (tmdn.org/tmview) for "rendertrail" and "render trail" (EU, German and US marks), and open rendertrail.com in a browser. If both are clear, reserve rendertrail.dev, the GitHub org and the npm name (publish a 0.0.1 placeholder).
- **Rejected:**
  - **Renderwave:** "Render Wave by GeoTech" (renderwave.app) is a live tool for Unreal Engine render jobs.
  - **Fiberscope:** taken on npm.
  - **Whyrender:** npm already has `why-render`.

Keep the name only in `src/brand.ts` and `package.json`, so a rename stays a five-minute job.

## 13. Open questions for the dev session

Ask before deciding these:
- The final name (§12). Until it's settled, use `rendertrail` everywhere and keep it in `src/brand.ts`.
- One package or a workspace with separate packages for the server and the card. The suggestion is one package until Phase 4.
- How the card is styled: plain CSS with the host's variables is the suggestion, with no UI library.
- Which service collects the opt-in usage counts (Phase 4).

## 14. References

- **Canvas** with the mockups and the MVP boards (private to Tanya's Claude account): https://claude.ai/artifact/WHVHPn5XoLJ3jxBLbdnF5g
- MCP Apps SDK, examples and Claude Code skills: https://github.com/modelcontextprotocol/ext-apps
- MCP Apps API docs: https://apps.extensions.modelcontextprotocol.io/api/
- Claude, MCP Apps design guidelines: https://claude.com/docs/connectors/building/mcp-apps/design-guidelines
- Claude, matching Claude's theme: https://claude.com/docs/connectors/building/mcp-apps/transparent-theming
- Claude, MCP Bundles: https://claude.com/docs/connectors/building/mcpb
- bippy: https://github.com/aidenybai/bippy
- Prior art:
  - React Scan, which also uses bippy: https://github.com/aidenybai/react-scan
  - React Render Tracker, which introduced the "update wave" idea: https://github.com/lahmatiy/react-render-tracker
  - Chrome DevTools MCP, browser traces for agents: https://github.com/ChromeDevTools/chrome-devtools-mcp
- Cloudflare Browser Run pricing: https://developers.cloudflare.com/browser-rendering/pricing/

## 15. Kickoff prompt for the first dev session

Copy this folder into a new, empty repo, open Claude Code there, and paste:

```
You're starting the Rendertrail MVP. Read HANDOFF.md fully, then CLAUDE.md and
fixtures/laggy-search/EXPECTED.md.

Do the Phase 0 dev tasks (HANDOFF.md §9):
1. Set up the repo (§4 layout, TypeScript, ESM, Node 22, MIT) and keep the name in src/brand.ts.
2. Scaffold the MCP server and card with the create-mcp-app skill (React), using
   @modelcontextprotocol/server v2 and @modelcontextprotocol/ext-apps.
3. Get a hello-world inline card working, and give me the exact Claude Desktop config to add.
4. Run the spike (spike/README.md) and show me the commit table next to EXPECTED.md.

Keep fixtures/ and spike/ as they are. Ask me before deciding anything HANDOFF.md doesn't
cover. Stop after Phase 0 so I can review.
```

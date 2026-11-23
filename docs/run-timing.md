# Where an inspect_render call spends its time

Measured on 2026-11-23 on the owner's Windows 11 machine (Node 24, Google Chrome 157, React 19.3.1)
with `scripts/time-run.mjs`. The project's floor is Node 22; Node 24 was what this machine had, and
the Node side is a small part of a call (below), so the picture shouldn't change on Node 22.

The script drives `dist/server.js` over stdio, the way Claude Desktop and Claude Code do, and reads
where the call's time went from the result's `_meta` (under `rendertrail/timing`). It never goes in
structuredContent or the text, so it doesn't reach the model.

- **Cold call:** a fresh server process for the call. It includes the first browser launch and the
  first load of the TypeScript compiler. This is the first call of a session.
- **Warm call:** a later call in the same server process.

Each phase is the median over 5 calls (10 in the second warm table). Medians of phases don't add up to
the median total. Totals show the median and the min–max. The "before" build is the commit that only
added the timing (53f2944); "after" is this branch. The two builds were measured call by call in turn,
so they shared the same background load. The machine was running other work, and a phase can still
jump between columns. For example, cart-summary's cold calls ranged from 3.4 to 5.9 s on the same
build. Trust the phase savings below more than small differences in totals.

To reproduce: `npm run build`, then `node scripts/time-run.mjs laggy-search todo-toggle cart-summary`.
To compare two builds, keep a copy of an older `dist/` inside the checkout (say `dist-before/`, so it
still finds `node_modules`) and pass `--server dist-before/server.js --server dist/server.js`.

## The fixed floor: the delays the steps ask for

Every run plays the test's steps with the delays they ask for, and every call does 3 runs. No change
to the code, and no other language, can remove this time without changing what is measured:

| Fixture | Steps (one run) | Scripted per run | Per call (×3) |
|---|---|---:|---:|
| laggy-search | type 5 letters at 100 ms, then wait 600 ms | 1,100 ms | **3,300 ms** |
| todo-toggle | type 4 letters at 100 ms, three waits of 200 ms | 1,000 ms | **3,000 ms** |
| cart-summary | 4 clicks, each followed by a 150 ms wait | 600 ms | **1,800 ms** |

## What changed, phase by phase

The savings come from three phases. None of them is inside the measured page:

| Phase (laggy-search) | Saved on a warm call | Saved on a cold call | How |
|---|---:|---:|---|
| Browser launch | ≈ 145–175 ms (all of it) | – | The browser stays warm between calls |
| Closing the browser after the call | ≈ 90–100 ms (all of it) | ≈ 100 ms | Not part of the call any more: idle timeout, or shutdown |
| Reading the trace out of the page (3 runs) | ≈ 235–260 ms | ≈ 260 ms | One JSON string instead of Playwright's value-by-value copy |

On this machine, browser close took 90–100 ms in this round, 150–300 ms in an earlier round, and once
several seconds while the machine was busy. Reading the trace saves the most on big traces: 1,000
rendered rows in laggy-search and user-table. On cart-summary's small trace it saves about 12–25 ms.

## Totals

Round trip of `tools/call` (ms, median and min–max). It excludes the server process start; the last
column adds it back for cold calls:

| Fixture | Warm before | Warm after | Cold before | Cold after | Cold with process start, before → after |
|---|---|---|---|---|---|
| laggy-search (5 calls) | 5,025 (4,949–5,043) | 4,488 (4,364–4,593) | 5,345 (5,205–5,554) | 4,954 (4,870–5,086) | 5,776 → 5,341 |
| laggy-search (10 calls) | 4,862 (4,836–5,060) | 4,374 (4,343–4,526) | | | |
| todo-toggle (5 calls) | 4,751 (4,716–5,442) | 4,266 (4,235–4,351) | 5,099 (4,992–5,181) | 4,844 (4,533–4,944) | 5,522 → 5,271 |
| todo-toggle (10 calls) | 4,786 (4,600–4,970) | 4,271 (4,183–4,399) | | | |
| cart-summary (5 calls) | 3,002 (2,927–12,159) | 2,733 (2,681–2,817) | noisy: 3,397–5,889 | noisy: 3,491–5,206 | not meaningful |

A warm call saves about 0.5 s and a cold call about 0.25–0.4 s. That matches the phase savings above.
The cold calls of cart-summary overlapped a burst of other work on the machine, so their totals say
nothing either way.

laggy-search, all phases (ms, medians of 5 calls):

| Phase | Cold before | Cold after | Warm before | Warm after |
|---|---:|---:|---:|---:|
| Process start (spawn until the MCP server answers) | 399 | 411 | – | – |
| Bundle (esbuild) | 64 | 65 | 46 | 47 |
| Browser launch | 166 | 188 | 160 | **0** |
| 3 runs: new browser context and page | 336 | 334 | 302 | 309 |
| 3 runs: page load and first render | 344 | 353 | 324 | 334 |
| 3 runs: scripted waits and typing delays | 3,300 | 3,300 | 3,300 | 3,300 |
| 3 runs: steps, the rest | 466 | 452 | 447 | 447 |
| 3 runs: read the trace out of the page | 276 | **13** | 268 | **14** |
| 3 runs: close the context | 24 | 20 | 24 | 20 |
| Analyze (a cold call loads the TypeScript compiler) | 246 | 218 | 6 | 5 |
| Summarize and store | < 10 | < 10 | < 5 | < 5 |
| Not in a phase above (before: mostly closing the browser) | 103 | **2** | 101 | **1** |

What each phase is:

- **Process start**: Node starts and loads the MCP SDK. The host does this once per session, not per call.
- **Bundle**: esbuild (already a native Go binary) bundles the user's files with React.
- **Browser launch**: starting Chrome. Before, this happened on every call.
- **New context and page**: a fresh, isolated browser context per run, with its network rules and a new page. About 100 ms per run, mostly Chrome starting a renderer process.
- **Page load and first render**: Chrome loads the bundle (React plus the app) and React mounts it. For laggy-search that includes 1,000 rows.
- **Scripted waits and typing delays**: the fixed floor above.
- **Steps, the rest**: Chrome handling each key press or click, React rendering in response (the measured work itself), and Playwright's checks that the element is ready.
- **Read the trace**: copying the recorded trace from the page to Node.
- **Analyze, summarize, store**: plain Node code, under 10 ms each on a warm call. The first call in a process also loads the TypeScript compiler (about 9 MB of JavaScript), which takes 200–400 ms.

A warm laggy-search call is now 3.3 s of scripted delays (about 75%), about 1 s in Chrome and in
Playwright's driver, and tens of milliseconds in Rendertrail's own Node code.

## How the warm browser behaves

- One browser per server process, reused by the next call. Every run still gets its own fresh browser
  context with the same isolation as before, so no page, storage or JavaScript heap carries over.
- It closes after 5 minutes without a call (`LIMITS.browserIdleMs`), because fix-and-check calls are
  often minutes apart. It also closes when a run timed out, when a page didn't close within 5 s, when
  a recording passed its deadline, and when the server stops: stdin closed, or SIGINT, SIGTERM or
  SIGHUP. A signalled stop exits within 3 s even if closing stalls. A browser that doesn't close in
  5 s is killed. After a hard kill of the server, Chrome exits by itself when its pipe breaks.
- Calls take turns. A call holds its turn through recording, analysis and the store write, so no work
  of one call can run during another call's recording. That includes the analyzer's first
  TypeScript load, which blocks Node for a few hundred ms and could stretch typing delays past a
  debounce. A call that is cancelled while it waits is skipped; one cancelled while it records stops
  after closing its page. A recording has a deadline: 3 × 20 s plus 15 s. After that the browser
  is closed (killed if need be), the call fails with a timeout, and the next call gets its turn.
- An idle warm Chrome on this machine: 5 processes, about 160 MB private memory (280 MB working set).

### Measured, and not kept

- **Loading TypeScript while Chrome launches.** Analyze fell from 344 to 26 ms, but the launch rose
  from 290 to 657 ms. Compiling 9 MB of JavaScript blocks Node's event loop, and Playwright needs that
  loop to finish the launch. No net gain, so it was reverted.
- **Bundling while Chrome launches** (about 60–200 ms on a call without a warm browser) and
  **creating run 1's context while bundling** (about 50 ms on a warm call): not built. The first
  starts Chrome even when the bundle fails, which the recorder deliberately avoids. The second is
  about 1% of a call.
- **Reusing an esbuild context between calls:** bundling is about 40–60 ms warm, and each call's files
  are different. The instrumentation build was already cached.

## Timing fidelity: the numbers the user sees did not move

Median input-commit render time per call, 10 warm calls each, before and after, measured in turn:

| Fixture | Before: median (min–max) | After: median (min–max) | After, run 1 / 2 / 3 |
|---|---|---|---|
| laggy-search | 20.4 ms (20.4–20.5) | 20.4 ms (20.3–20.5) | 20.4 / 20.3 / 20.4 |
| todo-toggle | 10.2 ms (10.1–10.3) | 10.2 ms (10.2–10.3) | 10.2 / 10.2 / 10.3 |

A reused browser neither inflates nor deflates the measured renders, and it adds no spread. The first
run in a fresh browser isn't an outlier either: by run, the medians agree within 0.1 ms, and the
cold calls show the same. So the recorder needs no warm-up run. It still takes the median over the
3 runs, as before. An earlier round on a busier machine gave the same picture (20.4 ms and 10.3 ms,
with the same spread before and after).

Render and commit counts match the golden tests exactly with the warm browser on React 19.3.1
(`npm run test:golden`, 3 runs in a row). On React 18.3.1 every fixture matches except
cart-summary's `Cart.tsx`. There, a random run sometimes records one extra update right after mount,
16 updates instead of 15. That run isn't always the first, and the same failure shows up without
these changes: 3 of 6 tries with the original recorder on this machine. It comes from the fixture, not
the recorder. On React 18 the mount's effects run on a timer, so the first shipping quote (for a
total of 0) sometimes lands before the total updates.

## What remains, and what a rewrite could change

A warm call is now about 1.0–1.2 s above its fixed floor. Most of that is Chrome, with Playwright's
Node-side driver traffic mixed in:

- creating a fresh context and renderer for each run, about 100 ms per run;
- loading and mounting the app, about 100 ms per run;
- delivering input events and running React's renders, about 150–200 ms per run.

A cold call adds the Chrome launch (about 170–300 ms), the TypeScript compiler's first load
(200–400 ms) and the server process start (0.4–0.9 s). The host pays that last one once per session.

Rendertrail's own Node code takes tens of milliseconds of a warm call: bundling setup, summarize,
analyze, store. That is the part a rewrite in Rust or another compiled language could speed up. Some
of the "Chrome" time is Playwright's driver in Node, and a rewrite would still need a driver, so
count the Node share as a lower bound of what's rewritable. Either way it's a few percent of a warm
call.

On a cold call, a compiled server would start faster. It could also skip the compiler load, but only
by replacing the TypeScript compiler API that the analyzer uses for line lookup. That might save up to
about 0.5–1 s, once per session.

A rewrite couldn't touch the 3.3 s of scripted delays, or most of the second Chrome spends on each
call. Both come from recording in a real browser, which is what makes the numbers trustworthy. The
bundler is already native (esbuild is Go).

The remaining levers are product choices, not code speed: fewer than 3 runs, shorter scripted
delays in the steps Claude writes, or reusing one page across runs (which would give up the clean
JavaScript heap per run). None of them was done here.

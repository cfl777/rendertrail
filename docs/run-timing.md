# Where an inspect_render call spends its time

Measured on 2026-11-23 on the owner's Windows 11 machine (Node 24, Google Chrome, React 19.3.1)
with `scripts/time-run.mjs`. The script drives `dist/server.js` over stdio, the way Claude Desktop
and Claude Code do, and reads the `run.timing` object that each result now carries.

- **Cold call**: a fresh server process for the call, so it includes the first browser launch and the
  first load of the TypeScript compiler. This is the first call of a session.
- **Warm call**: the next calls in the same server process.

Each number is the median of 5 calls (10 for the timing-fidelity check). The "before" and "after"
builds were measured call by call in turn, so they shared the same background load. The machine was
busy with other work while this ran, so single phases vary by up to 30% between columns even when
the code is the same. Compare totals, and treat small differences as noise.

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

## Baseline: where the time went before

laggy-search, before any change (ms, medians of 5 calls):

| Phase | Cold | Warm |
|---|---:|---:|
| Process start (spawn until the MCP server answers) | 747 | – |
| Bundle (esbuild) | 167 | 74 |
| Load the page instrumentation | 3 | 0 |
| Browser launch | 263 | 259 |
| 3 runs: new browser context and page | 514 | 447 |
| 3 runs: page load and first render | 527 | 471 |
| 3 runs: scripted waits and typing delays | 3,300 | 3,300 |
| 3 runs: steps, the rest | 627 | 587 |
| 3 runs: read the trace out of the page | 436 | 403 |
| 3 runs: close the context | 33 | 26 |
| Summarize | 5 | 4 |
| Analyze (first call loads the TypeScript compiler) | 341 | 7 |
| Store the run | 4 | 3 |
| Not in a phase above (mostly closing the browser) | 192 | 218 |
| **Call as the client sees it** | **7,047** | **5,849** |

What each phase is:

- **Process start**: Node starts and loads the MCP SDK. The host does this once per session, not per call.
- **Bundle**: esbuild (already a native Go binary) bundles the user's files with React. 50–170 ms.
- **Instrumentation**: reads `dist/instrument.js` once per process, then it is cached.
- **Browser launch**: starts Chrome. Before this change, this happened on every call.
- **New context and page**: a fresh, isolated browser context per run, with its network rules and a new page. About 150 ms per run, almost all of it Chrome creating the renderer process.
- **Page load and first render**: Chrome loads the bundle (React plus the app) and React mounts it. For laggy-search that includes 1,000 rows.
- **Scripted waits and typing delays**: the fixed floor above.
- **Steps, the rest**: Chrome handling each key press or click, React rendering in response (the measured work itself), and Playwright's checks that the element is ready.
- **Read the trace**: copying the recorded trace from the page to Node. Before this change, Playwright copied it value by value, which took 130–160 ms per run for a trace with 1,000 renders.
- **Close the context**: under 15 ms per run.
- **Summarize, analyze, store**: plain Node code, under 10 ms each on a warm call. The first call in a process also loads the TypeScript compiler (about 9 MB of JavaScript), which takes 200–400 ms.
- **Not in a phase above**: before this change, mostly closing Chrome at the end of every call, 100–300 ms and sometimes seconds on this machine.

On a warm call before the change: 3.3 s of scripted delays (56%), 2.2 s in Chrome, 0.1 s in Node
code, and 0.2 s closing the browser.

## After: what changed and what it saved

Three changes, none of which touches what is measured inside the page:

1. **Keep the browser warm between calls.** The long-lived server reuses one Chrome for the next
   call instead of launching and closing it every time. Every run still gets its own fresh browser
   context with the same isolation as before. Saves the launch (about 250 ms) and the close
   (100–300 ms, sometimes more) on every warm call. The browser closes after 60 s without a call.
2. **Read the trace as one JSON string.** Saves 130–160 ms per run on large traces (about 400 ms per
   laggy-search call). A strict deep-equality check on four fixtures found the two transports gave
   identical traces.
3. **Never overlap two recordings in one process.** A second call waits for the first, so one call
   can't slow down another's measured renders. This costs nothing when calls don't overlap.

Calls as the client sees them (ms, medians of 5 calls):

| Fixture | Cold before | Cold after | Warm before | Warm after | Fixed floor |
|---|---:|---:|---:|---:|---:|
| laggy-search | 7,047 | 5,828 (−17%) | 5,849 | 5,015 (−14%) | 3,300 |
| todo-toggle | 8,646 | 6,787 (−22%) | 5,299 | 4,580 (−14%) | 3,000 |
| cart-summary | 3,899 | 3,513 (−10%) | 4,297 | 3,425 (−20%) | 1,800 |

With 10 warm calls each: laggy-search 5,863 → 5,086 ms (−13%), todo-toggle 6,006 → 4,587 ms (−24%).
A cold call also pays the process start (0.5–1 s) once per session. That hasn't changed.

laggy-search, phase by phase (ms):

| Phase | Cold before | Cold after | Warm before | Warm after |
|---|---:|---:|---:|---:|
| Process start | 747 | 720 | – | – |
| Bundle | 167 | 145 | 74 | 86 |
| Browser launch | 263 | 262 | 259 | **0** |
| 3 runs: context and page | 514 | 483 | 447 | 454 |
| 3 runs: load and first render | 527 | 487 | 471 | 497 |
| 3 runs: scripted delays | 3,300 | 3,300 | 3,300 | 3,300 |
| 3 runs: steps, the rest | 627 | 699 | 587 | 618 |
| 3 runs: read the trace | 436 | **23** | 403 | **22** |
| 3 runs: close the context | 33 | 27 | 26 | 25 |
| Analyze | 341 | 385 | 7 | 8 |
| Not in a phase above | 192 | **2** | 218 | **1** |
| **Call** | **7,047** | **5,828** | **5,849** | **5,015** |

A warm laggy-search call is now 3.3 s of scripted delays (66%), 1.6 s in Chrome, and 0.1 s in Node code.

### Measured, and not kept

- **Loading TypeScript while Chrome launches.** Analyze fell from 344 to 26 ms, but the launch rose
  from 290 to 657 ms. Compiling 9 MB of JavaScript blocks Node's event loop, and Playwright needs that
  loop to finish the launch. No net gain, so it was reverted.
- **Bundling while Chrome launches** (about 100 ms on a call without a warm browser) and **creating
  run 1's context while bundling** (about 70 ms on a warm call): not built. The first starts Chrome
  even when the bundle fails, which the recorder deliberately avoids. The second is about 1.5% of a
  call and needs `runOnce` split in two.
- **Reusing an esbuild context between calls:** bundling is 50–90 ms warm, and each call's files are
  different. The instrumentation build was already cached.

## Timing fidelity: the numbers the user sees did not move

Median input-commit render time per call, 10 warm calls each, before and after, measured in turn:

| Fixture | Before: median (min–max) | After: median (min–max) | By run 1 / 2 / 3, after |
|---|---|---|---|
| laggy-search | 20.4 ms (20.3–20.7) | 20.4 ms (20.3–20.7) | 20.4 / 20.6 / 20.3 |
| todo-toggle | 10.3 ms (10.2–10.4) | 10.3 ms (10.2–10.4) | 10.3 / 10.2 / 10.3 |

A reused browser doesn't inflate or deflate the measured renders, and it adds no spread. The first
run in a fresh browser isn't an outlier either: by run, the medians agree within 0.3 ms. Before the
change it was 20.5 / 20.4 / 20.5 for laggy-search, and the cold calls are the same. So the recorder
needs no warm-up run. It still takes the median over the 3 runs, as before.

Render and commit counts match the golden tests exactly with the warm browser on React 19.3.1
(`npm run test:golden`, 3 runs in a row). On React 18.3.1 every fixture matches except
cart-summary's `Cart.tsx`. There, a random run sometimes records one extra update right after mount,
16 updates instead of 15. That run isn't always the first, and the same failure shows up without
these changes: 3 of 6 tries with the original recorder on this machine. It comes from the fixture, not
the recorder. On React 18 the mount's effects run on a timer, so the first shipping quote (for a
total of 0) sometimes lands before the total updates.

## What remains, and what a rewrite could change

A warm call is now about 1.2–1.7 s above its fixed floor, and all but about 0.1 s of that is Chrome:
creating a fresh context and renderer per run (about 150 ms per run), loading and mounting the app
(about 150 ms per run), and delivering input events and running React's renders (about 200 ms per run).
A cold call adds the Chrome launch (about 250 ms), the TypeScript compiler's first load (200–400 ms)
and the server process start (0.5–1 s). The host pays that last one once per session.

Rewriting the server in Rust or another compiled language could change only the Node part: about
0.1 s of a 5 s warm call (2%). On a cold call it could also save the process start and the
compiler load, perhaps 0.5–1 s, once per session. It couldn't touch the 3.3 s of scripted delays or the
1.5 s Chrome spends on each call, because both come from recording in a real browser. Those are
what make the numbers trustworthy. The bundler is already native (esbuild is Go).

The remaining honest levers are product choices, not code speed: fewer than 3 runs, shorter scripted
delays in the steps Claude writes, or reusing one page across runs (which would break the clean
JavaScript heap per run). None of them was done here.

# Review: run-timing-and-speed

Fresh-eyes review on 2026-11-23 by an Opus reviewer agent with a shell (typecheck, 189 unit tests;
golden covered by CI run 45159252303 on React 18.3.1 and 19.3.1), followed by fixes on this branch
(4a2c0ee, 7c36faf) and the CLAUDE.md command lines. Scope: phase timing, `scripts/time-run.mjs`, the
warm browser (`src/recorder/browser.ts`), the one-at-a-time queue, the trace read as one JSON
string, `docs/run-timing.md`.

## Findings

No critical findings. Should-fix (all fixed, with tests):

1. One hang blocked every later call once the browser was shared: context/page creation and
   context close were outside the run limit and the queue had no deadline. Now context creation
   counts toward the 20 s limit, close is capped at 5 s (a slow close discards the browser), each
   recording has a 75 s deadline, a browser that won't close is killed by pid, launch timeout 30 s.
2. The queue released before analysis, so one call's first TypeScript load could stretch the next
   call's typing gaps and change its counts. The turn now covers record, analyze and store.
3. Signal handlers awaited `browser.close()` without a deadline. The server now exits within 3 s.
   The SIGTERM test is POSIX-only and will first run on CI Linux; stdin close during a call is
   tested on Windows.
4. Cancelled calls held the queue. The MCP abort signal reaches the recorder; queued cancelled calls
   are skipped, running ones stop between or mid-run; input is checked before queueing.
5. `docs/run-timing.md` overstated small-trace savings (noise as large as the effect). Re-measured
   before/after alternating call by call; leads with per-phase savings, totals as median (min–max),
   headline percentages dropped, process start labelled, Node 24 vs the Node 22 floor noted.
6. A golden check that never ran (the stuck-page renderer check) now asserts both outcomes;
   `afterAll` closes the warm browser in the browser, recorder and fixtures golden files. Not added
   to `network.golden.test.ts`, which stays untouched by design.

Nits (fixed): the rewrite-language paragraph softened (the Node share is a lower bound); the page
captures `JSON.stringify` before user code and a golden test compares the trace both ways; timing
moved from structuredContent to the result's `_meta` ("rendertrail/timing").

Confirmed clean by the reviewer: every run still gets a fresh context with `serviceWorkers:'block'`,
the route abort and the WebSocket close; every launch goes through the same flags; no renderer or
heap sharing between runs; idle timer never fires mid-call and never keeps the process alive; no two
Chromes at once; types additive; text result and stored runs carry no timing.

Owner decisions applied and to confirm: idle timeout 5 minutes; the one-at-a-time queue kept.
Open: preload TypeScript at start (not done); the React 18 cart-summary fixture (a fixture issue,
left alone).

Resolved: all nine review items fixed; typecheck, 201 unit tests, build, golden 3× green on React
19.3.1, test:pack green at 7c36faf.

# Recorder spike

A throwaway proof that the recording approach works. Phase 1 starts from here: move the useful parts into `src/recorder`, then delete this folder.

Verified on 2026-10-31 with React 19.3.1 and React 18.3.1 (identical commit counts). Results: `../fixtures/laggy-search/EXPECTED.md`.

## Run it

```bash
npm install
npx playwright install chromium   # once (about 150 MB), or skip it and use your own Chrome:
                                  # RT_CHANNEL=chrome npm run record
npm run record          # the laggy search fixture
npm run record:fixed    # the same fixture with the fix applied
node record-renders.mjs ../fixtures/laggy-search --json > trace.json   # raw trace
```

To try React 18: `npm install react@18.3.1 react-dom@18.3.1`, then run it again.

## How it works

1. **Bundle.** esbuild bundles the fixture with production React and `react-dom/profiling`. That gives production speed, and React still measures render times in `fiber.actualDuration` (the normal production build doesn't). `minifySyntax` removes React's dev-only code; `keepNames` keeps component names as written.
2. **Run.** Playwright opens headless Chromium and injects `instrument.js` (built on bippy) with `addInitScript`, so it loads before React. It serves the bundle from memory and blocks every other network request.
3. **Play the test.** It plays `test.json` (type "hello", then wait) and reads `window.__RT__`.
4. **Record.** For every commit, `instrument.js` records what rendered, self and total time, which props changed (by reference only, or by value), which state hooks changed, and what triggered the commit: user input, right after another commit ("follow-up") or after a pause ("later").

## Shortcuts to replace in Phase 1

- "follow-up" vs "later" is a 20 ms gap. Replace it with the rule 2 approach in HANDOFF.md §7.
- Props are compared up to depth 3, and functions by their source text.
- Only components are recorded, not DOM nodes. Commit time is the sum of the topmost components that rendered.
- One run per test. Phase 1 runs each test 3 times and reports the median.
- No stubs for imports that aren't in the files yet.

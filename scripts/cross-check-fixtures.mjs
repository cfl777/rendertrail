// Independent cross-check of the golden fixtures: `node scripts/cross-check-fixtures.mjs`.
//
// It does NOT use the recorder (src/recorder/page/instrument.ts) or bippy. Render counts come from a
// counter call injected as the first statement of every function component (one call per render in
// production React without StrictMode); commits come from React's public <Profiler onRender>, using
// the react-dom/profiling build so onRender fires in production. The steps from test.json are
// played with playwright-core in the installed Chrome, like the recorder does. The result is
// compared with fixtures/*/expected.json; the exit code is 1 on any count disagreement or when runs
// disagree with each other.
//
// Options: --runs N (default 3), --fixture NAME (repeatable), --json FILE (write all results).
// Does not depend on dist/; `npm run build` isn't needed.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { instrumentComponents } from './cross-check/instrument-source.mjs';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = path.join(ROOT, 'fixtures');
const ORIGIN = 'http://cross-check.local';
const HTML =
  '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const DEFAULT_TYPE_DELAY_MS = 50; // same default as the recorder (src/recorder/limits.ts)
const ACTION_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------------------------
// Small checked readers for the JSON files (no unchecked property access).

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** @param {unknown} v @param {string} what @returns {Record<string, unknown>} */
function record(v, what) {
  if (!isRecord(v)) throw new Error(`${what}: expected an object`);
  return v;
}
/** @param {unknown} v @param {string} what @returns {string} */
function str(v, what) {
  if (typeof v !== 'string') throw new Error(`${what}: expected a string`);
  return v;
}
/** @param {unknown} v @param {string} what @returns {number} */
function num(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what}: expected a number`);
  return v;
}
/** @param {unknown} v @param {string} what @returns {unknown[]} */
function arr(v, what) {
  if (!Array.isArray(v)) throw new Error(`${what}: expected an array`);
  return v;
}
/** @param {unknown} v @param {string} what @returns {Record<string, number>} */
function counts(v, what) {
  const r = record(v, what);
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, n] of Object.entries(r)) if (!k.startsWith('$')) out[k] = num(n, `${what}.${k}`);
  return out;
}

/**
 * @typedef {{ action: 'type', target: string, text: string, delayMs?: number }
 *   | { action: 'click', target: string } | { action: 'wait', ms: number }} Step
 * @typedef {{ index: number, trigger: string, renders: Record<string, number> }} ExpectedCommit
 * @typedef {{ commitCount: number, commits: ExpectedCommit[], rendersAfterMount: Record<string, number> }} ExpectedVariant
 */

/** @param {unknown} raw @returns {{ entry: string, exportName: string, steps: Step[] }} */
function parseTest(raw) {
  const t = record(raw, 'test.json');
  const steps = arr(t.steps, 'test.json steps').map((s, i) => {
    const step = record(s, `step ${i}`);
    const action = str(step.action, `step ${i} action`);
    if (action === 'type') {
      return /** @type {Step} */ ({
        action,
        target: str(step.target, `step ${i} target`),
        text: str(step.text, `step ${i} text`),
        ...(step.delayMs === undefined ? {} : { delayMs: num(step.delayMs, `step ${i} delayMs`) }),
      });
    }
    if (action === 'click') return /** @type {Step} */ ({ action, target: str(step.target, `step ${i} target`) });
    if (action === 'wait') return /** @type {Step} */ ({ action, ms: num(step.ms, `step ${i} ms`) });
    throw new Error(`step ${i}: unknown action ${action}`);
  });
  return { entry: str(t.entry, 'entry'), exportName: str(t.exportName ?? 'default', 'exportName'), steps };
}

/** @param {unknown} raw @returns {{ fixedEntry: string | undefined, variants: Map<string, ExpectedVariant> }} */
function parseExpected(raw) {
  const e = record(raw, 'expected.json');
  const variants = new Map();
  for (const [name, v] of Object.entries(record(e.variants, 'variants'))) {
    const variant = record(v, name);
    variants.set(name, {
      commitCount: num(variant.commitCount, `${name}.commitCount`),
      commits: arr(variant.commits, `${name}.commits`).map((c, i) => {
        const commit = record(c, `${name}.commits[${i}]`);
        return {
          index: num(commit.index, `${name}.commits[${i}].index`),
          trigger: str(commit.trigger, `${name}.commits[${i}].trigger`),
          renders: counts(commit.renders, `${name}.commits[${i}].renders`),
        };
      }),
      rendersAfterMount: counts(variant.rendersAfterMount, `${name}.rendersAfterMount`),
    });
  }
  return { fixedEntry: e.fixedEntry === undefined ? undefined : str(e.fixedEntry, 'fixedEntry'), variants };
}

// ---------------------------------------------------------------------------------------------
// Bundling with the independent counter.

/** Installed before any page script: the counter, the Profiler callback and an input-event tally. */
const PAGE_RUNTIME = `(() => {
  const xc = { pending: Object.create(null), commits: [], inputs: 0 };
  xc.render = (name) => { xc.pending[name] = (xc.pending[name] || 0) + 1; };
  xc.onRender = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    xc.commits.push({ phase, actualDuration, commitTime, inputs: xc.inputs, renders: xc.pending });
    xc.pending = Object.create(null);
  };
  // Capture on window runs before React's listener on the root container.
  for (const type of ['click', 'input']) window.addEventListener(type, () => { xc.inputs += 1; }, true);
  globalThis.__xc = xc;
})();`;

/**
 * @param {string} dir fixture folder
 * @param {string} entry entry file name inside it
 * @param {string} exportName
 * @param {Map<string, string>} [overrides] file name -> replacement source (for probes)
 * @returns {Promise<{ code: string, components: { file: string, name: string, line: number, anonymousInDevTools: boolean }[] }>}
 */
async function bundleFixture(dir, entry, exportName, overrides = new Map()) {
  /** @type {{ file: string, name: string, line: number, anonymousInDevTools: boolean }[]} */
  const components = [];
  const importRoot = exportName === 'default' ? 'Root' : `{ ${exportName} as Root }`;
  const result = await build({
    stdin: {
      contents: [
        `import { createRoot } from 'react-dom/profiling';`,
        `import { Profiler } from 'react';`,
        `import ${importRoot} from ${JSON.stringify(`./${entry}`)};`,
        // No StrictMode (its double renders would distort the counts), one Profiler around the app.
        `createRoot(document.getElementById('root')).render(<Profiler id="xc" onRender={globalThis.__xc.onRender}><Root /></Profiler>);`,
      ].join('\n'),
      loader: 'tsx',
      resolveDir: dir,
      sourcefile: '__cross_check_entry__.tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minifySyntax: true,
    keepNames: true,
    jsx: 'automatic',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'xc-count-renders',
        setup(b) {
          b.onLoad({ filter: /\.tsx?$/ }, async (args) => {
            if (path.dirname(args.path) !== dir) return undefined;
            const file = path.basename(args.path);
            const source = overrides.get(file) ?? (await readFile(args.path, 'utf8'));
            const out = instrumentComponents(source, file);
            for (const c of out.components) components.push({ file, ...c });
            return { contents: out.code, loader: file.endsWith('.tsx') ? 'tsx' : 'ts' };
          });
        },
      },
    ],
  });
  const code = result.outputFiles[0]?.text;
  if (code === undefined) throw new Error(`esbuild produced no output for ${entry}`);
  return { code, components };
}

// ---------------------------------------------------------------------------------------------
// Running in Chrome.

/**
 * @typedef {{ index: number, phase: string, actualDuration: number, commitTime: number, isInput: boolean,
 *   renders: Record<string, number> }} Commit
 * @typedef {{ commits: Commit[], leftover: Record<string, number>, pageErrors: string[] }} Run
 */

/** @param {import('playwright-core').Page} page @param {Step} step */
async function playStep(page, step) {
  if (step.action === 'type') {
    await page
      .locator(step.target)
      .pressSequentially(step.text, { delay: step.delayMs ?? DEFAULT_TYPE_DELAY_MS, timeout: ACTION_TIMEOUT_MS });
  } else if (step.action === 'click') {
    await page.locator(step.target).click({ timeout: ACTION_TIMEOUT_MS });
  } else {
    await page.waitForTimeout(step.ms);
  }
}

/** @param {unknown} raw @returns {Omit<Run, 'pageErrors'>} */
function parsePageResult(raw) {
  const r = record(raw, 'page result');
  let previousInputs = 0;
  const commits = arr(r.commits, 'commits').map((c, index) => {
    const commit = record(c, `commit ${index}`);
    const inputs = num(commit.inputs, `commit ${index} inputs`);
    const isInput = index > 0 && inputs > previousInputs;
    previousInputs = inputs;
    return {
      index,
      phase: str(commit.phase, `commit ${index} phase`),
      actualDuration: num(commit.actualDuration, `commit ${index} actualDuration`),
      commitTime: num(commit.commitTime, `commit ${index} commitTime`),
      isInput,
      renders: counts(commit.renders, `commit ${index} renders`),
    };
  });
  return { commits, leftover: counts(r.pending, 'pending') };
}

/**
 * @param {import('playwright-core').Browser} browser
 * @param {string} code
 * @param {Step[]} steps
 * @returns {Promise<Run>}
 */
async function runOnce(browser, code, steps) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  /** @type {string[]} */
  const pageErrors = [];
  try {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: HTML });
      if (url === `${ORIGIN}/app.js`) return route.fulfill({ contentType: 'text/javascript', body: code });
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(`Uncaught: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') pageErrors.push(`console.${msg.type()}: ${msg.text()}`);
    });
    await page.addInitScript({ content: PAGE_RUNTIME });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction('globalThis.__xc && globalThis.__xc.commits.length > 0', null, { timeout: ACTION_TIMEOUT_MS });
    for (const step of steps) await playStep(page, step);
    const raw = await page.evaluate('({ commits: globalThis.__xc.commits, pending: globalThis.__xc.pending })');
    return { ...parsePageResult(raw), pageErrors };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Comparing.

/** @param {Record<string, number>} a @param {Record<string, number>} b */
function sameCounts(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

/** @param {Record<string, number>} c */
function fmtCounts(c) {
  const parts = Object.entries(c)
    .filter(([, n]) => n !== 0)
    .map(([k, n]) => (n === 1 ? k : `${k} x${n}`));
  return parts.length ? parts.join(', ') : '(nothing)';
}

/** @param {Run} run @param {string[]} names @returns {Record<string, number>} */
function rendersAfterMount(run, names) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const n of names) out[n] = 0;
  for (const c of run.commits.slice(1)) for (const [k, n] of Object.entries(c.renders)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** A stable fingerprint of a run's counts and triggers, to check that runs agree. @param {Run} run */
function signature(run) {
  return JSON.stringify(
    run.commits.map((c) => [c.phase === 'mount' ? 'mount' : c.isInput ? 'input' : 'other', Object.entries(c.renders).sort()]),
  );
}

/** @param {Run} run @param {ExpectedVariant} expected @returns {string[]} */
function compare(run, expected) {
  /** @type {string[]} */
  const problems = [];
  if (run.commits.length !== expected.commitCount) {
    problems.push(`commit count: expected ${expected.commitCount}, counted ${run.commits.length}`);
  }
  for (const e of expected.commits) {
    const c = run.commits[e.index];
    if (!c) continue;
    if (!sameCounts(c.renders, e.renders)) {
      problems.push(`commit ${e.index}: expected ${fmtCounts(e.renders)}; counted ${fmtCounts(c.renders)}`);
    }
    const counted = c.phase === 'mount' ? 'mount' : c.isInput ? 'input' : 'not input';
    const wanted = e.trigger === 'mount' || e.trigger === 'input' ? e.trigger : 'not input';
    if (counted !== wanted) problems.push(`commit ${e.index}: trigger expected ${e.trigger}, counted ${counted} (Profiler phase ${c.phase})`);
  }
  for (const c of run.commits.slice(expected.commits.length)) {
    problems.push(`commit ${c.index} (not expected): ${fmtCounts(c.renders)}`);
  }
  const after = rendersAfterMount(run, Object.keys(expected.rendersAfterMount));
  if (!sameCounts(after, expected.rendersAfterMount)) {
    problems.push(`renders after mount: expected ${JSON.stringify(expected.rendersAfterMount)}, counted ${JSON.stringify(after)}`);
  }
  if (Object.keys(run.leftover).length) problems.push(`renders with no commit after them: ${fmtCounts(run.leftover)}`);
  return problems;
}

/** @param {number[]} xs */
function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? NaN) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** @param {number} ms */
function fmtMs(ms) {
  return Number.isFinite(ms) ? `${ms.toFixed(2)} ms` : 'n/a';
}

// ---------------------------------------------------------------------------------------------
// The findings in EXPECTED.md, restated as questions to the independent data. The claims are
// transcribed by hand from each EXPECTED.md ("Findings the analyzer must report" / "Must NOT be
// reported"); the answers are computed from the counts and the Profiler only.

/** @param {Commit} c @param {string} name */
const r = (c, name) => c.renders[name] ?? 0;
/** @param {Run} run */
const afterMount = (run) => run.commits.slice(1);
/** @param {Run} run */
const inputCommits = (run) => run.commits.filter((c) => c.isInput);
/** @param {Run} run */
const otherCommits = (run) => afterMount(run).filter((c) => !c.isInput);
/** @param {Run} run @param {string} name */
const total = (run, name) => afterMount(run).reduce((s, c) => s + r(c, name), 0);
/** @param {Run} run */
const medianInputMs = (run) => median(inputCommits(run).map((c) => c.actualDuration));

/**
 * Rule 1: does the memo component re-render whenever its parent renders, and does that stop in the
 * fixed variant?
 * @param {{ component: string, parent: string, children: string[] }} claim
 * @param {Run} base @param {Run | undefined} fixed
 */
function rule1(claim, base, fixed) {
  /** @param {Run} run */
  const describe = (run) => {
    const withParent = afterMount(run).filter((c) => r(c, claim.parent) > 0);
    const inputs = withParent.filter((c) => c.isInput);
    const others = withParent.filter((c) => !c.isInput);
    const hit = (/** @type {Commit[]} */ cs) => cs.filter((c) => r(c, claim.component) > 0).length;
    const kids = claim.children.map((k) => `${k} ${total(run, k)}`).join(', ');
    return (
      `${claim.parent} rendered in ${inputs.length} input + ${others.length} other updates; ` +
      `${claim.component} rendered in ${hit(inputs)}/${inputs.length} and ${hit(others)}/${others.length} of them ` +
      `(${claim.component} ${total(run, claim.component)}${kids ? `, ${kids}` : ''} renders after mount)`
    );
  };
  return [`before: ${describe(base)}`, fixed ? `after fix: ${describe(fixed)}` : 'no fixed variant'];
}

/**
 * Rule 2: right after each input update, how many extra updates render only the named component
 * (and its listed children)? Which Profiler phase, how long after the input update?
 * @param {{ component: string, allowed: string[] }} claim
 * @param {Run} base @param {Run | undefined} fixed
 */
function rule2(claim, base, fixed) {
  const allowed = new Set(claim.allowed);
  /** @param {Run} run */
  const describe = (run) => {
    /** @type {number[]} */
    const perInput = [];
    /** @type {Set<string>} */
    const phases = new Set();
    /** @type {number[]} */
    const gaps = [];
    for (const input of inputCommits(run)) {
      let n = 0;
      let prev = input;
      for (const c of run.commits.slice(input.index + 1)) {
        const only = !c.isInput && r(c, claim.component) > 0 && Object.keys(c.renders).every((k) => allowed.has(k));
        if (!only) break;
        n += 1;
        phases.add(c.phase);
        gaps.push(c.commitTime - prev.commitTime);
        prev = c;
      }
      perInput.push(n);
    }
    return (
      `extra updates right after each input update, rendering only ${claim.allowed.join('/')}: [${perInput.join(', ')}]` +
      (phases.size ? `; Profiler phase: ${[...phases].join('/')}; gap after previous update: median ${fmtMs(median(gaps))}, max ${fmtMs(Math.max(...gaps))}` : '')
    );
  };
  return [`before: ${describe(base)}`, fixed ? `after fix: ${describe(fixed)}` : 'no fixed variant'];
}

/**
 * @typedef {{ label: string, show: (base: Run, fixed: Run | undefined, probe: Run | undefined) => string }} NotReported
 * @typedef {{ rule1?: { component: string, parent: string, children: string[] }[],
 *   rule2?: { component: string, allowed: string[] }[], notReported: NotReported[],
 *   probe?: { label: string, file: string, from: string, to: string } }} Claims
 */

/** @type {Record<string, Claims>} */
const CLAIMS = {
  'laggy-search': {
    rule1: [{ component: 'ResultsList', parent: 'SearchPage', children: ['ResultRow'] }],
    rule2: [{ component: 'SearchBox', allowed: ['SearchBox'] }],
    notReported: [
      {
        label: 'Header (re-renders with its parent, cheap)',
        show: (b, f) =>
          `Header rendered in ${inputCommits(b).filter((c) => r(c, 'Header')).length}/${inputCommits(b).length} input updates. ` +
          `After the fix a whole input update (SearchPage, Layout, Header, SearchBox) takes median ${fmtMs(f ? medianInputMs(f) : NaN)}, so Header alone costs less than that.`,
      },
      {
        label: 'Layout (new children every time)',
        show: (b) =>
          `Layout rendered ${total(b, 'Layout')} times after mount, never without SearchPage (${afterMount(b).filter((c) => r(c, 'Layout') && !r(c, 'SearchPage')).length} exceptions). The reason (new children) can't be seen in counts.`,
      },
      {
        label: 'ResultsList in commit 11 (items changed by value)',
        show: (b, f) =>
          `Update 11: ResultsList ${b.commits[11] ? r(b.commits[11], 'ResultsList') : '?'} before, ${f?.commits[11] ? r(f.commits[11], 'ResultsList') : '?'} after the fix (with a stable filters). It renders either way, so this render is needed.`,
      },
      {
        label: 'useDebounce (setter inside setTimeout)',
        show: (b) => {
          const last = inputCommits(b).at(-1);
          const c = b.commits[11];
          return c && last
            ? `Update 11 is not an input update; it came ${fmtMs(c.commitTime - last.commitTime)} after the last letter's input update (debounce is 300 ms), not right after an update. Profiler phase: ${c.phase}.`
            : 'update 11 missing';
        },
      },
      { label: 'Sidebar (memo holds)', show: (b, f) => `Sidebar renders after mount: ${total(b, 'Sidebar')} before, ${f ? total(f, 'Sidebar') : '?'} after the fix.` },
    ],
  },
  'cart-summary': {
    rule2: [{ component: 'CartSummary', allowed: ['CartSummary'] }],
    notReported: [
      {
        label: "useShippingQuote's setQuote (commits 5, 8, 11, 14)",
        show: (b, f) =>
          `Each click is followed by 2 CartSummary-only updates before the fix and 1 after it (see rule 2 line). The one that stays after the fix fits the quote; which state changed can't be seen in counts. Updates 5, 8, 11, 14 before: ${[5, 8, 11, 14].map((i) => (b.commits[i] ? fmtCounts(b.commits[i].renders) : '?')).join(' | ')}; fixed variant other updates: ${f ? otherCommits(f).length : '?'}.`,
      },
      {
        label: 'Mount follow-ups (commits 1 and 2)',
        show: (b, f) =>
          `Before the first click: ${b.commits.slice(1).findIndex((c) => c.isInput)} non-input updates (${b.commits.slice(1, 3).map((c) => fmtCounts(c.renders)).join(' | ')}); after the fix: ${f ? f.commits.slice(1).findIndex((c) => c.isInput) : '?'}.`,
      },
      { label: 'Rule 1 (nothing is memoised)', show: () => 'Nothing to count: memo is a source fact, not visible in counts.' },
      {
        label: 'CartLine renders',
        show: (b) => `CartLine per input update: [${inputCommits(b).map((c) => r(c, 'CartLine')).join(', ')}]; never outside input updates (${otherCommits(b).filter((c) => r(c, 'CartLine')).length}).`,
      },
    ],
  },
  'pricing-toggle': {
    rule1: [{ component: 'FeatureMatrix', parent: 'PricingPage', children: ['FeatureRow'] }],
    rule2: [{ component: 'PricingPage', allowed: ['PricingPage', 'PlanCard', 'FeatureMatrix', 'FeatureRow'] }],
    notReported: [
      {
        label: 'PlanCard x3 (price changed by value)',
        show: (b, f) =>
          `PlanCard per update before: [${afterMount(b).map((c) => r(c, 'PlanCard')).join(', ')}]; after the fix: [${f ? afterMount(f).map((c) => r(c, 'PlanCard')).join(', ') : '?'}]. Still 3 per click after the fix, so they are needed.`,
      },
      {
        label: 'FeatureRow as its own finding',
        show: (b) => `FeatureRow never rendered without FeatureMatrix (${afterMount(b).filter((c) => r(c, 'FeatureRow') && !r(c, 'FeatureMatrix')).length} exceptions).`,
      },
      {
        label: 'Mount (no follow-up after mount)',
        show: (b) => `Non-input updates between mount and the first click: ${b.commits.slice(1).findIndex((c) => c.isInput)}. Renders with no update after them: ${fmtCounts(b.leftover)}.`,
      },
      { label: "The button's inline onClick", show: () => 'A DOM element: nothing to count.' },
    ],
  },
  'theme-storefront': {
    notReported: [
      {
        label: 'ProductGrid / rule 1 on layout (the decoy)',
        show: (b, _f, p) =>
          `ProductGrid rendered ${total(b, 'ProductGrid')} times after mount; with layout made a module constant (probe) it still rendered ${p ? total(p, 'ProductGrid') : '?'} times. So the new layout object never caused a render; something else (the theme context, by elimination) did. The counts alone can't name the context.`,
      },
      {
        label: 'ProductCard x40 (reads the theme context)',
        show: (b, _f, p) =>
          `ProductCard per input update: [${inputCommits(b).map((c) => r(c, 'ProductCard')).join(', ')}]; probe: ${p ? total(p, 'ProductCard') : '?'} after mount. Their props come from a module constant, so the context is the remaining cause; counts only show that they rendered.`,
      },
      { label: 'PromoBanner (memo holds)', show: (b) => `PromoBanner renders after mount: ${total(b, 'PromoBanner')}.` },
      { label: 'The Provider value (a string)', show: () => 'A source fact: nothing to count.' },
      { label: 'Rule 2 (no effects)', show: (b) => `Non-input updates after mount: ${otherCommits(b).length}.` },
    ],
    probe: {
      label: 'layout made a module constant',
      file: 'Storefront.tsx',
      from: 'layout={{ columns: 4, gap: 12 }}',
      to: 'layout={XC_STABLE_LAYOUT}',
    },
  },
  'todo-toggle': {
    rule1: [{ component: 'TodoItem', parent: 'TodoApp', children: [] }],
    notReported: [
      { label: 'Inline arrows on DOM elements', show: () => 'DOM elements: nothing to count.' },
      {
        label: 'TodoFooter (memo holds while typing)',
        show: (b) => `TodoFooter per update: [${afterMount(b).map((c) => r(c, 'TodoFooter')).join(', ')}].`,
      },
      {
        label: 'The clicked row (Task 3) in commit 5',
        show: (b, f) =>
          `Update 5: TodoItem ${b.commits[5] ? r(b.commits[5], 'TodoItem') : '?'} before, ${f?.commits[5] ? r(f.commits[5], 'TodoItem') : '?'} after the fix: 1 row renders even with a stable onToggle, so 99 were wasted. Which row it is can't be seen in counts.`,
      },
      {
        label: 'The new row (Task 101) in commit 6',
        show: (b, f) =>
          `Update 6: TodoItem ${b.commits[6] ? r(b.commits[6], 'TodoItem') : '?'} before, ${f?.commits[6] ? r(f.commits[6], 'TodoItem') : '?'} after the fix. The counter can't tell a first render (mount) from a re-render; 101 = 100 + 1 is consistent with one new row.`,
      },
      { label: 'Rule 2 (no effects)', show: (b) => `Non-input updates after mount: ${otherCommits(b).length}.` },
    ],
  },
  'user-table': {
    rule1: [{ component: 'UserTable', parent: 'UserAdmin', children: ['UserRow'] }],
    notReported: [
      {
        label: 'FilterPanel (open changed by value)',
        show: (b, f) => `FilterPanel renders after mount: ${total(b, 'FilterPanel')} before, ${f ? total(f, 'FilterPanel') : '?'} after the fix (needed either way).`,
      },
      {
        label: 'UserRow as its own finding',
        show: (b) => `UserRow never rendered without UserTable (${afterMount(b).filter((c) => r(c, 'UserRow') && !r(c, 'UserTable')).length} exceptions).`,
      },
      { label: "The button's inline onClick", show: () => 'A DOM element: nothing to count.' },
      { label: 'Rule 2 (no effects)', show: (b) => `Non-input updates after mount: ${otherCommits(b).length}.` },
    ],
  },
};

// ---------------------------------------------------------------------------------------------
// Main.

/** @param {string[]} argv */
function parseArgs(argv) {
  let runs = 3;
  /** @type {string[]} */
  const only = [];
  /** @type {string | undefined} */
  let json;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--runs' && next) {
      runs = Number(next);
      i += 1;
    } else if (a === '--fixture' && next) {
      only.push(next);
      i += 1;
    } else if (a === '--json' && next) {
      json = path.resolve(next);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  return { runs, only, json };
}

/** @param {string} pkg */
function versionOf(pkg) {
  const json = record(require(`${pkg}/package.json`), `${pkg}/package.json`);
  return str(json.version, `${pkg} version`);
}

/** The installed Chrome first, like the recorder; Playwright's Chromium as the fallback. */
async function launch() {
  try {
    const browser = await chromium.launch({ channel: 'chrome' });
    return { browser, label: `Chrome ${browser.version()}` };
  } catch {
    const browser = await chromium.launch();
    return { browser, label: `Playwright Chromium ${browser.version()}` };
  }
}

async function main() {
  const { runs, only, json } = parseArgs(process.argv.slice(2));
  const react = versionOf('react');
  const reactDom = versionOf('react-dom');
  const { browser, label } = await launch();
  console.log(`Cross-check: React ${react}, react-dom ${reactDom}, ${label}, ${runs} runs per variant\n`);

  /** @type {string[]} */
  const disagreements = [];
  /** @type {unknown[]} */
  const report = [];
  /** @type {[fixture: string, variant: string, row: string, expected: string, counted: string][]} */
  const summary = [];
  try {
    const names = (await readdir(FIXTURES, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const fixture of names) {
      if (only.length && !only.includes(fixture)) continue;
      const dir = path.join(FIXTURES, fixture);
      const test = parseTest(JSON.parse(await readFile(path.join(dir, 'test.json'), 'utf8')));
      const expected = parseExpected(JSON.parse(await readFile(path.join(dir, 'expected.json'), 'utf8')));
      const claims = CLAIMS[fixture];
      console.log(`== ${fixture}`);

      /** @type {Map<string, Run>} */
      const firstRuns = new Map();
      const entries = [test.entry, ...(expected.fixedEntry ? [expected.fixedEntry] : [])];
      for (const entry of entries) {
        const exp = expected.variants.get(entry);
        if (!exp) throw new Error(`${fixture}: expected.json has no variant ${entry}`);
        const bundle = await bundleFixture(dir, entry, test.exportName);
        /** @type {Run[]} */
        const variantRuns = [];
        for (let i = 0; i < runs; i += 1) variantRuns.push(await runOnce(browser, bundle.code, test.steps));
        const first = variantRuns[0];
        if (!first) continue;
        firstRuns.set(entry, first);

        const problems = variantRuns.flatMap((run, i) => compare(run, exp).map((p) => `run ${i + 1}: ${p}`));
        const stable = variantRuns.every((run) => signature(run) === signature(first));
        if (!stable) problems.push('runs disagree with each other');
        const errors = [...new Set(variantRuns.flatMap((run) => run.pageErrors))];
        for (const p of problems) disagreements.push(`${fixture} / ${entry}: ${p}`);

        const counted = rendersAfterMount(first, Object.keys(exp.rendersAfterMount));
        console.log(`  ${entry}  (components counted: ${bundle.components.map((c) => `${c.name}@${c.file}:${c.line}`).join(', ')})`);
        console.log(`    commits             expected ${String(exp.commitCount).padStart(5)}  counted ${String(first.commits.length).padStart(5)}  ${first.commits.length === exp.commitCount ? 'OK' : 'DIFF'}`);
        summary.push([fixture, entry, 'commits', String(exp.commitCount), String(first.commits.length)]);
        for (const [name, n] of Object.entries(exp.rendersAfterMount)) {
          const got = counted[name] ?? 0;
          console.log(`    ${name.padEnd(19)} expected ${String(n).padStart(5)}  counted ${String(got).padStart(5)}  ${got === n ? 'OK' : 'DIFF'}`);
          summary.push([fixture, entry, name, String(n), String(got)]);
        }
        for (const name of Object.keys(counted)) {
          if (!(name in exp.rendersAfterMount)) {
            console.log(`    ${name.padEnd(19)} expected     -  counted ${String(counted[name]).padStart(5)}  DIFF (not in expected.json)`);
          }
        }
        console.log(`    per-update renders, trigger and phase: ${problems.length ? 'DIFF' : `all ${first.commits.length} match in all ${runs} runs`}`);
        console.log(`    input updates: median ${fmtMs(medianInputMs(first))} (run 1, Profiler actualDuration; orientation only)`);
        for (const p of problems) console.log(`    ! ${p}`);
        for (const e of errors) console.log(`    page: ${e}`);
        report.push({
          fixture,
          entry,
          react,
          components: bundle.components,
          problems,
          stable,
          errors,
          runs: variantRuns.map((run) => ({
            leftover: run.leftover,
            commits: run.commits.map((c) => ({ ...c, actualDuration: Math.round(c.actualDuration * 100) / 100 })),
          })),
        });
      }

      if (!claims) {
        console.log('  (no findings transcribed for this fixture)\n');
        continue;
      }
      const base = firstRuns.get(test.entry);
      if (!base) continue;
      const fixed = expected.fixedEntry ? firstRuns.get(expected.fixedEntry) : undefined;

      /** @type {Run | undefined} */
      let probe;
      if (claims.probe) {
        const { file, from, to, label } = claims.probe;
        const source = await readFile(path.join(dir, file), 'utf8');
        if (!source.includes(from)) throw new Error(`${fixture}: probe text not found in ${file}`);
        const changed = `${source.replace(from, to)}\nconst XC_STABLE_LAYOUT = { columns: 4, gap: 12 };\n`;
        const bundle = await bundleFixture(dir, test.entry, test.exportName, new Map([[file, changed]]));
        probe = await runOnce(browser, bundle.code, test.steps);
        console.log(`  probe (${label}): ${probe.commits.length} updates; after mount ${JSON.stringify(rendersAfterMount(probe, []))}`);
        report.push({ fixture, entry: `${test.entry} (probe: ${label})`, react, runs: [{ leftover: probe.leftover, commits: probe.commits }] });
      }

      /** @type {string[]} */
      const lines = [];
      for (const c of claims.rule1 ?? []) lines.push(`Rule 1, ${c.component}:`, ...rule1(c, base, fixed).map((l) => `  ${l}`));
      for (const c of claims.rule2 ?? []) lines.push(`Rule 2, ${c.component}:`, ...rule2(c, base, fixed).map((l) => `  ${l}`));
      if (!claims.rule1 && !claims.rule2) lines.push('Findings: none expected.');
      for (const n of claims.notReported) lines.push(`Not reported, ${n.label}: ${n.show(base, fixed, probe)}`);
      for (const l of lines) console.log(`  ${l}`);
      report.push({ fixture, findings: lines });
      console.log('');
    }
  } finally {
    await browser.close();
  }

  console.log(`Summary (React ${react}, run 1 shown; every run compared)`);
  console.log(`${'fixture'.padEnd(17)} ${'variant'.padEnd(22)} ${'row'.padEnd(13)} ${'expected'.padStart(8)} ${'counted'.padStart(8)}`);
  for (const [f, v, row, e, c] of summary) {
    console.log(`${f.padEnd(17)} ${v.padEnd(22)} ${row.padEnd(13)} ${e.padStart(8)} ${c.padStart(8)} ${e === c ? 'OK' : 'DIFF'}`);
  }
  if (json) {
    await writeFile(json, `${JSON.stringify({ react, reactDom, runs, disagreements, report }, null, 2)}\n`);
    console.log(`\nWrote ${json}`);
  }
  if (disagreements.length) {
    console.log(`\n${disagreements.length} disagreement(s):`);
    for (const d of disagreements) console.log(`  - ${d}`);
    process.exitCode = 1;
  } else {
    console.log('\nNo disagreements with expected.json.');
  }
}

await main();

#!/usr/bin/env node
// Phase 1 spike: record every React render of a fixture in headless Chrome.
// Usage: node record-renders.mjs [fixtureDir] [entryFile] [--json]
//   RT_CHANNEL=chrome node record-renders.mjs   (use your installed Chrome instead of Playwright's Chromium)
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const asJson = process.argv.includes('--json');
const fixtureDir = path.resolve(args[0] ?? path.join(here, '../fixtures/laggy-search'));
const test = JSON.parse(await readFile(path.join(fixtureDir, 'test.json'), 'utf8'));
const entry = args[1] ?? test.entry;
const exportName = test.exportName ?? 'default';
const ORIGIN = 'http://rendertrail.local';

const common = {
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minifySyntax: true, // drops React's dev-only branches (otherwise React logs a dead-code warning)
  keepNames: true, // keep component names exactly as written
  logLevel: 'silent',
  nodePaths: [path.join(here, 'node_modules')],
  // Production React with the profiling build: real-world speed, and React still measures render times.
  define: { 'process.env.NODE_ENV': '"production"' },
};

const importRoot = exportName === 'default' ? 'Root' : `{ ${exportName} as Root }`;
const app = await build({
  ...common,
  jsx: 'automatic',
  stdin: {
    contents: [
      `import { createRoot } from 'react-dom/profiling';`,
      `import ${importRoot} from './${entry}';`,
      `createRoot(document.getElementById('root')).render(<Root />);`,
    ].join('\n'),
    resolveDir: fixtureDir,
    loader: 'tsx',
    sourcefile: 'main.tsx',
  },
});
const instrumentation = await build({ ...common, entryPoints: [path.join(here, 'instrument.js')] });

const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const browser = await chromium.launch(process.env.RT_CHANNEL ? { channel: process.env.RT_CHANNEL } : {});

try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(`Page error: ${error.message}`));
  await page.addInitScript({ content: instrumentation.outputFiles[0].text });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: html });
    if (url === `${ORIGIN}/app.js`) return route.fulfill({ contentType: 'text/javascript', body: app.outputFiles[0].text });
    return route.abort(); // the recorded code gets no network access
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.__RT__ && window.__RT__.commits.length > 0, null, { timeout: 10_000 });

  for (const step of test.steps) {
    if (step.action === 'type') await page.locator(step.target).pressSequentially(step.text, { delay: step.delayMs ?? 50 });
    else if (step.action === 'click') await page.locator(step.target).click();
    else if (step.action === 'wait') await page.waitForTimeout(step.ms);
    else throw new Error(`Unknown step: ${JSON.stringify(step)}`);
  }

  const trace = await page.evaluate(() => window.__RT__);
  if (asJson) console.log(JSON.stringify(trace, null, 2));
  else report(trace);
} finally {
  await browser.close();
}

function report(trace) {
  if (trace.errors.length) console.log(`Instrumentation errors:\n${trace.errors.join('\n')}\n`);
  console.log(`${path.basename(fixtureDir)}/${entry}: ${trace.commits.length} commits\n`);

  for (const commit of trace.commits) {
    const groups = new Map();
    for (const r of commit.rendered) {
      const group = groups.get(r.name) ?? { name: r.name, memo: r.memo, count: 0, notes: new Set() };
      group.count += 1;
      for (const p of r.changedProps) {
        if (p.name === 'children') continue;
        group.notes.add(`${p.name} changed${p.sameValue ? ' (new reference, same value)' : ''}`);
      }
      for (const s of r.changedState) group.notes.add(`state #${s.hook} ${s.from} → ${s.to}`);
      groups.set(r.name, group);
    }
    const parts = [...groups.values()].map((g) => {
      const name = `${g.name}${g.count > 1 ? ` ×${g.count}` : ''}${g.memo ? ' [memo]' : ''}`;
      return g.notes.size ? `${name} {${[...g.notes].join('; ')}}` : name;
    });
    console.log(`#${String(commit.index).padEnd(3)} ${commit.trigger.padEnd(9)} ${commit.renderMs.toFixed(2).padStart(7)} ms   ${parts.join(', ')}`);
  }

  const renders = new Map();
  for (const commit of trace.commits.slice(1)) {
    for (const r of commit.rendered) renders.set(r.name, (renders.get(r.name) ?? 0) + 1);
  }
  console.log('\nRenders after mount:', [...renders].map(([name, n]) => `${name} ${n}`).join(', '));

  const inputCommits = trace.commits.filter((c) => c.trigger === 'input');
  const times = inputCommits.map((c) => c.renderMs).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;
  console.log(`Input commits: ${inputCommits.length}, median render ${median.toFixed(2)} ms; follow-up commits: ${trace.commits.filter((c) => c.trigger === 'follow-up').length}; later commits: ${trace.commits.filter((c) => c.trigger === 'later').length}`);
}

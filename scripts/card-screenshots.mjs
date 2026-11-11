// Screenshots of every card state from the harness, light and dark, at 400 and 720 px wide:
// `npm run card:screenshots` → .github/screenshots/phase-3/<state>-<theme>-<width>.png
// Only those files are replaced; the live host shots in phase-3/live/ are kept.
// Uses the installed Chrome (playwright-core, channel "chrome"), else Playwright's Chromium.
// Animations are finished before each shot (Playwright "animations: disabled"), so the tree rows show.
import { mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = path.join(root, '.github', 'screenshots', 'phase-3');
const resultsDir = path.join(root, 'ui', 'dev', 'results');

const results = (await readdir(resultsDir)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const states = ['waiting', 'receiving', 'failed', 'cancelled', ...results.sort()];
/** Extra shots with panels open: the state, a suffix, and the buttons to press. */
const opened = [
  { state: 'unfixed', suffix: 'open', press: ['Why does it happen?', 'Show me the line', 'How do I fix it?'] },
  { state: 'rerun-fixed', suffix: 'open', press: ['What changed in my code?'] },
  { state: 'rerun-all-fixed', suffix: 'open', press: ['What changed in my code?'] },
];
const themes = ['light', 'dark'];
const widths = [400, 720];
/** Checked for horizontal overflow only (HANDOFF.md §8: works from 320 px). */
const checkOnly = [320];

const server = await createServer({ configFile: path.join(root, 'ui', 'dev', 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5177/';

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch();
}

await mkdir(outDir, { recursive: true });
// Remove the old harness shots (files right in phase-3/), never the live/ folder.
for (const entry of await readdir(outDir, { withFileTypes: true })) {
  if (entry.isFile() && /-(light|dark)-d+.png$/.test(entry.name)) await unlink(path.join(outDir, entry.name));
}
const failures = [];
try {
  const shots = [
    ...states.map((state) => ({ state, suffix: '', press: [] })),
    ...opened.filter((o) => states.includes(o.state)),
  ];
  for (const theme of themes) {
    for (const width of [...checkOnly, ...widths]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on('pageerror', (err) => failures.push(`${theme} ${width}: ${err.message}`));
      for (const shot of shots) {
        await page.goto(`${base}?state=${shot.state}&theme=${theme}&bare=1`);
        await page.locator('.card').waitFor();
        for (const name of shot.press) await page.getByRole('button', { name }).click();
        await page.evaluate(() => document.fonts.ready);
        // No horizontal overflow, at any width.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) failures.push(`${shot.state} ${theme} ${width}: ${overflow}px horizontal overflow`);
        if (checkOnly.includes(width)) continue;
        const name = `${shot.state}${shot.suffix ? `-${shot.suffix}` : ''}-${theme}-${width}.png`;
        await page.getByTestId('frame').screenshot({ path: path.join(outDir, name), animations: 'disabled' });
        console.log(path.relative(root, path.join(outDir, name)));
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

// The README demo: `npm run demo:gif` → docs/demo.gif (720 px wide, under 30 s, under 3 MB).
// Drives the real card in the card harness (ui/dev, saved real results for fixtures/laggy-search):
// the answer → "Why does it happen?" → "Show me the line" → "How do I fix it?" → "Fix it and check"
// → recording → the re-run's "Fixed." card → "What changed in my code?".
// Frames are Playwright screenshots, decoded in the page and encoded with gifenc (no ffmpeg).
// Uses the installed Chrome (playwright-core, channel "chrome"), else Playwright's Chromium.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'docs', 'demo.gif');
const WIDTH = 720;
const HEIGHT = 800;
const FPS = 8;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SECONDS = 30;
/** Set RT_DEMO_FRAMES=<folder> to also save a PNG per frame, for review. */
const framesDir = process.env.RT_DEMO_FRAMES;

const server = await createServer({ configFile: path.join(root, 'ui', 'dev', 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5177/';

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
} catch {
  browser = await chromium.launch();
}

/** { png, ms }: one screenshot and how long it stays on screen. */
const frames = [];
try {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: 'light', deviceScaleFactor: 1 });
  const page = await context.newPage();
  // A little room around the card, as in a chat.
  const pad = () => page.addStyleTag({ content: '.bare .harness { padding: 16px 20px; }' });

  const shot = async (ms) => {
    const png = await page.screenshot({ type: 'png' });
    const last = frames.at(-1);
    if (last && last.png.equals(png)) last.ms += ms;
    else frames.push({ png, ms });
  };
  const hold = (ms) => shot(ms);
  /** Records whatever moves (the tree animation) for `ms`, at about FPS frames a second. */
  const film = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const start = Date.now();
      await shot(1000 / FPS);
      const spent = Date.now() - start;
      if (spent < 1000 / FPS) await page.waitForTimeout(1000 / FPS - spent);
      else frames.at(-1).ms = spent; // a slow screenshot: show it as long as it took
    }
  };
  /** Scrolls smoothly so `locator` sits near the bottom of the view (or to the top). */
  const scrollTo = async (locator) => {
    const from = await page.evaluate(() => window.scrollY);
    const to = locator
      ? await locator.evaluate((el, h) => Math.max(0, el.getBoundingClientRect().bottom + window.scrollY - h + 24), HEIGHT)
      : 0;
    const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    const target = Math.min(Math.max(to, 0), Math.max(max, 0));
    if (Math.abs(target - from) < 4) return;
    for (let i = 1; i <= 6; i += 1) {
      await page.evaluate((y) => window.scrollTo(0, y), from + ((target - from) * i) / 6);
      await shot(60);
    }
  };
  const open = async (name, holdMs) => {
    const button = page.getByRole('button', { name });
    await scrollTo(button);
    await button.hover();
    await hold(500);
    await button.click();
    await page.waitForTimeout(250);
    // Bring the panel the button opened into view.
    const panelId = await button.getAttribute('aria-controls');
    await scrollTo(panelId ? page.locator(`[id="${panelId}"]`) : button);
    await hold(holdMs);
  };
  const show = async (state) => {
    await page.goto(`${base}?state=${state}&theme=light&bare=1`);
    await pad();
    await page.locator('.card').waitFor();
    await page.evaluate(() => document.fonts.ready);
  };

  await show('unfixed');
  await film(2600);
  await hold(1500);
  await open('Why does it happen?', 2600);
  await open('Show me the line', 2600);
  await open('How do I fix it?', 2600);
  const fix = page.getByRole('button', { name: 'Fix it and check' });
  await scrollTo(fix);
  await fix.hover();
  await hold(900);
  await fix.click();
  await hold(500);

  await show('receiving'); // the recording skeleton while the re-run records
  await hold(1400);
  await show('rerun-fixed');
  await film(2400);
  await hold(1800);
  await open('What changed in my code?', 3200);

  // Decode the PNGs to RGBA in the page (no PNG decoder dependency).
  const decoder = await context.newPage();
  const encoder = GIFEncoder();
  let total = 0;
  for (const [index, frame] of frames.entries()) {
    const rgbaB64 = await decoder.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let s = '';
      for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return btoa(s);
    }, frame.png.toString('base64'));
    const rgba = new Uint8Array(Buffer.from(rgbaB64, 'base64'));
    const palette = quantize(rgba, 256);
    const delay = Math.round(frame.ms / 10) * 10;
    encoder.writeFrame(applyPalette(rgba, palette), WIDTH, HEIGHT, { palette, delay });
    total += delay;
    if (framesDir) await writeFile(path.join(framesDir, `frame-${String(index).padStart(3, '0')}.png`), frame.png);
  }
  encoder.finish();
  const bytes = encoder.bytes();
  await writeFile(out, bytes);
  console.log(`${path.relative(root, out)}: ${frames.length} frames, ${(total / 1000).toFixed(1)} s, ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
  if (bytes.length > MAX_BYTES || total / 1000 > MAX_SECONDS) {
    console.error(`Too big: keep it under ${MAX_BYTES / 1024 / 1024} MB and ${MAX_SECONDS} s.`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await server.close();
}

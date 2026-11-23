/**
 * The warm browser with real Chrome: reuse across calls, idle close, relaunch after a kill,
 * overlapping calls, a page stuck in a loop, and no Chrome left behind when the server stops
 * (stdin closed, or the server killed outright).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import { BRAND } from '../../src/brand.js';
import { WarmBrowser, warmBrowser } from '../../src/recorder/browser.js';
import { recordRender } from '../../src/recorder/index.js';
import { InspectRenderInputSchema } from '../../src/shared/types.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER = path.join(ROOT, 'dist', 'server.js');

const COUNTER = [
  `import { useState } from 'react';`,
  `export default function Counter() {`,
  `  const [n, setN] = useState(0);`,
  `  return <button id="inc" onClick={() => setN(n + 1)}>{n}</button>;`,
  `}`,
].join('\n');

const counterInput = {
  files: [{ path: 'Counter.tsx', content: COUNTER }],
  entry: 'Counter.tsx',
  steps: [
    { action: 'click', target: '#inc' },
    { action: 'click', target: '#inc' },
  ],
};
const input = InspectRenderInputSchema.parse(counterInput);

async function record() {
  const result = await recordRender(input);
  if (!result.ok) throw new Error(JSON.stringify(result.error, null, 2));
  return result;
}

/** pid → parent pid for every process on the machine. */
function processTable(): Map<number, number> {
  const table = new Map<number, number>();
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
      { encoding: 'utf8' },
    );
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid !== undefined) table.set(pid, ppid);
    }
  } else {
    for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid !== undefined) table.set(pid, ppid);
    }
  }
  return table;
}

function descendants(root: number): number[] {
  const table = processTable();
  const found: number[] = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const [pid, ppid] of table) {
      if (ppid === parent && !found.includes(pid)) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

/** Chrome's own list of its processes (browser, GPU, utility, one renderer per open page). */
async function processInfo(browser: Browser): Promise<{ type: string; id: number }[]> {
  const session = await browser.newBrowserCDPSession();
  const info = (await session.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
  await session.detach();
  return info.processInfo;
}

async function processTypes(browser: Browser): Promise<string[]> {
  return (await processInfo(browser)).map((p) => p.type);
}

// The warm browser stays up after a file's last call; close it rather than leave it to the worker's exit.
afterAll(() => warmBrowser.close());

describe('warm browser', () => {
  it('reuses the browser for the next call, with the same counts', async () => {
    await warmBrowser.close();
    const first = await record();
    const second = await record();
    expect(first.timing.browserReused).toBe(false);
    expect(second.timing.browserReused).toBe(true);
    expect(second.timing.launchMs).toBeLessThan(first.timing.launchMs);
    expect(second.summary.commits.map((c) => c.rendered)).toEqual(first.summary.commits.map((c) => c.rendered));
    expect(second.summary.commitCount).toBe(3);
  });

  it('times every phase of every run', async () => {
    const { timing } = await record();
    expect(Object.keys(timing).sort()).toEqual(
      ['browserReused', 'bundleMs', 'instrumentationMs', 'launchMs', 'queueMs', 'runs', 'summarizeMs'].sort(),
    );
    expect(timing.runs).toHaveLength(3);
    for (const run of timing.runs) {
      expect(Object.keys(run).sort()).toEqual(['closeMs', 'collectMs', 'contextMs', 'loadMountMs', 'scriptedMs', 'stepsMs', 'totalMs']);
      expect(run.scriptedMs).toBe(0);
      expect(run.totalMs).toBeGreaterThanOrEqual(run.contextMs + run.loadMountMs + run.stepsMs + run.collectMs - 1);
    }
  });

  it('launches a new browser when the warm one was killed', async () => {
    await record();
    const browser = warmBrowser.peek();
    if (!browser) throw new Error('no warm browser');
    const pid = (await processInfo(browser)).find((p) => p.type === 'browser')?.id;
    if (!pid) throw new Error('no browser process id');
    const gone = new Promise((resolve) => browser.once('disconnected', resolve));
    process.kill(pid);
    await gone;
    const after = await record();
    expect(after.timing.browserReused).toBe(false);
    expect(after.summary.commitCount).toBe(3);
    expect(warmBrowser.peek()).not.toBe(browser);
  });

  it('runs two overlapping calls one after the other in the same browser', async () => {
    await record();
    const [a, b] = await Promise.all([recordRender(input), recordRender(input)]);
    if (!a.ok || !b.ok) throw new Error('a call failed');
    expect(a.timing.browserReused && b.timing.browserReused).toBe(true);
    expect(b.timing.queueMs).toBeGreaterThan(a.timing.runs.reduce((sum, run) => sum + run.totalMs, 0));
    expect(b.summary.commits.map((c) => c.rendered)).toEqual(a.summary.commits.map((c) => c.rendered));
  });

  it('a page stuck in a loop costs that call, not the next one', async () => {
    const stuck = InspectRenderInputSchema.parse({
      files: [
        {
          path: 'Stuck.tsx',
          content: `export default function Stuck() { return <button id="b" onClick={() => { for (;;) {} }}>x</button>; }`,
        },
      ],
      entry: 'Stuck.tsx',
      steps: [
        { action: 'click', target: '#b' },
        { action: 'click', target: '#b' },
      ],
    });
    const failed = await recordRender(stuck);
    if (failed.ok) throw new Error('the stuck page recorded');
    if (failed.error.kind === 'timeout') {
      // A run that timed out never keeps its browser.
      expect(warmBrowser.peek()).toBeUndefined();
    } else {
      // The click gave up first (a step error) and the browser was kept: the looping page's
      // process must be gone with its context.
      expect(failed.error.kind).toBe('step');
      const browser = warmBrowser.peek();
      if (!browser) throw new Error('the browser was not kept after a step error');
      expect((await processTypes(browser)).filter((type) => type === 'renderer')).toEqual([]);
    }
    const next = await record();
    expect(next.summary.commitCount).toBe(3);
    expect(next.timing.runs.every((run) => run.totalMs < 5_000)).toBe(true);
  });

  it('a run past its time limit discards the browser', async () => {
    await record();
    const before = warmBrowser.peek();
    if (!before) throw new Error('no warm browser');
    const slow = InspectRenderInputSchema.parse({
      ...counterInput,
      steps: Array.from({ length: 5 }, () => ({ action: 'wait', ms: 5_000 })), // 25 s, past the 20 s limit
    });
    const result = await recordRender(slow);
    expect(!result.ok && result.error.kind).toBe('timeout');
    expect(warmBrowser.peek()).toBeUndefined();
    expect(await waitUntil(() => !before.isConnected(), 10_000)).toBe(true);
    expect((await record()).timing.browserReused).toBe(false);
  });

  it('closes an idle browser after the idle time', async () => {
    const warm = new WarmBrowser(undefined, 500);
    const lease = await warm.acquire();
    const browser = lease.launched.browser;
    lease.release();
    expect(browser.isConnected()).toBe(true);
    expect(await waitUntil(() => !browser.isConnected(), 10_000)).toBe(true);
    expect(warm.peek()).toBeUndefined();
  });
});

describe.skipIf(!existsSync(SERVER))('no Chrome left behind by dist/server.js (needs `npm run build`)', () => {
  function startServer() {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env } });
    let buffer = '';
    const replies = new Map<number, (message: unknown) => void>();
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined) replies.get(message.id)?.(message);
      }
    });
    let id = 0;
    const rpc = (method: string, params: object) =>
      new Promise<unknown>((resolve) => {
        id += 1;
        replies.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const ready = rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'orphans', version: '0' },
    }).then(() => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    });
    const call = (args: object) =>
      rpc('tools/call', { name: 'inspect_render', arguments: args }) as Promise<{
        result?: { structuredContent?: { run?: unknown }; _meta?: Record<string, unknown> };
      }>;
    return { child, exited, ready, call };
  }

  async function serverWithWarmBrowser() {
    const server = startServer();
    await server.ready;
    const reply = await server.call(counterInput);
    expect(reply.result?.structuredContent?.run).toBeDefined();
    expect(reply.result?._meta?.[BRAND.timingMetaKey]).toMatchObject({ browserReused: false });
    const chrome = descendants(server.child.pid!);
    expect(chrome.length).toBeGreaterThan(0); // the warm browser and its helpers
    return { ...server, chrome };
  }

  async function allGone(chrome: number[], ms: number): Promise<void> {
    const ok = await waitUntil(() => chrome.every((pid) => !alive(pid)), ms);
    expect(ok, `left: ${chrome.filter(alive).join(', ')}`).toBe(true);
  }

  it('closing stdin stops the server and its browser', async () => {
    const { child, exited, chrome } = await serverWithWarmBrowser();
    child.stdin.end();
    await exited;
    await allGone(chrome, 10_000);
  });

  it('closing stdin while a call is recording stops the server and its browser', async () => {
    const server = startServer();
    await server.ready;
    void server.call({ ...counterInput, steps: [{ action: 'wait', ms: 4_000 }] });
    // Chrome and its helpers are up and the first run has started.
    expect(await waitUntil(() => descendants(server.child.pid!).length >= 3, 20_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const chrome = descendants(server.child.pid!);
    server.child.stdin.end();
    await server.exited;
    await allGone(chrome, 10_000);
  });

  it.skipIf(process.platform === 'win32')('SIGTERM stops the server and its browser (POSIX)', async () => {
    const { child, exited, chrome } = await serverWithWarmBrowser();
    child.kill('SIGTERM');
    await exited;
    expect(child.exitCode).toBe(143);
    await allGone(chrome, 10_000);
  });

  it('killing the server outright leaves no browser behind', async () => {
    const { child, exited, chrome } = await serverWithWarmBrowser();
    child.kill('SIGKILL');
    await exited;
    await allGone(chrome, 15_000);
  });
});

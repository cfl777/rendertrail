// Where an inspect_render call spends its time: `node scripts/time-run.mjs [fixture ...] [--calls N]
// [--mode cold|warm|both] [--json file] [--server path/to/server.js ...]`. Needs `npm run build`
// first: it drives dist/server.js over stdio, the way Claude Desktop and Claude Code do, and reads
// the timing each result carries in `_meta` (under "<package name>/timing"; older builds put it in
// structuredContent.run.timing).
//   cold: a fresh server process per call (process start, first browser launch, first TypeScript load)
//   warm: one server process for all calls; calls 2..N+1 are the warm path (call 1 is left out)
// Several --server builds (e.g. a copy of an older dist/ kept inside the checkout, so it finds
// node_modules) are measured call by call in turn, so a busy machine slows them all alike.
// Prints medians per phase, and the median input-commit time per call so a speed-up can be checked
// not to change what is measured. Runs go to a temp folder; counting is forced off. Nothing is sent
// anywhere: the recorded page has no network, and this script only talks to its own child process.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const TIMING_KEY = `${JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name}/timing`;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const servers = [];
for (let s = option('--server'); s; s = option('--server')) servers.push(path.resolve(s));
if (!servers.length) servers.push(path.join(root, 'dist', 'server.js'));
const label = (server) => path.basename(path.dirname(server));
const calls = Number(option('--calls', '5'));
const mode = option('--mode', 'both');
const jsonOut = option('--json', undefined);
const fixtures = args.length ? args : ['laggy-search'];

for (const server of servers) {
  if (!existsSync(server)) {
    console.error(`${server} is missing: run npm run build first.`);
    process.exit(1);
  }
}

function loadFixture(name) {
  const dir = path.join(root, 'fixtures', name);
  const test = JSON.parse(readFileSync(path.join(dir, 'test.json'), 'utf8'));
  const files = readdirSync(dir)
    .filter((file) => /\.tsx?$/.test(file) && !file.includes('.fixed'))
    .map((file) => ({ path: file, content: readFileSync(path.join(dir, file), 'utf8') }));
  return { ...test, files };
}

/** A stdio MCP client for one server process. */
function startServer(server, env) {
  const started = performance.now();
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'], env });
  const pending = new Map();
  let buffer = '';
  let nextId = 0;
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const rpc = (method, params) =>
    new Promise((resolve) => {
      nextId += 1;
      pending.set(nextId, resolve);
      send({ id: nextId, method, params });
    });
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'time-run', version: '0' } }).then(() => {
    send({ method: 'notifications/initialized' });
    return performance.now() - started;
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return {
    ready,
    async call(input) {
      const t = performance.now();
      const reply = await rpc('tools/call', { name: 'inspect_render', arguments: input });
      const clientMs = performance.now() - t;
      const output = reply.result?.structuredContent;
      const timing = reply.result?._meta?.[TIMING_KEY] ?? output?.run?.timing;
      if (!timing || !output?.run) throw new Error(`no timing in the result: ${JSON.stringify(reply).slice(0, 2000)}`);
      return { clientMs, timing, summary: output.run.summary };
    },
    async stop() {
      child.stdin.end(); // the way a host closes a stdio server
      const timer = setTimeout(() => child.kill(), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

function sample(clientMs, timing, summary, startMs) {
  const input = summary.commits.filter((c) => c.trigger === 'input');
  const perRun = [0, 1, 2].map((r) => median(input.map((c) => c.renderMsRuns[r] ?? 0)));
  const runs = timing.runs;
  const sum = (key) => runs.reduce((s, run) => s + run[key], 0);
  return {
    processStartMs: startMs,
    clientMs,
    startAndCallMs: startMs + clientMs,
    queueMs: timing.queueMs ?? 0, // older builds had no queue
    bundleMs: timing.bundleMs,
    instrumentationMs: timing.instrumentationMs,
    launchMs: timing.launchMs,
    browserReused: timing.browserReused,
    contextMs: sum('contextMs'),
    loadMountMs: sum('loadMountMs'),
    scriptedMs: sum('scriptedMs'),
    stepsOtherMs: sum('stepsMs') - sum('scriptedMs'),
    collectMs: sum('collectMs'),
    closeMs: sum('closeMs'),
    runsMs: sum('totalMs'),
    summarizeMs: timing.summarizeMs,
    analyzeMs: timing.analyzeMs,
    storeMs: timing.storeMs,
    totalMs: timing.totalMs,
    otherMs:
      timing.totalMs -
      (timing.queueMs ?? 0) -
      timing.bundleMs -
      timing.instrumentationMs -
      timing.launchMs -
      sum('totalMs') -
      timing.summarizeMs -
      timing.analyzeMs -
      timing.storeMs,
    inputMedianMs: summary.timings.inputMedianMs,
    inputMedianByRun: perRun,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function measure(name, which, runsDir) {
  const input = loadFixture(name);
  const env = { ...process.env, RENDERTRAIL_RUNS_DIR: runsDir, RENDERTRAIL_TELEMETRY: '0' };
  const samples = Object.fromEntries(servers.map((server) => [server, []]));
  if (which === 'cold') {
    for (let i = 0; i < calls; i += 1) {
      for (const server of servers) {
        const s = startServer(server, env);
        const startMs = await s.ready;
        const { clientMs, timing, summary } = await s.call(input);
        samples[server].push(sample(clientMs, timing, summary, startMs));
        await s.stop();
      }
    }
  } else {
    const started = servers.map((server) => [server, startServer(server, env)]);
    for (const [, s] of started) await s.ready;
    for (let i = 0; i < calls + 1; i += 1) {
      for (const [server, s] of started) {
        const { clientMs, timing, summary } = await s.call(input);
        if (i > 0) samples[server].push(sample(clientMs, timing, summary, 0)); // call 1 is the cold one
      }
    }
    for (const [, s] of started) await s.stop();
  }
  return Object.fromEntries(servers.map((server) => [`${which} ${label(server)}`, samples[server]]));
}

const ROWS = [
  ['processStartMs', 'process start (spawn → MCP ready)'],
  ['queueMs', 'waiting for another call'],
  ['bundleMs', 'bundle (esbuild)'],
  ['instrumentationMs', 'load page instrumentation'],
  ['launchMs', 'browser launch'],
  ['contextMs', '3 runs: new context + page'],
  ['loadMountMs', '3 runs: load + first render'],
  ['scriptedMs', '3 runs: scripted waits + typing delays'],
  ['stepsOtherMs', '3 runs: steps, the rest'],
  ['collectMs', '3 runs: collect trace'],
  ['closeMs', '3 runs: close context'],
  ['runsMs', '3 runs: total'],
  ['summarizeMs', 'summarize'],
  ['analyzeMs', 'analyze (incl. TypeScript load)'],
  ['storeMs', 'store write'],
  ['otherMs', 'not in a phase above'],
  ['totalMs', 'server total'],
  ['clientMs', 'tools/call round trip (no process start)'],
  ['startAndCallMs', 'process start + round trip (cold only)'],
];

const RANGED = new Set(['totalMs', 'clientMs', 'startAndCallMs']);
const fmt = (n) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));
const results = {};
const runsDir = mkdtempSync(path.join(os.tmpdir(), 'rendertrail-time-'));
try {
  for (const name of fixtures) {
    results[name] = {};
    for (const which of mode === 'both' ? ['cold', 'warm'] : [mode]) {
      Object.assign(results[name], await measure(name, which, runsDir));
    }
    const modes = Object.keys(results[name]);
    console.log(`\n${name}: medians of ${calls} calls (ms)`);
    console.log(`| phase | ${modes.join(' | ')} |`);
    console.log(`|---|${modes.map(() => '---:').join('|')}|`);
    for (const [key, label] of ROWS) {
      const cells = modes.map((m) => {
        if ((key === 'processStartMs' || key === 'startAndCallMs') && m.startsWith('warm')) return '–';
        const values = results[name][m].map((s) => s[key]);
        const cell = fmt(median(values));
        // Totals with their range: medians of phases don't add up to the median total.
        return RANGED.has(key) ? `${cell} (${fmt(Math.min(...values))}–${fmt(Math.max(...values))})` : cell;
      });
      console.log(`| ${label} | ${cells.join(' | ')} |`);
    }
    for (const m of modes) {
      const values = results[name][m].map((s) => s.inputMedianMs);
      const byRun = [0, 1, 2].map((r) => fmt(median(results[name][m].map((s) => s.inputMedianByRun[r]))));
      console.log(
        `${m}: input-commit median per call ${values.map(fmt).join(', ')} ` +
          `(median ${fmt(median(values))}, min ${fmt(Math.min(...values))}, max ${fmt(Math.max(...values))}); ` +
          `by run 1/2/3: ${byRun.join(' / ')}; browser reused in ${results[name][m].filter((s) => s.browserReused).length} of ${values.length} calls`,
      );
    }
  }
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
} finally {
  rmSync(runsDir, { recursive: true, force: true });
}

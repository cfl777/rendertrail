// The package as a stranger gets it: `npm run test:pack` (builds first; CI runs this script after
// its build). Packs the tarball, installs it in an empty temp folder outside the repo, runs the
// installed `rendertrail --version`, then initialize + tools/list over stdio, and checks the
// answers. Exits non-zero on any failure. Installing downloads the dependencies from npm.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath;
/** npm as a node script, so no shell is needed (npm.cmd on Windows can't run without one). */
function npm(args, cwd) {
  const cli =
    npmCli && /\.c?js$/.test(npmCli)
      ? npmCli
      : process.platform === 'win32'
        ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : null;
  if (cli) return execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  return execFileSync('npm', args, { cwd, encoding: 'utf8' });
}
function fail(message) {
  throw new Error(message);
}

for (const file of pkg.files) {
  if (!existsSync(path.join(root, file))) {
    console.error(`test:pack failed: ${file} is missing: run npm run build first.`);
    process.exit(1);
  }
}

const work = mkdtempSync(path.join(os.tmpdir(), `${pkg.name}-pack-`));
try {
  npm(['pack', '--ignore-scripts', '--silent', '--pack-destination', work], root);
  const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'));
  if (!tarball) fail('npm pack produced no tarball');
  const app = path.join(work, 'app');
  mkdirSync(app);
  writeFileSync(path.join(app, 'package.json'), '{ "private": true }\n');
  npm(['install', path.join(work, tarball), '--no-audit', '--no-fund', '--silent'], app);

  const installed = path.join(app, 'node_modules', pkg.name);
  const bin = path.join(app, 'node_modules', '.bin', process.platform === 'win32' ? `${pkg.name}.cmd` : pkg.name);
  if (!existsSync(bin)) fail(`no ${path.relative(app, bin)} after install`);
  const entry = path.join(installed, pkg.bin[pkg.name]);
  const version = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).trim();
  if (version !== pkg.version) fail(`--version printed "${version}", expected "${pkg.version}"`);
  console.log(`installed ${tarball}: --version ${version}`);

  const child = spawn(process.execPath, [entry], { cwd: app, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  const other = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        replies.get(message.id)?.(message);
      } catch {
        other.push(line);
      }
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} within 20 s`)), 20_000);
      replies.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-pack', version: '0' } });
    if (init.result?.serverInfo?.version !== pkg.version) fail(`initialize answered ${JSON.stringify(init.result?.serverInfo)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await rpc('tools/list', {});
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    if (names.join() !== 'inspect_render') fail(`tools/list answered ${JSON.stringify(names)}`);
    if (other.length) fail(`stdout had non-protocol lines: ${other.join(' | ')}`);
    console.log(`stdio: ${init.result.serverInfo.name} ${init.result.serverInfo.version}, tools: ${names.join(', ')}`);
  } finally {
    child.kill();
  }
} catch (err) {
  console.error(`test:pack failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}

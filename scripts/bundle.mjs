// Builds the MCP Bundle for Claude Desktop: `npm run bundle` (builds first) → dist/<name>.mcpb.
// Stages manifest.json, the built server (dist/server.js, card.html, instrument.js) and the
// production node_modules (npm ci --omit=dev) in dist/mcpb/, then runs `mcpb validate` and
// `mcpb pack`. esbuild is the only native dependency: its binaries for the other Claude Desktop
// platforms (macOS and Windows, x64 and arm64) are added, so one bundle works on all of them when
// it's built on macOS or Linux (see the Windows note below). Not signed.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = path.join(root, 'dist', 'mcpb');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const pkg = readJson(path.join(root, 'package.json'));
const manifest = readJson(path.join(root, 'manifest.json'));
const out = path.join(root, 'dist', `${pkg.name}.mcpb`);
const ESBUILD_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'];

// npm and the mcpb CLI run as node scripts, so no shell is needed (npm is a .cmd file on Windows).
const npmCli = process.env.npm_execpath;
function npm(args, cwd) {
  if (npmCli && /\.c?js$/.test(npmCli)) execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' });
  else execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}
const mcpbCli = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
function mcpb(args) {
  execFileSync(process.execPath, [mcpbCli, ...args], { cwd: root, stdio: 'inherit' });
}

if (manifest.version !== pkg.version || manifest.name !== pkg.name) {
  console.error(`manifest.json (${manifest.name} ${manifest.version}) doesn't match package.json (${pkg.name} ${pkg.version}).`);
  process.exit(1);
}
const built = ['server.js', 'card.html', 'instrument.js'];
for (const file of built) {
  if (!existsSync(path.join(root, 'dist', file))) {
    console.error(`dist/${file} is missing: run \`npm run build\` first (\`npm run bundle\` does).`);
    process.exit(1);
  }
}

rmSync(stage, { recursive: true, force: true });
rmSync(out, { force: true });
mkdirSync(path.join(stage, 'dist'), { recursive: true });
for (const file of ['manifest.json', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']) {
  cpSync(path.join(root, file), path.join(stage, file));
}
for (const file of built) cpSync(path.join(root, 'dist', file), path.join(stage, 'dist', file));

npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);

const esbuildVersion = readJson(path.join(stage, 'node_modules', 'esbuild', 'package.json')).version;
const tarballs = path.join(root, 'dist', 'mcpb-esbuild');
mkdirSync(tarballs, { recursive: true });
for (const platform of ESBUILD_PLATFORMS) {
  const target = path.join(stage, 'node_modules', '@esbuild', platform);
  if (existsSync(target)) continue;
  const spec = `@esbuild/${platform}@${esbuildVersion}`;
  const file = `esbuild-${platform}-${esbuildVersion}.tgz`;
  if (!existsSync(path.join(tarballs, file))) npm(['pack', spec, '--silent'], tarballs);
  mkdirSync(target, { recursive: true });
  // A relative path: GNU tar reads "C:..." as a remote host.
  execFileSync('tar', ['-xzf', path.relative(target, path.join(tarballs, file)), '--strip-components=1'], { cwd: target, stdio: 'inherit' });
}

if (process.platform === 'win32') {
  // Windows has no executable bit, so the macOS esbuild binaries go into the zip without one and
  // esbuild can't start there. Fine for trying it on Windows; build the release bundle elsewhere.
  console.warn('Note: built on Windows, this bundle works on Windows only. Build release bundles on macOS or Linux.');
} else {
  for (const platform of ESBUILD_PLATFORMS.filter((p) => p.startsWith('darwin'))) {
    const bin = path.join(stage, 'node_modules', '@esbuild', platform, 'bin', 'esbuild');
    if ((statSync(bin).mode & 0o111) === 0) throw new Error(`${bin} isn't executable`);
  }
}

mcpb(['validate', path.join(stage, 'manifest.json')]);
mcpb(['pack', stage, out]);
console.log(`${path.relative(root, out)}: ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB`);

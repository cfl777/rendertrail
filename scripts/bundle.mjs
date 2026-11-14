// Builds the MCP Bundle for Claude Desktop: `npm run bundle` (builds first) → dist/<name>.mcpb.
// Stages manifest.json, the built files (dist/server.js, start.js, card.html, instrument.js) and
// the production node_modules (npm ci --omit=dev) in dist/mcpb/, trims what the server never loads
// (.mcpbignore), then runs `mcpb validate` and `mcpb pack`. Not signed.
//
// esbuild is the only native dependency: its binaries for the Claude Desktop platforms (macOS and
// Windows, x64 and arm64) are added so one bundle works on all of them. That needs macOS or Linux:
// Windows has no executable bit, so a bundle built there can't start esbuild on macOS. On Windows
// the script builds dist/<name>-win32.mcpb instead, with only the Windows binaries and
// `compatibility.platforms: ["win32"]`, and says so.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = path.join(root, 'dist', 'mcpb');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const pkg = readJson(path.join(root, 'package.json'));
const manifest = readJson(path.join(root, 'manifest.json'));
const windowsOnly = process.platform === 'win32';
const out = path.join(root, 'dist', `${pkg.name}${windowsOnly ? '-win32' : ''}.mcpb`);
const ESBUILD_PLATFORMS = windowsOnly ? ['win32-x64', 'win32-arm64'] : ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'];
const built = ['server.js', 'start.js', 'card.html', 'instrument.js'];

/** Never loaded by the server: TypeScript's compiler CLIs, language service and messages, Playwright's bundled Vite apps, source maps, esbuild for Linux. */
const MCPB_IGNORE = `node_modules/typescript/lib/*
!node_modules/typescript/lib/typescript.js
node_modules/typescript/bin/
node_modules/playwright-core/lib/vite/
node_modules/@esbuild/linux-*
**/*.map
`;

/** npm and the mcpb CLI run as node scripts, so no shell is needed (npm.cmd on Windows can't run without one). */
const npmCli = process.env.npm_execpath;
function npm(args, cwd) {
  const cli =
    npmCli && /\.c?js$/.test(npmCli)
      ? npmCli
      : process.platform === 'win32'
        ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : null;
  if (cli) execFileSync(process.execPath, [cli, ...args], { cwd, stdio: 'inherit' });
  else execFileSync('npm', args, { cwd, stdio: 'inherit' });
}
const mcpbCli = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
function mcpb(args) {
  execFileSync(process.execPath, [mcpbCli, ...args], { cwd: root, stdio: 'inherit' });
}

if (manifest.version !== pkg.version || manifest.name !== pkg.name) {
  console.error(`manifest.json (${manifest.name} ${manifest.version}) doesn't match package.json (${pkg.name} ${pkg.version}).`);
  process.exit(1);
}
for (const file of built) {
  if (!existsSync(path.join(root, 'dist', file))) {
    console.error(`dist/${file} is missing: run \`npm run build\` first (\`npm run bundle\` does).`);
    process.exit(1);
  }
}

rmSync(stage, { recursive: true, force: true });
rmSync(out, { force: true });
mkdirSync(path.join(stage, 'dist'), { recursive: true });
for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'README.md']) cpSync(path.join(root, file), path.join(stage, file));
const staged = windowsOnly ? { ...manifest, compatibility: { ...manifest.compatibility, platforms: ['win32'] } } : manifest;
writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(staged, null, 2)}\n`);
writeFileSync(path.join(stage, '.mcpbignore'), MCPB_IGNORE);
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

if (windowsOnly) {
  console.warn(
    `Note: built on Windows, so this bundle is for Windows only (${path.basename(out)}): Windows can't mark ` +
      "esbuild's macOS binaries as executable. Build the release bundle on macOS or Linux (CI does).",
  );
} else {
  for (const platform of ESBUILD_PLATFORMS.filter((p) => p.startsWith('darwin'))) {
    const bin = path.join(stage, 'node_modules', '@esbuild', platform, 'bin', 'esbuild');
    if ((statSync(bin).mode & 0o111) === 0) throw new Error(`${bin} isn't executable`);
  }
}

mcpb(['validate', path.join(stage, 'manifest.json')]);
mcpb(['pack', stage, out]);
console.log(`${path.relative(root, out)}: ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB`);

/**
 * The `rendertrail` command, bundled to dist/server.js.
 *   rendertrail                     stdio MCP server (Claude Desktop, Claude Code)
 *   rendertrail --http              Streamable HTTP MCP server on 127.0.0.1 (ext-apps basic-host, card work)
 *   rendertrail --version | --help | --telemetry-status   print and exit
 * The servers live in ./start.ts (dist/start.js), loaded only when needed. In stdio mode stdout
 * carries the protocol only: anything else goes to stderr.
 */
import pkg from '../../package.json' with { type: 'json' };
import { BRAND } from '../brand.js';
import { telemetryStatus } from '../store/counts.js';

const HELP = `${BRAND.displayName} ${pkg.version}: records how React components render in headless Chrome and explains the main performance problem.

Usage: ${BRAND.name} [option]

  (no option)          Start the MCP server over stdio. Claude Desktop and Claude Code run this.
  --http               Start the MCP server over HTTP on http://127.0.0.1:3001/mcp (PORT overrides).
  --telemetry-status   Show whether the opt-in anonymous counts are on, and the counts so far.
  --version, -v        Print the version.
  --help, -h           Print this help.

Runs are stored in ~/${BRAND.homeDir}/runs (${BRAND.runsDirEnv} overrides). Needs Google Chrome, or
Playwright's Chromium. More: ${pkg.homepage}
`;

const args = process.argv.slice(2);
const KNOWN = ['--http', '--version', '-v', '--help', '-h', '--telemetry-status'];
const unknown = args.filter((arg) => !KNOWN.includes(arg));

if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(' ')}

${HELP}`);
  process.exit(2);
} else if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version);
} else if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
} else if (args.includes('--telemetry-status')) {
  console.log(await telemetryStatus());
} else {
  // Loaded only now: the MCP SDK, esbuild and playwright-core take a second to load.
  const { startHttp, startStdio } = await import('./start.js');
  if (args.includes('--http')) {
    startHttp(Number(process.env.PORT ?? 3001));
  } else {
    startStdio().catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
  }
}

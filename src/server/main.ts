/**
 * Entry point, bundled to dist/server.js.
 *   node dist/server.js          stdio (Claude Desktop, Claude Code)
 *   node dist/server.js --http   Streamable HTTP on 127.0.0.1 (ext-apps basic-host, card work)
 */
import http from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import pkg from '../../package.json' with { type: 'json' };
import { BRAND } from '../brand.js';
import { telemetryStatus } from '../store/counts.js';
import { createServer } from './server.js';

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

function startHttp(port: number): void {
  // Binding to 127.0.0.1 does not stop DNS rebinding: a page on another site can point its
  // DNS at 127.0.0.1 and reach this port same-origin. Refuse any Host or Origin that is not
  // localhost before doing anything else (both guards answer 403 themselves).
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const httpServer = http.createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    // Stateless: a fresh server and transport per request.
    const server = createServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err: unknown) => {
        console.error('MCP error:', err instanceof Error ? err.message : err);
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  httpServer.listen(port, '127.0.0.1', () => {
    console.error(`MCP server listening on http://127.0.0.1:${port}/mcp`);
  });
}

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
} else if (args.includes('--http')) {
  startHttp(Number(process.env.PORT ?? 3001));
} else {
  startStdio().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

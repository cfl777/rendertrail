/**
 * Starts the MCP server: over stdio (Claude Desktop, Claude Code) or Streamable HTTP on 127.0.0.1
 * (ext-apps basic-host, card work). Built to dist/start.js and loaded by dist/server.js only when
 * a server is wanted, so --version and --help don't load the MCP SDK, esbuild or playwright-core.
 */
import http from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { closeWarmBrowser } from '../recorder/browser.js';
import { createServer } from './server.js';

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * The recorder keeps a browser warm between calls. Close it when the process is told to stop, so no
 * Chrome is left behind. (A hard kill can't be caught: then Chrome exits by itself when its pipe to
 * this process breaks.)
 */
function closeBrowserOnShutdown(): void {
  let stopping = false;
  const stop = (code: number) => (): void => {
    if (stopping) return;
    stopping = true;
    void closeWarmBrowser().finally(() => process.exit(code));
  };
  process.once('SIGINT', stop(130));
  process.once('SIGTERM', stop(143));
  process.once('SIGHUP', stop(129));
}

export async function startStdio(): Promise<void> {
  closeBrowserOnShutdown();
  // The host closes stdin to stop a stdio server: close the browser, so nothing keeps this process
  // alive and it exits by itself, as it did before the browser stayed warm.
  const onStdinGone = (): void => {
    void closeWarmBrowser();
  };
  process.stdin.once('end', onStdinGone);
  process.stdin.once('close', onStdinGone);
  await createServer().connect(new StdioServerTransport());
}

export function startHttp(port: number): void {
  closeBrowserOnShutdown();
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

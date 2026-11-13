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
import { createServer } from './server.js';

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

export function startHttp(port: number): void {
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

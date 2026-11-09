/**
 * Entry point, bundled to dist/server.js.
 *   node dist/server.js          stdio (Claude Desktop, Claude Code)
 *   node dist/server.js --http   Streamable HTTP on 127.0.0.1 (ext-apps basic-host, card work)
 */
import http from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

function startHttp(port: number): void {
  const httpServer = http.createServer((req, res) => {
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

if (process.argv.includes('--http')) {
  startHttp(Number(process.env.PORT ?? 3001));
} else {
  startStdio().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

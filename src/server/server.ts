import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { BRAND } from '../brand.js';
import { SCHEMA_VERSION, type HelloResult } from '../shared/types.js';

// The bundled server is dist/server.js; the card is built next to it.
const CARD_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'card.html');

export function createServer(): McpServer {
  const server = new McpServer({ name: BRAND.serverName, version: pkg.version });

  // Temporary Phase 0 tool: proves the tool → card wiring. Removed when inspect_render lands.
  registerAppTool(
    server,
    'hello',
    {
      title: `${BRAND.displayName} hello (temporary)`,
      description: `Temporary test tool for ${BRAND.displayName} setup. Greets someone and shows a test card.`,
      inputSchema: { name: z.string().max(100).default('world').describe('Who to greet') },
      _meta: { ui: { resourceUri: BRAND.cardResourceUri } },
    },
    ({ name }): CallToolResult => {
      const result: HelloResult = {
        schemaVersion: SCHEMA_VERSION,
        greeting: `Hello, ${name}!`,
        name,
        serverTime: new Date().toISOString(),
      };
      return {
        // Stands alone: Claude Code shows only this text.
        content: [
          {
            type: 'text',
            text: `${result.greeting} ${BRAND.displayName} is connected. Server time: ${result.serverTime}.`,
          },
        ],
        structuredContent: { ...result },
      };
    },
  );

  registerAppResource(
    server,
    `${BRAND.displayName} card`,
    BRAND.cardResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: BRAND.cardResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await fs.readFile(CARD_HTML_PATH, 'utf-8'),
          _meta: {
            ui: {
              prefersBorder: false,
              csp: { resourceDomains: ['https://assets.claude.ai'] },
            },
          },
        },
      ],
    }),
  );

  return server;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import pkg from '../../package.json' with { type: 'json' };
import { BRAND } from '../brand.js';
import { InspectRenderInputShape } from '../shared/types.js';
import { INSPECT_RENDER_DESCRIPTION, inspectRender } from './inspect-render.js';

// The bundled server is dist/server.js; the card is built next to it.
const CARD_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'card.html');

export function createServer(): McpServer {
  const server = new McpServer({ name: BRAND.serverName, version: pkg.version });

  registerAppTool(
    server,
    'inspect_render',
    {
      title: `${BRAND.displayName}: inspect render`,
      description: INSPECT_RENDER_DESCRIPTION,
      inputSchema: InspectRenderInputShape,
      _meta: { ui: { resourceUri: BRAND.cardResourceUri } },
    },
    (input) => inspectRender(input),
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
              // Lets "Copy for PR" use navigator.clipboard (Permission Policy clipboard-write).
              permissions: { clipboardWrite: {} },
            },
          },
        },
      ],
    }),
  );

  return server;
}

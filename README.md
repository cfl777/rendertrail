# rendertrail
MCP App that records how React components render in headless Chrome and explains the main performance problem in a card inside Claude

## Development

Needs Node 22 or later.

```sh
npm install
npm run build          # card -> dist/card.html, server -> dist/server.js, dist/instrument.js
npm test               # unit tests
npm run test:golden    # builds, then golden tests: records fixtures/ in your installed Chrome
node dist/server.js    # the MCP server over stdio
npm run start:http     # the MCP server over HTTP, for the ext-apps basic-host
```

The recorder uses your installed Google Chrome. Without Chrome, install Playwright's Chromium
(about 150 MB) once with `npx playwright-core install chromium`.

Connect it to Claude Code with `claude mcp add rendertrail -- node <absolute path>/dist/server.js`,
or to Claude Desktop with an `mcpServers` entry that runs `node <absolute path>/dist/server.js`.

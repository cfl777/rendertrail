# rendertrail
MCP App that records how React components render in headless Chrome and explains the main performance problem in a card inside Claude

## Development

Needs Node 22 or later.

```sh
npm install
npm run build          # card -> dist/card.html, server -> dist/server.js
npm test
node dist/server.js    # the MCP server over stdio
npm run start:http     # the MCP server over HTTP, for the ext-apps basic-host
cd spike && npm install && RT_CHANNEL=chrome npm run record   # the recorder spike
```

Connect it to Claude Code with `claude mcp add rendertrail -- node <absolute path>/dist/server.js`,
or to Claude Desktop with an `mcpServers` entry that runs `node <absolute path>/dist/server.js`.

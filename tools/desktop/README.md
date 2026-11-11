# Claude Desktop helpers

`patch-desktop-config.cmd` (double-click, or run from Windows Terminal, never from inside Claude
Desktop) waits for Claude Desktop to quit, adds the `rendertrail` MCP server to
`%APPDATA%\Claude\claude_desktop_config.json`, and relaunches Desktop.

Why a script: Desktop rewrites that file from memory on every session event and reads it only at
launch, so an edit made while it runs is lost within seconds. `add-desktop-config.mjs` does the JSON
edit (points `mcpServers.rendertrail` at this checkout's `dist/server.js`); `patch-desktop-config.ps1`
does the waiting and relaunching.

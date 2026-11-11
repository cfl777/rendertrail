import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This checkout's built server: tools/desktop/ -> repo root -> dist/server.js
const serverJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'server.js');

const file = path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
const raw = fs.readFileSync(file, 'utf8');
const cfg = JSON.parse(raw);
cfg.mcpServers ??= {};
if (cfg.mcpServers.rendertrail) {
  console.log('already present:', JSON.stringify(cfg.mcpServers.rendertrail));
} else {
  fs.copyFileSync(file, file + '.bak');
  cfg.mcpServers.rendertrail = {
    command: 'node',
    args: ['C:\\Users\\casse\\GitHub\\rendertrail\\dist\\server.js'],
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log('added; backup at', file + '.bak');
}
console.log('mcpServers now:', JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers, null, 2));

// Writes the card harness data (ui/dev/results/*.json) from the saved traces: `npm run card:results`.
// The builder is TypeScript (test/helpers/card-results.ts), so bundle it with esbuild first.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const outfile = path.join(root, 'node_modules', '.cache', 'rendertrail', 'card-results.mjs');
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: [path.join(root, 'test', 'helpers', 'card-results.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile,
  logLevel: 'warning',
  // The builder finds the repo from its own URL; keep it pointing at test/helpers/.
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(root, 'test', 'helpers', 'card-results.ts')).href) },
});
const { writeCardResults } = await import(pathToFileURL(outfile).href);
for (const file of await writeCardResults()) console.log(path.relative(root, file));

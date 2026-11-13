/**
 * The npm package and the MCP Bundle manifest stay in step with package.json and src/brand.ts, so
 * a version bump or a rename can't leave manifest.json behind.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { BRAND } from '../src/brand.js';
import { INSPECT_RENDER_DESCRIPTION } from '../src/server/inspect-render.js';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8')) as {
  name: string;
  display_name: string;
  version: string;
  license: string;
  keywords: string[];
  server: { entry_point: string; mcp_config: { command: string; args: string[] } };
  tools: { name: string; description: string }[];
  compatibility: { runtimes: { node: string } };
};

describe('manifest.json (MCP Bundle)', () => {
  it('matches package.json and src/brand.ts', () => {
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.name).toBe(BRAND.name);
    expect(manifest.display_name).toBe(BRAND.displayName);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.keywords).toEqual(pkg.keywords);
    expect(manifest.compatibility.runtimes.node).toBe(`${pkg.engines.node}.0.0`);
  });

  it('starts the bundled server and lists the one tool with its real description', () => {
    expect(manifest.server.entry_point).toBe(pkg.bin.rendertrail);
    expect(manifest.server.mcp_config).toMatchObject({ command: 'node', args: [`\${__dirname}/${pkg.bin.rendertrail}`] });
    expect(manifest.tools).toEqual([{ name: 'inspect_render', description: INSPECT_RENDER_DESCRIPTION }]);
  });
});

describe('package.json (npm)', () => {
  it('publishes only the built server, card and page instrumentation', () => {
    expect(pkg).not.toHaveProperty('private');
    expect(pkg.files).toEqual(['dist/server.js', 'dist/card.html', 'dist/instrument.js']);
    expect(pkg.bin).toEqual({ [BRAND.name]: 'dist/server.js' });
    expect(pkg.scripts.prepack).toBe('npm run build');
  });

  it('keeps build-only packages out of the runtime dependencies', () => {
    // bippy is inlined into dist/instrument.js at build time.
    for (const dev of ['bippy', 'vite', 'vitest', '@anthropic-ai/mcpb', 'gifenc']) expect(pkg.dependencies).not.toHaveProperty(dev);
    // The server bundles user code with esbuild, records with playwright-core and React, and finds lines with TypeScript.
    for (const runtime of ['esbuild', 'playwright-core', 'react', 'react-dom', 'typescript', 'zod']) expect(pkg.dependencies).toHaveProperty(runtime);
  });
});

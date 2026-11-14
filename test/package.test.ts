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

const read = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

const manifest = JSON.parse(read('../manifest.json')) as {
  name: string;
  display_name: string;
  version: string;
  license: string;
  keywords: string[];
  long_description: string;
  homepage: string;
  documentation: string;
  support: string;
  repository: { type: string; url: string };
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

  it('links where package.json links, and names the product as src/brand.ts does', () => {
    expect(manifest.homepage).toBe(pkg.homepage);
    expect(manifest.documentation).toBe(pkg.homepage);
    expect(manifest.support).toBe(pkg.bugs.url);
    expect(manifest.repository).toEqual({ type: 'git', url: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') });
    expect(manifest.long_description).toContain(`${BRAND.displayName} runs them`);
    expect(manifest.long_description).toContain(`~/${BRAND.homeDir}/runs`);
  });

  it('starts the bundled server and lists the one tool with its real description', () => {
    expect(manifest.server.entry_point).toBe(pkg.bin.rendertrail);
    expect(manifest.server.mcp_config).toMatchObject({ command: 'node', args: [`\${__dirname}/${pkg.bin.rendertrail}`] });
    expect(manifest.tools).toEqual([{ name: 'inspect_render', description: INSPECT_RENDER_DESCRIPTION }]);
  });
});

describe('package.json (npm)', () => {
  it('publishes only the built command, server, card and page instrumentation', () => {
    expect(pkg).not.toHaveProperty('private');
    expect(pkg.files).toEqual(['dist/server.js', 'dist/start.js', 'dist/card.html', 'dist/instrument.js']);
    expect(pkg.bin).toEqual({ [BRAND.name]: 'dist/server.js' });
    expect(pkg.scripts.prepack).toBe('npm run build');
  });

  it('keeps build-only packages out of the runtime dependencies', () => {
    // bippy is inlined into dist/instrument.js at build time.
    for (const dev of ['bippy', 'vite', 'vitest', '@anthropic-ai/mcpb', 'gifenc']) expect(pkg.dependencies).not.toHaveProperty(dev);
    // The server bundles user code with esbuild, records with playwright-core and React, and finds lines with TypeScript.
    for (const runtime of ['esbuild', 'playwright-core', 'react', 'react-dom', 'typescript', 'zod']) expect(pkg.dependencies).toHaveProperty(runtime);
  });

  it('pins every runtime dependency to the exact version the golden tests ran with', () => {
    // npx installs whatever a range allows; React and playwright-core are checked against bippy and the fixtures.
    const ranged = Object.entries(pkg.dependencies).filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version));
    expect(ranged).toEqual([]);
  });

  it("the README's Chromium command names the playwright-core version in dependencies", () => {
    const versions = [...read('../README.md').matchAll(/playwright-core@(\S+?) install/g)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version).toBe(pkg.dependencies['playwright-core']);
  });
});

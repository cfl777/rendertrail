/**
 * Guards against outgoing network code (CLAUDE.md: everything runs on the user's machine; the
 * opt-in counts are stored, never sent). The only network module allowed is node:http in
 * src/server/start.ts, for the localhost `--http` server, which listens and never requests.
 * This is a tripwire, not a proof: if it fails, a new way out appeared and needs the owner's
 * explicit decision, not a test change.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** Outgoing calls, checked in the sources and the built files. */
const OUTGOING = [/\bfetch\s*\(/, /\bhttps?\.request\s*\(/, /\bhttps?\.get\s*\(/, /\bnet\.connect\s*\(/, /\bXMLHttpRequest\b/, /\bnew\s+WebSocket\s*\(/, /\bsendBeacon\b/];
/** Modules that can open a connection or start another program. */
const BANNED_MODULES = ['net', 'tls', 'http2', 'dgram', 'dns', 'https', 'http', 'child_process', 'undici'];
const ALLOWED: Record<string, string[]> = { http: ['src/server/start.ts'] };
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const rel = (file: string): string => path.relative(ROOT, file).replace(/\\/g, '/');
const sources = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'ui', 'src'))];

function outgoing(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return OUTGOING.filter((re) => re.test(text)).map((re) => `${rel(file)}: ${re.source}`);
}

describe('no outgoing network code', () => {
  it('finds the sources', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it('no outgoing calls in src/ or ui/src/', () => {
    expect(sources.flatMap(outgoing)).toEqual([]);
  });

  it('no `fetch` at all in src/ or ui/src/', () => {
    expect(sources.filter((file) => /\bfetch\b/.test(readFileSync(file, 'utf8'))).map(rel)).toEqual([]);
  });

  it('no network or child-process modules, except node:http for the localhost server', () => {
    const found: string[] = [];
    for (const file of sources) {
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const name = (match[1] ?? '').replace(/^node:/, '').split('/')[0] ?? '';
        if (BANNED_MODULES.includes(name) && !(ALLOWED[name] ?? []).includes(rel(file))) found.push(`${rel(file)}: ${match[1]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('catches the ways out it looks for (self-check)', () => {
    const sample = `import x from 'node:https';\nconst y = await import("undici");\nrequire('child_process');\nimport 'net';`;
    expect([...sample.matchAll(IMPORT)].map((m) => m[1])).toEqual(['node:https', 'undici', 'child_process', 'net']);
  });

  for (const built of ['server.js', 'start.js', 'card.html']) {
    const file = path.join(ROOT, 'dist', built);
    it.skipIf(!existsSync(file))(`no outgoing calls in dist/${built} (skipped before \`npm run build\`)`, () => {
      expect(outgoing(file)).toEqual([]);
    });
  }
});

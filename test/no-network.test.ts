/**
 * Nothing in the shipped code calls out to the network (CLAUDE.md: everything runs on the user's
 * machine; the opt-in counts are stored, never sent). The only network code is the localhost
 * `--http` server in src/server/main.ts, which listens and never requests. If this fails, a new
 * outgoing call appeared: it needs the owner's explicit decision, not a test change.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTGOING = [/\bfetch\s*\(/, /\bhttps?\.request\s*\(/, /\bhttps?\.get\s*\(/, /\bnet\.connect\s*\(/, /\bXMLHttpRequest\b/, /\bnew\s+WebSocket\s*\(/, /\bsendBeacon\b/];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function hits(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return OUTGOING.filter((re) => re.test(text)).map((re) => `${path.relative(ROOT, file)}: ${re.source}`);
}

describe('no outgoing network calls', () => {
  it('in the server and card sources', () => {
    const files = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'ui', 'src'))];
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap(hits)).toEqual([]);
  });

  const server = path.join(ROOT, 'dist', 'server.js');
  it.skipIf(!existsSync(server))('in the built server, dist/server.js (skipped before `npm run build`)', () => {
    expect(hits(server)).toEqual([]);
  });
});

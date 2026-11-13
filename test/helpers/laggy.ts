/** Test helpers: the saved laggy-search traces (test/fixtures/traces) and the fixture's files. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecordedTrace, TraceSummary } from '../../src/shared/types.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function laggyFiles(): { path: string; content: string }[] {
  const dir = path.join(ROOT, 'fixtures', 'laggy-search');
  return readdirSync(dir)
    .filter((n) => /\.tsx?$/.test(n))
    // readdir order differs by OS (case-insensitive on Windows, unsorted on Linux): sort the same way everywhere.
    .sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))
    .map((n) => ({ path: n, content: readFileSync(path.join(dir, n), 'utf8') }));
}

export function savedTrace(variant: 'SearchPage' | 'SearchPage.fixed'): { summary: TraceSummary; traces: RecordedTrace[] } {
  return JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'traces', `laggy-search.${variant}.json`), 'utf8')) as {
    summary: TraceSummary;
    traces: RecordedTrace[];
  };
}

/**
 * Test helpers for every golden fixture: its files, its expected.json `findings` section (a copy of
 * EXPECTED.md's "must report" / "must NOT be reported"), the saved traces in test/fixtures/traces
 * (`RT_SAVE_TRACES=1 npm run test:golden`), and how a finding is compared with that section. Used by
 * the analyzer golden test (real browser) and the analyzer unit tests on saved traces (no browser).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, RecordedTrace, TraceSummary } from '../../src/shared/types.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURES_DIR = path.join(ROOT, 'fixtures');
export const TRACES_DIR = path.join(ROOT, 'test', 'fixtures', 'traces');

/** Every fixture that ships with the repo; discovery alone would let one drop out silently. */
export const KNOWN_FIXTURES = ['cart-summary', 'laggy-search', 'pricing-toggle', 'theme-storefront', 'todo-toggle', 'user-table'];

export interface ExpectedFinding {
  rule: string;
  component: string;
  prop?: string;
  setter?: string;
  location?: string;
  fix?: string;
  compilerFixes?: boolean;
  stepsAffected?: number;
  steps?: number;
}

export interface MustNot {
  component?: string;
  prop?: string;
  setter?: string;
  hookOwner?: string;
  file?: string;
  commit?: number;
}

export interface FindingsSection {
  variants: Record<string, { report: ExpectedFinding[]; mustNotReport: MustNot[] }>;
  comparison?: { baseline: string; fixed: string; resolved: string[]; stillThere: string[]; new: string[] };
}

export interface FixtureExpected {
  test: string;
  fixedEntry?: string;
  variants?: Record<string, { commitCount: number }>;
  findings?: FindingsSection;
}

export type Files = { path: string; content: string }[];

/** The fixture's source files, sorted the same way on every OS. */
export function fixtureFiles(name: string): Files {
  const dir = path.join(FIXTURES_DIR, name);
  return readdirSync(dir)
    .filter((n) => /\.[cm]?[jt]sx?$/.test(n))
    .sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))
    .map((n) => ({ path: n, content: readFileSync(path.join(dir, n), 'utf8') }));
}

export function fixtureExpected(name: string): FixtureExpected {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name, 'expected.json'), 'utf8')) as FixtureExpected;
}

export function fixtureTest(name: string): Record<string, unknown> & { entry: string } {
  const expected = fixtureExpected(name);
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name, expected.test), 'utf8')) as Record<string, unknown> & { entry: string };
}

/** `Cart.fixed.tsx` → `Cart.fixed`: the variant part of a saved trace's file name. */
export function variantOf(entry: string): string {
  return entry.replace(/\.[cm]?[jt]sx?$/, '');
}

export function traceFile(name: string, entry: string): string {
  return path.join(TRACES_DIR, `${name}.${variantOf(entry)}.json`);
}

/** A saved recording: the summary and the first run's trace. */
export function savedFixtureTrace(name: string, entry: string): { summary: TraceSummary; traces: RecordedTrace[] } {
  return JSON.parse(readFileSync(traceFile(name, entry), 'utf8')) as { summary: TraceSummary; traces: RecordedTrace[] };
}

/** A finding in the shape of an expected.json `report` entry. */
export function findingView(f: Finding): Required<Omit<ExpectedFinding, 'prop' | 'setter'>> & { prop?: string; setter?: string } {
  return {
    rule: f.rule,
    component: f.component,
    ...(f.prop ? { prop: f.prop.name } : {}),
    ...(f.hook ? { setter: f.hook.setter } : {}),
    location: f.location ? `${f.location.file}:${f.location.line}` : '',
    fix: f.fix.kind,
    compilerFixes: f.fix.compilerFixes,
    stepsAffected: f.stepsAffected,
    steps: f.steps,
  };
}

/** True when the finding matches every field the `mustNotReport` entry sets. */
export function matchesMustNot(f: Finding, m: MustNot): boolean {
  return (
    (m.component === undefined || f.component === m.component) &&
    (m.prop === undefined || f.prop?.name === m.prop) &&
    (m.setter === undefined || f.hook?.setter === m.setter) &&
    (m.hookOwner === undefined || f.hook?.owner === m.hookOwner) &&
    (m.file === undefined || f.location?.file === m.file) &&
    (m.commit === undefined || f.commits.includes(m.commit))
  );
}

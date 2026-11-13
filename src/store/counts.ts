/**
 * Opt-in anonymous counts (HANDOFF.md §9 Phase 4): how many runs, findings by rule and fixes
 * checked, per ISO week. Off unless the user turns them on. They stay in ~/.rendertrail/counts.json:
 * sending is not implemented, and nothing here touches the network.
 *
 * What is counted is fixed by `tally` and `buildPayload`, which read only rule ids and comparison
 * flags: never code, file or component names, paths, run ids or anything about the machine.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BRAND } from '../brand.js';
import type { FindingRule, InspectRenderOutput } from '../shared/types.js';

export const COUNTS_SCHEMA_VERSION = 1;
export const RULES: readonly FindingRule[] = ['unstable-prop', 'state-in-effect'];

export interface WeekCounts {
  runs: number;
  findings: Record<FindingRule, number>;
  /** Re-runs where the baseline's top finding was resolved. */
  fixesChecked: number;
}

export interface CountsFile {
  schemaVersion: typeof COUNTS_SCHEMA_VERSION;
  /** ISO week ("2026-W46") → counts. The week is the only time information kept. */
  weeks: Record<string, WeekCounts>;
}

/** What would be sent for one week, if sending existed. */
export interface CountsPayload {
  schemaVersion: typeof COUNTS_SCHEMA_VERSION;
  week: string;
  runs: number;
  findings: Record<FindingRule, number>;
  fixesChecked: number;
}

export interface TelemetrySwitch {
  on: boolean;
  /** Which setting decided it, in words. */
  reason: string;
}

export function homeFolder(): string {
  return path.join(os.homedir(), BRAND.homeDir);
}

export const CONFIG_FILE = 'config.json';
export const COUNTS_FILE = 'counts.json';

function isSet(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/**
 * Off by default. DO_NOT_TRACK always turns it off; then RENDERTRAIL_TELEMETRY=1 or 0; then
 * `"telemetry": true` in ~/.rendertrail/config.json.
 */
export function telemetrySwitch(env: NodeJS.ProcessEnv, config: unknown): TelemetrySwitch {
  if (isSet(env.DO_NOT_TRACK)) return { on: false, reason: 'DO_NOT_TRACK is set' };
  const flag = env[BRAND.telemetryEnv]?.trim();
  if (flag === '1') return { on: true, reason: `${BRAND.telemetryEnv}=1` };
  if (flag === '0') return { on: false, reason: `${BRAND.telemetryEnv}=0` };
  if (typeof config === 'object' && config !== null && (config as { telemetry?: unknown }).telemetry === true) {
    return { on: true, reason: `"telemetry": true in ${CONFIG_FILE}` };
  }
  return { on: false, reason: 'the default' };
}

/** The config file, or null when it's missing or not valid JSON (then nothing is turned on). */
export async function readConfig(home = homeFolder()): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(home, CONFIG_FILE), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** ISO 8601 week, "2026-W46" (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // the Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function emptyCounts(): WeekCounts {
  return { runs: 0, findings: { 'unstable-prop': 0, 'state-in-effect': 0 }, fixesChecked: 0 };
}

/** What one inspect_render result adds. Reads only rule ids and comparison flags. */
export function tally(output: InspectRenderOutput): WeekCounts {
  const delta = emptyCounts();
  if ('error' in output) return delta;
  delta.runs = 1;
  for (const finding of output.findings) {
    if (RULES.includes(finding.rule)) delta.findings[finding.rule] += 1;
  }
  const c = output.comparison;
  if (c?.found && c.checked && c.baselineTopFindingId && c.resolved.some((f) => f.id === c.baselineTopFindingId)) {
    delta.fixesChecked = 1;
  }
  return delta;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Only known keys survive, whatever the file on disk holds. */
function cleanWeek(value: unknown): WeekCounts {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof WeekCounts, unknown>>;
  const findings = (typeof v.findings === 'object' && v.findings !== null ? v.findings : {}) as Record<string, unknown>;
  return {
    runs: count(v.runs),
    findings: { 'unstable-prop': count(findings['unstable-prop']), 'state-in-effect': count(findings['state-in-effect']) },
    fixesChecked: count(v.fixesChecked),
  };
}

const WEEK = /^\d{4}-W\d{2}$/;

export function parseCounts(text: string): CountsFile {
  const file: CountsFile = { schemaVersion: COUNTS_SCHEMA_VERSION, weeks: {} };
  try {
    const parsed = JSON.parse(text) as { weeks?: unknown };
    if (typeof parsed.weeks === 'object' && parsed.weeks !== null) {
      for (const [week, value] of Object.entries(parsed.weeks)) {
        if (WEEK.test(week)) file.weeks[week] = cleanWeek(value);
      }
    }
  } catch {
    // a damaged file starts over
  }
  return file;
}

export function addCounts(file: CountsFile, week: string, delta: WeekCounts): CountsFile {
  const now = cleanWeek(file.weeks[week]);
  const next: WeekCounts = {
    runs: now.runs + delta.runs,
    findings: {
      'unstable-prop': now.findings['unstable-prop'] + delta.findings['unstable-prop'],
      'state-in-effect': now.findings['state-in-effect'] + delta.findings['state-in-effect'],
    },
    fixesChecked: now.fixesChecked + delta.fixesChecked,
  };
  return { schemaVersion: COUNTS_SCHEMA_VERSION, weeks: { ...file.weeks, [week]: next } };
}

/** The payload-to-be for one week: these keys and nothing else. */
export function buildPayload(file: CountsFile, week: string): CountsPayload {
  const w = cleanWeek(file.weeks[week]);
  return { schemaVersion: COUNTS_SCHEMA_VERSION, week, runs: w.runs, findings: w.findings, fixesChecked: w.fixesChecked };
}

export async function readCounts(home = homeFolder()): Promise<CountsFile> {
  try {
    return parseCounts(await readFile(path.join(home, COUNTS_FILE), 'utf8'));
  } catch {
    return { schemaVersion: COUNTS_SCHEMA_VERSION, weeks: {} };
  }
}

export interface CountOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: Date;
}

/**
 * Adds one result to this week's counts, only when the user turned counting on. Returns whether
 * it counted. Never throws: counting must never cost the user a result.
 */
export async function recordCounts(output: InspectRenderOutput, options: CountOptions = {}): Promise<boolean> {
  try {
    const home = options.home ?? homeFolder();
    if (!telemetrySwitch(options.env ?? process.env, await readConfig(home)).on) return false;
    const delta = tally(output);
    if (delta.runs === 0) return false;
    const next = addCounts(await readCounts(home), isoWeek(options.now ?? new Date()), delta);
    await mkdir(home, { recursive: true });
    const target = path.join(home, COUNTS_FILE);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temp, target);
    return true;
  } catch {
    return false;
  }
}

/** `rendertrail --telemetry-status`: whether counting is on, and the counts so far. */
export async function telemetryStatus(options: CountOptions = {}): Promise<string> {
  const home = options.home ?? homeFolder();
  const state = telemetrySwitch(options.env ?? process.env, await readConfig(home));
  const counts = await readCounts(home);
  const week = isoWeek(options.now ?? new Date());
  const weeks = Object.keys(counts.weeks).sort();
  const lines = [
    `Anonymous counts: ${state.on ? 'on' : 'off'} (${state.reason}).`,
    state.on
      ? 'Each run adds to this week\'s counts: runs, findings by rule, fixes checked. No code, file names, component names, paths or ids.'
      : `To turn them on: set ${BRAND.telemetryEnv}=1, or put {"telemetry": true} in ${path.join(home, CONFIG_FILE)}. DO_NOT_TRACK=1 always turns them off.`,
    `Sending is not implemented: the counts stay in ${path.join(home, COUNTS_FILE)}.`,
    `This week (what would be sent, if sending existed): ${JSON.stringify(buildPayload(counts, week))}`,
  ];
  const earlier = weeks.filter((w) => w !== week);
  if (earlier.length) lines.push(`Earlier weeks: ${earlier.map((w) => JSON.stringify(buildPayload(counts, w))).join(', ')}`);
  return lines.join('\n');
}

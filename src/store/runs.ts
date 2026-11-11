/**
 * The run store (HANDOFF.md §4): one JSON file per run in ~/.rendertrail/runs (or the absolute
 * folder in RENDERTRAIL_RUNS_DIR), keeping the last 50. Everything stays on this computer.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BRAND } from '../brand.js';
import { SCHEMA_VERSION, StepSchema, type StoredRun } from '../shared/types.js';

export const MAX_RUNS = 50;
/** `r_` plus 4–6 lowercase letters or digits. New ids use 6. */
export const RUN_ID = /^r_[a-z0-9]{4,6}$/;
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no 0/o, 1/l
const ID_LENGTH = 6;
/** A temp file older than this is left over from a crashed write. */
const STALE_TEMP_MS = 60_000;

export interface RunsDir {
  dir: string;
  /** Set when the environment override was ignored, and why. */
  warning: string | null;
}

/**
 * The runs folder. The override must be absolute: Claude Desktop starts the server with no
 * defined working folder, so a relative path would land somewhere unpredictable.
 */
export function resolveRunsDir(env: NodeJS.ProcessEnv = process.env): RunsDir {
  const fallback = path.join(os.homedir(), BRAND.homeDir, 'runs');
  const override = env[BRAND.runsDirEnv]?.trim();
  if (!override) return { dir: fallback, warning: null };
  if (!path.isAbsolute(override)) {
    return { dir: fallback, warning: `${BRAND.runsDirEnv} must be an absolute path; "${override}" was ignored and runs are stored in ${fallback}.` };
  }
  return { dir: path.normalize(override), warning: null };
}

export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveRunsDir(env).dir;
}

export function newRunId(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const bytes = randomBytes(ID_LENGTH);
    const id = `r_${[...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')}`;
    if (!taken.has(id)) return id;
  }
}

async function runFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json') && RUN_ID.test(name.slice(0, -5)));
  } catch {
    return [];
  }
}

/** Ids of the stored runs. */
export async function listRunIds(dir = runsDir()): Promise<string[]> {
  return (await runFiles(dir)).map((name) => name.slice(0, -5));
}

/** What the comparison reads from a stored run; anything else in the file is passed through. */
const StoredRunSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string(),
    createdAt: z.string(),
    input: z.object({
      files: z.array(z.object({ path: z.string(), content: z.string() })),
      entry: z.string(),
      exportName: z.string(),
      props: z.record(z.string(), z.unknown()).optional(),
      steps: z.array(StepSchema),
    }),
    summary: z.looseObject({}),
    steps: z.array(z.unknown()),
    findings: z.array(z.looseObject({ id: z.string(), rule: z.string(), component: z.string() })),
    keystroke: z.looseObject({ unit: z.string(), steps: z.number(), msPerStep: z.number(), rendersPerStep: z.number() }),
  })
  .loose();

export type LoadedRun = { ok: true; run: StoredRun } | { ok: false; reason: 'missing' | 'unreadable' };

/** Reads a run. A malformed id or a missing file is 'missing'; a file that doesn't parse or validate is 'unreadable'. */
export async function loadRun(id: string, dir = runsDir()): Promise<LoadedRun> {
  if (!RUN_ID.test(id)) return { ok: false, reason: 'missing' }; // also keeps the id from naming a path outside the folder
  let text: string;
  try {
    text = await readFile(path.join(dir, `${id}.json`), 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  try {
    const parsed = StoredRunSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.id !== id) return { ok: false, reason: 'unreadable' };
    return { ok: true, run: parsed.data as unknown as StoredRun };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** Deletes the oldest runs beyond `keep` (by file time, then id), and temp files left by crashed writes. */
export async function pruneRuns(dir = runsDir(), keep = MAX_RUNS): Promise<string[]> {
  const now = Date.now();
  try {
    const temps = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    await Promise.all(
      temps.map(async (name) => {
        const file = path.join(dir, name);
        const age = await stat(file).then((s) => now - s.mtimeMs, () => 0);
        if (age > STALE_TEMP_MS) await rm(file, { force: true });
      }),
    );
  } catch {
    // the folder may not exist yet
  }
  const files = await runFiles(dir);
  if (files.length <= keep) return [];
  const timed = await Promise.all(
    files.map(async (name) => ({ name, time: await stat(path.join(dir, name)).then((s) => s.mtimeMs, () => 0) })),
  );
  timed.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  const old = timed.slice(keep);
  await Promise.all(old.map(({ name }) => rm(path.join(dir, name), { force: true })));
  return old.map(({ name }) => name.slice(0, -5));
}

/**
 * Writes the run (atomically, through a temp file), then prunes to the last MAX_RUNS. Throws only
 * when the run itself couldn't be written; a failed prune is ignored (the run is saved).
 */
export async function saveRun(run: StoredRun, dir = runsDir()): Promise<void> {
  if (!RUN_ID.test(run.id)) throw new Error(`Invalid run id: ${run.id}`);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${run.id}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(run), 'utf8');
  await rename(temp, target);
  await pruneRuns(dir).catch(() => []);
}

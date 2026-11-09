/**
 * The run store (HANDOFF.md §4): one JSON file per run in ~/.rendertrail/runs (or the folder in
 * RENDERTRAIL_RUNS_DIR), keeping the last 50. Everything stays on this computer.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BRAND } from '../brand.js';
import { SCHEMA_VERSION, type StoredRun } from '../shared/types.js';

export const MAX_RUNS = 50;
/** `r_` plus 4–6 lowercase letters or digits. New ids use 6. */
export const RUN_ID = /^r_[a-z0-9]{4,6}$/;
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no 0/o, 1/l
const ID_LENGTH = 6;

export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[BRAND.runsDirEnv];
  return override && override.trim() ? path.resolve(override) : path.join(os.homedir(), BRAND.homeDir, 'runs');
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

/** Reads a run; null when the id is malformed, missing or the file can't be read. */
export async function loadRun(id: string, dir = runsDir()): Promise<StoredRun | null> {
  if (!RUN_ID.test(id)) return null; // also keeps the id from naming a path outside the folder
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dir, `${id}.json`), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const run = parsed as Partial<StoredRun>;
    if (run.schemaVersion !== SCHEMA_VERSION || run.id !== id || !run.keystroke || !Array.isArray(run.findings)) return null;
    return run as StoredRun;
  } catch {
    return null;
  }
}

/** Deletes the oldest runs beyond MAX_RUNS (by file time, then id). */
export async function pruneRuns(dir = runsDir(), keep = MAX_RUNS): Promise<string[]> {
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

/** Writes the run (atomically, through a temp file), then prunes to the last MAX_RUNS. */
export async function saveRun(run: StoredRun, dir = runsDir()): Promise<void> {
  if (!RUN_ID.test(run.id)) throw new Error(`Invalid run id: ${run.id}`);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${run.id}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(run), 'utf8');
  await rename(temp, target);
  await pruneRuns(dir);
}

import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { SCHEMA_VERSION, type StoredRun } from '../shared/types.js';
import { listRunIds, loadRun, MAX_RUNS, newRunId, pruneRuns, resolveRunsDir, RUN_ID, runsDir, saveRun } from './runs.js';

function run(id: string): StoredRun {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    createdAt: new Date(0).toISOString(),
    input: { files: [{ path: 'a.tsx', content: 'x' }], entry: 'a.tsx', exportName: 'default', steps: [{ action: 'wait', ms: 0 }] },
    summary: {} as StoredRun['summary'],
    steps: [],
    findings: [],
    keystroke: { unit: 'letter', steps: 1, msPerStep: 1, rendersPerStep: 1 } as StoredRun['keystroke'],
  };
}

describe('run store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rt-runs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses ~/.rendertrail/runs unless the environment overrides it with an absolute path', () => {
    const home = path.join(os.homedir(), '.rendertrail', 'runs');
    expect(runsDir({})).toBe(home);
    expect(runsDir({ [BRAND.runsDirEnv]: dir })).toBe(path.normalize(dir));
    const relative = resolveRunsDir({ [BRAND.runsDirEnv]: 'runs-here' });
    expect(relative.dir).toBe(home);
    expect(relative.warning).toContain('must be an absolute path');
  });

  it('makes short run ids', () => {
    const id = newRunId();
    expect(id).toMatch(RUN_ID);
    expect(id).toHaveLength(8);
  });

  it('saves and loads a run; refuses ids that are not run ids and files that do not validate', async () => {
    await saveRun(run('r_abcd12'), dir);
    const loaded = await loadRun('r_abcd12', dir);
    expect(loaded.ok && loaded.run.id).toBe('r_abcd12');
    expect(await loadRun('r_zzzz99', dir)).toEqual({ ok: false, reason: 'missing' });
    expect(await loadRun('../r_abcd12', dir)).toEqual({ ok: false, reason: 'missing' });
    await writeFile(path.join(dir, 'r_bad000.json'), '{not json');
    expect(await loadRun('r_bad000', dir)).toEqual({ ok: false, reason: 'unreadable' });
    const { input: _input, ...noInput } = run('r_bad001');
    await writeFile(path.join(dir, 'r_bad001.json'), JSON.stringify(noInput));
    expect(await loadRun('r_bad001', dir)).toEqual({ ok: false, reason: 'unreadable' });
    await expect(saveRun(run('../escape'), dir)).rejects.toThrow('Invalid run id');
  });

  it(`keeps only the newest ${MAX_RUNS} runs`, async () => {
    const ids = Array.from({ length: MAX_RUNS + 3 }, (_, i) => `r_${String(i).padStart(4, '0')}`);
    for (const [i, id] of ids.entries()) {
      await saveRun(run(id), dir);
      const time = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      await utimes(path.join(dir, `${id}.json`), time, time);
    }
    await saveRun(run('r_last00'), dir); // newest; triggers the prune once more
    const kept = await listRunIds(dir);
    expect(kept).toHaveLength(MAX_RUNS);
    expect(kept).toContain('r_last00');
    for (const gone of ids.slice(0, 4)) expect(kept).not.toContain(gone);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('removes temp files left by a crashed write, but not fresh ones', async () => {
    const stale = path.join(dir, 'r_aaaa11.json.123.tmp');
    const fresh = path.join(dir, 'r_aaaa22.json.456.tmp');
    await writeFile(stale, '{');
    await writeFile(fresh, '{');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, old, old);
    await pruneRuns(dir);
    expect((await readdir(dir)).sort()).toEqual(['r_aaaa22.json.456.tmp']);
  });
});

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InspectRenderOutput } from '../shared/types.js';
import {
  addCounts,
  buildPayload,
  emptyCounts,
  isoWeek,
  parseCounts,
  readConfig,
  recordCounts,
  tally,
  telemetryStatus,
  telemetrySwitch,
} from './counts.js';

/** Real results saved from the laggy-search fixture (they hold file, component and run names). */
async function result(name: string): Promise<InspectRenderOutput> {
  const file = path.join(import.meta.dirname, '..', '..', 'ui', 'dev', 'results', `${name}.json`);
  return (JSON.parse(await readFile(file, 'utf8')) as { output: InspectRenderOutput }).output;
}

const NOW = new Date('2026-11-13T12:00:00Z');

const none = { value: null, problem: null };
const optedIn = { value: { telemetry: true }, problem: null };

describe('telemetrySwitch', () => {
  it('is off by default, and only a real true in the config turns it on', () => {
    expect(telemetrySwitch({}, none)).toEqual({ on: false, reason: 'the default' });
    expect(telemetrySwitch({}, { value: { telemetry: 'yes' }, problem: null }).on).toBe(false);
    expect(telemetrySwitch({}, optedIn)).toEqual({ on: true, reason: '"telemetry": true in config.json' });
  });

  it.each(['1', 'true', 'YES', ' on '])('RENDERTRAIL_TELEMETRY=%j turns it on', (value) => {
    expect(telemetrySwitch({ RENDERTRAIL_TELEMETRY: value }, none).on).toBe(true);
  });

  it.each(['0', 'false', 'No', ' OFF '])('RENDERTRAIL_TELEMETRY=%j turns it off, even with the config opted in', (value) => {
    expect(telemetrySwitch({ RENDERTRAIL_TELEMETRY: value }, optedIn).on).toBe(false);
  });

  it.each(['2', 'enable', 'y'])('an unrecognised RENDERTRAIL_TELEMETRY=%j is off, whatever the config says', (value) => {
    const state = telemetrySwitch({ RENDERTRAIL_TELEMETRY: value }, optedIn);
    expect(state.on).toBe(false);
    expect(state.reason).toContain('unrecognised value');
  });

  it('an empty RENDERTRAIL_TELEMETRY leaves it to the config', () => {
    expect(telemetrySwitch({ RENDERTRAIL_TELEMETRY: '' }, optedIn).on).toBe(true);
  });

  it('a config.json that cannot be read keeps it off and says so', () => {
    expect(telemetrySwitch({}, { value: null, problem: "config.json couldn't be read (it isn't valid JSON)" })).toEqual({
      on: false,
      reason: "config.json couldn't be read (it isn't valid JSON)",
    });
  });

  it('DO_NOT_TRACK beats everything, for any value except empty, 0 and false', () => {
    for (const value of ['1', 'true', 'yes', 'anything']) {
      expect(telemetrySwitch({ DO_NOT_TRACK: value, RENDERTRAIL_TELEMETRY: '1' }, optedIn)).toEqual({ on: false, reason: 'DO_NOT_TRACK is set' });
    }
    for (const value of ['', '0', 'false', 'FALSE']) {
      expect(telemetrySwitch({ DO_NOT_TRACK: value, RENDERTRAIL_TELEMETRY: '1' }, none).on).toBe(true);
    }
  });
});

describe('isoWeek', () => {
  it('follows ISO 8601, including weeks that cross a new year', () => {
    expect(isoWeek(NOW)).toBe('2026-W46');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
  });
});

describe('the counts and the payload-to-be', () => {
  it('counts a run, its findings by rule, and a checked fix only when the top finding was resolved', async () => {
    expect(tally(await result('unfixed'))).toEqual({ runs: 1, findings: { 'unstable-prop': 1, 'state-in-effect': 1 }, fixesChecked: 0 });
    expect(tally(await result('rerun-fixed'))).toEqual({ runs: 1, findings: { 'unstable-prop': 0, 'state-in-effect': 1 }, fixesChecked: 1 });
    expect(tally(await result('rerun-not-fixed')).fixesChecked).toBe(0);
    expect(tally(await result('error'))).toEqual(emptyCounts());
  });

  it('has exactly these keys, and leaks no file, component, prop, path or run id', async () => {
    const outputs = await Promise.all(['unfixed', 'rerun-fixed', 'rerun-not-fixed'].map(result));
    let file = parseCounts('');
    for (const output of outputs) file = addCounts(file, '2026-W46', tally(output));
    const payload = buildPayload(file, '2026-W46');

    expect(Object.keys(payload).sort()).toEqual(['findings', 'fixesChecked', 'runs', 'schemaVersion', 'week']);
    expect(Object.keys(payload.findings).sort()).toEqual(['state-in-effect', 'unstable-prop']);
    expect(payload).toEqual({ schemaVersion: 1, week: '2026-W46', runs: 3, findings: { 'unstable-prop': 2, 'state-in-effect': 3 }, fixesChecked: 1 });

    const json = JSON.stringify(payload);
    const secrets = new Set<string>();
    for (const output of outputs) {
      if ('error' in output) continue;
      secrets.add(output.run.id);
      for (const f of output.findings) {
        secrets.add(f.component);
        if (f.prop) secrets.add(f.prop.name);
        if (f.location) secrets.add(f.location.file);
      }
      for (const p of output.comparison?.changedFiles ?? []) secrets.add(p);
    }
    for (const word of ['SearchPage', 'ResultsList', 'SearchBox', 'filters', '.tsx', 'r_', '/', '\\']) secrets.add(word);
    for (const secret of secrets) expect(json, secret).not.toContain(secret);
  });

  it('drops unknown keys and bad weeks from a file someone edited', () => {
    const file = parseCounts(
      JSON.stringify({
        weeks: {
          '2026-W46': { runs: 2, findings: { 'unstable-prop': 1, 'SearchPage.tsx': 9 }, fixesChecked: -1, path: 'C:/secret' },
          'C:/secret': { runs: 1 },
        },
        machineId: 'abc',
      }),
    );
    expect(file).toEqual({
      schemaVersion: 1,
      weeks: { '2026-W46': { runs: 2, findings: { 'unstable-prop': 1, 'state-in-effect': 0 }, fixesChecked: 0 } },
    });
  });
});

describe('recordCounts', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'rt-counts-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('writes nothing while off', async () => {
    expect(await recordCounts(await result('unfixed'), { env: {}, home, now: NOW })).toBe(false);
    await expect(readFile(path.join(home, 'counts.json'), 'utf8')).rejects.toThrow();
  });

  it('adds to this week when the config turns it on, and the status shows it', async () => {
    await writeFile(path.join(home, 'config.json'), '{ "telemetry": true }');
    expect(await recordCounts(await result('unfixed'), { env: {}, home, now: NOW })).toBe(true);
    expect(await recordCounts(await result('rerun-fixed'), { env: {}, home, now: NOW })).toBe(true);
    const stored = parseCounts(await readFile(path.join(home, 'counts.json'), 'utf8'));
    expect(buildPayload(stored, '2026-W46')).toMatchObject({ runs: 2, fixesChecked: 1 });

    const status = await telemetryStatus({ env: {}, home, now: NOW });
    expect(status).toContain('Anonymous counts: on ("telemetry": true in config.json).');
    expect(status).toContain('Sending is not implemented');
    expect(status).toContain('"week":"2026-W46","runs":2');
    expect(await telemetryStatus({ env: { DO_NOT_TRACK: '1' }, home, now: NOW })).toContain('Anonymous counts: off (DO_NOT_TRACK is set).');
    // No temp files left behind.
    expect((await readdir(home)).sort()).toEqual(['config.json', 'counts.json']);
  });

  it('reads a config.json saved with a byte order mark (Windows Notepad)', async () => {
    await writeFile(path.join(home, 'config.json'), `${String.fromCharCode(0xfeff)}{ "telemetry": true }`);
    expect(await readConfig(home)).toEqual({ value: { telemetry: true }, problem: null });
    expect(await recordCounts(await result('unfixed'), { env: {}, home, now: NOW })).toBe(true);
  });

  it("stays off and says so when config.json isn't valid JSON", async () => {
    await writeFile(path.join(home, 'config.json'), '{ telemetry: true }');
    expect(await recordCounts(await result('unfixed'), { env: {}, home, now: NOW })).toBe(false);
    expect(await telemetryStatus({ env: {}, home, now: NOW })).toContain("Anonymous counts: off (config.json couldn't be read (it isn't valid JSON)).");
  });

  it('removes its temp file when the write fails', async () => {
    await writeFile(path.join(home, 'config.json'), '{ "telemetry": true }');
    await mkdir(path.join(home, 'counts.json')); // a folder where the file should go: the rename fails
    expect(await recordCounts(await result('unfixed'), { env: {}, home, now: NOW })).toBe(false);
    expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

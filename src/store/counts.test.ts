import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('telemetrySwitch', () => {
  it('is off by default', () => {
    expect(telemetrySwitch({}, null)).toEqual({ on: false, reason: 'the default' });
    expect(telemetrySwitch({}, { telemetry: 'yes' }).on).toBe(false);
  });
  it('turns on with RENDERTRAIL_TELEMETRY=1 or "telemetry": true in the config', () => {
    expect(telemetrySwitch({ RENDERTRAIL_TELEMETRY: '1' }, null).on).toBe(true);
    expect(telemetrySwitch({}, { telemetry: true }).on).toBe(true);
  });
  it('RENDERTRAIL_TELEMETRY=0 beats the config, and DO_NOT_TRACK beats everything', () => {
    expect(telemetrySwitch({ RENDERTRAIL_TELEMETRY: '0' }, { telemetry: true }).on).toBe(false);
    expect(telemetrySwitch({ DO_NOT_TRACK: '1', RENDERTRAIL_TELEMETRY: '1' }, { telemetry: true })).toEqual({
      on: false,
      reason: 'DO_NOT_TRACK is set',
    });
    expect(telemetrySwitch({ DO_NOT_TRACK: '0', RENDERTRAIL_TELEMETRY: '1' }, null).on).toBe(true);
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
  });
});

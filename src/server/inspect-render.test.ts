import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { laggyFiles, savedTrace } from '../../test/helpers/laggy.js';
import { SCHEMA_VERSION, type InspectRenderOutput } from '../shared/types.js';
import { inspectRender } from './inspect-render.js';

// No browser here: the recorder returns the saved laggy-search trace.
vi.mock('../recorder/index.js', () => ({
  recordRender: async () => {
    const { summary, traces } = savedTrace('SearchPage');
    return { ok: true, summary, traces };
  },
}));

const input = {
  files: laggyFiles().filter((f) => !f.path.includes('.fixed')),
  entry: 'SearchPage.tsx',
  exportName: 'default',
  steps: savedTrace('SearchPage').summary.steps,
};

function textOf(result: Awaited<ReturnType<typeof inspectRender>>): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('inspectRender', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rt-inspect-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the findings when the baseline file is damaged, and says the baseline could not be read', async () => {
    await writeFile(path.join(dir, 'r_bad000.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, id: 'r_bad000', findings: [], keystroke: {} }));
    const result = await inspectRender({ ...input, baselineRunId: 'r_bad000' }, dir);
    const output = result.structuredContent as InspectRenderOutput;
    expect('error' in output).toBe(false);
    if ('error' in output) return;
    expect(output.findings.map((f) => f.id)).toEqual(['unstable-prop:ResultsList:filters', 'state-in-effect:SearchBox:setCharCount']);
    expect(output.comparison).toMatchObject({ found: false, baselineRunId: 'r_bad000' });
    const text = textOf(result);
    expect(text).toContain('The stored run "r_bad000" couldn\'t be read');
    expect(text).toContain('1. ResultsList (memo)');
    expect(text).toContain(`Run id: ${output.run.id}.`);
  });

  it('says the run could not be saved, without offering its id as a baseline', async () => {
    const notADir = path.join(dir, 'file');
    await writeFile(notADir, 'x');
    const result = await inspectRender(input, notADir);
    const text = textOf(result);
    expect(text).toContain("This run couldn't be saved");
    expect(text).not.toContain('Run id:');
    expect(text).toContain('1. ResultsList (memo)');
  });
});

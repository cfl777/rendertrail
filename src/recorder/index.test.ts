import { describe, expect, it } from 'vitest';
import { checkInput, recordRender, withRecordingLock } from './index.js';

const steps = [{ action: 'wait' as const, ms: 0 }];

describe('checkInput', () => {
  it('accepts a small input', () => {
    expect(checkInput({ files: [{ path: 'a.tsx', content: 'x' }], entry: 'a.tsx', exportName: 'default', steps })).toBeNull();
  });

  it('refuses more than 300 KB of source', () => {
    const files = [{ path: 'a.tsx', content: 'x'.repeat(301 * 1024) }];
    const error = checkInput({ files, entry: 'a.tsx', exportName: 'default', steps });
    expect(error?.kind).toBe('input');
    expect(error?.message).toContain('300 KB');
  });

  it('refuses the same file twice', () => {
    const files = [
      { path: 'a.tsx', content: '' },
      { path: './a.tsx', content: '' },
    ];
    expect(checkInput({ files, entry: 'a.tsx', exportName: 'default', steps })?.message).toContain('twice');
  });
});

describe('recordRender', () => {
  it('returns bundle errors as results, before starting a browser', async () => {
    const files = [{ path: 'a.tsx', content: 'export default (' }];
    const result = await recordRender({ files, entry: 'a.tsx', exportName: 'default', steps });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('bundle');
  });
});

/** Takes the turn and keeps it until release() is called. */
async function holdTurn(): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  let taken!: () => void;
  const isTaken = new Promise<void>((resolve) => (taken = resolve));
  const done = withRecordingLock(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        taken();
      }),
  );
  await isTaken;
  return { release, done };
}

describe('turns and cancelling', () => {
  const ok = { files: [{ path: 'a.tsx', content: 'export default () => null;' }], entry: 'a.tsx', exportName: 'default', steps };

  it('skips a call whose request was cancelled while it waited for its turn', async () => {
    const turn = await holdTurn();
    const abort = new AbortController();
    const queued = recordRender(ok, { signal: abort.signal });
    abort.abort();
    turn.release();
    await turn.done;
    const result = await queued;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('cancelled');
  });

  it('refuses invalid input at once, even while another call holds the turn', async () => {
    const turn = await holdTurn();
    const result = await recordRender({ ...ok, files: [ok.files[0]!, { path: './a.tsx', content: '' }] });
    expect(!result.ok && result.error.kind).toBe('input');
    turn.release();
    await turn.done;
  });

  it('gives turns in call order and reports how long each waited', async () => {
    const order: string[] = [];
    const slow = withRecordingLock(async (queueMs) => {
      order.push(`a ${queueMs < 50}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const next = withRecordingLock(async (queueMs) => {
      order.push(`b ${queueMs >= 90}`);
    });
    await Promise.all([slow, next]);
    expect(order).toEqual(['a true', 'b true']);
  });
});

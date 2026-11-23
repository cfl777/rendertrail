/**
 * A recording stuck past its deadline: the call fails with a timeout, the browser is closed, and the
 * next call gets its turn. No Chrome: the browser and the run are stand-ins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECORDING_DEADLINE_MS } from './limits.js';

const fake = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  release: vi.fn(),
  runOnce: vi.fn(() => new Promise<never>(() => {})), // a run that never finishes
}));

vi.mock('./browser.js', () => ({
  warmBrowser: {
    acquire: async () => ({ launched: { browser: {}, label: 'Fake' }, reused: true, release: fake.release }),
    close: fake.close,
  },
}));
vi.mock('./run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run.js')>()),
  runOnce: fake.runOnce,
}));

const { recordRender } = await import('./index.js');

const input = {
  files: [{ path: 'a.tsx', content: 'export default () => null;' }],
  entry: 'a.tsx',
  exportName: 'default',
  steps: [{ action: 'wait' as const, ms: 0 }],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('recording deadline', () => {
  it('fails a stuck recording at the deadline, closes the browser and lets the next call run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stuck = recordRender(input);
    const next = recordRender(input);
    await vi.waitFor(() => expect(fake.runOnce).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(fake.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RECORDING_DEADLINE_MS);
    const first = await stuck;
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.kind).toBe('timeout');
      expect(first.error.message).toContain('so the browser was closed');
    }
    expect(fake.close).toHaveBeenCalledTimes(1);

    // The queued call got its turn (and hit the same stuck run).
    await vi.waitFor(() => expect(fake.runOnce).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    await vi.advanceTimersByTimeAsync(RECORDING_DEADLINE_MS);
    expect((await next).ok).toBe(false);
  });
});

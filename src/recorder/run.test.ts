/**
 * runOnce with a stand-in browser (no Chrome): a context that doesn't close in time marks the run
 * as leaving the browser in doubt, so the recorder won't reuse it; context setup counts toward the
 * run's time limit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { LIMITS } from './limits.js';
import { RecorderError, runOnce } from './run.js';

const TRACE = { commits: [{ rendered: [{}] }], errors: [], truncated: false };

function fakeBrowser(options: { closeHangs?: boolean; mountFails?: boolean; newContextHangs?: boolean } = {}) {
  const page = {
    on: () => {},
    addInitScript: async () => {},
    goto: async () => {},
    waitForFunction: async () => {
      if (options.mountFails) throw new Error('timeout');
    },
    evaluate: async (expression: string) => (expression.includes('serialize') ? JSON.stringify(TRACE) : 1),
  };
  const context = {
    route: async () => {},
    routeWebSocket: async () => {},
    newPage: async () => page,
    close: vi.fn(() => (options.closeHangs ? new Promise<void>(() => {}) : Promise.resolve())),
  };
  const browser = {
    newContext: () => (options.newContextHangs ? new Promise(() => {}) : Promise.resolve(context)),
  };
  return { browser: browser as unknown as Browser, context };
}

async function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'ok',
    (err: unknown) => err,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runOnce', () => {
  it('returns the trace and closes the context', async () => {
    const { browser, context } = fakeBrowser();
    const output = await runOnce(browser, '', '', []);
    expect(output.trace.commits).toHaveLength(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('fails a run whose context does not close in time, and marks the browser as not reusable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { browser } = fakeBrowser({ closeHangs: true });
    const result = outcome(runOnce(browser, '', '', []));
    await vi.advanceTimersByTimeAsync(LIMITS.closeTimeoutMs);
    const error = await result;
    expect(error).toBeInstanceOf(RecorderError);
    expect((error as RecorderError).kind).toBe('browser');
    expect((error as RecorderError).browserBroken).toBe(true);
  });

  it("keeps a run's own error when the context also fails to close, marked as not reusable", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { browser } = fakeBrowser({ closeHangs: true, mountFails: true });
    const result = outcome(runOnce(browser, '', '', []));
    await vi.advanceTimersByTimeAsync(LIMITS.closeTimeoutMs);
    const error = (await result) as RecorderError;
    expect(error.kind).toBe('mount');
    expect(error.browserBroken).toBe(true);
  });

  it('counts creating the context toward the run time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { browser } = fakeBrowser({ newContextHangs: true });
    const result = outcome(runOnce(browser, '', '', []));
    await vi.advanceTimersByTimeAsync(LIMITS.runTimeoutMs + LIMITS.closeTimeoutMs);
    const error = (await result) as RecorderError;
    expect(error.kind).toBe('timeout');
    expect(error.browserBroken).toBe(true);
  });

  it('stops when the call is cancelled, without marking the browser', async () => {
    const { browser } = fakeBrowser();
    const abort = new AbortController();
    abort.abort();
    const error = (await outcome(runOnce(browser, '', '', [], abort.signal))) as RecorderError;
    expect(error.message).toContain('cancelled');
    expect(error.browserBroken).toBe(false);
  });
});

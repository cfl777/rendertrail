/**
 * The warm browser's bookkeeping, with a stand-in browser (no Chrome here; the real browser is
 * covered by test/golden/browser.golden.test.ts).
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarmBrowser } from './browser.js';
import type { LaunchedBrowser } from './run.js';

class FakeBrowser extends EventEmitter {
  connected = true;
  closes = 0;
  isConnected(): boolean {
    return this.connected;
  }
  async close(): Promise<void> {
    this.closes += 1;
    this.crash();
  }
  /** Gone without close(): a crash or a kill from outside. */
  crash(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnected');
  }
}

function fakeLauncher() {
  const browsers: FakeBrowser[] = [];
  const launch = vi.fn(async (): Promise<LaunchedBrowser> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const browser = new FakeBrowser();
    browsers.push(browser);
    return { browser: browser as unknown as LaunchedBrowser['browser'], label: `Fake ${browsers.length}` };
  });
  return { launch, browsers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WarmBrowser', () => {
  it('reuses the browser for the next call', async () => {
    const { launch, browsers } = fakeLauncher();
    const warm = new WarmBrowser(launch, 60_000);
    const first = await warm.acquire();
    expect(first.reused).toBe(false);
    first.release();
    const second = await warm.acquire();
    expect(second.reused).toBe(true);
    expect(second.launched).toBe(first.launched);
    second.release();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browsers[0]!.closes).toBe(0);
    await warm.close();
    expect(browsers[0]!.closes).toBe(1);
  });

  it('closes the browser after the idle time, and launches a new one for the next call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { launch, browsers } = fakeLauncher();
    const warm = new WarmBrowser(launch, 60_000);
    const pending = warm.acquire();
    await vi.advanceTimersByTimeAsync(5);
    const lease = await pending;
    lease.release();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(browsers[0]!.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(browsers[0]!.closes).toBe(1);
    expect(warm.peek()).toBeUndefined();

    const next = warm.acquire();
    await vi.advanceTimersByTimeAsync(5);
    expect((await next).reused).toBe(false);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('never closes a browser while a call holds it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { launch, browsers } = fakeLauncher();
    const warm = new WarmBrowser(launch, 1_000);
    const a = warm.acquire();
    await vi.advanceTimersByTimeAsync(5);
    const leaseA = await a;
    const leaseB = await warm.acquire();
    leaseA.release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(browsers[0]!.closes).toBe(0);
    leaseB.release();
    leaseB.release(); // a second release is ignored
    await vi.advanceTimersByTimeAsync(1_000);
    expect(browsers[0]!.closes).toBe(1);
  });

  it('launches a new browser when the warm one crashed or was killed', async () => {
    const { launch, browsers } = fakeLauncher();
    const warm = new WarmBrowser(launch, 60_000);
    (await warm.acquire()).release();
    browsers[0]!.crash();
    const lease = await warm.acquire();
    expect(lease.reused).toBe(false);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(lease.launched.browser).toBe(browsers[1]);
    lease.release();
    await warm.close();
  });

  it('two overlapping calls share one launch', async () => {
    const { launch } = fakeLauncher();
    const warm = new WarmBrowser(launch, 60_000);
    const [a, b] = await Promise.all([warm.acquire(), warm.acquire()]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(a.launched).toBe(b.launched);
    a.release();
    b.release();
    await warm.close();
  });

  it('closes a browser released with discard', async () => {
    const { launch, browsers } = fakeLauncher();
    const warm = new WarmBrowser(launch, 60_000);
    (await warm.acquire()).release(true);
    await warm.close();
    expect(browsers[0]!.closes).toBe(1);
    expect((await warm.acquire()).reused).toBe(false);
  });

  it('after shutdown, closes a browser that was still launching and refuses new calls', async () => {
    const { launch, browsers } = fakeLauncher();
    const warm = new WarmBrowser(launch, 60_000);
    const pending = warm.acquire();
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    await warm.shutdown();
    await pending;
    expect(browsers[0]!.closes).toBe(1);
    await expect(warm.acquire()).rejects.toThrow('shutting down');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('a call that starts just before shutdown launches nothing', async () => {
    const { launch } = fakeLauncher();
    const warm = new WarmBrowser(launch, 60_000);
    const pending = warm.acquire();
    await warm.shutdown();
    await expect(pending).rejects.toThrow('shutting down');
    expect(launch).not.toHaveBeenCalled();
  });

  it("kills a browser that doesn't close in time, so the next call isn't held up", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stuck = new FakeBrowser();
    stuck.close = () => new Promise<void>(() => {}); // a wedged browser
    const kill = vi.fn();
    const { launch, browsers } = fakeLauncher();
    launch.mockImplementationOnce(async () => ({
      browser: stuck as unknown as LaunchedBrowser['browser'],
      label: 'Stuck',
      pid: 4242,
    }));
    const warm = new WarmBrowser(launch, 60_000, { closeTimeoutMs: 5_000, kill });
    (await warm.acquire()).release();
    const closing = warm.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    expect(kill).toHaveBeenCalledWith(4242);
    const next = warm.acquire();
    await vi.advanceTimersByTimeAsync(5);
    expect((await next).launched.browser).toBe(browsers[0]);
  });

  it('a failed launch is not cached', async () => {
    const launch = vi.fn<() => Promise<LaunchedBrowser>>().mockRejectedValueOnce(new Error('no Chrome'));
    const { launch: works } = fakeLauncher();
    launch.mockImplementation(works);
    const warm = new WarmBrowser(launch, 60_000);
    await expect(warm.acquire()).rejects.toThrow('no Chrome');
    const lease = await warm.acquire();
    expect(lease.reused).toBe(false);
    lease.release();
    await warm.close();
  });
});

/**
 * Keeps one browser running between inspect_render calls in a long-lived server, so a call doesn't
 * pay for a browser launch. Every run still gets its own fresh browser context (run.ts), so nothing
 * carries over between runs or calls but the browser process itself.
 *
 * The browser is closed after LIMITS.browserIdleMs without a call, when a run left it in doubt (a
 * run that timed out, a page that wouldn't close), when a recording passed its deadline, and on
 * shutdown (closeWarmBrowser). A browser that doesn't close within LIMITS.closeTimeoutMs is killed.
 * If it crashed or was closed from outside, the next call launches a new one.
 */
import type { Browser } from 'playwright-core';
import { LIMITS } from './limits.js';
import { launchBrowser, RecorderError, settlesWithin, type LaunchedBrowser } from './run.js';

function killProcess(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

export interface Lease {
  launched: LaunchedBrowser;
  /** True when the browser was already running before this call. */
  reused: boolean;
  /** Hand the browser back; `discard` closes it instead of keeping it warm. */
  release(discard?: boolean): void;
}

export class WarmBrowser {
  private current: LaunchedBrowser | undefined;
  private launching: Promise<LaunchedBrowser> | undefined;
  private users = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private closing: Promise<void> = Promise.resolve();
  private stopped = false;

  private readonly closeTimeoutMs: number;
  private readonly kill: (pid: number) => void;

  constructor(
    private readonly launch: () => Promise<LaunchedBrowser> = launchBrowser,
    private readonly idleMs: number = LIMITS.browserIdleMs,
    options: { closeTimeoutMs?: number; kill?: (pid: number) => void } = {},
  ) {
    this.closeTimeoutMs = options.closeTimeoutMs ?? LIMITS.closeTimeoutMs;
    this.kill = options.kill ?? killProcess;
  }

  /** A connected browser: the warm one, or a new one. Pair every acquire with one release. */
  async acquire(): Promise<Lease> {
    this.users += 1;
    this.clearIdleTimer();
    try {
      await this.closing; // never hand out a browser that's being closed
      if (this.stopped) throw new RecorderError('browser', 'The server is shutting down.');
      const warm = this.current;
      if (warm && warm.browser.isConnected()) return this.lease(warm, true);
      this.current = undefined;
      const launched = await this.start();
      return this.lease(launched, false);
    } catch (err) {
      this.users -= 1;
      this.scheduleIdleClose();
      throw err;
    }
  }

  /** The running browser, if any (tests). */
  peek(): Browser | undefined {
    return this.current?.browser;
  }

  /** Closes the browser now, whoever is using it. */
  close(): Promise<void> {
    this.clearIdleTimer();
    const launched = this.current;
    const launching = this.launching;
    this.current = undefined;
    if (launched) this.closing = this.closing.then(() => this.shut(launched));
    if (launching) {
      // A launch in progress (shutdown during a call): close that browser too once it's up.
      this.closing = this.closing.then(() =>
        launching.then(
          (late) => {
            if (this.current === late) this.current = undefined;
            return this.shut(late);
          },
          () => {},
        ),
      );
    }
    return this.closing;
  }

  /** Closes a browser; kills it when it doesn't close in time, so a stuck one can't hold up the next call. */
  private async shut(launched: LaunchedBrowser): Promise<void> {
    const closed = await settlesWithin(launched.browser.close(), this.closeTimeoutMs);
    if (!closed && launched.pid !== undefined) this.kill(launched.pid);
  }

  private start(): Promise<LaunchedBrowser> {
    // Two calls that both find no browser share one launch.
    if (!this.launching) {
      this.launching = this.launch()
        .then((launched) => {
          this.current = launched;
          launched.browser.on('disconnected', () => {
            if (this.current === launched) this.current = undefined;
          });
          return launched;
        })
        .finally(() => {
          this.launching = undefined;
        });
    }
    return this.launching;
  }

  private lease(launched: LaunchedBrowser, reused: boolean): Lease {
    let released = false;
    return {
      launched,
      reused,
      release: (discard = false) => {
        if (released) return;
        released = true;
        this.users -= 1;
        if (discard && this.current === launched) void this.close();
        this.scheduleIdleClose();
      },
    };
  }

  private scheduleIdleClose(): void {
    if (this.users > 0 || !this.current) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.users === 0) void this.close();
    }, this.idleMs);
    this.idleTimer.unref(); // an idle browser must never keep the process alive on its own
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** Closes the browser for good: later acquires fail instead of launching another (shutdown). */
  shutdown(): Promise<void> {
    this.stopped = true;
    return this.close();
  }
}

/** The process-wide warm browser used by recordRender. */
export const warmBrowser = new WarmBrowser();

/** Closes the warm browser for good (server shutdown). Safe to call more than once. */
export function closeWarmBrowser(): Promise<void> {
  return warmBrowser.shutdown();
}

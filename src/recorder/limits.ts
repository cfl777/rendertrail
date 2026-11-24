/** Recorder limits and constants (HANDOFF.md §6, §7). */
export const LIMITS = {
  maxFiles: 30,
  maxSourceBytes: 300 * 1024,
  /** Wall-clock limit for one run: load, mount, play the steps, collect. */
  runTimeoutMs: 20_000,
  /** Limit for a single step or the mount, so a missing selector fails fast. */
  actionTimeoutMs: 5_000,
  runs: 3,
  /** Limit for closing a run's browser context, or the browser itself, before it's treated as stuck. */
  closeTimeoutMs: 5_000,
  /**
   * A warm browser is closed after this long without a call (browser.ts). Fix-and-check calls are
   * often minutes apart.
   */
  browserIdleMs: 300_000,
} as const;

/**
 * Deadline for one whole recording: every run at its limit, plus time to launch the browser and
 * close contexts. Past it the browser is closed (killed if need be) and the call fails, so one stuck
 * recording can't hold up the calls queued behind it.
 */
export const RECORDING_DEADLINE_MS = LIMITS.runs * LIMITS.runTimeoutMs + 15_000;

/** Default delay between typed characters when a `type` step has no delayMs. */
export const DEFAULT_TYPE_DELAY_MS = 50;
/** One frame at 60 Hz. */
export const FRAME_BUDGET_MS = 16.7;
/** performance.now() resolution in this setup; differences below it are noise. */
export const TIMER_RESOLUTION_MS = 0.1;
/** Cap on page errors kept per run. */
export const MAX_PAGE_ERRORS = 10;

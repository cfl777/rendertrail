/** Recorder limits and constants (HANDOFF.md §6, §7). */
export const LIMITS = {
  maxFiles: 30,
  maxSourceBytes: 300 * 1024,
  /** Wall-clock limit for one run: load, mount, play the steps, collect. */
  runTimeoutMs: 20_000,
  /** Limit for a single step or the mount, so a missing selector fails fast. */
  actionTimeoutMs: 5_000,
  runs: 3,
} as const;

/** Default delay between typed characters when a `type` step has no delayMs. */
export const DEFAULT_TYPE_DELAY_MS = 50;
/** One frame at 60 Hz. */
export const FRAME_BUDGET_MS = 16.7;
/** performance.now() resolution in this setup; differences below it are noise. */
export const TIMER_RESOLUTION_MS = 0.1;
/** Cap on page errors kept per run. */
export const MAX_PAGE_ERRORS = 10;

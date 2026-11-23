/**
 * Runs a bundled component in headless Chrome, plays the steps and collects the trace.
 */
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright-core';
import { BRAND } from '../brand.js';
import type { RecordedTrace, RunTiming, Step } from '../shared/types.js';
import { DEFAULT_TYPE_DELAY_MS, LIMITS, MAX_PAGE_ERRORS } from './limits.js';

const ORIGIN = 'http://recorder.local';

/**
 * Defence in depth beside the context routes: no DNS for any host (the in-memory routes are
 * fulfilled before DNS), and no WebRTC/STUN over UDP.
 */
const LAUNCH_ARGS = [
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--force-webrtc-ip-handling-policy',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
];
/** Playwright's default is 3 minutes; a browser that takes this long won't record well anyway. */
const LAUNCH_TIMEOUT_MS = 30_000;
const HTML =
  '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

export class RecorderError extends Error {
  /** Set when the browser may be left in a bad state (a page that won't close): don't reuse it. */
  browserBroken = false;

  constructor(
    readonly kind: 'browser' | 'mount' | 'step' | 'timeout',
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

export interface LaunchedBrowser {
  browser: Browser;
  label: string;
  /** The browser's process id, so a browser that won't close can be killed (browser.ts). */
  pid?: number;
}

/** Resolves true when `work` settles within `ms`, false when it fails or takes longer. */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true, () => false), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Chrome's own browser process id (Playwright doesn't expose it for a launched browser). */
async function browserPid(browser: Browser): Promise<number | undefined> {
  try {
    const session = await browser.newBrowserCDPSession();
    const info = (await session.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
    await session.detach().catch(() => {});
    return info.processInfo.find((p) => p.type === 'browser')?.id;
  } catch {
    return undefined;
  }
}

/**
 * The command that installs the Chromium build this playwright-core expects. The version is pinned:
 * a plain `npx playwright-core install` would get the latest release, whose Chromium may not match.
 */
export function chromiumInstallCommand(): string {
  const pkg = createRequire(import.meta.url)('playwright-core/package.json') as { version?: string };
  return `npx playwright-core@${pkg.version ?? 'latest'} install chromium`;
}

/** What to tell someone who has neither Chrome nor Playwright's Chromium. */
export function noBrowserError(chromeError: string, chromiumError: string): RecorderError {
  return new RecorderError(
    'browser',
    `No browser to record in. ${BRAND.displayName} uses your installed Google Chrome and couldn't find or start it.`,
    [
      'Fix it once, either way, then call inspect_render again (no restart needed):',
      '  - install Google Chrome: https://www.google.com/chrome/',
      `  - or download Playwright's Chromium (about 150 MB) by running this in a terminal: ${chromiumInstallCommand()}`,
      `Chrome: ${chromeError}`,
      `Chromium: ${chromiumError}`,
    ],
  );
}

/** The installed Chrome first (no download); Playwright's Chromium as the fallback. */
export async function launchBrowser(): Promise<LaunchedBrowser> {
  let chromeError = '';
  try {
    const browser = await chromium.launch({ channel: 'chrome', args: LAUNCH_ARGS, timeout: LAUNCH_TIMEOUT_MS });
    return { browser, label: `Chrome ${browser.version()}`, pid: await browserPid(browser) };
  } catch (err) {
    chromeError = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : 'Unknown error';
  }
  try {
    const browser = await chromium.launch({ args: LAUNCH_ARGS, timeout: LAUNCH_TIMEOUT_MS });
    return { browser, label: `Chromium ${browser.version()}`, pid: await browserPid(browser) };
  } catch (err) {
    const chromiumError = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : 'Unknown error';
    throw noBrowserError(chromeError, chromiumError);
  }
}

export interface RunOutput {
  trace: RecordedTrace;
  pageErrors: string[];
  timing: RunTiming;
}

/** Milliseconds since `start`, to 0.1 ms. */
export function since(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}

/** The delay a step asks for itself: a `wait`, or one typing delay per character. */
export function scriptedDelayMs(step: Step): number {
  if (step.action === 'wait') return step.ms;
  if (step.action === 'type') return [...step.text].length * (step.delayMs ?? DEFAULT_TYPE_DELAY_MS);
  return 0;
}

function isTrace(value: unknown): value is RecordedTrace {
  return (
    typeof value === 'object' &&
    value !== null &&
    'commits' in value &&
    Array.isArray(value.commits) &&
    'errors' in value &&
    Array.isArray(value.errors) &&
    'truncated' in value &&
    typeof value.truncated === 'boolean'
  );
}

function describeStep(step: Step, index: number): string {
  const n = `Step ${index + 1}`;
  if (step.action === 'type') return `${n} (type ${JSON.stringify(step.text)} into ${step.target})`;
  if (step.action === 'click') return `${n} (click ${step.target})`;
  return `${n} (wait ${step.ms} ms)`;
}

async function playStep(page: Page, step: Step): Promise<void> {
  const timeout = LIMITS.actionTimeoutMs;
  if (step.action === 'type') {
    await page.locator(step.target).pressSequentially(step.text, { delay: step.delayMs ?? DEFAULT_TYPE_DELAY_MS, timeout });
  } else if (step.action === 'click') {
    await page.locator(step.target).click({ timeout });
  } else {
    await page.waitForTimeout(step.ms);
  }
}

async function recordInPage(
  page: Page,
  instrumentation: string,
  steps: Step[],
  pageErrors: string[],
  timing: RunTiming,
): Promise<RecordedTrace> {
  let start = performance.now();
  await page.addInitScript({ content: instrumentation });
  await page.goto(`${ORIGIN}/`);
  try {
    await page.waitForFunction('window.__RT__ && window.__RT__.commits.length > 0', null, {
      timeout: LIMITS.actionTimeoutMs,
    });
  } catch {
    throw new RecorderError('mount', `The component didn't render within ${LIMITS.actionTimeoutMs / 1000} s.`, pageErrors);
  }
  const mounted = await page.evaluate('window.__RT__.commits[0].rendered.length');
  if (mounted === 0 && pageErrors.length > 0) {
    throw new RecorderError('mount', 'The component threw an error while mounting.', pageErrors);
  }
  timing.loadMountMs = since(start);

  start = performance.now();

  for (const [index, step] of steps.entries()) {
    try {
      await playStep(page, step);
    } catch (err) {
      const first = err instanceof Error ? (err.message.split('\n')[0] ?? '') : '';
      const reason = /timeout/i.test(first)
        ? `no element matched the selector, or it couldn't be used, within ${LIMITS.actionTimeoutMs / 1000} s`
        : first || 'it failed';
      throw new RecorderError('step', `${describeStep(step, index)} failed: ${reason}.`, pageErrors);
    }
  }
  timing.stepsMs = since(start);
  timing.scriptedMs = steps.reduce((sum, step) => sum + scriptedDelayMs(step), 0);

  start = performance.now();
  // As one JSON string, made by the instrumentation (page/instrument.ts): for laggy-search's
  // 1,000-row trace about 6 ms instead of 130 ms with Playwright's value-by-value copy.
  const json: unknown = await page.evaluate('window.__RT__.serialize()');
  const trace: unknown = typeof json === 'string' ? JSON.parse(json) : undefined;
  timing.collectMs = since(start);
  if (!isTrace(trace)) throw new RecorderError('mount', 'The page instrumentation returned no trace.', pageErrors);
  return trace;
}

/**
 * One run in a fresh browser context. Everything, creating the context and page included, is limited
 * to LIMITS.runTimeoutMs; closing the context to LIMITS.closeTimeoutMs. A run that timed out, or a
 * context that didn't close (its page might keep running the user's timers), marks the error
 * `browserBroken`, so the browser isn't reused. `signal` stops the run early (a cancelled call).
 */
export async function runOnce(
  browser: Browser,
  app: string,
  instrumentation: string,
  steps: Step[],
  signal?: AbortSignal,
): Promise<RunOutput> {
  const runStart = performance.now();
  const timing: RunTiming = { contextMs: 0, loadMountMs: 0, stepsMs: 0, scriptedMs: 0, collectMs: 0, closeMs: 0, totalMs: 0 };
  const pageErrors: string[] = [];
  const keep = (text: string): void => {
    if (pageErrors.length < MAX_PAGE_ERRORS) pageErrors.push(text);
  };
  // Context-wide, so popups (window.open) get the same rules; service workers can't bypass routes.
  const contextReady = browser.newContext({ serviceWorkers: 'block' });

  const record = async (): Promise<RecordedTrace> => {
    const context = await contextReady;
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: HTML });
      if (url === `${ORIGIN}/app.js`) return route.fulfill({ contentType: 'text/javascript', body: app });
      return route.abort(); // the recorded code gets no network access
    });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const page = await context.newPage();
    timing.contextMs = since(runStart);
    page.on('pageerror', (error) => keep(`Uncaught: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') keep(`console.error: ${message.text()}`);
    });
    return recordInPage(page, instrumentation, steps, pageErrors, timing);
  };

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new RecorderError('timeout', `The run took longer than ${LIMITS.runTimeoutMs / 1000} s.`, pageErrors);
      error.browserBroken = true; // a page busy in a loop might not let go
      reject(error);
    }, LIMITS.runTimeoutMs);
    onAbort = () => reject(new RecorderError('timeout', 'The call was cancelled before the recording finished.', pageErrors));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

  let failure: unknown;
  let trace: RecordedTrace | undefined;
  try {
    trace = await Promise.race([record(), stopped]);
  } catch (err) {
    failure = err;
  }
  clearTimeout(timer);
  if (onAbort) signal?.removeEventListener('abort', onAbort);

  const closeStart = performance.now();
  const closed = await settlesWithin(
    contextReady.then((context) => context.close()),
    LIMITS.closeTimeoutMs,
  );
  timing.closeMs = since(closeStart);
  timing.totalMs = since(runStart);

  if (failure === undefined && !closed) {
    failure = new RecorderError('browser', `Chrome didn't close the recorded page within ${LIMITS.closeTimeoutMs / 1000} s.`, pageErrors);
  }
  if (failure !== undefined) {
    if (!closed && failure instanceof RecorderError) failure.browserBroken = true;
    throw failure;
  }
  return { trace: trace!, pageErrors, timing };
}

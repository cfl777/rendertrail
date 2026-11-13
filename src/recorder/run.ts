/**
 * Runs a bundled component in headless Chrome, plays the steps and collects the trace.
 */
import { createRequire } from 'node:module';
import { chromium, type Browser, type Page } from 'playwright-core';
import { BRAND } from '../brand.js';
import type { RecordedTrace, Step } from '../shared/types.js';
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
const HTML =
  '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

export class RecorderError extends Error {
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
}

/**
 * The command that installs the Chromium build this playwright-core expects. The version is pinned:
 * a plain `npx playwright-core install` would fetch the latest release, whose Chromium may not match.
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
    const browser = await chromium.launch({ channel: 'chrome', args: LAUNCH_ARGS });
    return { browser, label: `Chrome ${browser.version()}` };
  } catch (err) {
    chromeError = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : 'Unknown error';
  }
  try {
    const browser = await chromium.launch({ args: LAUNCH_ARGS });
    return { browser, label: `Chromium ${browser.version()}` };
  } catch (err) {
    const chromiumError = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : 'Unknown error';
    throw noBrowserError(chromeError, chromiumError);
  }
}

export interface RunOutput {
  trace: RecordedTrace;
  pageErrors: string[];
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

async function recordInPage(page: Page, instrumentation: string, steps: Step[], pageErrors: string[]): Promise<RecordedTrace> {
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

  const trace: unknown = await page.evaluate('({ commits: window.__RT__.commits, errors: window.__RT__.errors, truncated: window.__RT__.truncated })');
  if (!isTrace(trace)) throw new RecorderError('mount', 'The page instrumentation returned no trace.', pageErrors);
  return trace;
}

/** One run in a fresh browser context, limited to LIMITS.runTimeoutMs. */
export async function runOnce(browser: Browser, app: string, instrumentation: string, steps: Step[]): Promise<RunOutput> {
  // Context-wide, so popups (window.open) get the same rules; service workers can't bypass routes.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const pageErrors: string[] = [];
  const keep = (text: string): void => {
    if (pageErrors.length < MAX_PAGE_ERRORS) pageErrors.push(text);
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: HTML });
      if (url === `${ORIGIN}/app.js`) return route.fulfill({ contentType: 'text/javascript', body: app });
      return route.abort(); // the recorded code gets no network access
    });
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const page = await context.newPage();
    page.on('pageerror', (error) => keep(`Uncaught: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') keep(`console.error: ${message.text()}`);
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RecorderError('timeout', `The run took longer than ${LIMITS.runTimeoutMs / 1000} s.`, pageErrors)),
        LIMITS.runTimeoutMs,
      );
    });
    const trace = await Promise.race([recordInPage(page, instrumentation, steps, pageErrors), timeout]);
    return { trace, pageErrors };
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
}

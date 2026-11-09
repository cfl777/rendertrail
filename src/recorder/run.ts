/**
 * Runs a bundled component in headless Chrome, plays the steps and collects the trace.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import type { RecordedTrace, Step } from '../shared/types.js';
import { DEFAULT_TYPE_DELAY_MS, LIMITS, MAX_PAGE_ERRORS } from './limits.js';

const ORIGIN = 'http://rendertrail.local';
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

/** The installed Chrome first (no download); Playwright's Chromium as the fallback. */
export async function launchBrowser(): Promise<LaunchedBrowser> {
  let chromeError = '';
  try {
    const browser = await chromium.launch({ channel: 'chrome' });
    return { browser, label: `Chrome ${browser.version()}` };
  } catch (err) {
    chromeError = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : 'Unknown error';
  }
  try {
    const browser = await chromium.launch();
    return { browser, label: `Chromium ${browser.version()}` };
  } catch (err) {
    const chromiumError = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : 'Unknown error';
    throw new RecorderError(
      'browser',
      "Couldn't start a browser. Install Google Chrome, or install Playwright's Chromium (about 150 MB) with: npx playwright-core install chromium",
      [`Chrome: ${chromeError}`, `Chromium: ${chromiumError}`],
    );
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
    Array.isArray(value.errors)
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

async function recordInPage(page: Page, app: string, instrumentation: string, steps: Step[], pageErrors: string[]): Promise<RecordedTrace> {
  await page.addInitScript({ content: instrumentation });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: HTML });
    if (url === `${ORIGIN}/app.js`) return route.fulfill({ contentType: 'text/javascript', body: app });
    return route.abort(); // the recorded code gets no network access
  });
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

  const trace: unknown = await page.evaluate('({ commits: window.__RT__.commits, errors: window.__RT__.errors })');
  if (!isTrace(trace)) throw new RecorderError('mount', 'The page instrumentation returned no trace.', pageErrors);
  return trace;
}

/** One run in a fresh browser context, limited to LIMITS.runTimeoutMs. */
export async function runOnce(browser: Browser, app: string, instrumentation: string, steps: Step[]): Promise<RunOutput> {
  const context = await browser.newContext();
  const pageErrors: string[] = [];
  const keep = (text: string): void => {
    if (pageErrors.length < MAX_PAGE_ERRORS) pageErrors.push(text);
  };
  let timer: NodeJS.Timeout | undefined;
  try {
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
    const trace = await Promise.race([recordInPage(page, app, instrumentation, steps, pageErrors), timeout]);
    return { trace, pageErrors };
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
}

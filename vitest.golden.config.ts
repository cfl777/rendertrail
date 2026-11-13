import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { BRAND } from './src/brand.js';

// Golden tests: record fixtures/ in a real browser (installed Chrome, or Playwright's Chromium).
export default defineConfig({
  test: {
    // Runs stored by the tests (and by servers they spawn) go to a temp folder, never the real home.
    // Counting stays off whatever the developer's own settings say.
    env: { [BRAND.runsDirEnv]: path.join(os.tmpdir(), `${BRAND.name}-test-runs`), [BRAND.telemetryEnv]: '0' },
    root: '.',
    include: ['test/**/*.golden.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

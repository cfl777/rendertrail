import { defineConfig } from 'vitest/config';

// Golden tests: record fixtures/ in a real browser (installed Chrome, or Playwright's Chromium).
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.golden.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

// Unit tests. The golden tests need Chrome and run separately (vitest.golden.config.ts).
export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.golden.test.ts'],
  },
});

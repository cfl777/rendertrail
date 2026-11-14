import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { BRAND } from './src/brand.js';

// Unit tests. The golden tests need Chrome and run separately (vitest.golden.config.ts).
export default defineConfig({
  test: {
    // Runs stored by the tests (and by servers they spawn) go to a temp folder, never the real home.
    // Counting stays off whatever the developer's own settings say.
    env: { [BRAND.runsDirEnv]: path.join(os.tmpdir(), `${BRAND.name}-test-runs`), [BRAND.telemetryEnv]: '0' },
    root: '.',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'ui/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/*.golden.test.ts'],
  },
});

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json' with { type: 'json' };
import { BRAND } from './src/brand.js';

/** The page title comes from src/brand.ts, the one place the name lives. */
const brandTitle: Plugin = {
  name: 'brand-title',
  transformIndexHtml: (html) => html.replace('%BRAND_NAME%', BRAND.displayName),
};

// Builds ui/card.html into one self-contained dist/card.html (served as the MCP App resource).
export default defineConfig({
  root: 'ui',
  plugins: [react(), viteSingleFile(), brandTitle],
  // Only the version goes into the card, not the whole package.json.
  define: { __CARD_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: '../dist',
    emptyOutDir: false,
    rolldownOptions: {
      input: fileURLToPath(new URL('./ui/card.html', import.meta.url)),
    },
  },
});

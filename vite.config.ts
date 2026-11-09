import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds ui/card.html into one self-contained dist/card.html (served as the MCP App resource).
export default defineConfig({
  root: 'ui',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist',
    emptyOutDir: false,
    rolldownOptions: {
      input: fileURLToPath(new URL('./ui/card.html', import.meta.url)),
    },
  },
});

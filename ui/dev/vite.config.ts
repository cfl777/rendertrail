import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The card harness: `npm run dev:card`, then http://127.0.0.1:5177/ (not part of the build). */
export const HARNESS_PORT = 5177;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: HARNESS_PORT,
    strictPort: true,
    // The harness imports ../src and ../../src (the card and the shared types).
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
  },
});

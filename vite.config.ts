import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/frontend'),
  server: {
    port: 5173,
  },
});

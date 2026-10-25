import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'client',
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/socket.io': { target: 'http://127.0.0.1:3000', ws: true },
      '/healthz': { target: 'http://127.0.0.1:3000' },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
    emptyOutDir: true,
  },
});

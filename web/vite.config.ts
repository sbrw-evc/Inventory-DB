import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const sharedSrc = fileURLToPath(new URL('../shared/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@shared$/, replacement: `${sharedSrc}/index.ts` },
      { find: /^@shared\/(.*)$/, replacement: `${sharedSrc}/$1` },
    ],
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080' } },
  build: {
    rollupOptions: {
      output: {
        // React and the data/router libraries change rarely: keep them in their own long-cached chunk.
        manualChunks: (id: string) =>
          /node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@tanstack)\//.test(id) ? 'vendor' : undefined,
      },
    },
  },
  test: { environment: 'jsdom' },
} as never);

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
  test: { environment: 'jsdom' },
} as never);

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    // Webhook tests post to local HTTP servers.
    env: { WEBHOOK_ALLOW_PRIVATE: '1' },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests run against PostgreSQL (TEST_DATABASE_URL); each test file gets its own schema.
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 20000,
    // Webhook tests post to local HTTP servers.
    env: { WEBHOOK_ALLOW_PRIVATE: '1' },
  },
});

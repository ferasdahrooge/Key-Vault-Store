import { defineConfig } from 'vitest/config';

// Vitest settings for the server: Node environment, generous timeout for DB tests.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});

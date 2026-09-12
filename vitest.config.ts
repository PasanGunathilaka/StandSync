import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Default run must never hit the network. Live tests opt in with LIVE=1.
    passWithNoTests: false,
  },
});

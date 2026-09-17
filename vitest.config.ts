import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Default run must never hit the network. Live tests opt in with LIVE=1.
    passWithNoTests: false,
    /**
     * Above the 5s default.
     *
     * The first test in a file to construct a Fastify instance pays the one-off
     * cost of Fastify's own module initialisation. On Windows, under a parallel
     * run, that has been measured at over 5s — long enough to fail tests that
     * pass in isolation, in both test/teams.test.ts and test/devRoutes.test.ts.
     * 20s still fails fast on a genuinely hung test.
     */
    testTimeout: 20_000,
  },
});

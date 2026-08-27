import { defineWorkspace } from 'vitest/config';

/**
 * P0 test topology.
 *
 * One project per workspace package. Contracts tests are pure and must stay
 * hermetic: no network, no provider CLI, no database, no filesystem writes
 * outside the repository. The architecture fence is exercised by
 * `pnpm check:architecture`, not by the unit runner.
 */
export default defineWorkspace([
  {
    test: {
      name: 'contracts',
      root: './packages/contracts',
      include: ['src/**/*.test.ts'],
      environment: 'node',
      restoreMocks: true,
      unstubEnvs: true,
      unstubGlobals: true,
    },
  },
]);

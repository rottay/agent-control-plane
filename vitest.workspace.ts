import { fileURLToPath } from 'node:url';

import { defineWorkspace } from 'vitest/config';

/**
 * Test topology.
 *
 * One project per workspace package. Contracts tests are pure and must stay
 * hermetic: no network, no provider CLI, no database, no filesystem writes
 * outside the repository. The architecture fence is exercised by
 * `pnpm check:architecture`, not by the unit runner.
 *
 * Ledger tests do use a database, by necessity, but only inside a temporary
 * directory they create and remove themselves. They never touch a repository
 * path, and they never reach the network or a provider CLI.
 *
 * The ledger project resolves `@acp/contracts` to its TypeScript source rather
 * than to its build output, so `pnpm test` does not silently depend on a build
 * having run first. The cross-process concurrency test is the one exception:
 * a child process cannot use this alias, so that test builds the package on
 * demand and runs the compiled entry point.
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
  {
    test: {
      name: 'ledger',
      root: './packages/ledger',
      include: ['src/**/*.test.ts'],
      environment: 'node',
      restoreMocks: true,
      unstubEnvs: true,
      unstubGlobals: true,
      // The concurrency test spawns child processes and may build the package.
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
    resolve: {
      alias: [
        {
          find: /^@acp\/contracts$/,
          replacement: fileURLToPath(
            new URL('./packages/contracts/src/index.ts', import.meta.url),
          ),
        },
      ],
    },
  },
]);

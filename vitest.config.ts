import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Test topology.
 *
 * One project per workspace package that actually has tests. This replaces the
 * former `vitest.workspace.ts`: `defineWorkspace` is deprecated in Vitest 3 and
 * the same topology is expressed here as `test.projects`, which keeps one file
 * as the single place a reader looks for how the suite is composed.
 *
 * Contracts tests are pure and must stay hermetic: no network, no provider CLI,
 * no database, no filesystem writes outside the repository. The architecture
 * fence is exercised by `pnpm check:architecture`, not by the unit runner.
 *
 * Ledger tests do use a database, by necessity, but only inside a temporary
 * directory they create and remove themselves. They never touch a repository
 * path, and they never reach the network or a provider CLI.
 *
 * The ledger and api-contracts projects resolve `@acp/contracts` to its
 * TypeScript source rather than to its build output, so `pnpm test` does not
 * silently depend on a build having run first. The cross-process concurrency
 * test is the one exception: a child process cannot use this alias, so that
 * test builds the package on demand and runs the compiled entry point.
 *
 * The cli, server and ui packages have no project here. They are P1B scaffolds
 * with no behaviour to assert, and a project that collects zero test files
 * would report a green suite for code nobody has written yet. Each lane adds
 * its own project together with its first test.
 */

const contractsSource = fileURLToPath(
  new URL('./packages/contracts/src/index.ts', import.meta.url),
);

export default defineConfig({
  test: {
    projects: [
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
          alias: [{ find: /^@acp\/contracts$/, replacement: contractsSource }],
        },
      },
      {
        test: {
          name: 'api-contracts',
          root: './packages/api-contracts',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          restoreMocks: true,
          unstubEnvs: true,
          unstubGlobals: true,
        },
        resolve: {
          alias: [{ find: /^@acp\/contracts$/, replacement: contractsSource }],
        },
      },
    ],
  },
});

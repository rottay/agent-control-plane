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
 * Every project resolves the workspace contract packages to their TypeScript
 * sources rather than to their build output, so `pnpm test` does not silently
 * depend on a build having run first. The cross-process concurrency test in the
 * ledger is the one exception: a child process cannot use these aliases, so
 * that test builds the package on demand and runs the compiled entry point.
 *
 * P1 adds the cli, server and ui projects. Each lane built its suite behind a
 * package-local config because the root config is integrator owned and outside
 * a lane write-set; those configs are gone and their projects live here, so
 * `pnpm check` actually executes every suite in the repository. A suite that
 * only runs under a command nobody types is not a gate.
 *
 * P2A adds `@acp/runtime` to the TypeScript solution but deliberately adds no
 * project here. That package currently exports frozen types and constants and
 * nothing executable, so it has nothing to assert that its own compilation does
 * not already prove. Its contracts are covered by the `contracts` project,
 * which owns the schemas. An empty project would report a green suite for
 * behaviour nobody has written; P2B adds the project together with the first
 * driver test, exactly as the three P1 lanes did.
 */

const contractsSource = fileURLToPath(
  new URL('./packages/contracts/src/index.ts', import.meta.url),
);
const ledgerSource = fileURLToPath(
  new URL('./packages/ledger/src/index.ts', import.meta.url),
);
const apiContractsSource = fileURLToPath(
  new URL('./packages/api-contracts/src/index.ts', import.meta.url),
);

/** The contract packages, resolved to source for every downstream project. */
const workspaceSourceAliases = [
  { find: /^@acp\/contracts$/, replacement: contractsSource },
  { find: /^@acp\/ledger$/, replacement: ledgerSource },
  { find: /^@acp\/api-contracts$/, replacement: apiContractsSource },
];

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
      {
        test: {
          name: 'server',
          root: './packages/server',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          restoreMocks: true,
          unstubEnvs: true,
          unstubGlobals: true,
          // Builds disposable ledgers and opens real loopback sockets.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
        resolve: { alias: workspaceSourceAliases },
      },
      {
        test: {
          name: 'cli',
          root: './packages/cli',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          restoreMocks: true,
          unstubEnvs: true,
          unstubGlobals: true,
          // Seeds disposable ledgers before invoking the command surface.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
        resolve: { alias: workspaceSourceAliases },
      },
      {
        test: {
          name: 'ui',
          root: './packages/ui',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          environment: 'node',
          restoreMocks: true,
          unstubEnvs: true,
          unstubGlobals: true,
        },
        resolve: { alias: workspaceSourceAliases },
      },
    ],
  },
});

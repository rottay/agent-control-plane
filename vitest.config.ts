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
 * P2A added `@acp/runtime` to the TypeScript solution with no project here,
 * because it exported types and constants and had nothing to assert that its
 * own compilation did not already prove. P2B adds the project together with the
 * first driver, exactly as promised and exactly as the three P1 lanes did.
 *
 * The runtime project carries the long timeouts: its kill/restart drills spawn
 * real child processes, terminate them with real signals and reopen the ledger
 * afterwards. A drill that caught an exception in-process would prove nothing
 * about durability, so it costs wall clock instead.
 *
 * It also runs its files one at a time. Its suites share one mutable root,
 * `.acp-local/drills`, and the boundary tests are adversarial about it: they
 * rename that root aside and put a symlink in its place to prove the runtime
 * refuses to descend through it. Run in parallel with the supervisor drills,
 * which spawn children that resolve scenarios under the same root, a child
 * could observe the adversarial root mid-test. That is a race in the test
 * harness, not in the code under test, and it would surface as an intermittent
 * failure in whichever suite happened to lose. Serialising this one project is
 * cheaper and more honest than giving each suite a private root, because the
 * fixed root is exactly what the boundary tests exist to defend.
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
      {
        test: {
          name: 'runtime',
          root: './packages/runtime',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          restoreMocks: true,
          unstubEnvs: true,
          unstubGlobals: true,
          // Shared adversarial root: see the note above. Only this project.
          fileParallelism: false,
          // Real child processes, real SIGKILL, real ledger reopens.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
        resolve: { alias: workspaceSourceAliases },
      },
    ],
  },
});

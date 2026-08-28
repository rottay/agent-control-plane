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

/**
 * P2D adds the daemon project, and with it a resource neither project owns
 * alone: the pinned loopback ports 8080, 9070 and 9080.
 *
 * `fileParallelism: false` is not enough here, and the distinction matters.
 * That option serialises the files *within* one project; it says nothing about
 * two projects, which Vitest is free to run at the same time. The runtime
 * drills start a real Restate server on 8080/9070 and the daemon drills start
 * another one, so concurrent projects would collide on bind — and the failure
 * would surface as an unrelated timeout in whichever suite happened to lose,
 * which is the kind of flake that gets re-run rather than diagnosed.
 *
 * `sequence.groupOrder` is the project-level control: projects sharing a number
 * run together, and lower numbers run first. The two port-binding projects get
 * distinct numbers, so they are serialised with respect to each other while
 * every hermetic project still runs concurrently in group 0.
 *
 * The daemon drills additionally assert the ports are unbound before they start
 * and fail loudly if they are not. Solving this with dynamic ports was rejected:
 * the pinned addresses are part of the contract, and a daemon that quietly moved
 * would pass its own drills and then not be where anything expects it.
 */

/**
 * A correction P2D found the hard way, which applies to the runtime project too.
 *
 * `fileParallelism: false` declared **inside a project** is not honoured. Only
 * the root-level option and the `--no-file-parallelism` flag are, so the setting
 * the runtime project has carried since P2B has been inert: its files have been
 * running in parallel over the shared `.acp-local/drills` root the whole time,
 * and it stayed green by luck rather than by design.
 *
 * The daemon suites surfaced it immediately because they share one fixed owned
 * root and one lock file, so interleaving is not subtle: suites deleted each
 * other's directories mid-test. Passing the same files with
 * `--no-file-parallelism` made them pass, which is what identified the config as
 * the cause rather than the code.
 *
 * `poolOptions.forks.singleFork` is the per-project control that does bind: it
 * confines the project to one worker, so its files run one at a time. Both
 * port-binding projects now set it. `fileParallelism: false` is left in place as
 * documentation of intent, but the fork option is what enforces it.
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

const runtimeSource = fileURLToPath(
  new URL('./packages/runtime/src/index.ts', import.meta.url),
);

/** The daemon additionally resolves the runtime to source, for the same reason. */
const daemonSourceAliases = [
  ...workspaceSourceAliases,
  { find: /^@acp\/runtime$/, replacement: runtimeSource },
];

/**
 * Deep aliases for the P3D parity test, resolved only in the server project.
 *
 * The three-way equality has to compare the CLI's row model against the UI's,
 * and neither module is its package's entry point. Widening either entry for a
 * test-only need is exactly the export-surface drift the closed-surface pins
 * exist to prevent, so the specifiers are aliased here instead: test resolution
 * only, invisible to production code, and both packages' public surfaces stay
 * byte-untouched.
 *
 * The architecture fence asserts these two targets and that the specifiers are
 * imported only by `packages/server/src/parity.test.ts`.
 */
const cliRowModelSource = fileURLToPath(
  new URL('./packages/cli/src/observation.ts', import.meta.url),
);
const uiRowModelSource = fileURLToPath(
  new URL('./packages/ui/src/api/client.ts', import.meta.url),
);
const parityAliases = [
  ...workspaceSourceAliases,
  { find: /^@acp\/cli\/observation-rows$/, replacement: cliRowModelSource },
  { find: /^@acp\/ui\/row-model$/, replacement: uiRowModelSource },
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
          // Reads only; binds no port and spawns nothing, so it stays in the
          // default parallel group (groupOrder 0) rather than joining the
          // serialized port-binding groups the runtime and daemon projects use.
          name: 'observation',
          root: './packages/observation',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          restoreMocks: true,
          unstubEnvs: true,
          unstubGlobals: true,
        },
        resolve: { alias: workspaceSourceAliases },
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
        resolve: { alias: parityAliases },
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
          poolOptions: { forks: { singleFork: true } },
          // Binds the pinned ports; must not overlap the daemon project.
          sequence: { groupOrder: 1 },
          // Real child processes, real SIGKILL, real ledger reopens.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
        resolve: { alias: workspaceSourceAliases },
      },
      {
        test: {
          name: 'daemon',
          root: './packages/daemon',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          restoreMocks: true,
          unstubEnvs: true,
          unstubGlobals: true,
          // One owned root, one lock file, one set of pinned ports.
          fileParallelism: false,
          poolOptions: { forks: { singleFork: true } },
          // Runs after the runtime project, never beside it.
          sequence: { groupOrder: 2 },
          // Real child processes, real signals, a real external server.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
        resolve: { alias: daemonSourceAliases },
      },
    ],
  },
});

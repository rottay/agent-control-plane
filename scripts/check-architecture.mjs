#!/usr/bin/env node
/**
 * Agent Control Plane architecture fence.
 *
 * This runs first in `pnpm check`. It is deliberately dependency free and
 * deterministic: it reads the working tree, asks git a few read-only
 * questions, and executes the pre-push hook to prove it still denies.
 *
 * It enforces the P0 laws that a type system cannot:
 *
 *   1. the phase write-set is respected: the exact P0 list plus the exact P1A
 *      additions, and nothing else;
 *   2. docs/ROADMAP.md is still the byte-exact kickoff roadmap;
 *   3. the authority documents still carry their critical literals;
 *   4. the pre-push hook exists, is executable and always refuses;
 *   5. core.hooksPath is actually pointed at .githooks, so the fence is live;
 *   6. no remote is configured;
 *   7. no credential store is present in the repository.
 *
 * P1A adds three more, all of which exist because P1A introduces the first
 * native dependency and the first substantial body of code:
 *
 *   8. the install-time native build allow-list names exactly better-sqlite3;
 *   9. the ledger package depends on exactly what it was authorized to;
 *  10. no file outside the authority documents claims product integration or
 *      cutover authority.
 *
 * P1B adds three more, all of which exist because P1B is the last single-writer
 * phase before three lanes run in parallel:
 *
 *  11. the four new packages depend on exactly what they were authorized to,
 *      and the browser package names no ledger and no database driver anywhere;
 *  12. the retired Vitest workspace file is actually gone, so the deletion is
 *      enforced rather than merely performed once;
 *  13. the lane envelope is scoped to three named prefixes and expires by
 *      itself when the roadmap stops saying P1_INCOMPLETE;
 *  14. no tracked file, lane files included, carries credential material.
 *
 * Every check is read-only. This script never writes, stages or commits.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Phase write-sets.
 *
 * These are cumulative and exact. A path is legal only if it appears in the P0
 * list or in the P1A list, and every later phase appends a new list rather than
 * loosening either of these. Keeping them separate rather than merging them
 * into one blob is deliberate: an auditor can see exactly what each phase was
 * authorized to create.
 */
const P0_WRITE_SET = [
  ".editorconfig",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
  "eslint.config.mjs",
  "vitest.workspace.ts",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/workflows/ci.yml",
  ".githooks/pre-push",
  "scripts/check-architecture.mjs",
  "docs/ROADMAP.md",
  "docs/architecture/0001-control-plane-authority.md",
  "packages/contracts/package.json",
  "packages/contracts/tsconfig.json",
  "packages/contracts/src/index.ts",
  "packages/contracts/src/schemas/index.ts",
  "packages/contracts/test/schemas/index.test.ts",
];

/** The exact P1A additions. No twenty-fourth ledger path is authorized. */
const P1A_WRITE_SET = [
  "docs/architecture/0002-sqlite-event-ledger.md",
  "packages/ledger/package.json",
  "packages/ledger/tsconfig.json",
  "packages/ledger/README.md",
  "packages/ledger/src/index.ts",
  "packages/ledger/src/types/index.ts",
  "packages/ledger/src/errors/index.ts",
  "packages/ledger/src/canonical-json/index.ts",
  "packages/ledger/src/migrations/index.ts",
  "packages/ledger/src/projection/index.ts",
  "packages/ledger/src/ledger/index.ts",
  "packages/ledger/test/concurrent-writer-worker/index.ts",
  "packages/ledger/test/ledger/index.test.ts",
];

/**
 * The exact P1B shared additions.
 *
 * P1B builds the shared foundation only: the browser-safe observation contract,
 * the scaffolds and boundary of the three lane packages, and the test topology
 * that replaces the deprecated Vitest workspace file. No twenty-fourth path is
 * authorized here either.
 */
const P1B_SHARED_WRITE_SET = [
  "vitest.config.ts",
  "docs/architecture/0003-read-only-observation-plane.md",
  "packages/api-contracts/package.json",
  "packages/api-contracts/tsconfig.json",
  "packages/api-contracts/README.md",
  "packages/api-contracts/src/index.ts",
  "packages/api-contracts/src/version/index.ts",
  "packages/api-contracts/src/routes/index.ts",
  "packages/api-contracts/src/schemas/index.ts",
  "packages/api-contracts/test/schemas/index.test.ts",
  "packages/cli/package.json",
  "packages/cli/tsconfig.json",
  "packages/cli/src/index.ts",
  "packages/server/package.json",
  "packages/server/tsconfig.json",
  "packages/server/src/index.ts",
  "packages/ui/package.json",
  "packages/ui/tsconfig.json",
  "packages/ui/tsconfig.node.json",
  "packages/ui/vite.config.ts",
  "packages/ui/index.html",
  "packages/ui/src/index.tsx",
  "packages/ui/src/app/index.tsx",
];

/**
 * Paths an earlier phase created and a later phase deliberately removed.
 *
 * P0 authorized vitest.workspace.ts. P1B retires it: `defineWorkspace` is
 * deprecated in Vitest 3 and the topology moved to vitest.config.ts. The path
 * stays listed in P0_WRITE_SET because that list is the historical record of
 * what P0 was authorized to create, and it is named here so the fence both
 * stops requiring it and starts requiring its absence. A deletion that is only
 * performed once is not enforced.
 *
 * P4B and P4C authorized the flat provider modules; the provider-folders law
 * retires them: each provider is a directory `providers/<name>/` containing
 * `index.ts` and `index.test.ts`, and the flat files are renamed into it. The
 * flat paths stay out of every phase array — the arrays name the nested paths
 * they became — and are named here so a flat provider file can never come back
 * alongside its directory.
 */
const RETIRED_PATHS = [
  "vitest.workspace.ts",
  // P5C: the router's own test, the last file to leave a src/ tree. Its
  // relocation is what let accounts join TOPOLOGY_ACTIVE_TREES (ruling R1).
  "packages/accounts/src/routing/index.test.ts",
  // P5N cohort C11 (accounts, structural remnant): the refusal vocabulary and
  // the two colocated tests, now under src/<domain>/index.ts and the mirrored
  // test tree. Topology activation is withheld to P5C per DT ruling R1.
  "packages/accounts/src/errors.ts",
  "packages/accounts/src/quota/index.test.ts",
  "packages/accounts/src/registry/index.test.ts",
  // P5N cohort C10 (server): the HTTP surface — the route table, the
  // aggregates and mappers, the ledger source and database identity, the
  // builder and its start path, and both integration tests, now under
  // src/<domain>/index.ts and the mirrored test tree. The tenth and last
  // structural cohort.
  "packages/server/src/aggregates.ts",
  "packages/server/src/build-server.test.ts",
  "packages/server/src/build-server.ts",
  "packages/server/src/constants.ts",
  "packages/server/src/database-identity.ts",
  "packages/server/src/errors.ts",
  "packages/server/src/ledger-source.ts",
  "packages/server/src/mappers.ts",
  "packages/server/src/parity.test.ts",
  "packages/server/src/query-schemas.ts",
  "packages/server/src/routes.ts",
  "packages/server/src/start.ts",
  // P5N cohort C9 (ui): the browser package — the app entry and shell, every
  // component, view, hook and routing helper, the API client and the format
  // helpers (collapsed per adjudication C), and every colocated test, now
  // under src/<domain>/index.tsx and the mirrored test tree.
  "packages/ui/src/App.tsx",
  "packages/ui/src/api/client.test.ts",
  "packages/ui/src/api/client.ts",
  "packages/ui/src/api/queryString.ts",
  "packages/ui/src/components/AppShell.test.tsx",
  "packages/ui/src/components/AppShell.tsx",
  "packages/ui/src/components/AsyncSection.test.tsx",
  "packages/ui/src/components/AsyncSection.tsx",
  "packages/ui/src/components/BarBreakdown.test.tsx",
  "packages/ui/src/components/BarBreakdown.tsx",
  "packages/ui/src/components/DataTable.test.tsx",
  "packages/ui/src/components/DataTable.tsx",
  "packages/ui/src/components/FilterBar.test.tsx",
  "packages/ui/src/components/FilterBar.tsx",
  "packages/ui/src/components/IdValue.test.tsx",
  "packages/ui/src/components/IdValue.tsx",
  "packages/ui/src/components/Pagination.test.tsx",
  "packages/ui/src/components/Pagination.tsx",
  "packages/ui/src/components/SkipLink.tsx",
  "packages/ui/src/components/StatusBadge.test.tsx",
  "packages/ui/src/components/StatusBadge.tsx",
  "packages/ui/src/components/TimelineList.test.tsx",
  "packages/ui/src/components/TimelineList.tsx",
  "packages/ui/src/format/chain.test.ts",
  "packages/ui/src/format/chain.ts",
  "packages/ui/src/format/format.test.ts",
  "packages/ui/src/format/format.ts",
  "packages/ui/src/format/statusTone.test.ts",
  "packages/ui/src/format/statusTone.ts",
  "packages/ui/src/hooks/useAsyncResource.ts",
  "packages/ui/src/main.tsx",
  "packages/ui/src/routing/hashRoute.test.ts",
  "packages/ui/src/routing/hashRoute.ts",
  "packages/ui/src/routing/useHashRoute.ts",
  "packages/ui/src/views/EventsView.tsx",
  "packages/ui/src/views/IntegrityView.tsx",
  "packages/ui/src/views/NotFoundView.test.tsx",
  "packages/ui/src/views/NotFoundView.tsx",
  "packages/ui/src/views/OverviewView.tsx",
  "packages/ui/src/views/StatusView.tsx",
  "packages/ui/src/views/TaskDetailView.tsx",
  "packages/ui/src/views/TasksListView.tsx",
  "packages/ui/src/views/WorkerDetailView.tsx",
  "packages/ui/src/views/WorkersListView.tsx",
  "packages/ui/src/views/views.test.tsx",
  // P5N cohort C8 (runtime): the durability plane — constants and contracts,
  // the core execution model, both drivers with their two child executables
  // (kept in src/, adjudication A), the Restate server pin and submit path,
  // the toy repository, and every colocated test, now under
  // src/<domain>/index.ts and the mirrored test tree.
  "packages/runtime/src/constants.ts",
  "packages/runtime/src/contracts.ts",
  "packages/runtime/src/core/coordinates.test.ts",
  "packages/runtime/src/core/coordinates.ts",
  "packages/runtime/src/core/events.test.ts",
  "packages/runtime/src/core/events.ts",
  "packages/runtime/src/core/lifecycle.test.ts",
  "packages/runtime/src/core/lifecycle.ts",
  "packages/runtime/src/core/step-executor.test.ts",
  "packages/runtime/src/core/step-executor.ts",
  "packages/runtime/src/drivers/restate-child.ts",
  "packages/runtime/src/drivers/restate-drills.test.ts",
  "packages/runtime/src/drivers/restate-driver.test.ts",
  "packages/runtime/src/drivers/restate-driver.ts",
  "packages/runtime/src/drivers/restate-endpoint.ts",
  "packages/runtime/src/drivers/sqlite-supervisor-child.ts",
  "packages/runtime/src/drivers/sqlite-supervisor.test.ts",
  "packages/runtime/src/drivers/sqlite-supervisor.ts",
  "packages/runtime/src/errors.ts",
  "packages/runtime/src/restate/server-handle.ts",
  "packages/runtime/src/restate/submit.ts",
  "packages/runtime/src/toy/repository.test.ts",
  "packages/runtime/src/toy/repository.ts",
  // P5N cohort C7 (daemon): the packaged entry and its config contract, the
  // child-process fixture (kept in src/, ruling C7-R1 — not a src->test
  // split), the process boundary, the launchd rendering and validation
  // surface, and every colocated and integration test, now under
  // src/<domain>/index.ts and the mirrored test tree.
  "packages/daemon/src/bin/acp-daemon.test.ts",
  "packages/daemon/src/bin/acp-daemon.ts",
  "packages/daemon/src/bin/config-file.ts",
  "packages/daemon/src/constants.ts",
  "packages/daemon/src/daemon-child.ts",
  "packages/daemon/src/daemon-drills.test.ts",
  "packages/daemon/src/errors.ts",
  "packages/daemon/src/identity-probe.test.ts",
  "packages/daemon/src/identity-probe.ts",
  "packages/daemon/src/import-purity.test.ts",
  "packages/daemon/src/launchd/launchd-drills.test.ts",
  "packages/daemon/src/launchd/launchd-lifecycle.test.ts",
  "packages/daemon/src/launchd/render.test.ts",
  "packages/daemon/src/launchd/render.ts",
  "packages/daemon/src/launchd/validate.test.ts",
  "packages/daemon/src/launchd/validate.ts",
  "packages/daemon/src/lifecycle.test.ts",
  "packages/daemon/src/lifecycle.ts",
  "packages/daemon/src/log.test.ts",
  "packages/daemon/src/log.ts",
  "packages/daemon/src/mode-restate.ts",
  "packages/daemon/src/mode-sqlite.ts",
  "packages/daemon/src/paths.test.ts",
  "packages/daemon/src/paths.ts",
  "packages/daemon/src/signals.ts",
  "packages/daemon/src/singleton.test.ts",
  "packages/daemon/src/singleton.ts",
  "packages/daemon/src/status.test.ts",
  "packages/daemon/src/status.ts",
  // P5N cohort C6 (adapters): the contract, the normalized-event taxonomy,
  // the process boundary, the three provider descriptors' tests, and the
  // fake-provider fixture (relocated from src/ to test/), now under
  // src/<domain>/index.ts and the mirrored test tree.
  "packages/adapters/src/config-root.test.ts",
  "packages/adapters/src/config-root.ts",
  "packages/adapters/src/contract.test.ts",
  "packages/adapters/src/contract.ts",
  "packages/adapters/src/errors.ts",
  "packages/adapters/src/events.test.ts",
  "packages/adapters/src/events.ts",
  "packages/adapters/src/process/handle.ts",
  "packages/adapters/src/process/spawn.test.ts",
  "packages/adapters/src/process/spawn.ts",
  "packages/adapters/src/providers/claude/index.test.ts",
  "packages/adapters/src/providers/codex/index.test.ts",
  "packages/adapters/src/providers/kimi/index.test.ts",
  "packages/adapters/src/redact.test.ts",
  "packages/adapters/src/redact.ts",
  "packages/adapters/src/session.test.ts",
  "packages/adapters/src/session.ts",
  "packages/adapters/src/testing/fake-provider.ts",
  // P5N cohort C5 (cli): the CLI entry, the renderer and the ledger-to-DTO
  // layer, plus their colocated test, now under src/<domain>/index.ts and the
  // mirrored test tree.
  "packages/cli/src/cli.test.ts",
  "packages/cli/src/cli.ts",
  "packages/cli/src/format.ts",
  "packages/cli/src/observation.ts",
  // P5N cohort C4 (observation): four flat domains, two collectors and five
  // colocated tests, now under src/<domain>/index.ts and the mirrored test tree.
  "packages/observation/src/baseline.test.ts",
  "packages/observation/src/baseline.ts",
  "packages/observation/src/collect/artifact.test.ts",
  "packages/observation/src/collect/artifact.ts",
  "packages/observation/src/collect/scenario.test.ts",
  "packages/observation/src/collect/scenario.ts",
  "packages/observation/src/errors.ts",
  "packages/observation/src/roots.test.ts",
  "packages/observation/src/roots.ts",
  "packages/observation/src/shadow-ledger.test.ts",
  "packages/observation/src/shadow-ledger.ts",
  // P5N cohort C3 (api-contracts): four flat modules and two colocated tests,
  // now under src/<domain>/index.ts and the mirrored test tree. The two pure
  // renames retire their old flat path too, even though no byte inside them
  // changed.
  "packages/api-contracts/src/parity.test.ts",
  "packages/api-contracts/src/parity.ts",
  "packages/api-contracts/src/routes.ts",
  "packages/api-contracts/src/schemas.test.ts",
  "packages/api-contracts/src/schemas.ts",
  "packages/api-contracts/src/version.ts",
  // P5N cohort C2 (ledger): six flat modules, a colocated test and a child
  // process fixture, now under src/<domain>/index.ts and the mirrored test
  // tree. Named here so none can return beside its replacement.
  "packages/ledger/src/canonical-json.ts",
  "packages/ledger/src/concurrent-writer-worker.ts",
  "packages/ledger/src/errors.ts",
  "packages/ledger/src/ledger.test.ts",
  "packages/ledger/src/ledger.ts",
  "packages/ledger/src/migrations.ts",
  "packages/ledger/src/projection.ts",
  "packages/ledger/src/types.ts",
  // P5N cohort C1 (contracts): the flat schema module and its colocated test,
  // now at src/schemas/index.ts and test/schemas/index.test.ts. Named here so
  // neither can return beside its replacement.
  "packages/contracts/src/schemas.ts",
  "packages/contracts/src/schemas.test.ts",
  "packages/adapters/src/providers/claude.ts",
  "packages/adapters/src/providers/claude.test.ts",
  "packages/adapters/src/providers/kimi.ts",
  "packages/adapters/src/providers/kimi.test.ts",
];

/**
 * The P1B lane envelope.
 *
 * P1B is the last single-writer phase before the CLI, server and UI lanes run
 * as isolated writers. Each lane needs room to create files this phase cannot
 * enumerate in advance, so the fence tolerates paths under exactly these three
 * prefixes, and nowhere else.
 *
 * This is deliberately three named prefixes rather than a general packages/
 * permission: a wildcard over packages/ would silently authorize edits to the
 * contracts, the ledger and the observation contract, which are integrator
 * owned and single-writer by law.
 *
 * The envelope is also temporary. It is open only while docs/ROADMAP.md still
 * says P1_INCOMPLETE, so it closes by itself when P1 completes rather than
 * waiting for someone to remember to close it. Files inside the envelope are
 * still subject to every content check below: the envelope widens where a lane
 * may write, never what it may write.
 */
const P1B_LANE_ENVELOPES = ["packages/cli/", "packages/server/", "packages/ui/"];

/**
 * The exact P1 lane additions, enumerated at P1 closure.
 *
 * While P1 was in flight these paths were tolerated by the lane envelope above,
 * because no one could enumerate in advance what three parallel writers would
 * need to create. P1 is complete, so the envelope has closed itself: the
 * roadmap no longer says P1_INCOMPLETE, and every one of these files is now
 * named individually. A sixty-fifth lane path is no longer authorized by
 * anything.
 */
const P1_WRITE_SET = [
  "packages/cli/README.md",
  "packages/cli/test/cli/index.test.ts",
  "packages/cli/src/cli/index.ts",
  "packages/cli/src/format/index.ts",
  "packages/cli/src/observation/index.ts",
  "packages/server/src/aggregates/index.ts",
  "packages/server/test/build-server/index.test.ts",
  "packages/server/src/build-server/index.ts",
  "packages/server/src/constants/index.ts",
  "packages/server/src/database-identity/index.ts",
  "packages/server/src/errors/index.ts",
  "packages/server/src/ledger-source/index.ts",
  "packages/server/src/mappers/index.ts",
  "packages/server/src/query-schemas/index.ts",
  "packages/server/src/routes/index.ts",
  "packages/server/src/start/index.ts",
  "packages/ui/test/api/client/index.test.ts",
  "packages/ui/src/api/client/index.ts",
  "packages/ui/src/api/query-string/index.ts",
  "packages/ui/test/components/app-shell/index.test.tsx",
  "packages/ui/src/components/app-shell/index.tsx",
  "packages/ui/test/components/async-section/index.test.tsx",
  "packages/ui/src/components/async-section/index.tsx",
  "packages/ui/test/components/bar-breakdown/index.test.tsx",
  "packages/ui/src/components/bar-breakdown/index.tsx",
  "packages/ui/test/components/data-table/index.test.tsx",
  "packages/ui/src/components/data-table/index.tsx",
  "packages/ui/test/components/filter-bar/index.test.tsx",
  "packages/ui/src/components/filter-bar/index.tsx",
  "packages/ui/test/components/id-value/index.test.tsx",
  "packages/ui/src/components/id-value/index.tsx",
  "packages/ui/test/components/pagination/index.test.tsx",
  "packages/ui/src/components/pagination/index.tsx",
  "packages/ui/src/components/skip-link/index.tsx",
  "packages/ui/test/components/status-badge/index.test.tsx",
  "packages/ui/src/components/status-badge/index.tsx",
  "packages/ui/test/components/timeline-list/index.test.tsx",
  "packages/ui/src/components/timeline-list/index.tsx",
  "packages/ui/test/format/chain/index.test.ts",
  "packages/ui/src/format/chain/index.ts",
  "packages/ui/test/format/index.test.ts",
  "packages/ui/src/format/index.ts",
  "packages/ui/test/format/status-tone/index.test.ts",
  "packages/ui/src/format/status-tone/index.ts",
  "packages/ui/src/hooks/use-async-resource/index.ts",
  "packages/ui/test/routing/hash-route/index.test.ts",
  "packages/ui/src/routing/hash-route/index.ts",
  "packages/ui/src/routing/use-hash-route/index.ts",
  "packages/ui/src/styles/base.css",
  "packages/ui/src/styles/components.css",
  "packages/ui/src/styles/index.css",
  "packages/ui/src/styles/layout.css",
  "packages/ui/src/styles/tokens.css",
  "packages/ui/src/views/events-view/index.tsx",
  "packages/ui/src/views/integrity-view/index.tsx",
  "packages/ui/test/views/not-found-view/index.test.tsx",
  "packages/ui/src/views/not-found-view/index.tsx",
  "packages/ui/src/views/overview-view/index.tsx",
  "packages/ui/src/views/status-view/index.tsx",
  "packages/ui/src/views/task-detail-view/index.tsx",
  "packages/ui/src/views/tasks-list-view/index.tsx",
  "packages/ui/src/views/worker-detail-view/index.tsx",
  "packages/ui/src/views/workers-list-view/index.tsx",
  "packages/ui/test/views/index.test.tsx",
];

/**
 * The exact P2A additions.
 *
 * P2A is a contract freeze: an ADR, five public data contracts, and a package
 * that exports types and constants and executes nothing. There is no driver, no
 * daemon and no drill here, and no sixth path is authorized.
 */
const P2A_WRITE_SET = [
  "docs/architecture/0004-durability-and-supervisor.md",
  "packages/runtime/package.json",
  "packages/runtime/tsconfig.json",
  "packages/runtime/README.md",
  "packages/runtime/src/index.ts",
  "packages/runtime/src/contracts/index.ts",
  "packages/runtime/src/constants/index.ts",
];

/**
 * The exact P2B additions: one shared core, one driver, and their evidence.
 *
 * P2B implements the lifecycle engine and the SQLite supervisor. The Restate
 * driver, the daemon, the launchd template and any observation route are not
 * here, and no eighth path is authorized.
 */
const P2B_WRITE_SET = [
  "packages/runtime/src/errors/index.ts",
  "packages/runtime/src/core/coordinates/index.ts",
  "packages/runtime/test/core/coordinates/index.test.ts",
  "packages/runtime/src/core/events/index.ts",
  "packages/runtime/test/core/events/index.test.ts",
  "packages/runtime/src/core/lifecycle/index.ts",
  "packages/runtime/test/core/lifecycle/index.test.ts",
  "packages/runtime/src/toy/repository/index.ts",
  "packages/runtime/test/toy/repository/index.test.ts",
  "packages/runtime/src/drivers/sqlite-supervisor/index.ts",
  "packages/runtime/src/drivers/sqlite-supervisor-child/index.ts",
  "packages/runtime/test/drivers/sqlite-supervisor/index.test.ts",
];

/**
 * The exact P2C additions: the Restate driver and its external server pin.
 *
 * P2C is single-writer, so there is no lane envelope. No thirteenth path is
 * authorized.
 */
const P2C_WRITE_SET = [
  "docs/architecture/0005-restate-driver-and-adoption.md",
  "packages/runtime/src/core/step-executor/index.ts",
  "packages/runtime/test/core/step-executor/index.test.ts",
  "packages/runtime/src/drivers/restate-driver/index.ts",
  "packages/runtime/src/drivers/restate-endpoint/index.ts",
  "packages/runtime/test/drivers/restate-driver/index.test.ts",
  "packages/runtime/test/drivers/drills/index.test.ts",
  "packages/runtime/src/drivers/restate-child/index.ts",
  "packages/runtime/src/restate/server-handle/index.ts",
  "packages/runtime/src/restate/submit/index.ts",
  "scripts/acquire-restate-server.mjs",
  "scripts/restate-server.pin.json",
];

const RETIRED = new Set(RETIRED_PATHS);

/**
 * The exact P2D additions: a dedicated daemon package and the debts it settles.
 *
 * Several entries also appear in earlier arrays. That is intentional and
 * authorised: the earlier arrays stay as the historical record of what each
 * phase was allowed to touch, and membership is validated against the union.
 * The displayed count below deduplicates, so a path in two phases is one path.
 */
const P2D_WRITE_SET = [
  "packages/daemon/package.json",
  "packages/daemon/tsconfig.json",
  "packages/daemon/README.md",
  "packages/daemon/src/index.ts",
  "packages/daemon/src/constants/index.ts",
  "packages/daemon/src/errors/index.ts",
  "packages/daemon/src/paths/index.ts",
  "packages/daemon/test/paths/index.test.ts",
  "packages/daemon/src/singleton/index.ts",
  "packages/daemon/test/singleton/index.test.ts",
  "packages/daemon/src/identity-probe/index.ts",
  "packages/daemon/test/identity-probe/index.test.ts",
  "packages/daemon/src/status/index.ts",
  "packages/daemon/test/status/index.test.ts",
  "packages/daemon/src/log/index.ts",
  "packages/daemon/test/log/index.test.ts",
  "packages/daemon/src/lifecycle/index.ts",
  "packages/daemon/test/lifecycle/index.test.ts",
  "packages/daemon/src/mode-sqlite/index.ts",
  "packages/daemon/src/mode-restate/index.ts",
  "packages/daemon/src/signals/index.ts",
  "packages/daemon/src/daemon-child/index.ts",
  "packages/daemon/test/drills/index.test.ts",
  "packages/daemon/test/index.test.ts",
  "docs/architecture/0006-daemon-process-lifecycle.md",
  "packages/runtime/src/restate/server-handle/index.ts",
  "packages/runtime/src/index.ts",
  "packages/runtime/README.md",
  "packages/runtime/package.json",
  "docs/ROADMAP.md",
  "tsconfig.base.json",
  "vitest.config.ts",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
];

/**
 * The exact P2E additions: an inert launchd template and P2 closure.
 *
 * `vitest.config.ts` is deliberately absent. The daemon project already globs
 * `src/**` for tests, so the launchd suites are picked up without a topology
 * change, and they bind no port, so the P2D serialization law is untouched.
 */
const P2E_WRITE_SET = [
  "packages/daemon/launchd/com.rottay.agent-control-plane.plist.template",
  "packages/daemon/launchd/README.md",
  "packages/daemon/src/launchd/render/index.ts",
  "packages/daemon/test/launchd/render/index.test.ts",
  "packages/daemon/src/launchd/validate/index.ts",
  "packages/daemon/test/launchd/validate/index.test.ts",
  "packages/daemon/test/launchd/drills/index.test.ts",
  "docs/architecture/0007-launchd-template-and-p2-closure.md",
  "packages/daemon/src/index.ts",
  "packages/daemon/README.md",
  "README.md",
  "docs/ROADMAP.md",
  "scripts/check-architecture.mjs",
];

/**
 * P2F Stage A: the packaged entry, its config contract, and one real launchd
 * lifecycle. Capability only — no status line moves here. Stage B records
 * closure separately, after the drill has been reproduced independently, so the
 * claim and its evidence never land at the same instant.
 */
const P2F_STAGE_A_WRITE_SET = [
  "packages/daemon/src/bin/acp-daemon/index.ts",
  "packages/daemon/src/bin/config-file/index.ts",
  "packages/daemon/test/bin/acp-daemon/index.test.ts",
  "packages/daemon/test/launchd/lifecycle/index.test.ts",
  "docs/architecture/0008-packaged-entry-and-launchd-lifecycle.md",
  "packages/daemon/package.json",
  "packages/daemon/src/daemon-child/index.ts",
  "packages/daemon/README.md",
  "packages/daemon/launchd/README.md",
  "docs/architecture/0006-daemon-process-lifecycle.md",
  "docs/architecture/0007-launchd-template-and-p2-closure.md",
  "scripts/check-architecture.mjs",
];

/**
 * P3A: the shadow-mode boundary. Roots, refusals, and the laws that govern the
 * rest of P3 — collectors (P3B), baseline (P3C), parity (P3D), closure (P3E).
 *
 * P3 is 31 distinct paths across 37 packet entries. Four paths are touched
 * more than once: `packages/observation/src/index.ts` (A, C),
 * `packages/observation/README.md` (A, E), `vitest.config.ts` (A, B) and
 * `scripts/check-architecture.mjs` (A, C, D, E — four touches). Check:
 * 37 − (1 + 1 + 1 + 3) = 31. `packages/server/src/routes/index.ts` and
 * `packages/server/tsconfig.json` are each new distinct paths *within P3*;
 * their P1 array membership is historical and outside the scope this count
 * describes, which is the treatment the ordering ruling set for `routes.ts`.
 * The earlier arrays stay as the historical record and the displayed count
 * deduplicates, as P2D established.
 */
const P3A_WRITE_SET = [
  "packages/observation/package.json",
  "packages/observation/tsconfig.json",
  "packages/observation/README.md",
  "packages/observation/src/index.ts",
  "packages/observation/src/roots/index.ts",
  "packages/observation/test/roots/index.test.ts",
  "packages/observation/src/errors/index.ts",
  "docs/architecture/0009-shadow-observation-boundary.md",
  "tsconfig.base.json",
  "vitest.config.ts",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
];

/**
 * P3B: the passive collectors. Sonnet's only authorized surface: five new
 * files under one new subdirectory with frozen imports, plus `vitest.config.ts`
 * — the collectors' test topology has to be declared somewhere, and the P3B
 * topology ruling put it here rather than letting an integrator add it later.
 */
const P3B_WRITE_SET = [
  "packages/observation/src/collect/artifact/index.ts",
  "packages/observation/test/collect/artifact/index.test.ts",
  "packages/observation/src/collect/scenario/index.ts",
  "packages/observation/test/collect/scenario/index.test.ts",
  "packages/observation/src/collect/index.ts",
  "vitest.config.ts",
];

/** P3C: the baseline and its disposable shadow ledger. */
const P3C_WRITE_SET = [
  "packages/observation/src/baseline/index.ts",
  "packages/observation/test/baseline/index.test.ts",
  "packages/observation/src/shadow-ledger/index.ts",
  "packages/observation/test/shadow-ledger/index.test.ts",
  "packages/observation/src/index.ts",
  // The export re-pin, the sole-writer law and the count restatement all live
  // in the fence, so P3C touches it like P3A and P3D did.
  "scripts/check-architecture.mjs",
];

/** P3D: the ledger-to-client parity contract and its three-way proof. */
const P3D_WRITE_SET = [
  "packages/api-contracts/src/parity/index.ts",
  "packages/api-contracts/test/parity/index.test.ts",
  "packages/api-contracts/src/index.ts",
  "packages/cli/src/observation/index.ts",
  "packages/ui/src/api/client/index.ts",
  "packages/server/test/parity/index.test.ts",
  "scripts/check-architecture.mjs",
  // Sorting only, at the two aggregate emit sites. The server was emitting
  // `Map` insertion order while the CLI sorted; ordering is part of the parity
  // law, so the server converges onto the CLI's existing deterministic order.
  "packages/server/src/routes/index.ts",
  // The TypeScript counterpart of the P3A deep aliases. Those live in
  // `vitest.config.ts`, which `tsc` and type-aware eslint never read, so the
  // parity test resolved at run time and nowhere else. Declaration-based, so
  // no foreign source enters this project's `rootDir`.
  "packages/server/tsconfig.json",
];

/** P3E: closure. The status line moves here and nowhere else. */
const P3E_WRITE_SET = [
  "docs/ROADMAP.md",
  "README.md",
  "packages/observation/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P4: read-only provider adapters.
 *
 * P4 is **40 packet entries across 32 distinct paths**. The convention is the
 * standing one, applied without exception: entries are the sum of the packet
 * array lengths, distinct is `new Set` over their union, within phase scope.
 * 24 + 4 + 4 + 4 + 4 = 40 entries; the repeats are
 * `scripts/check-architecture.mjs` (A, B, C, D, E), `src/index.ts`
 * (A, B, C, D) and `packages/adapters/README.md` (A, E), contributing
 * 4 + 3 + 1 = 8 duplicate entries, so 40 − 8 = 32.
 *
 * One number, stated once. An earlier revision of this comment opened with 31
 * and then computed 32 in its own next sentence, netting the fence script out
 * of `scripts/check-architecture.mjs` as "historical". That subtraction is not
 * the convention: the convention counts distinct paths within phase scope, and
 * a path P4 edits is in P4's scope whether or not an earlier phase edited it
 * too. 32 is what ADR 0010 records, and the two now agree.
 *
 * This supersedes an earlier 33/25, computed over arrays that omitted the six
 * co-located test paths and `session.ts`. A test file is its own path.
 */
const P4A_WRITE_SET = [
  "packages/adapters/package.json",
  "packages/adapters/tsconfig.json",
  "packages/adapters/README.md",
  "packages/adapters/src/index.ts",
  "packages/adapters/src/errors/index.ts",
  "packages/adapters/src/contract/index.ts",
  "packages/adapters/src/events/index.ts",
  "packages/adapters/src/redact/index.ts",
  "packages/adapters/src/config-root/index.ts",
  "packages/adapters/src/session/index.ts",
  "packages/adapters/src/process/spawn/index.ts",
  "packages/adapters/src/process/handle/index.ts",
  "packages/adapters/test/testing/index.ts",
  "packages/adapters/test/contract/index.test.ts",
  "packages/adapters/test/events/index.test.ts",
  "packages/adapters/test/redact/index.test.ts",
  "packages/adapters/test/config-root/index.test.ts",
  "packages/adapters/test/session/index.test.ts",
  "packages/adapters/test/process/spawn/index.test.ts",
  "tsconfig.base.json",
  "vitest.config.ts",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
  "docs/architecture/0010-provider-adapter-boundary.md",
];

/** P4B: the Claude headless descriptor. */
const P4B_WRITE_SET = [
  "packages/adapters/src/providers/claude/index.ts",
  "packages/adapters/test/providers/claude/index.test.ts",
  "packages/adapters/src/index.ts",
  "scripts/check-architecture.mjs",
];

/** P4C: the Kimi ACP descriptor. */
const P4C_WRITE_SET = [
  "packages/adapters/src/providers/kimi/index.ts",
  "packages/adapters/test/providers/kimi/index.test.ts",
  "packages/adapters/src/index.ts",
  "scripts/check-architecture.mjs",
];

/** P4D: the Codex App Server descriptor. */
const P4D_WRITE_SET = [
  "packages/adapters/src/providers/codex/index.ts",
  "packages/adapters/test/providers/codex/index.test.ts",
  "packages/adapters/src/index.ts",
  "scripts/check-architecture.mjs",
];

/** P4E: closure. The status line moves here and nowhere else. */
const P4E_WRITE_SET = [
  "docs/ROADMAP.md",
  "README.md",
  "packages/adapters/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P5: accounts, quotas and shadow routing.
 *
 * P5 is **28 packet entries across 20 distinct paths**. The standing convention,
 * applied without exception: entries are the sum of the packet array lengths,
 * distinct is `new Set` over their union, within phase scope.
 * 12 + 4 + 4 + 4 + 4 = 28 entries; the repeats are
 * `scripts/check-architecture.mjs` (A, B, C, D, E), `src/index.ts` (A, B, C, D)
 * and `packages/accounts/README.md` (A, E), contributing 4 + 3 + 1 = 8
 * duplicate entries, so 28 − 8 = 20.
 *
 * A path an earlier phase also edited is still in P5's scope: the convention
 * counts distinct paths within the phase, and nothing is netted out as
 * "historical". That correction was made for P4 at P4E closure and the same
 * arithmetic is used here from the start.
 */
const P5A_WRITE_SET = [
  "packages/accounts/package.json",
  "packages/accounts/tsconfig.json",
  "packages/accounts/README.md",
  "packages/accounts/src/index.ts",
  "packages/accounts/src/errors/index.ts",
  "packages/accounts/src/registry/index.ts",
  "packages/accounts/test/registry/index.test.ts",
  "tsconfig.base.json",
  "vitest.config.ts",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
  "docs/architecture/0011-accounts-registry-shadow-routing.md",
];

/**
 * P5B, P5C, P5D and P5E are declared here and are **future**.
 *
 * Their paths are named now so the write-set gate accepts them when they
 * arrive, and so a reader can see the whole phase from one place. None of the
 * files exists yet, and the gate does not require a declared path to be
 * present — it requires a present path to be declared. Declaring them early
 * costs nothing and prevents the alternative, which is a fence edit smuggled
 * into a packet that was supposed to be about a router.
 */
const P5B_WRITE_SET = [
  "packages/accounts/src/quota/index.ts",
  "packages/accounts/test/quota/index.test.ts",
  "packages/accounts/src/index.ts",
  "scripts/check-architecture.mjs",
];

const P5C_WRITE_SET = [
  "packages/accounts/src/routing/index.ts",
  "packages/accounts/test/routing/index.test.ts",
  "packages/accounts/src/index.ts",
  "scripts/check-architecture.mjs",
];

const P5D_WRITE_SET = [
  "packages/accounts/src/switching/index.ts",
  "packages/accounts/test/switching/index.test.ts",
  "packages/accounts/src/index.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N-A: the first structural commit of the normalization checkpoint.
 *
 * It relocates nothing that is committed. It retires the colocated-test law,
 * scaffolds the mirrored-topology gate with an empty activation list, records
 * the law in ADR 0012 and re-pins the roadmap the owner's edit produced. The
 * cohorts that follow carry the relocations, each with its own enumerated
 * write-set from the adjudicated inventory.
 */
const P5N_A_WRITE_SET = [
  "docs/ROADMAP.md",
  "docs/architecture/0012-structural-normalization.md",
  "scripts/check-architecture.mjs",
];

/** P5E: closure. The status line moves here and nowhere else. */
const P5E_WRITE_SET = [
  "docs/ROADMAP.md",
  "README.md",
  "packages/accounts/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P6: writer enforcement.
 *
 * P6 is **25 packet entries across 11 distinct paths**. The standing convention
 * applies: entries are the sum of the packet array lengths, distinct is
 * `new Set` over their union, within phase scope. 5 + 4 + 6 + 4 + 6 = 25
 * entries; the repeats are `scripts/check-architecture.mjs` (A, B, C, E, F)
 * contributing 4, `packages/runtime/src/enforcement/index.ts` (A, C, F) and
 * `packages/runtime/test/enforcement/index.test.ts` (A, C, F) and
 * `packages/runtime/README.md` (A, E, F) contributing 2 each,
 * `packages/runtime/src/index.ts` (A, B, C) contributing 2, and
 * `packages/runtime/src/commit-authorization/index.ts` (C, F) and
 * `packages/runtime/test/commit-authorization/index.test.ts` (C, F)
 * contributing 1 each: 14 duplicate entries, so 25 - 14 = 11. P6F adds no path
 * that was not already in the phase.
 *
 * P6A is the enforcement module and its mirrored test, the runtime barrel, the
 * runtime README falsified by that landing, and this file. P6B is the conflict
 * graph and its mirrored test, the barrel and this file; its README sentence
 * rides the union through P6A_WRITE_SET, the P5D Ruling-2 form. P6C is the
 * commit-authorization module and its mirrored test, the enforcement pair for
 * the deferred P6A-N1 payload unification, the barrel and this file; its
 * README paragraph rides the union the same way. P6E is the closure: the
 * roadmap status line, the root README's evidence paragraphs, the runtime
 * README's scope sentence and this file. P6F is the checkpoint correction: the
 * enforcement pair, the commit-authorization pair, the runtime README and this
 * file.
 *
 * The module ships no observer. Its git port is a runtime-internal type with a
 * closed read-only verb set, and `SPAWN_ALLOWED_FILES` gains nothing here: a
 * fourth spawner in the package that enforces the no-cleanup law would be the
 * thing being prevented. Production wiring is a separate authorized packet.
 */
const P6A_WRITE_SET = [
  "packages/runtime/src/enforcement/index.ts",
  "packages/runtime/test/enforcement/index.test.ts",
  "packages/runtime/src/index.ts",
  "packages/runtime/README.md",
  "scripts/check-architecture.mjs",
];

const P6B_WRITE_SET = [
  "packages/runtime/src/conflict-graph/index.ts",
  "packages/runtime/test/conflict-graph/index.test.ts",
  "packages/runtime/src/index.ts",
  "scripts/check-architecture.mjs",
];

const P6C_WRITE_SET = [
  "packages/runtime/src/commit-authorization/index.ts",
  "packages/runtime/test/commit-authorization/index.test.ts",
  "packages/runtime/src/enforcement/index.ts",
  "packages/runtime/test/enforcement/index.test.ts",
  "packages/runtime/src/index.ts",
  "scripts/check-architecture.mjs",
];

/** P6E: closure. The status line moves here and nowhere else. */
const P6E_WRITE_SET = [
  "docs/ROADMAP.md",
  "README.md",
  "packages/runtime/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P6F: the checkpoint corrections.
 *
 * The four defects the P6 phase checkpoint rejected on — unparsed prestate
 * entries and their duplicate-path ambiguity, the same laxity in the
 * conformance observation, an authorization that never bound the lease to its
 * writer or worktree, and a renewal that neither extended nor recorded
 * anything. The README rides its own entry here rather than the union, because
 * this packet edits it for its own reasons.
 */
const P6F_WRITE_SET = [
  "packages/runtime/src/enforcement/index.ts",
  "packages/runtime/test/enforcement/index.test.ts",
  "packages/runtime/src/commit-authorization/index.ts",
  "packages/runtime/test/commit-authorization/index.test.ts",
  "packages/runtime/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P7: the read-only packet path.
 *
 * P7P opens the phase and is P7A's precondition: it makes the lifecycle plan
 * commit-policy-aware, so a `NO_COMMIT` packet has a lawful close. P7A is the
 * isolated pilot that walks the landed plan over the real machinery. P7B is
 * the second isolated pilot: kill/restart of the read-only walk over a real
 * child process (runtime test tree), and the account switch played as values
 * over a real ledger (accounts test tree) -- two drills, one per package that
 * owns the machinery each exercises, per the P1B dependency law. P7C is the
 * mechanical writer packet: the eleven-step writer plan
 * (`LOCAL_COMMIT_WITH_RECEIPT`) over a toy repository this drill genuinely
 * writes to, with a real local commit and reconciliation against the
 * receipt -- the first end-to-end evidence for the commit path. P7E is the
 * closure: the roadmap status line, the root README's status sentence and
 * this file. P7 is therefore **33 packet entries across 28 distinct paths**:
 * 19 (P7P) + 3 (P7A) + 5 (P7B) + 3 (P7C) + 3 (P7E) = 33 entries. Two paths
 * repeat: `scripts/check-architecture.mjs` itself, named by all five packets
 * (P7P, P7A, P7B, P7C, P7E), contributing 4 duplicate entries, and
 * `docs/ROADMAP.md`, named by P7P -- which moved the roadmap when it opened
 * the phase -- and again by P7E, contributing 1. So 33 - 4 - 1 = 28 distinct
 * paths. P7A's other two paths --
 * `packages/runtime/test/pilots/index.test.ts` and
 * `packages/runtime/test/pilots/helpers/index.ts` -- are new to the phase.
 * P7B's other four paths -- `packages/runtime/test/pilots/recovery/index.test.ts`,
 * `packages/runtime/test/pilots/recovery/helpers/index.ts`,
 * `packages/accounts/test/pilots/index.test.ts` and
 * `packages/accounts/test/pilots/helpers/index.ts` -- are new to the phase.
 * P7C's other two paths -- `packages/runtime/test/pilots/writer/index.test.ts`
 * and `packages/runtime/test/pilots/writer/helpers/index.ts` -- are new to
 * the phase. Of P7E's other two, only `README.md` is new to the phase;
 * `docs/ROADMAP.md` is the second repeat named above.
 *
 * The plan is selected at the driver boundary, which is why the set reaches
 * into `@acp/daemon`: the two places that construct a driver must now say which
 * commit policy they are running under, and today's answer, made explicit, is
 * `LOCAL_COMMIT_WITH_RECEIPT`. `DurableInvocation` and `@acp/contracts` are
 * untouched.
 */
const P7P_WRITE_SET = [
  "packages/runtime/src/core/lifecycle/index.ts",
  "packages/runtime/src/core/step-executor/index.ts",
  "packages/runtime/src/drivers/sqlite-supervisor/index.ts",
  "packages/runtime/src/drivers/sqlite-supervisor-child/index.ts",
  "packages/runtime/src/drivers/restate-driver/index.ts",
  "packages/runtime/src/drivers/restate-child/index.ts",
  "packages/runtime/src/index.ts",
  "packages/runtime/test/core/lifecycle/index.test.ts",
  "packages/runtime/test/core/step-executor/index.test.ts",
  "packages/runtime/test/drivers/sqlite-supervisor/index.test.ts",
  "packages/runtime/test/drivers/restate-driver/index.test.ts",
  "packages/runtime/test/drivers/drills/index.test.ts",
  "packages/runtime/README.md",
  "docs/ROADMAP.md",
  "scripts/check-architecture.mjs",
  "packages/daemon/src/index.ts",
  "packages/daemon/src/mode-sqlite/index.ts",
  "packages/daemon/src/mode-restate/index.ts",
  "packages/daemon/test/drills/index.test.ts",
];

/**
 * P7A: the isolated pilot.
 *
 * The read-only packet drill and its helpers -- the toy-repo builder, the
 * test-tree `GitReadPort` implementation, ledger/supervisor wiring -- live
 * under the mirror test domain, per the topology law. No production source
 * changes: the pilot walks the plan P7P already landed.
 */
const P7A_WRITE_SET = [
  "packages/runtime/test/pilots/index.test.ts",
  "packages/runtime/test/pilots/helpers/index.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P7B: the second isolated pilot -- kill/restart and the account switch.
 *
 * Two drills, two packages, per the P1B dependency law
 * (`packages/runtime` may not import `@acp/accounts` and `packages/accounts`
 * may not import `@acp/runtime`): leg 1 is a new subdomain,
 * `test/pilots/recovery/`, under the runtime package's landed `pilots`
 * domain -- the kill/restart drill for the `NO_COMMIT` walk over a real
 * child process, SIGKILLed and restarted. Leg 2 mirrors the `pilots` domain
 * shape into the accounts test tree for the first time -- the account-switch
 * decision core (`decideSwitch`), played by the drill as the executor over a
 * real `@acp/ledger` instance, closed and reopened. No production source
 * changes in either package: leg 1 walks the plan P7P already landed, leg 2
 * plays a plan `decideSwitch` already returns as a value.
 */
const P7B_WRITE_SET = [
  "packages/runtime/test/pilots/recovery/index.test.ts",
  "packages/runtime/test/pilots/recovery/helpers/index.ts",
  "packages/accounts/test/pilots/index.test.ts",
  "packages/accounts/test/pilots/helpers/index.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P7C: the mechanical writer packet.
 *
 * A new subdomain, `test/pilots/writer/`, sibling to P7A's `pilots` root and
 * P7B leg 1's `pilots/recovery/` -- the writer plan
 * (`LOCAL_COMMIT_WITH_RECEIPT`) walked over a toy repository this drill
 * genuinely writes to: a real local commit, and reconciliation against the
 * receipt `authorizeCommit` produced. No production source changes: the
 * drill walks the plan P7P already landed and reconciles against the
 * receipt `commit-authorization` (P6C) already produces.
 */
const P7C_WRITE_SET = [
  "packages/runtime/test/pilots/writer/index.test.ts",
  "packages/runtime/test/pilots/writer/helpers/index.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P7E: closure. The status line moves here and nowhere else.
 *
 * The phase's own documents only: the roadmap's Estado line and its `P7
 * completo` annotation, the root README's status sentence, and this file --
 * the roadmap re-pin, the status literal, this array and the README status
 * text the closure retires. No package is touched, and no test changes.
 */
const P7E_WRITE_SET = ["docs/ROADMAP.md", "README.md", "scripts/check-architecture.mjs"];

/**
 * P7I: initiative contracts and the versioned roadmap.
 *
 * P7I-0 opens the phase and is P7I-1's precondition: it moves
 * `CONTRACT_VERSION` to `2.0.0` and, in the same packet, replaces every
 * hardcoded `"1.0.0"` in a fixture with the imported constant, so the next
 * bump is genuinely mechanical. The split is causal rather than cosmetic --
 * the bump and the schema additions are different units of change, and each
 * packet leaves a green tree.
 *
 * The de-hardcoding is the packet's real content. A literal that *means*
 * `CONTRACT_VERSION` but does not *reference* it is invisible to typecheck:
 * these fixtures build `Record<string, unknown>` values, or spread an
 * `overrides` of that type, so the literal is erased before `.parse()` ever
 * sees it. That is why P7I-1's first attempt stopped -- `tsc` reported zero
 * errors while 125 tests would have failed -- and why, for a contract-shape
 * change, the **full test suite** is the completeness proof and typecheck is
 * not. Two packages reach the constant through `@acp/api-contracts`'s
 * `LEDGER_CONTRACT_VERSION` re-export rather than directly: `packages/cli` and
 * `packages/server` may not depend on `@acp/contracts` under the P1B
 * dependency law, and the re-export exists for exactly this.
 *
 * P7I-1 is the contracts themselves, on top of the landed bump: `Initiative`,
 * `RoadmapVersion`, the `InitiativeEvent` sibling stream and its three-name
 * vocabulary, the sibling idempotency builder, the task stream's two usage
 * types, and `TaskEnvelope.initiativeId` -- with the fixture adaptation the
 * required field forces, and the two sentences this phase falsifies: the
 * observation baseline's event-type count (21 becomes 23 here) and the
 * accounts README's version example (falsified by P7I-0, swept here on the
 * rule that the packet which falsifies a sentence fixes it).
 *
 * P7I-2 is the ledger side: the additive migration that adds the sibling
 * `initiative_events` stream with its own chain and triggers, the two
 * projection tables and the nullable task column; the append path, the folds
 * and both chains verified and rebuilt together; and the pure
 * roadmap-version decision, placed beside the fold it consumes the way
 * `AUTHORIZATION_REFUSALS` sits beside its own module.
 *
 * P7I-3 closes the phase's R4 obligation: the token rollups, a pure fold in
 * the read-model plane over the two usage types P7I-1 added and the
 * attribution P7I-2 landed.
 *
 * P7I-E closes the phase: the roadmap status line and its annotation, the root
 * README's status sentence, and this file.
 *
 * P7I is therefore **36 packet entries across 30 distinct paths**: 10 (P7I-0)
 * + 8 (P7I-1) + 10 (P7I-2) + 5 (P7I-3) + 3 (P7I-E) = 36 entries. Three paths
 * repeat: `scripts/check-architecture.mjs` itself, named by all five packets,
 * contributing 4; `packages/contracts/src/schemas/index.ts`, named by P7I-0
 * for the bump and by P7I-1 for the contracts, contributing 1; and
 * `packages/ledger/test/ledger/index.test.ts`, named by P7I-0 for the
 * de-hardcoding and by P7I-2 for the sibling stream's laws, contributing 1.
 * So 36 - 4 - 1 - 1 = 30 distinct paths. Both of P7I-E's other two paths --
 * `docs/ROADMAP.md` and `README.md` -- are new to this phase, unlike P7's
 * closure, where the roadmap had already been moved by P7P. This file's
 * appearances in earlier phases are counted in those phases, since the
 * standing convention scopes the arithmetic to the phase.
 *
 * P7I-2's tenth path, `packages/ledger/src/types/index.ts`, is where the
 * package declares every public value type. `TaskReadModel` is declared only
 * there, so Q6's nullable `initiativeId` has nowhere else to land; the sibling
 * stream's value shapes and the both-chains fields on `RebuildResult` and
 * `LedgerStatus` follow it by the same convention.
 */
const P7I0_WRITE_SET = [
  "packages/contracts/src/schemas/index.ts",
  "packages/ledger/test/ledger/index.test.ts",
  "packages/cli/test/cli/index.test.ts",
  "packages/server/test/build-server/index.test.ts",
  "packages/server/test/parity/index.test.ts",
  "packages/observation/test/shadow-ledger/index.test.ts",
  "packages/observation/test/collect/scenario/index.test.ts",
  "packages/observation/test/collect/artifact/index.test.ts",
  "packages/observation/test/baseline/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P7I-1: the initiative contracts.
 *
 * The contracts package and the fixtures the required `initiativeId` forces,
 * plus the two stale sentences this phase falsifies. Nothing outside
 * `packages/contracts` changes in substance: the runtime and observation
 * entries are a fixture factory, a pilot helper's fixed initiative id and one
 * comment line, and the accounts entry is one line of a JSON example.
 */
const P7I1_WRITE_SET = [
  "packages/contracts/src/schemas/index.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/test/schemas/index.test.ts",
  "packages/runtime/test/conflict-graph/index.test.ts",
  "packages/runtime/test/pilots/helpers/index.ts",
  "packages/observation/src/baseline/index.ts",
  "packages/accounts/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P7I-3: the token rollups.
 *
 * A pure fold in the read-model plane, closing R4. It reads the two usage
 * types the task stream gained in P7I-1 and the initiative attribution the
 * task projection gained in P7I-2, and it adds no dependency to do it: the
 * observation package's surface stays `@acp/contracts` + `@acp/ledger`, and
 * this module names neither a ledger nor an accounts type. Its entry in this
 * file also re-pins the package's closed export surface, which is checked by
 * equality in both directions.
 */
const P7I3_WRITE_SET = [
  "packages/observation/src/rollups/index.ts",
  "packages/observation/src/index.ts",
  "packages/observation/test/rollups/index.test.ts",
  "packages/observation/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P7I-E: closure. The status line moves here and nowhere else.
 *
 * The phase's own documents only: the roadmap's Estado line, its `P7I
 * completo` annotation and a one-line pointer to the owner's
 * transport-agnostic ruling in the P8 section; the root README's status
 * sentence; and this file — the roadmap re-pin, the status literal, this array
 * and the README status text the closure retires. No package is touched, and
 * no test changes.
 */
const P7IE_WRITE_SET = ["docs/ROADMAP.md", "README.md", "scripts/check-architecture.mjs"];

/**
 * P8: the complete product and its pre-cutover certification.
 *
 * P8-D opens the phase with design rather than code: it incorporates the
 * owner's transport-agnostic ruling into the roadmap as binding product law,
 * so the certification criteria are written down before anything is built
 * against them. Provider, model, account, transport, UI library, observability
 * exporter and durable-runtime integrations all stay replaceable behind owned
 * contracts, and the roadmap now says so where a reader of the phase will find
 * it.
 *
 * The Estado line does not move here. P8 opens as *next* and stays that way
 * until the phase's own closure: incorporating the criteria a phase will be
 * judged against is not the same as meeting them, and a status line that
 * moved on a design packet would say it was.
 *
 * P8-1 opens the implementation: the owned execution boundary as contracts,
 * before any transport binds to it.
 *
 * P8-W is the runtime wiring that makes the contracts and the P7I folds
 * load-bearing.
 *
 * P8-2 binds the first transport to the boundary P8-1 declared, and re-points
 * the adapters' own provider union at the contracts' vocabulary so there is
 * one canonical list rather than two that agree today.
 *
 * P8-3 binds the second transport, `API_KEY`, over an interface the repository
 * owns rather than an SDK's: law 6 keeps the SDK optional, so the real binding
 * is registered as P8-3b and the dependency graph does not move here.
 *
 * P8-4 binds the third transport, `LOCAL_OR_SELF_HOSTED`, in P8-3's adjudicated
 * shape: the same optional-at-construction discipline, the same shared trail
 * assertion, an injected client of the same OpenAI-compatible chat/completions
 * shape bound to a local or self-hosted server instead of a provider API.
 *
 * P8-5 lands law 4's versioned capability/policy registry: the document as data
 * outside application code, its schema and loader in the accounts package, and
 * `routeWithPolicy` as the one seam that stamps `capabilityPolicyVersion`.
 *
 * P8-6 is the runtime fallback gate: the positive certification that
 * disabling Restate leaves the documented `SQLITE_SUPERVISOR` path
 * operational, drilled over a real child process rather than only asserted,
 * plus the operator paragraph the drill backs.
 *
 * P8-7 lands law 9's observability leg: the neutral OTel/OpenInference-shaped
 * projection, the structural redaction gate inside it, and the optional
 * Langfuse translator as a pure value-producing function no dependency backs.
 *
 * P8-8A opens the UI phase's data plane: three read-only initiative routes,
 * the ledger's portfolio enumerator, and the server's first edge to the
 * observation package's rollup folds.
 *
 * P8-8B adopts the UI foundation: two runtime dependencies with use sites in
 * the packet, the design tokens' elevation dimension completed and consumed,
 * and the shell rebuilt on the adopted primitive.
 *
 * P8-8C lands the portfolio view and the initiative switcher: the one
 * adjudicated new primitive (`@radix-ui/react-dropdown-menu`), the
 * initiative-scoped route prefix over the landed grammar, and the tone
 * mapping and card styles the blueprint names. The write-set widened by two
 * paths after the packet's own STOP (`p8-8c-kimi-widening-adjudication.md`):
 * `packages/ui/test/views/index.test.tsx` and
 * `packages/ui/test/views/not-found-view/index.test.tsx`, each carrying the
 * one-line `initiativeId: null` fixture fix the `Route` field addition made
 * unavoidable.
 *
 * P8-T records the owner's blocking structural-topology tranche in the
 * roadmap. A docs packet: both of its paths are already named elsewhere in the
 * phase, so it adds two entries and **no new distinct path**.
 *
 * P8-8D-pre adds the plane's first write route, its content store and ADR 0013.
 *
 * P8 is therefore **340 packet entries across 139 distinct paths**: 2 (P8-D) +
 * 4 (P8-1) + 31 (P8-W) + 7 (P8-2) + 6 (P8-3) + 6 (P8-4) + 6 (P8-5) + 3 (P8-6) +
 * 6 (P8-7) + 19 (P8-8A) + 10 (P8-8B) + 17 (P8-8C) + 22 (P8-8D-pre) +
 * 13 (P8-8D-c2) + 18 (P8-8D) + 2 (P8-T-docs) + 5 (P8-T2) + 17 (P8-8E-pre) +
 * 17 (P8-8E) + 15 (P8-8E2) + 19 (P8-8F-srv) + 2 (P8-debrief-ruling) +
 * 19 (P8-8F-ui) + 2 (P8-8F-record) + 21 (P8-8G-a) + 27 (P8-8G-b) +
 * 12 (P8-8G-ui) + 2 (P8-8G-record) + 6 (P8-8G-causal) + 2 (P8-9-1) +
 * 2 (P8-T-roadmap) = 340 entries, with 201 duplicate entries.
 *
 * Folded from a computed duplicate-owner table and grouped by how many times
 * a path repeats, which is the form that stays checkable as the phase grows:
 *
 *   1 path  × 30 duplicates = 30   (`scripts/check-architecture.mjs`, every packet)
 *   3 paths ×  7 duplicates = 21   (`docs/ROADMAP.md`, the routes source and the
 *                                   build-server drill suite the causal packet
 *                                   seamed)
 *   6 paths ×  6 duplicates = 36   (the api-contracts surface, its CLI mirror
 *                                   suite and the lockfile the write packets
 *                                   keep returning to)
 *   5 paths ×  5 duplicates = 25   (the api-contracts route and parity surface
 *                                   with its parity suite, and the UI's api
 *                                   client and app root)
 *   2 paths ×  4 duplicates = 8    (the initiatives suite and the UI styles
 *                                   sheet)
 *   7 paths ×  3 duplicates = 21
 *  15 paths ×  2 duplicates = 30
 *  30 paths ×  1 duplicate  = 30
 *
 * 30 + 21 + 36 + 25 + 8 + 21 + 30 + 30 = 201.
 *
 * Every parenthetical above is derived from the computed owner table, not from
 * memory of which packet touched what; the rows without one have more members
 * than a phrase can name honestly, so they carry none.
 *
 * P8-5 and P8-6 share no path with any earlier P8 packet but the fence
 * itself; P8-7 likewise. Five packets add entries without adding paths:
 * P8-8D-pre's 22nd, the whole of P8-8D-c2, the whole of P8-T-roadmap, the
 * debrief-ruling record, and the P8-8F record. P8-T2 added three paths;
 * P8-8E-pre three; P8-8E six; P8-8E2 two; P8-8F-srv five; P8-8F-ui seven;
 * P8-8G-a two; P8-8G-b six; and P8-8G-ui adds **two** — the bearer field's
 * component and its mirrored suite are the only genuinely new paths this
 * packet touches. The other ten of its twelve entries revisit files five
 * earlier UI packets (P8-8B, P8-8C, P8-8D, P8-8E, P8-8F-ui) and P8-8G-b
 * itself already own — the api client, the app root, the styles sheet, the
 * accounts view and its suite, the edit dialog and its suite, and the
 * fence — which is why the distinct count moves only 137 → 139 while the
 * entries move 318 → 330.
 *
 * P8-8G-record adds **no** path: both of its entries are already owned, so
 * distinct holds at 139 while the entries move 330 → 332. It briefly recorded
 * four, when two server suites were granted into it to repair an expired
 * fixture; that ruling was superseded by the causal packet, which owns those
 * suites, and this array was trimmed back to the two paths the packet actually
 * writes.
 *
 * P8-8G-causal adds **no** path either: all six of its entries are already
 * owned — the two server sources by the packets that wrote them, the three
 * suites by packet 2 and this packet's own predecessors, and the fence by
 * every packet — so distinct holds at 139 a third time while the entries move
 * 332 → 338. That a six-path packet introduces nothing new is the expected
 * shape for a fix that reaches an existing seam rather than adding a surface.
 *
 * P8-9-1 opens P8-9 and adds **no** path either, so distinct holds at 139 for a
 * fourth packet running while the entries move 338 → 340. Its two group steps:
 * this file's own row moves 29 → 30 duplicates (31 appearances, one per
 * packet), and the runtime drill file gains its second in-phase appearance and
 * so enters the ×1 row, which moves 29 → 30 paths. The drill file's only other
 * in-phase owner is `P8W_WRITE_SET`; its earlier occurrences belong to P2C and
 * P7P and are counted in those phases by the standing convention.
 *
 * This file's appearances in earlier phases are
 * counted in those phases, since the standing convention scopes the
 * arithmetic to the phase.
 */
const P8D_WRITE_SET = ["docs/ROADMAP.md", "scripts/check-architecture.mjs"];

/**
 * P8-1: the owned execution port.
 *
 * The ruling's laws 1-3 as contracts: `TransportKind`, the CLI provider
 * vocabulary that lives here because this package imports nothing and
 * everything imports it, `ResolvedRoute` with the route final and CLI-bound,
 * the normalized `ExecutionEvent` superset, and `ModelExecutionPort` as an
 * owned boundary type with its laws in doc comments. Contracts and tests only
 * -- the adapters bind in P8-2, which also re-points their `ProviderName` at
 * the vocabulary declared here.
 */
const P81_WRITE_SET = [
  "packages/contracts/src/schemas/index.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/test/schemas/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-W: the runtime wiring.
 *
 * The three forward-carry items, now due: `initiativeId` threaded end to end
 * so the projection's nullable fold finally has a producer; usage and
 * reservation emission, which is what the P7I-3 rollups fold; and the switch
 * executor, which plays a `decideSwitch` plan and closes the P7B
 * `LEASE_REVOKED` divergence by naming the real lease beside the account.
 *
 * This is where `@acp/accounts` enters the runtime's dependency surface. The
 * direction is the one the law below already states -- runtime consumes
 * accounts, never the reverse -- and the accounts entry still forbids
 * `@acp/runtime` by name, so the cycle stays refused.
 */
const P8W_WRITE_SET = [
  "packages/runtime/src/core/events/index.ts",
  "packages/runtime/src/core/step-executor/index.ts",
  "packages/runtime/src/drivers/sqlite-supervisor/index.ts",
  "packages/runtime/src/drivers/sqlite-supervisor-child/index.ts",
  "packages/runtime/src/drivers/restate-driver/index.ts",
  "packages/runtime/src/drivers/restate-child/index.ts",
  "packages/runtime/src/usage/index.ts",
  "packages/runtime/src/switch-executor/index.ts",
  "packages/runtime/src/index.ts",
  "packages/runtime/package.json",
  // The build-graph edges the authorized dependency needs. Runtime is the
  // repository's first accounts consumer, and `tsc --build` resolves workspace
  // packages through project references rather than the manifest, so without
  // these two the switch executor does not compile at all.
  "packages/runtime/tsconfig.json",
  "packages/runtime/test/tsconfig.json",
  "packages/runtime/test/usage/index.test.ts",
  "packages/runtime/test/switch-executor/index.test.ts",
  "packages/runtime/test/core/events/index.test.ts",
  "packages/runtime/test/core/step-executor/index.test.ts",
  "packages/runtime/test/drivers/sqlite-supervisor/index.test.ts",
  "packages/runtime/test/drivers/drills/index.test.ts",
  "packages/runtime/test/drivers/restate-driver/index.test.ts",
  "packages/runtime/test/pilots/index.test.ts",
  "packages/runtime/test/pilots/recovery/index.test.ts",
  "packages/runtime/test/pilots/writer/index.test.ts",
  "packages/daemon/src/index.ts",
  "packages/daemon/src/mode-sqlite/index.ts",
  "packages/daemon/src/mode-restate/index.ts",
  "packages/daemon/src/daemon-child/index.ts",
  "packages/daemon/test/bin/acp-daemon/index.test.ts",
  "packages/daemon/test/launchd/lifecycle/index.test.ts",
  "packages/daemon/test/drills/index.test.ts",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
];

/**
 * P8-2: the CLI subscription binding of the execution port.
 *
 * The contracts' `ModelExecutionPort` implemented over the landed session
 * machinery, with the admitted binary, configuration root, working directory
 * and budgets arriving per account at binding time rather than inside the
 * contract's strict `ExecutionRequest`. The adapters' `ProviderName` re-points
 * at `CLI_SUBSCRIPTION_PROVIDERS` in the same packet: one canonical list, in
 * the only lawful direction, since adapters already depend on contracts.
 *
 * No new dependency edge. The package's pinned import surface stays
 * `@acp/contracts` alone, which is what makes the port a binding rather than a
 * widening.
 */
const P82_WRITE_SET = [
  "packages/adapters/src/execution-port/index.ts",
  "packages/adapters/src/contract/index.ts",
  "packages/adapters/src/index.ts",
  "packages/adapters/test/execution-port/index.test.ts",
  "packages/adapters/test/contract/index.test.ts",
  "packages/adapters/test/testing/index.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-3: the API_KEY execution surface.
 *
 * The second transport on the same boundary, driven by an injected streaming
 * client this repository owns. No dependency moves: the roadmap's law 6 makes
 * Vercel AI SDK Core optional and restricted to API-backed adapters, and the
 * acceptance bullet admits a fake for the conformance fixture, so the SDK
 * binding is registered as optional P8-3b with its own gates rather than
 * landing here. The adapters' pinned import surface is untouched, which is
 * what makes law 6 true by construction: nothing on the CLI path can reach an
 * API key, because no API key exists in the graph.
 */
const P83_WRITE_SET = [
  "packages/adapters/src/providers/api-key/index.ts",
  "packages/adapters/src/execution-port/index.ts",
  "packages/adapters/src/index.ts",
  "packages/adapters/test/execution-port/index.test.ts",
  "packages/adapters/test/testing/index.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-4: the LOCAL_OR_SELF_HOSTED execution surface.
 *
 * The third transport on the same boundary, in P8-3's adjudicated shape: an
 * injected client this repository owns, this time shaped like an
 * OpenAI-compatible chat/completions stream a local or self-hosted server
 * would present, and no real server anywhere. No dependency moves and no new
 * package: the local binding is optional at construction exactly like the API
 * one, so law 6 generalizes -- a CLI-only-constructed port refuses both
 * non-CLI kinds, classified, by construction.
 */
const P84_WRITE_SET = [
  "packages/adapters/src/providers/local/index.ts",
  "packages/adapters/src/execution-port/index.ts",
  "packages/adapters/src/index.ts",
  "packages/adapters/test/execution-port/index.test.ts",
  "packages/adapters/test/testing/index.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-5: the versioned capability/policy registry.
 *
 * Law 4's record, as data outside application code: the document under
 * `packages/accounts/policy/`, its schema and loader inside the accounts
 * package, and `routeWithPolicy` — the single seam that stamps
 * `capabilityPolicyVersion`, leaving `rankAccounts` version-less. No contracts
 * bump: the registry is the accounts domain's to own, and nothing outside it
 * needs the shape.
 *
 * The data file needs no import admission. The accounts purity scan is scoped
 * to `src/` and `test/` `.ts` sources, so a `.json` document rides the
 * write-set membership scan and nothing else.
 */
const P85_WRITE_SET = [
  "packages/accounts/policy/capability-policy.json",
  "packages/accounts/src/policy/index.ts",
  "packages/accounts/src/index.ts",
  "packages/accounts/test/policy/index.test.ts",
  "packages/accounts/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P8-6: the runtime fallback gate.
 *
 * Law 5's removal bullet, drilled rather than only claimed: disabling Restate
 * leaves the documented `SQLITE_SUPERVISOR` path operational. P2 already
 * proved the machinery (D4 fails closed; the 3/3 kill/restart drill;
 * byte-equivalence) -- this packet is the positive certification gate none of
 * those is, over a real child process with the pinned Restate ports checked
 * unbound before and after, plus the operator paragraph the drill backs. No
 * production source changes: the packet proves the landed fallback, it does
 * not build one.
 */
const P86_WRITE_SET = [
  "packages/daemon/test/fallback/index.test.ts",
  "packages/runtime/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P8-7: neutral observability, the redaction gate, and the optional exporter.
 *
 * Law 9's order of dependence, made structural. The neutral surface is a pure
 * projection from ledger events to OTel/OpenInference-shaped values; the
 * redaction gate runs inside it, refusing and counting rather than throwing,
 * with diagnostics that carry coordinates only; and the Langfuse translator is
 * one pure function typed on the gated output, importing no SDK.
 *
 * The package's pinned dependency surface does not move. That is what makes
 * "no observability vendor is required" a property of the import graph rather
 * than a paragraph: removing the exporter is deleting a file, not clearing a
 * flag.
 */
const P87_WRITE_SET = [
  "packages/observation/src/telemetry/index.ts",
  "packages/observation/src/telemetry/langfuse/index.ts",
  "packages/observation/src/index.ts",
  "packages/observation/test/telemetry/index.test.ts",
  "packages/observation/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8A: the initiative data plane.
 *
 * The UI phase's first packet, and read-only like every route before it: three
 * GETs, the response shapes they answer with, the ledger's portfolio
 * enumerator, and the server read-model module where the three folds meet.
 * `registerGet` still answers every other method 405, and that law does not
 * move.
 *
 * The one dependency edge — server → observation — lands with its full kit,
 * because a manifest entry without a lockfile, a fence law and a project
 * reference is an edge that works on one machine.
 */
const P88A_WRITE_SET = [
  "packages/api-contracts/src/routes/index.ts",
  "packages/api-contracts/src/schemas/index.ts",
  "packages/api-contracts/src/parity/index.ts",
  "packages/api-contracts/src/version/index.ts",
  "packages/api-contracts/src/index.ts",
  "packages/api-contracts/test/schemas/index.test.ts",
  "packages/api-contracts/test/parity/index.test.ts",
  "packages/server/src/routes/index.ts",
  "packages/server/src/mappers/index.ts",
  "packages/server/src/initiatives/index.ts",
  "packages/server/package.json",
  "packages/server/tsconfig.json",
  "packages/server/test/build-server/index.test.ts",
  "packages/server/test/initiatives/index.test.ts",
  "packages/ledger/src/ledger/index.ts",
  "packages/ledger/test/ledger/index.test.ts",
  "packages/cli/test/cli/index.test.ts",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8B: the UI foundation.
 *
 * Deferred adoption, and the write-set shows it: two runtime dependencies with
 * use sites in this packet, the catalog pins and the law-comment record that
 * the added graph declares no install script, the tokens' elevation dimension
 * completed and actually consumed, and the shell rebuilt on the one adopted
 * primitive. `onlyBuiltDependencies` stays exactly `better-sqlite3`.
 *
 * The two style files that moved are named here because the brief asked which
 * of the five did: `tokens.css` (the elevation scale) and `layout.css` (the
 * header that consumes it). `base.css`, `components.css` and `index.css` stood.
 *
 * `test/components/app-shell/index.test.tsx` was declared in the brief and is
 * deliberately **absent** here: the rebuild preserved the shell's landmarks and
 * its `aria-current` contract exactly, so the landed test passes unmodified.
 * Declaring a path the packet does not touch would make this array a wish
 * rather than a record — and the test standing untouched is the packet's own
 * evidence that the landed views keep working identically.
 */
const P88B_WRITE_SET = [
  "packages/ui/package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "packages/ui/src/styles/tokens.css",
  "packages/ui/src/styles/layout.css",
  "packages/ui/src/app/index.tsx",
  "packages/ui/src/components/app-shell/index.tsx",
  "packages/ui/src/api/client/index.ts",
  "packages/ui/test/app/index.test.tsx",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8C: the portfolio view and the initiative switcher.
 *
 * The blueprint v2 made real (`.acp-local/p8-8c-blueprint.md`): the portfolio
 * card grid over `GET /api/initiatives`, the route-driven switcher on the one
 * adjudicated new primitive (`@radix-ui/react-dropdown-menu`), and the
 * initiative-scoped route prefix layered onto the landed grammar rather than
 * a second one beside it.
 *
 * Two paths were not in the original 17-item brief and were added only after
 * a Sonnet STOP and a DT widening adjudication
 * (`.acp-local/p8-8c-kimi-widening-adjudication.md`):
 * `packages/ui/test/views/index.test.tsx` and
 * `packages/ui/test/views/not-found-view/index.test.tsx`. Both are
 * pre-existing test files, unrelated to initiative scoping in what they
 * assert, that construct a `Route` object literal inline; `Route` gaining the
 * required `initiativeId` field (this packet, in
 * `packages/ui/src/routing/hash-route/index.ts`) made both fail to typecheck
 * until each gained the same one-line, additive `initiativeId: null` fix
 * `packages/ui/test/components/app-shell/index.test.tsx` (in the original
 * 15) already needed for the identical reason.
 *
 * `packages/ui/src/styles/components.css` is named here and
 * `packages/ui/src/styles/layout.css` and `tokens.css` are not: every new
 * rule (the switcher, the portfolio grid, the card, the extended hit area,
 * the objective's line-clamp) is expressed in existing tokens, and the brand
 * block gained a wrapper div rather than a change to the header layout the
 * landed file already declares.
 */
const P88C_WRITE_SET = [
  "packages/ui/src/views/portfolio-view/index.tsx",
  "packages/ui/src/components/app-shell/index.tsx",
  "packages/ui/src/routing/hash-route/index.ts",
  "packages/ui/src/routing/use-hash-route/index.ts",
  "packages/ui/src/app/index.tsx",
  "packages/ui/src/format/status-tone/index.ts",
  "packages/ui/src/styles/components.css",
  "packages/ui/src/api/client/index.ts",
  "packages/ui/test/views/portfolio-view/index.test.tsx",
  "packages/ui/test/components/app-shell/index.test.tsx",
  "packages/ui/test/routing/hash-route/index.test.ts",
  "packages/ui/package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
  "packages/ui/test/views/index.test.tsx",
  "packages/ui/test/views/not-found-view/index.test.tsx",
];

/**
 * P8-8D-pre: the roadmap-version write endpoint — the plane's first write.
 *
 * One named, decision-mediated route. `decideRoadmapVersion` already owns the
 * six-name refusal vocabulary and reasons over a folded head it is handed, so
 * the endpoint gathers, hands over and appends exactly what a grant produced —
 * it decides nothing. The content is content-addressed in the ledger's own
 * artifact store (atomic publication, verify-on-existing, no delete), because
 * the Checkpoint law keeps content out of events and the ledger owns the data
 * root.
 *
 * The read plane's method list does not move: `API_ALLOWED_METHODS` still says
 * `["GET"]`, and the exception is a second frozen table. ADR 0013 records why.
 */
const P88D_PRE_WRITE_SET = [
  "packages/api-contracts/src/routes/index.ts",
  "packages/api-contracts/src/schemas/index.ts",
  "packages/api-contracts/src/parity/index.ts",
  "packages/api-contracts/src/version/index.ts",
  "packages/api-contracts/src/index.ts",
  "packages/api-contracts/README.md",
  "packages/api-contracts/test/schemas/index.test.ts",
  "packages/api-contracts/test/parity/index.test.ts",
  "packages/server/package.json",
  "packages/server/src/routes/index.ts",
  "packages/server/src/roadmap-write/index.ts",
  // The 21st path, adjudicated: `STATUS_BY_CODE` is an exhaustive Record over
  // the closed code set, so `WRITE_REFUSED` cannot exist without its 409
  // mapping here. Proved by probe before it was asked for.
  "packages/server/src/errors/index.ts",
  "packages/server/test/build-server/index.test.ts",
  "packages/server/test/roadmap-write/index.test.ts",
  // The 22nd path, adjudicated: P8-8A's initiatives suite asserted that every
  // non-GET refuses on every initiative path, which this packet falsifies for
  // exactly one cell. The C4 class, missed by C4's own enumeration.
  "packages/server/test/initiatives/index.test.ts",
  "packages/ledger/src/artifact-store/index.ts",
  "packages/ledger/src/index.ts",
  "packages/ledger/test/artifact-store/index.test.ts",
  "packages/ledger/README.md",
  "docs/architecture/0013-the-first-write-route.md",
  "packages/cli/test/cli/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8D-c2: the roadmap content read.
 *
 * Fable's C2 from the workspace design review: the central region needs to
 * show a roadmap document, and no surface served one. A read, through
 * `registerGet` like every other read, so the plane's write surface stays at
 * exactly one route.
 *
 * Selected by **version**, not by digest. The store is content-addressed and a
 * digest selector would have been shorter — and would have let any caller
 * fetch any object by naming it, including one recorded against a different
 * initiative. Resolving version → digest through that initiative's own fold
 * makes the request's shape enforce the scoping.
 */
const P88D_C2_WRITE_SET = [
  "packages/api-contracts/src/routes/index.ts",
  "packages/api-contracts/src/schemas/index.ts",
  "packages/api-contracts/src/parity/index.ts",
  "packages/api-contracts/src/version/index.ts",
  "packages/api-contracts/src/index.ts",
  "packages/api-contracts/test/schemas/index.test.ts",
  "packages/api-contracts/test/parity/index.test.ts",
  "packages/server/src/routes/index.ts",
  "packages/server/src/initiatives/index.ts",
  "packages/server/test/build-server/index.test.ts",
  "packages/server/test/initiatives/index.test.ts",
  "packages/cli/test/cli/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8D: the initiative workspace.
 *
 * The read surface plus the roadmap's one deliberate edit: the objective,
 * the roadmap region (head, expandable history, the edit dialog on
 * `@radix-ui/react-dialog`, adjudicated C6), and the work state — nothing
 * the data plane does not serve (C1: no "agents active", no "reset in 2d",
 * both cut to their own registered homes, P8-8E/P8-8F).
 *
 * The 18th path, adjudicated after a Sonnet STOP
 * (`.acp-local/p8-8d-kimi-stop-adjudication.md`):
 * `packages/ui/test/views/portfolio-view/index.test.tsx`, whose two
 * `href="#/i/<id>/tasks"` expectations are the mechanical fallout of
 * `buildInitiativeHash`'s own authorized change (bare `#/i/<id>` now lands
 * on the workspace, C3) — a pre-existing test outside the original 17,
 * falsified by an in-scope change, the same class C4 already named for
 * P8-8D-pre and P8-8D-c2's own widenings.
 */
const P88D_WRITE_SET = [
  "packages/ui/src/views/workspace-view/index.tsx",
  "packages/ui/src/components/edit-roadmap-dialog/index.tsx",
  "packages/ui/src/app/index.tsx",
  "packages/ui/src/routing/hash-route/index.ts",
  "packages/ui/src/components/app-shell/index.tsx",
  "packages/ui/src/format/status-tone/index.ts",
  "packages/ui/src/styles/components.css",
  "packages/ui/src/api/client/index.ts",
  "packages/ui/test/views/workspace-view/index.test.tsx",
  "packages/ui/test/components/edit-roadmap-dialog/index.test.tsx",
  "packages/ui/test/routing/hash-route/index.test.ts",
  "packages/ui/test/components/app-shell/index.test.tsx",
  "packages/ui/test/views/index.test.tsx",
  "packages/ui/package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
  // The 18th path, adjudicated (see the doc comment above).
  "packages/ui/test/views/portfolio-view/index.test.tsx",
];

/**
 * P8-T (docs): the blocking structural-topology tranche enters the roadmap.
 *
 * A records-only packet. The owner's ruling of 2026-08-31 makes a fresh joint
 * structural audit mandatory and blocking before P8-E closes and before any
 * P9 request — Kimi maps, Fable challenges, Codex checkpoints once, Opus
 * implements the accepted topology, and the gate ends in a
 * `STRUCTURAL_TOPOLOGY_CERTIFIED` receipt.
 *
 * The tranche's **execution** is scheduled at the final pre-closure point,
 * after the product, UI, E2E and certification work is functionally complete.
 * This packet only writes it down, which is why the status line does not move:
 * recording a gate a phase will be judged against is not the same as meeting
 * it, and a status that advanced on a docs packet would say it was.
 */
const P8T_DOC_WRITE_SET = ["docs/ROADMAP.md", "scripts/check-architecture.mjs"];

/**
 * P8-T (roadmap): the tranche charter amended after the joint audit.
 *
 * The same two paths as `P8T_DOC_WRITE_SET`, and deliberately a separate
 * array: the first packet recorded that a structural audit would happen, this
 * one records what that audit decided. Two entries, zero new paths — a packet
 * that rewrites a subsection the phase already owns moves the entry count and
 * leaves the path count alone.
 *
 * The status line still does not move. The charter now names five strata, ten
 * G-packets and a `STRUCTURAL_TOPOLOGY_CERTIFIED` gate; none of that is met by
 * writing it down, and P9 stays as impossible on the day this lands as it was
 * the day before.
 */
const P8T_ROADMAP_WRITE_SET = ["docs/ROADMAP.md", "scripts/check-architecture.mjs"];

/**
 * P8-T2: the OSS elevation adjudication, and the ADR corpus's own law.
 *
 * The delta-2 pass produced one adjudication; this packet records it. The
 * roadmap's tranche gains the delta block, and the ADR corpus gains the three
 * things it never had -- an index, a template, and the topology record itself
 * at 0014.
 *
 * The renumber is the packet's own evidence. The amended charter commissioned
 * that record as 0013 while 0013 was already the first write route, and the
 * commission passed a synthesis, a review, a verification and a post-audit
 * without anyone comparing it to `docs/architecture/`. The fix is not the
 * renumber -- that is bookkeeping -- it is `assertAdrNumbering` below, so the
 * next commissioned number is checked by something that cannot forget.
 */
const P8T2_WRITE_SET = [
  "docs/ROADMAP.md",
  "docs/architecture/0014-repository-topology.md",
  "docs/architecture/index.md",
  "docs/architecture/_template.md",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8E-pre: the scoped edges/timeline/agents read surface.
 *
 * The graph/timeline/agents cohort's server prerequisite — three cores the
 * cohort cannot derive for itself. The edge facts (`causationId`,
 * `correlationId`) are surfaced rather than invented; the merged timeline tags
 * each row with the chain it came from and states its tie-break; the scoped
 * workers are folded from this initiative's own task events rather than read
 * off the global projection, which would answer faster and wrongly.
 *
 * Seventeen paths, not thirteen. The brief declared thirteen; adding two required
 * fields to `TimelineItem` broke its only constructor and two UI fixtures, all
 * outside the set, and the DT approved those three after the STOP. The lesson
 * is recorded where it will be read again: a `.parse()` on an object literal is
 * invisible to `tsc`, so a type-driven probe under-reports the blast radius of
 * a required DTO field. The full suite is the probe that does not.
 */
const P88E_PRE_WRITE_SET = [
  "packages/api-contracts/src/routes/index.ts",
  "packages/api-contracts/src/schemas/index.ts",
  "packages/api-contracts/src/parity/index.ts",
  "packages/api-contracts/src/version/index.ts",
  "packages/api-contracts/src/index.ts",
  "packages/api-contracts/test/schemas/index.test.ts",
  "packages/api-contracts/test/parity/index.test.ts",
  "packages/server/src/routes/index.ts",
  "packages/server/src/initiatives/index.ts",
  "packages/server/src/mappers/index.ts",
  "packages/server/test/build-server/index.test.ts",
  "packages/server/test/initiatives/index.test.ts",
  "packages/ui/test/components/timeline-list/index.test.tsx",
  "packages/ui/test/format/chain/index.test.ts",
  "packages/cli/src/observation/index.ts",
  "packages/cli/test/cli/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8E: the task graph, the scoped timeline, and the agents surface.
 *
 * The blueprint made real, the design review and the DT adjudication
 * incorporated. Nodes are tasks, state-toned; edges are real causal facts
 * derived from `ScopedTimelineEntry`'s `causationId` chain, never invented —
 * a `causationId` that resolves to nothing on the fetched page, or to the
 * same task's own earlier event, produces no edge. The layout is a pure
 * exported function (`layoutGraph`), unit-tested without a canvas; the
 * `@xyflow/react` canvas mounts behind a client-only seam and is
 * `aria-hidden`, since the same edges rendered as a list are this view's
 * actual keyboard surface and static-testable contract. The scoped timeline
 * and agents views round out the cohort, each reading one of the two new
 * P8-8E-pre endpoints; the sub-navigation between all four initiative pages
 * is defined once, in `workspace-view`, and imported by the three new views.
 *
 * `@xyflow/react` is the one new dependency: pinned exactly, catalog-listed,
 * and the whole graph it pulls in — including the d3-family and zustand —
 * carries no install-time script, verified the same way every dependency
 * addition before it was.
 */
const P88E_WRITE_SET = [
  "packages/ui/src/views/graph-view/index.tsx",
  "packages/ui/src/views/timeline-view/index.tsx",
  "packages/ui/src/views/agents-view/index.tsx",
  "packages/ui/src/app/index.tsx",
  "packages/ui/src/routing/hash-route/index.ts",
  "packages/ui/src/views/workspace-view/index.tsx",
  "packages/ui/src/api/client/index.ts",
  "packages/ui/src/styles/components.css",
  "packages/ui/test/views/graph-view/index.test.tsx",
  "packages/ui/test/views/timeline-view/index.test.tsx",
  "packages/ui/test/views/agents-view/index.test.tsx",
  "packages/ui/test/views/workspace-view/index.test.tsx",
  "packages/ui/test/routing/hash-route/index.test.ts",
  "packages/ui/package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8E2: the causation producers.
 *
 * P8-8E landed a task graph that was correct and empty: the surface existed
 * end to end and every event constructor in the repository hardcoded
 * `causationId` to null. This packet is the other half — the producers write
 * the thread, so the view finally draws from a fact something records.
 *
 * Two properties are worth stating where they will be read again. The chain is
 * **derived**, not remembered, from the invocation and the plan's previous
 * transition id: that is why the resume law needs no special case, because a
 * pure derivation lands on the same event before and after a kill. And
 * causation is **advisory** — the ledger's integrity machinery verifies hash
 * chains, not causal claims — so its trustworthiness rests entirely on two
 * guards that do not trust each other: the producer refuses to append a link
 * whose predecessor is not durably present, and the consumer refuses to draw
 * an edge it cannot resolve on the page it holds.
 *
 * The blast radius is mostly fixtures. `correlationId` is a `Uuid`, and the
 * suites had carried invocation ids like `"inv-0001"` since P1 — legal as
 * opaque strings, illegal the moment one becomes a contract-checked field.
 */
const P88E2_WRITE_SET = [
  "packages/runtime/src/core/events/index.ts",
  "packages/runtime/src/core/step-executor/index.ts",
  "packages/runtime/src/usage/index.ts",
  "packages/runtime/src/switch-executor/index.ts",
  "packages/contracts/src/schemas/index.ts",
  "packages/runtime/test/core/events/index.test.ts",
  "packages/runtime/test/core/step-executor/index.test.ts",
  "packages/runtime/test/usage/index.test.ts",
  "packages/runtime/test/switch-executor/index.test.ts",
  "packages/runtime/test/drivers/sqlite-supervisor/index.test.ts",
  "packages/runtime/test/drivers/restate-driver/index.test.ts",
  "packages/runtime/test/pilots/recovery/helpers/index.ts",
  "packages/runtime/test/pilots/writer/helpers/index.ts",
  "docs/ROADMAP.md",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8F packet 1: the accounts read, and the plane's first non-ledger source.
 *
 * Every route before this one folds the append-only stream. This one reads the
 * owner's accounts file and computes quota and reset against an injected
 * instant, which is why the parity table gains a source of its own
 * (`ACCOUNTS_FILE`) rather than binding these fields to `LEDGER` and asserting
 * a provenance the data does not have.
 *
 * Two properties are the packet's point. The five UNAVAILABLE words are
 * **mapped** from the accounts domain's fourteen refusals by a `Record` keyed
 * on the refusal type, so the map is exhaustive by compilation and a refusal
 * added downstream cannot fall through to a default. And `credentialRef` and
 * `authProfileRef` are **absent from the DTO**, not nulled or redacted: a
 * projection that never reads a field cannot leak it, and strictness makes the
 * omission fail the build rather than depend on care.
 *
 * The dependency edge is the second one this phase has added and is declared at
 * all five sites: the manifest, `P1B_DEPENDENCY_LAW` below, the lockfile, and
 * both project references.
 */
const P88F_SRV_WRITE_SET = [
  "packages/api-contracts/src/routes/index.ts",
  "packages/api-contracts/src/schemas/index.ts",
  "packages/api-contracts/src/parity/index.ts",
  "packages/api-contracts/src/version/index.ts",
  "packages/api-contracts/src/index.ts",
  "packages/api-contracts/test/schemas/index.test.ts",
  "packages/api-contracts/test/parity/index.test.ts",
  "packages/server/src/accounts/index.ts",
  "packages/server/src/routes/index.ts",
  "packages/server/src/build-server/index.ts",
  "packages/server/src/start/index.ts",
  "packages/server/package.json",
  "packages/server/tsconfig.json",
  "packages/server/test/tsconfig.json",
  "packages/server/test/build-server/index.test.ts",
  "packages/server/test/accounts/index.test.ts",
  "packages/cli/test/cli/index.test.ts",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
];

/**
 * P8-debrief-ruling: the owner's final-debrief ruling recorded.
 *
 * A records-only packet, the same two paths as the earlier docs packets:
 * the roadmap gains the bounded final debrief (its composition, its nine
 * certification axes, the one-debrief/one-adjudication bound) and the P9
 * deferral; this file's roadmap digest moves with it. Two entries, zero
 * new paths — the status line does not move, and P9 stays exactly as
 * owner-gated as the ruling says.
 */
const P8_DEBRIEF_RULING_WRITE_SET = ["docs/ROADMAP.md", "scripts/check-architecture.mjs"];

/**
 * P8-8F packet 2: the UI over the landed 0.6.0 contract.
 *
 * Three new views over the accounts read, the scoped operator log and the
 * roadmap document, plus the P8-8D C1 deferral's named home: the workspace's
 * quota-confidence row, read from the detail fetch it already makes (no new
 * fetch). `AccountsResponse` is a closed union and both arms are a 200, so
 * the accounts view branches on `data.status` inside its own success render
 * rather than treating `UNAVAILABLE` as this package's landed error idiom —
 * it is the state a fresh machine actually shows. The scoped logs and the
 * roadmap document join `graph`/`events`/`agents` in
 * `parseScopedOnlySegments`; `accounts` joins the plain grammar beside
 * `tasks`/`workers`/`events`, since accounts are global by roadmap law. No
 * new dependency and no new primitive: the version selector is a native
 * `select`, and the document body is pre-wrapped monospace text, not a
 * markdown renderer.
 */
const P88F_UI_WRITE_SET = [
  "packages/ui/src/views/accounts-view/index.tsx",
  "packages/ui/src/views/logs-view/index.tsx",
  "packages/ui/src/views/roadmap-document-view/index.tsx",
  "packages/ui/src/app/index.tsx",
  "packages/ui/src/routing/hash-route/index.ts",
  "packages/ui/src/views/workspace-view/index.tsx",
  "packages/ui/src/api/client/index.ts",
  "packages/ui/src/components/app-shell/index.tsx",
  "packages/ui/src/styles/components.css",
  "packages/ui/test/views/accounts-view/index.test.tsx",
  "packages/ui/test/views/logs-view/index.test.tsx",
  "packages/ui/test/views/roadmap-document-view/index.test.tsx",
  "packages/ui/test/views/workspace-view/index.test.tsx",
  "packages/ui/test/views/index.test.tsx",
  "packages/ui/test/routing/hash-route/index.test.ts",
  "packages/ui/test/app/index.test.tsx",
  "packages/ui/test/components/app-shell/index.test.tsx",
  "packages/ui/test/api/client/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8F-record: the cohort's own record enters the roadmap.
 *
 * A records-only packet, the same two paths as the earlier docs packets:
 * the roadmap gains the `#### P8-8F` block at its declared home; this
 * file's roadmap digest moves with it. Two entries, zero new paths — the
 * status line does not move.
 */
const P88F_RECORD_WRITE_SET = ["docs/ROADMAP.md", "scripts/check-architecture.mjs"];

/**
 * P8-8G packet 1: the write door, armed.
 *
 * Three hardenings that share a theme — the write surface was correct and
 * unguarded, and each of these closes a way it could tell a caller something
 * untrue.
 *
 * **R1.** A lost race used to surface as 500. Two writers folding the same
 * head assemble the same version number and the ledger's uniqueness lets one
 * through; the loser was not broken and its request was not malformed, so it
 * now hears 409 `WRITE_CONFLICT` and can retry. Narrow **by name**: exactly
 * the two conflict codes are caught and anything else still classifies
 * `INTERNAL`, because a broad catch would turn every future ledger fault into
 * a cheerful "try again".
 *
 * **R2.** One ceiling, one authority, one unit. The number lived in two
 * packages measured two ways — the store weighed UTF-8 bytes, the API schema
 * counted UTF-16 code units — so a multibyte document could pass the schema
 * and be refused by the store. The declaration moves to `@acp/contracts` with
 * the unit law, both packages re-export under their landed names, and the
 * schema bound becomes a byte refinement using a browser-safe `TextEncoder`
 * rather than `Buffer`.
 *
 * **The bearer.** Armed inside the write registrar rather than in a handler:
 * structural, so a future write route is guarded by where it is registered and
 * there is nowhere to forget the check from. Reads stay unguarded by design.
 * Fail-closed — an unconfigured door answers 403, never proceeds — and the
 * comparison is hash-then-`timingSafeEqual`, so neither the token nor its
 * length leaks through timing.
 */
const P88G_A_WRITE_SET = [
  "packages/contracts/src/schemas/index.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/test/schemas/index.test.ts",
  "packages/api-contracts/src/schemas/index.ts",
  "packages/api-contracts/src/version/index.ts",
  "packages/api-contracts/src/index.ts",
  "packages/api-contracts/test/schemas/index.test.ts",
  "packages/ledger/src/artifact-store/index.ts",
  "packages/ledger/test/artifact-store/index.test.ts",
  "packages/server/src/bearer/index.ts",
  "packages/server/src/errors/index.ts",
  "packages/server/src/roadmap-write/index.ts",
  "packages/server/src/routes/index.ts",
  "packages/server/src/build-server/index.ts",
  "packages/server/src/start/index.ts",
  "packages/server/test/bearer/index.test.ts",
  "packages/server/test/build-server/index.test.ts",
  "packages/server/test/roadmap-write/index.test.ts",
  "packages/server/test/initiatives/index.test.ts",
  "packages/cli/test/cli/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8G packet 2: the account-actions stream and the operator entry.
 *
 * The accounts surface becomes operable rather than merely visible. Three
 * things land, and the first is the one worth reading twice.
 *
 * **The authority law, including its silent case.** An account's existence,
 * plan and limits always come from the owner file. Its *operational state* has
 * two possible owners, decided by one fact: whether any action has ever been
 * recorded. None → the file governs. Any → the ledger owns the lifecycle from
 * then on, and the newest action wins. The case a reader would otherwise
 * assume backwards: **a later owner-file edit does not override an earlier
 * action.** Authority never returns to the file implicitly, because the file
 * cannot know what the operator did on Monday, and letting it win would erase
 * a recorded decision with an unrecorded one. The correction path is always an
 * explicit act, recorded with its own receipt.
 *
 * **The second write door**, registered through the same guarded registrar as
 * the first — so the bearer is inherited by *where it is written* rather than
 * by anyone remembering. `API_WRITE_ROUTES` grows visibly to two, which is
 * what that separate frozen table is for.
 *
 * **The operator entry**, so starting this server is no longer a script an
 * operator writes themselves. Hand-rolled argv, the daemon entry's
 * classified-exit idiom, and no new dependency.
 *
 * The migration is worth a note. Its first draft created `account_events`
 * without the append-only triggers its two sibling streams carry, and
 * `EXPECTED_SCHEMA_OBJECTS` refused the schema — the inventory caught a
 * silently mutable log before any test did, which is the whole reason that
 * list exists.
 */
const P88G_B_WRITE_SET = [
  "packages/contracts/src/schemas/index.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/test/schemas/index.test.ts",
  "packages/ledger/src/migrations/index.ts",
  "packages/ledger/src/ledger/index.ts",
  "packages/ledger/src/types/index.ts",
  "packages/ledger/src/index.ts",
  "packages/ledger/test/ledger/index.test.ts",
  "packages/api-contracts/src/routes/index.ts",
  "packages/api-contracts/src/schemas/index.ts",
  "packages/api-contracts/src/parity/index.ts",
  "packages/api-contracts/src/version/index.ts",
  "packages/api-contracts/test/schemas/index.test.ts",
  "packages/api-contracts/test/parity/index.test.ts",
  // Granted after the STOP: the barrel is the package's only export surface,
  // so the action schemas are unreachable without it, and the UI fixture is
  // typed against `AccountDto` and must satisfy its three new fields or `tsc`
  // refuses the whole graph.
  "packages/api-contracts/src/index.ts",
  "packages/ui/test/views/accounts-view/index.test.tsx",
  "packages/server/src/account-actions/index.ts",
  "packages/server/src/accounts/index.ts",
  "packages/server/src/routes/index.ts",
  "packages/server/src/bin/index.ts",
  "packages/server/package.json",
  "packages/server/test/account-actions/index.test.ts",
  "packages/server/test/accounts/index.test.ts",
  "packages/server/test/bin/index.test.ts",
  "packages/server/test/build-server/index.test.ts",
  "packages/cli/test/cli/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8G packet 3 (isolated worktree, Sonnet implementer; Opus integrates):
 * the UI half of the write surface — the session-only bearer field, the
 * account action controls and their deliberate confirms, and the two write
 * surfaces sending the header (blueprint v2 §3).
 *
 * The bearer is held in module scope inside `api/client`, not React context:
 * `App` owns the one `useState` that changes it and is this packet's only
 * caller of the setter, but the roadmap edit dialog is reached through
 * `views/roadmap-document-view` — outside this packet's write-set — so it
 * cannot receive the value as a new prop. Reading the module-level getter at
 * render time is what lets a file several layers below the root see the
 * current token without that file, or the ones between it and the root,
 * needing to change.
 *
 * `packages/api-contracts/src/index.ts` is not listed again here: packet 2
 * already added every DTO and route name this packet's UI reads, and
 * nothing here grows that barrel further.
 */
const P88G_UI_WRITE_SET = [
  "packages/ui/src/api/client/index.ts",
  "packages/ui/src/app/index.tsx",
  "packages/ui/src/components/bearer-field/index.tsx",
  "packages/ui/src/views/accounts-view/index.tsx",
  "packages/ui/src/components/edit-roadmap-dialog/index.tsx",
  "packages/ui/src/styles/components.css",
  "packages/ui/test/api/client/index.test.ts",
  "packages/ui/test/app/index.test.tsx",
  "packages/ui/test/components/bearer-field/index.test.tsx",
  "packages/ui/test/views/accounts-view/index.test.tsx",
  "packages/ui/test/components/edit-roadmap-dialog/index.test.tsx",
  "scripts/check-architecture.mjs",
];

/**
 * P8-8G-record: the cohort's own record enters the roadmap.
 *
 * A records-only packet, the same two paths as the earlier docs packets:
 * the roadmap gains the `#### P8-8G` block at its declared home and the C2
 * language amendment ("the write surface", not "the single write door" — a
 * singular guarded surface may hold more than one route, and after this
 * cohort it holds two); this file's roadmap digest moves with it. Two
 * entries, zero new paths — the status line does not move.
 *
 * It briefly recorded four. Two server suites were granted into this packet to
 * repair a fixture whose absolute `nextResetAt` had expired, and that ruling
 * was superseded: the expiry is fixed at its cause by `P88G_CAUSAL_WRITE_SET`,
 * which owns those suites. Trimmed back to its true composition, so this array
 * records the packet that exists rather than the one that was briefly planned.
 */
const P88G_RECORD_WRITE_SET = ["docs/ROADMAP.md", "scripts/check-architecture.mjs"];

/**
 * P8-8G-causal: the injected-instant seam.
 *
 * The cause behind the closing packet's red gate, fixed at its root rather
 * than at its symptom. `BuildServerOptions` gains an optional `now` supplier
 * defaulting to the real clock, the accounts route reads it instead of calling
 * `new Date()` inline, and the two server suites pin an instant through it —
 * so their fixture keeps the literal reset it always declared and stops
 * measuring the calendar. The seam is deliberately absent from the operator's
 * start surface: every other build option is operator configuration, and a
 * production clock freezable from the command line is a footgun with no
 * operator use, which the drill asserts rather than assumes.
 */
const P88G_CAUSAL_WRITE_SET = [
  "packages/server/src/build-server/index.ts",
  "packages/server/src/routes/index.ts",
  "packages/server/test/accounts/index.test.ts",
  "packages/server/test/account-actions/index.test.ts",
  "packages/server/test/build-server/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P8-9-1: the drill teardown kills what it spawns.
 *
 * The first packet of P8-9, and the fix for a named incident rather than a
 * hypothetical: a `restate-server` outlived the runtime lane and falsified it,
 * because two drills recorded a spawned server's pid at the call site but never
 * registered the handle the teardown sweeps. Any failure between the spawn and
 * the explicit stop left a live server nothing was responsible for. Registration
 * now happens in one act, inside a helper wrapping the spawn, so both the leak
 * assertion and the teardown are fed by the same provenance and forgetting is
 * impossible by construction. Test-side only: no `src/` path moves.
 */
const P89_1_WRITE_SET = [
  "packages/runtime/test/drivers/drills/index.test.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P7I-2: the ledger mappings.
 *
 * Everything the sibling stream needs to exist durably, in the package that
 * owns durability. The decision module is a new domain rather than a function
 * bolted onto the ledger class: it is pure, it never opens a database, and
 * keeping it separate is what makes that checkable.
 */
const P7I2_WRITE_SET = [
  "packages/ledger/src/migrations/index.ts",
  "packages/ledger/src/ledger/index.ts",
  "packages/ledger/src/projection/index.ts",
  "packages/ledger/src/roadmap-version/index.ts",
  "packages/ledger/src/types/index.ts",
  "packages/ledger/src/index.ts",
  "packages/ledger/test/ledger/index.test.ts",
  "packages/ledger/test/roadmap-version/index.test.ts",
  "packages/ledger/README.md",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C1: contracts, the first tree normalized under the mirrored
 * topology.
 *
 * The three relocated source paths are **not** listed here. `P0_WRITE_SET`
 * carries them and this cohort rewrote them there 1:1, per the relocation
 * mechanics; repeating them would give each a second declaration site, and a
 * path declared twice is a path whose rewrite no gate can enforce — the P0 edit
 * would become invisible to the write-set check. This array therefore declares
 * only what the cohort genuinely adds or edits elsewhere.
 *
 * That file sits in `test/` rather than being a `tsconfig.test.json` at the
 * package root, and the placement is load-bearing rather than a preference.
 * ESLint runs with `projectService: true`, which finds a file's project by
 * walking up to the nearest `tsconfig.json`; a root-level `tsconfig.test.json`
 * is never discovered that way, so the test tree would lint as unprojected and
 * type-aware rules would silently stop applying to it. Placed here it is found,
 * the tests are typechecked as evidence must be, and `eslint.config.mjs` needs
 * no change — which matters, because that file's parser settings are repo-wide
 * and not a cohort's to decide.
 */
const P5N_C1_WRITE_SET = [
  "packages/contracts/test/tsconfig.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C2: ledger, the second tree normalized.
 *
 * As with C1, the eight relocated source paths are **not** listed here —
 * `P1A_WRITE_SET` carries them and this cohort rewrote them there 1:1. This
 * array declares only what the cohort adds or edits elsewhere: the test tree's
 * own `tsconfig.json`, and the two one-line hygiene entries for the build
 * output that config produces — `.gitignore` so it is not tracked, and the
 * ESLint ignore so it is not linted as if a compiler's output were authored
 * code. Both recur for every package whose test tree emits.
 */
const P5N_C2_WRITE_SET = [
  "packages/ledger/test/tsconfig.json",
  ".gitignore",
  "eslint.config.mjs",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C3: api-contracts, the third tree normalized.
 *
 * As with C1 and C2 the relocated source paths are not listed here — they are
 * carried by `P1B_SHARED_WRITE_SET` and `P3D_WRITE_SET`, rewritten 1:1 — so
 * this array declares only the test tree's own `tsconfig.json` and the config
 * files the cohort edits. No `.gitignore` or ESLint entry is needed: this test
 * tree typechecks with `noEmit`, so it produces no build output to ignore.
 */
const P5N_C3_WRITE_SET = [
  "packages/api-contracts/test/tsconfig.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C4: observation, the fourth tree normalized.
 *
 * The relocated source paths stay declared once, in `P3A`/`P3B`/`P3C`, rewritten
 * 1:1. Note what is **not** here: observation is the first cohort whose package
 * the fence already scans, so it does not join `TEST_TREE_NO_PACKAGE_SCAN` —
 * its scan is extended to the mirrored tree instead, which is what B5b asks of
 * a package that has one.
 */
const P5N_C4_WRITE_SET = [
  "packages/observation/test/tsconfig.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C5: cli, the fifth tree normalized.
 *
 * As with C1-C4 the relocated source paths are not listed here — they are
 * carried by `P1_WRITE_SET` and `P3D_WRITE_SET`, rewritten 1:1 — so this array
 * declares only the test tree's own `tsconfig.json` and the config files the
 * cohort edits. This cohort additionally edits `packages/server/tsconfig.json`:
 * the DT's binding deep-alias adjudication moves the
 * `@acp/cli/observation-rows` half of the P3D alias update here rather than to
 * the server cohort, so every commit keeps the server's typecheck green. No
 * `.gitignore` or ESLint entry is needed: this test tree typechecks with
 * `noEmit`, so it produces no build output to ignore.
 */
const P5N_C5_WRITE_SET = [
  "packages/cli/test/tsconfig.json",
  "packages/server/tsconfig.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C6 (adapters): the paths the mirrored-topology normalization
 * touches outside the cohort's own relocated sources — the new package-scoped
 * test project, the two root build/test configs that must learn about it, and
 * the fence itself. Enumerated by the C6 brief, item 8.
 */
const P5N_C6_WRITE_SET = [
  "packages/adapters/test/tsconfig.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C7: daemon, the seventh tree normalized. As with C1-C6 the
 * relocated source paths are not listed here — they are carried by
 * P2D_WRITE_SET, P2E_WRITE_SET and P2F_STAGE_A_WRITE_SET, rewritten 1:1 — so
 * this array declares only the test tree's own tsconfig.json and the
 * config/manifest/doc files the cohort edits. Ruling C7-R1 rescinded the v1
 * emit-project machinery entirely: there is no test/daemon-child/tsconfig.json
 * and no second tsconfig here.
 */
const P5N_C7_WRITE_SET = [
  "packages/daemon/test/tsconfig.json",
  "packages/daemon/package.json",
  "packages/daemon/README.md",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C8: runtime, the eighth tree normalized. As with C1-C7 the
 * relocated source paths are not listed here — they are carried by
 * P2A_WRITE_SET, P2B_WRITE_SET, P2C_WRITE_SET and the P2D-era array,
 * rewritten 1:1 — so this array declares only the test tree's own
 * tsconfig.json and the config/doc files the cohort edits.
 */
const P5N_C8_WRITE_SET = [
  "packages/runtime/test/tsconfig.json",
  "packages/runtime/README.md",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C9: ui, the ninth tree normalized. The relocated source paths are
 * carried by P1B_SHARED_WRITE_SET, P1_WRITE_SET and P3D_WRITE_SET, rewritten
 * 1:1. This array declares the test tree's own tsconfig.json, the one admitted
 * index.html line, the config files, and — per adjudication C9-F —
 * packages/server/tsconfig.json, whose @acp/ui/row-model declaration alias is
 * pinned by equality against SERVER_TS_ALIASES and so must move in the same
 * change as the ui path it names.
 */
const P5N_C9_WRITE_SET = [
  "packages/ui/test/tsconfig.json",
  "packages/ui/index.html",
  "packages/server/tsconfig.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C10: server, the tenth and last tree normalized. The relocated
 * source paths are carried by P1_WRITE_SET and P3D_WRITE_SET, rewritten 1:1.
 * This array declares only the test tree's own tsconfig.json and the config
 * files the cohort edits. packages/server/tsconfig.json is deliberately
 * absent — adjudication C: its aliases and references were already correct
 * once C5 and C9-F landed, and it is not touched here.
 */
const P5N_C10_WRITE_SET = [
  "packages/server/test/tsconfig.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

/**
 * P5N cohort C11: the accounts structural remnant. The relocated paths are
 * carried by P5A_WRITE_SET and P5B_WRITE_SET, rewritten 1:1. This array
 * declares only the test tree's own tsconfig.json and the config files the
 * cohort edits. TOPOLOGY_ACTIVE_TREES is deliberately NOT extended here — DT
 * ruling R1 reassigns the accounts activation to P5C, sequenced after the
 * frozen routing test leaves src/.
 */
const P5N_C11_WRITE_SET = [
  "packages/accounts/test/tsconfig.json",
  "tsconfig.base.json",
  "vitest.config.ts",
  "scripts/check-architecture.mjs",
];

const WRITE_SET = [
  ...P0_WRITE_SET,
  ...P1A_WRITE_SET,
  ...P1B_SHARED_WRITE_SET,
  ...P1_WRITE_SET,
  ...P2A_WRITE_SET,
  ...P2B_WRITE_SET,
  ...P2C_WRITE_SET,
  ...P2D_WRITE_SET,
  ...P2E_WRITE_SET,
  ...P2F_STAGE_A_WRITE_SET,
  ...P3A_WRITE_SET,
  ...P3B_WRITE_SET,
  ...P3C_WRITE_SET,
  ...P3D_WRITE_SET,
  ...P3E_WRITE_SET,
  ...P4A_WRITE_SET,
  ...P4B_WRITE_SET,
  ...P4C_WRITE_SET,
  ...P4D_WRITE_SET,
  ...P4E_WRITE_SET,
  ...P5A_WRITE_SET,
  ...P5B_WRITE_SET,
  ...P5C_WRITE_SET,
  ...P5D_WRITE_SET,
  ...P5E_WRITE_SET,
  ...P6A_WRITE_SET,
  ...P6B_WRITE_SET,
  ...P6C_WRITE_SET,
  ...P6E_WRITE_SET,
  ...P6F_WRITE_SET,
  ...P7P_WRITE_SET,
  ...P7A_WRITE_SET,
  ...P7B_WRITE_SET,
  ...P7C_WRITE_SET,
  ...P7E_WRITE_SET,
  ...P7I0_WRITE_SET,
  ...P7I1_WRITE_SET,
  ...P7I2_WRITE_SET,
  ...P7I3_WRITE_SET,
  ...P7IE_WRITE_SET,
  ...P8D_WRITE_SET,
  ...P81_WRITE_SET,
  ...P8W_WRITE_SET,
  ...P82_WRITE_SET,
  ...P83_WRITE_SET,
  ...P84_WRITE_SET,
  ...P85_WRITE_SET,
  ...P86_WRITE_SET,
  ...P87_WRITE_SET,
  ...P88A_WRITE_SET,
  ...P88B_WRITE_SET,
  ...P88C_WRITE_SET,
  ...P88D_PRE_WRITE_SET,
  ...P88D_C2_WRITE_SET,
  ...P88D_WRITE_SET,
  ...P8T_ROADMAP_WRITE_SET,
  ...P8T2_WRITE_SET,
  ...P88E_PRE_WRITE_SET,
  ...P88E_WRITE_SET,
  ...P88E2_WRITE_SET,
  ...P88F_SRV_WRITE_SET,
  ...P8_DEBRIEF_RULING_WRITE_SET,
  ...P88F_UI_WRITE_SET,
  ...P88F_RECORD_WRITE_SET,
  ...P88G_A_WRITE_SET,
  ...P88G_B_WRITE_SET,
  ...P88G_UI_WRITE_SET,
  ...P88G_RECORD_WRITE_SET,
  ...P88G_CAUSAL_WRITE_SET,
  ...P89_1_WRITE_SET,
  ...P8T_DOC_WRITE_SET,
  ...P5N_A_WRITE_SET,
  ...P5N_C1_WRITE_SET,
  ...P5N_C2_WRITE_SET,
  ...P5N_C3_WRITE_SET,
  ...P5N_C4_WRITE_SET,
  ...P5N_C5_WRITE_SET,
  ...P5N_C6_WRITE_SET,
  ...P5N_C7_WRITE_SET,
  ...P5N_C8_WRITE_SET,
  ...P5N_C9_WRITE_SET,
  ...P5N_C10_WRITE_SET,
  ...P5N_C11_WRITE_SET,
].filter((relativePath) => !RETIRED.has(relativePath));

/** Distinct paths, for reporting. A path in two phases is still one path. */
const WRITE_SET_DISTINCT = [...new Set(WRITE_SET)];

/**
 * docs/ROADMAP.md is pinned by digest so it cannot drift.
 *
 * Each phase is authorized to change exactly one line of it, the Estado line,
 * and the pin is re-anchored here to the resulting file. Because a re-pin is
 * only as trustworthy as the reviewer who approved it, the roadmap is
 * additionally checked for the structural literals below: a rewritten roadmap
 * that happened to carry a matching digest would still have to keep saying all
 * of them.
 */

/**
 * The ADR corpus's numbers are unique and contiguous.
 *
 * Added in P8-T2, after a topology record was commissioned as 0013 while 0013
 * was already the plane's first write route. The corpus is append-only, so a
 * duplicate resolves either as two records sharing a number or as one
 * overwriting the other, and both destroy the property the corpus exists for.
 * Nothing checked, through a full audit chain, because checking it was nobody's
 * named job. It is this function's job now.
 *
 * Only `NNNN-*.md` files are records: `index.md` and `_template.md` are corpus
 * furniture and are skipped by the shape of the pattern rather than by an
 * exclusion list, so adding a second non-record file cannot silently widen the
 * exemption.
 */
function assertAdrNumbering() {
  const dir = join(REPO_ROOT, "docs/architecture");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    fail("docs/architecture is unreadable; the ADR corpus is a required tree");
    return;
  }

  const records = entries
    .map((name) => /^(\d{4})-.+\.md$/.exec(name))
    .filter((match) => match !== null)
    .map((match) => ({ name: match[0], number: Number.parseInt(match[1], 10) }))
    .sort((a, b) => a.number - b.number);

  if (records.length === 0) {
    fail("docs/architecture holds no NNNN-*.md records");
    return;
  }

  const byNumber = new Map();
  for (const record of records) {
    const seen = byNumber.get(record.number);
    if (seen !== undefined) {
      fail(
        "ADR number " +
          String(record.number).padStart(4, "0") +
          " is used twice: " +
          seen +
          " and " +
          record.name,
      );
      return;
    }
    byNumber.set(record.number, record.name);
  }

  const first = records[0];
  if (first === undefined || first.number !== 1) {
    fail("the ADR corpus must start at 0001; it starts at " + String(first?.number));
    return;
  }

  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (previous === undefined || current === undefined) continue;
    if (current.number !== previous.number + 1) {
      fail(
        "the ADR corpus is not contiguous: " +
          previous.name +
          " is followed by " +
          current.name,
      );
      return;
    }
  }

  // The index is the corpus's front door, so a record absent from it is a
  // record nobody finds. Bijection both ways.
  let index;
  try {
    index = readFileSync(join(dir, "index.md"), "utf8");
  } catch {
    fail("docs/architecture/index.md is missing; the corpus has no index");
    return;
  }
  for (const record of records) {
    if (!index.includes(record.name)) {
      fail("ADR " + record.name + " is absent from docs/architecture/index.md");
      return;
    }
  }
  for (const linked of index.matchAll(/\((\d{4}-[^)]+\.md)\)/g)) {
    const target = linked[1];
    if (target !== undefined && !byNumber.has(Number.parseInt(target.slice(0, 4), 10))) {
      fail("docs/architecture/index.md links " + target + ", which is not in the corpus");
      return;
    }
  }

  notes.push("ADR corpus: " + String(records.length) + " records, unique, contiguous, indexed");
}

const ROADMAP_SHA256 =
  "7ee1f2e35a1c7e1b089cfd614109203c400abb0150126a2d8fba51b7d99c6682";

/**
 * The Estado line P7 closure is allowed to have produced.
 *
 * P7 is complete on its committed commits and the independently verified
 * receipts behind them: the commit-policy-aware lifecycle plan that gives a
 * `NO_COMMIT` packet a lawful close (P7P), the read-only packet pilot over the
 * real machinery (P7A), kill/restart 3/3 by real SIGKILL plus the account
 * switch played as values over a real ledger (P7B), and the mechanical writer
 * packet with a real local commit under a receipt (P7C). The literal is exact,
 * and because it still does not contain P1_INCOMPLETE it also keeps the lane
 * envelope closed.
 *
 * What P7 completion does NOT mean is worth stating where the claim is made.
 * P7 is the first phase whose drills act — but only inside repositories they
 * create and delete themselves. Every `git` invocation in the phase is aimed
 * at an `mkdtemp` toy repository the drill owns; the one commit any packet
 * makes is that toy's own, disposed with its directory; no product repository
 * was read or written, no worktree outside a temp directory was touched, and
 * nothing pushed — the toys carry zero remotes, the drills' spawned argv is
 * proven free of `push`, the receipt type sets `pushAuthorized` false and the
 * canonical pre-push hook still refuses unconditionally. The pilots prove the
 * machinery; nothing is in service. P7I opens as *next*, not as started.
 *
 * P7I closes on the same evidence, one phase later: the contract generation
 * bump with every fixture de-hardcoded (P7I-0), the initiative and versioned
 * roadmap contracts with the sibling event stream (P7I-1), the ledger mappings
 * that give that stream a table, a chain, a head and both-chain verification
 * (P7I-2), and the token rollups that close R4 (P7I-3). Its design was
 * pre-audited once and adjudicated twice, and two STOPs were honored rather
 * than worked around -- the write-set law held when a version bump reached
 * four packages the brief had not named, and again when a tenth path proved
 * structurally required.
 *
 * What P7I completion does NOT mean: nothing consumes any of it. No daemon,
 * runtime or server path threads an initiative id, wires the sibling stream or
 * calls the rollup fold; only tests append the two usage event types; and no
 * UI exists at all, which is the phase's own scope law rather than an
 * omission. The contracts and the mappings are proven; nothing is running on
 * them. P8 opens as *next*, not as started.
 *
 * NO_PRODUCT_CUTOVER stays in the same line and must stay there. Nothing P7 or
 * P7I built is in service, and adoption happens once, after P8 certification
 * and under a separate P9 authorisation.
 */
const ROADMAP_STATUS_LITERAL =
  "Estado: `P0_COMPLETE / P1_COMPLETE / P2_COMPLETE / P3_COMPLETE / P4_COMPLETE / P5_COMPLETE / P6_COMPLETE / P7_COMPLETE / P7I_COMPLETE / NEXT_P8 / NO_PRODUCT_CUTOVER`";

/** Structural statements the roadmap must still make after any re-pin. */
const ROADMAP_LITERALS = [
  "NO_PRODUCT_CUTOVER",
  "no takeover de Modern Rescue",
  "El producto nuevo debe llegar completo a una certificación pre-cutover",
  "P8 — Producto completo y certificación pre-cutover",
  "P9 — Cutover explícito y reversible",
  "no writers concurrentes en un mismo worktree",
  "no almacenar secretos en el repositorio, ledger o artifacts",
];

/**
 * Status claims that would overstate what has actually been delivered.
 *
 * P1_COMPLETE left this list at P1 closure, because it is now true and carries
 * a verifier receipt. The cutover literals never leave it: no phase status may
 * ever assert cutover authority, which is granted by the owner at P9 and by
 * nothing else.
 *
 * P2_COMPLETE went back on at P2E, because the roadmap's P2 criterion is a
 * daemon startable under launchd and an inert template is not that. It leaves
 * the list again here, in P2F Stage B, and only now: Stage A supplied the
 * packaged entry and the config-file contract, drove one real disposable
 * launchd lifecycle, and an independent verifier reproduced it across four
 * cycles. The claim follows the evidence rather than arriving beside it.
 *
 * The cutover literals never leave. No phase status may assert cutover
 * authority, which is the owner's at P9 and nobody else's.
 */
// P3_COMPLETE never entered this list. A status goes on it when the claim would
// outrun the evidence; P3 closed on four committed commits, each behind an
// independent verifier's receipt, so there was never a claim to suppress. The
// membership below is therefore unchanged at P3 closure — and the cutover
// literals still never leave it.
//
// P4_COMPLETE never entered it either, and for the same reason: P4 closed on
// five committed commits, each behind an independent verifier's receipt and a
// semantic audit. The claim it makes is also a narrow one — three adapters
// built, every provider capability left UNKNOWN — so there is no overclaim for
// this list to suppress. Membership is therefore unchanged at P4 closure, and
// the cutover literals still never leave it.
const FORBIDDEN_ROADMAP_LITERALS = [
  "P1_DONE",
  "PRODUCT_CUTOVER_AUTHORIZED",
  "CUTOVER_AUTHORIZED",
];

/**
 * The no-push fence is tamper-evident. Any edit to the hook changes this digest
 * and fails the gate until the pin is updated deliberately, so the hook cannot
 * be quietly softened into a no-op that still exits nonzero on a happy path.
 */
const PRE_PUSH_SHA256 =
  "991a22f42db599bdf618cb3c2b686b91350d909aeb4bcc239467b28f8b883515";

/**
 * Literals that encode authority. If any of these disappears, the document no
 * longer says what P0 froze, and the fence fails rather than trusting prose.
 */
/** Lower-case and collapse whitespace, so a line break cannot hide a statement. */
function flatten(text) {
  return text.toLowerCase().replace(/\s+/g, " ");
}

const AUTHORITY_LITERALS = {
  "README.md": [
    "docs/ROADMAP.md",
    "canonical",
    "no product cutover authority",
    "git config core.hooksPath .githooks",
    "P1A is not P1 completion",
  ],
  "AGENTS.md": [
    "<provider>/<model>/<role>/<instance>",
    "single writer",
    "exact write-set",
    "independent validation",
    "structurally read-only",
    "never push",
    "no destructive Git",
    "no product-repo access",
    "no partial cutover",
    "CommitAuthorizationReceipt",
    "git config core.hooksPath .githooks",
  ],
  "CLAUDE.md": [
    "single writer",
    "exact write-set",
    "never push",
    "CommitAuthorizationReceipt",
    "no partial cutover",
  ],
  "docs/architecture/0001-control-plane-authority.md": [
    "append-only",
    "SQLite",
    "authority",
    "Restate",
    "derived",
    "read model",
    "rebuild",
    "fallback",
  ],
  "docs/architecture/0002-sqlite-event-ledger.md": [
    "append-only",
    "hash chain",
    "idempotency",
    "read model",
    "rebuild",
    "migration",
    "P1A is not P1 completion",
    "no product adoption",
  ],
  "packages/ledger/README.md": [
    "append-only",
    "rebuild",
    "verifyIntegrity",
    "P1A is not P1 completion",
  ],
  "docs/architecture/0003-read-only-observation-plane.md": [
    "browser",
    "read-only",
    "127.0.0.1",
    "GET",
    "redact",
    "error envelope",
    "cursor",
    "P1B is not P1 completion",
    "no product adoption",
    "no partial",
    "lane envelope",
  ],
  "docs/architecture/0004-durability-and-supervisor.md": [
    "append",
    "authority",
    "derived",
    "intent",
    "effect",
    "outcome",
    "fail closed",
    "postcondition",
    "127.0.0.1",
    "determinism",
    "P2A is not P2 completion",
    "no product adoption",
    "no partial",
  ],
  "packages/runtime/README.md": [
    "authority",
    "no side effects",
    "fails closed",
    // "P2D is not P2 completion" was pinned here until P6A. A phrase cannot be
    // required present and required absent at once: retiring it under
    // EXPIRED_LITERALS means it leaves this list in the same change. The
    // completion disclaimer it carried survives as "no product adoption".
    "no product adoption",
  ],
  "packages/daemon/README.md": [
    "no side effects",
    "adds no authority",
    "no auto-detection",
    "never silently reclaimed",
    "P2E is not product adoption",
    "nothing invokes `launchctl`",
  ],
  "packages/daemon/launchd/README.md": [
    "template",
    "RunAtLoad",
    "never automated",
    "in the sense of product adoption",
    "no cutover is authorized",
  ],
  "docs/architecture/0007-launchd-template-and-p2-closure.md": [
    "inert",
    "P2E is not product adoption",
    "no cutover",
    "parses",
    "duplicate key",
    "never in production",
  ],
  "docs/architecture/0006-daemon-process-lifecycle.md": [
    "authority",
    "observation",
    "fails closed",
    "no failover",
    "acyclic",
    "P2D is not P2 completion",
    "no product adoption",
  ],
  "docs/architecture/0005-restate-driver-and-adoption.md": [
    "derived",
    "authority",
    "127.0.0.1",
    "cache",
    "fails closed",
    "no merge policy",
    "adoption criterion",
    "P2C is not P2 completion",
    "no product adoption",
    "no partial cutover",
  ],
  "packages/api-contracts/README.md": [
    "browser-safe",
    "P1B is not P1 completion",
    "no product adoption",
    // P8-8D-pre falsified "GET only": the plane took its first write route.
    // The literal moves to the claim that is now true and is equally
    // load-bearing — the read plane is unchanged and the one exception is
    // named in its own table, which is the whole design of the amendment.
    "the one write is named",
  ],
  // The checkpoint's own laws, asserted rather than described. Without this
  // entry the fence knows ADR 0012 only as a write-set path, and the four
  // statements the whole normalization rests on — the activation list starts
  // empty, no P5C byte is staged, P5C does not resume until full compliance,
  // and no commit claims the live tree is green — would live only in prose that
  // nothing checks.
  "docs/architecture/0012-structural-normalization.md": [
    "mirrored",
    "zero",
    "activation list",
    "starts empty",
    "never moves",
    "does not resume until full compliance",
    "no P5C byte",
    "claims the live tree is green",
    "no product adoption",
    "no cutover",
  ],
  "docs/architecture/0011-accounts-registry-shadow-routing.md": [
    "read-only",
    "no default path",
    "never dereferenced",
    "0600",
    "never a value",
    "shadow",
    "read-only by law",
    "never imports",
    "deferred to P8",
    "STOP law",
    "P5A is not P5 completion",
    "no product adoption",
    "no cutover",
  ],
};

/**
 * Text that must no longer appear, now that a later phase has falsified it.
 *
 * The mirror of AUTHORITY_LITERALS, and it exists because of a real miss. P2C
 * shipped with `packages/runtime/README.md` still saying "There is no Restate
 * driver" in the same commit that added one, and the full suite passed over it:
 * the literal table can require a sentence to be PRESENT but has no way to
 * require one to be GONE. A document could therefore satisfy every assertion it
 * carried while contradicting the code it described, and the more literals a
 * file carried, the more confident the green looked.
 */
const EXPIRED_LITERALS = {
  "packages/runtime/README.md": [
    "There is no Restate driver",
    "This is P2B",
    "will walk the same one in P2C",
    // Retired by the P6A landing: the README framed itself as P2D-only and
    // disclaimed P2 completion for as long as the package held nothing but the
    // lifecycle engine and its drivers. It now holds the enforcement core too.
    "This is P2D: one shared lifecycle engine and both of its drivers.",
    "P2D is not P2 completion",
    // Retired by the P6B landing: true while the package computed no conflict
    // check at all, misleading once the conflict-graph module computes the
    // complete one. The enforcement core still computes none, and the rewritten
    // sentence says exactly that.
    "Nothing here computes a partial conflict check",
    // Retired by P7P: there is no longer a single plan. The module holds one
    // step table and one plan per commit policy, derived from it, and the
    // rewritten sentence says so.
    "holds the single plan",
    // Retired by the P6 closure: the scope sentence enumerated the three P6
    // packets as things being *added*, which was true while each was landing
    // and false once the phase closed. The rewritten sentence states the
    // completed plane instead, and adds the claim that matters -- decision
    // machinery only, no production observer.
    "P6A adds the writer-enforcement core",
    "P6B adds the conflict graph",
    "P6C adds commit authorization and quarantine",
  ],
  "packages/runtime/src/index.ts": ["This is P2B", "This is P2D"],
  "packages/runtime/package.json": ["the SQLite supervisor driver over the append-only ledger"],
  "README.md": [
    "There is no orchestrator",
    "P0 and P1 complete. Next: P2.",
    "P0, P1 and P2 complete. Next: P3.",
    "P0, P1, P2 and P3 complete. Next: P4.",
    "P0, P1, P2, P3 and P4 complete. Next: P5.",
    "P0, P1, P2, P3, P4 and P5 complete. Next: P6.",
    // Retired by the P7 closure, the same way every status sentence before it
    // was: the claim was true while P7 was the next phase and false the moment
    // the pilots landed. Pinned absent rather than merely rewritten, because a
    // sentence that is only deleted can come back.
    "P0, P1, P2, P3, P4, P5 and P6 complete. Next: P7.",
    // Retired by the P7I closure, the same way every status sentence before
    // it was. Pinned absent rather than merely rewritten, because a sentence
    // that is only deleted can come back.
    "P0, P1, P2, P3, P4, P5, P6 and P7 complete. Next: P7I.",
    // Falsified by the same commit that retires the status text above: P4
    // shipped three provider adapters. Pinned here rather than merely deleted,
    // because a sentence that is only removed can come back, and coming back
    // is the exact drift this table exists to catch.
    "There is no provider adapter yet",
  ],
  "packages/daemon/README.md": ["This is P2D", "The launchd template is P2E"],
  // The P3A-only frame the observation README carried until P3 closed. Both
  // literals are lifted byte-exactly from the pre-edit file (lines 7 and 19).
  "packages/observation/README.md": ["This is P3A", "P3A is not P3 completion"],
  // The P4A-only frame the adapters README carried until P4 closed. Both
  // literals are lifted byte-exactly from the pre-edit file: the scope section
  // opened "This is P4A" and closed by saying the three descriptors "are not
  // exported yet". All three are exported now, so both sentences are false and
  // pinned absent.
  "packages/adapters/README.md": ["This is P4A", "are not exported yet"],
  // The P5A-only frame the accounts README carried until the router landed.
  // Both literals are lifted byte-exactly from the pre-edit file: the scope
  // section deferred quota estimation and the router to P5B/P5C as "not
  // exported yet", and the shadow-mode paragraph spoke of the router as still
  // to arrive. Both are exported and arrived now, so both sentences are false
  // and pinned absent.
  "packages/accounts/README.md": [
    "Quota estimation, the quota-aware router and the switching policy arrive in P5B, P5C and P5D and are not exported yet",
    "The router and the switching machine that arrive later",
    // The P5C-era frame the accounts README carried until the switching policy
    // landed. Both are lifted byte-exactly from the pre-edit file: the scope
    // section deferred the switching policy to P5D, and the shadow-mode
    // paragraph still spoke of a machine that had not arrived. It has, and it
    // is exported, so both sentences are false and pinned absent.
    "The switching policy arrives in P5D and is not exported yet",
    "the switching machine that follows it",
    // Retired by P5 closure itself: the scope paragraph disclaimed completion
    // for as long as a P5 surface was still to come. None is.
    "This is not P5 completion.",
  ],
};

/** Files that must never exist in the repository, in any directory. */
const FORBIDDEN_BASENAMES = new Set([
  "accounts.local.json",
  ".env",
  ".env.local",
  "id_rsa",
  "credentials.json",
]);

const FORBIDDEN_SUFFIXES = [".pem", ".p12", ".pfx", ".key"];

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function git(args) {
  return spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function readIfPresent(relativePath) {
  try {
    return readFileSync(join(REPO_ROOT, relativePath), "utf8");
  } catch {
    return null;
  }
}

// The roadmap gates the lane envelope, so it is read before the write-set is
// checked rather than after. The envelope is open only while P1 is explicitly
// incomplete; the moment the status line stops saying so, the exact write-set
// is the only thing that passes again.
const roadmap = readIfPresent("docs/ROADMAP.md");
const laneEnvelopeOpen = roadmap !== null && roadmap.includes("P1_INCOMPLETE");

// --- 1. required paths -----------------------------------------------------

// The write-set has two jobs: it admits paths, and it requires them to exist.
// Those jobs collide the moment one array declares paths a *future* packet will
// create — P3B and P3C are declared here now so their fence admission arrives
// with the packet that declares them, but their files do not exist yet.
//
// The git index resolves the collision without a hand-maintained exception
// list, which would immediately drift from the packet state:
//
//   present on disk           → unchanged, every check applies;
//   absent, known to index    → fail. A committed path stays in the index, so
//                               a deletion — staged or not — can never be
//                               mistaken for a not-yet-written file;
//   absent, unknown to index  → tolerate as declared-future, and say so. The
//                               tolerance is named in the output, never silent.
//
// Fail-closed in both directions: a file that has never existed is tolerated;
// a file that has ever entered the index cannot go missing quietly.
const requiredSeen = new Set();
for (const relativePath of WRITE_SET) {
  if (relativePath === "pnpm-lock.yaml") continue;
  if (requiredSeen.has(relativePath)) continue;
  requiredSeen.add(relativePath);

  let present = true;
  try {
    statSync(join(REPO_ROOT, relativePath));
  } catch {
    present = false;
  }
  if (present) continue;

  const cached = git(["ls-files", "--cached", "--", relativePath]);
  const knownToIndex = cached.status === 0 && cached.stdout.trim() !== "";
  if (knownToIndex) {
    fail("tracked path is missing: " + relativePath);
  } else {
    notes.push("declared future path, not yet created: " + relativePath);
  }
}

// A retired path must be absent. Otherwise a deletion is a one-off event rather
// than a rule, and the file can quietly come back on the next branch.
let allRetiredAbsent = true;
for (const relativePath of RETIRED_PATHS) {
  let stillPresent = true;
  try {
    statSync(join(REPO_ROOT, relativePath));
  } catch {
    stillPresent = false;
  }
  if (stillPresent) {
    allRetiredAbsent = false;
    fail("retired path is present again: " + relativePath);
  }
}
if (allRetiredAbsent) {
  notes.push("retired path absent: " + RETIRED_PATHS.join(", "));
}

// --- 2. write-set conformance ---------------------------------------------

const tracked = git(["ls-files", "--cached", "--others", "--exclude-standard"]);
if (tracked.status !== 0) {
  fail("git ls-files failed; is this a git repository?");
} else {
  const allowed = new Set(WRITE_SET);
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  let inEnvelope = 0;
  let retiredInIndex = 0;
  for (const relativePath of present) {
    if (allowed.has(relativePath)) continue;

    const envelope = P1B_LANE_ENVELOPES.find((prefix) => relativePath.startsWith(prefix));
    if (envelope !== undefined && laneEnvelopeOpen) {
      inEnvelope += 1;
      continue;
    }

    if (RETIRED.has(relativePath)) {
      // The file is gone from the working tree, which check 1 verified, but git
      // still lists it from the index until the deletion is committed. That is a
      // pending deletion, not a violation, and check 1 is what would catch the
      // file actually coming back.
      retiredInIndex += 1;
      continue;
    }

    fail(
      "path is outside the exact P0 plus P1A plus P1B write-set" +
        (envelope === undefined
          ? ""
          : " and the P1B lane envelope is closed because the roadmap no longer says P1_INCOMPLETE") +
        ": " +
        relativePath,
    );
  }
  notes.push(
    present.length +
      " repository files scanned against the write-set (" +
      WRITE_SET_DISTINCT.length +
      " distinct paths across P0 through P2D; " +
      inEnvelope +
      " inside the lane envelope which is " +
      (laneEnvelopeOpen ? "open" : "closed") +
      "; " +
      retiredInIndex +
      " retired path(s) still in the git index pending an uncommitted deletion)",
  );
}

// --- 3. roadmap authority digest ------------------------------------------

if (roadmap === null) {
  fail("docs/ROADMAP.md is missing");
} else {
  const digest = createHash("sha256").update(roadmap, "utf8").digest("hex");
  if (digest !== ROADMAP_SHA256) {
    fail(
      "docs/ROADMAP.md digest is " +
        digest +
        " but the frozen kickoff roadmap is " +
        ROADMAP_SHA256,
    );
  } else {
    notes.push("docs/ROADMAP.md matches its pinned digest");
  }

  assertAdrNumbering();

  // The digest alone would let a re-pin smuggle in a rewritten roadmap, so the
  // structural statements are checked independently of it.
  if (!roadmap.includes(ROADMAP_STATUS_LITERAL)) {
    fail("docs/ROADMAP.md no longer carries the authorized P1A status line");
  } else {
    // Derived, never restated. A hand-typed copy of the value being checked is
    // exactly what drifted: this line announced P2C long after the enforced
    // literal had moved to P2D, and the gate passed the whole time because the
    // note is only a note. Deriving it means it cannot say something the fence
    // is not actually enforcing.
    notes.push("roadmap status literal enforced: " + ROADMAP_STATUS_LITERAL);
  }
  for (const literal of ROADMAP_LITERALS) {
    if (!roadmap.includes(literal)) {
      fail("docs/ROADMAP.md no longer states: " + literal);
    }
  }
  for (const literal of FORBIDDEN_ROADMAP_LITERALS) {
    if (roadmap.includes(literal)) {
      fail(
        "docs/ROADMAP.md claims " +
          literal +
          ", which overstates what has actually been delivered",
      );
    }
  }
}

// --- 4. authority literals -------------------------------------------------

for (const [relativePath, literals] of Object.entries(AUTHORITY_LITERALS)) {
  const content = readIfPresent(relativePath);
  if (content === null) {
    fail("authority document is missing: " + relativePath);
    continue;
  }
  // Case-insensitive and whitespace-normalised: the fence checks that the
  // statement is still made, not how a sentence happened to capitalise it or
  // where a paragraph happened to wrap. A literal that failed because a phrase
  // straddled a line break would teach people to reword prose to satisfy a
  // checker, which is the opposite of what this table is for.
  const haystack = flatten(content);
  for (const literal of literals) {
    if (!haystack.includes(flatten(literal))) {
      fail(relativePath + " no longer states the authority literal: " + literal);
    }
  }
}

// And the mirror: statements a later phase has falsified must be gone, not
// merely outnumbered by newer ones.
for (const [relativePath, literals] of Object.entries(EXPIRED_LITERALS)) {
  const content = readIfPresent(relativePath);
  if (content === null) continue;
  const haystack = flatten(content);
  for (const literal of literals) {
    if (haystack.includes(flatten(literal))) {
      fail(
        relativePath +
          " still says " +
          JSON.stringify(literal) +
          ", which a later phase made false",
      );
    }
  }
}
notes.push(
  Object.keys(EXPIRED_LITERALS).length + " document(s) checked for statements that expired",
);

// --- 5. pre-push hook still denies ----------------------------------------

const hookPath = join(REPO_ROOT, ".githooks", "pre-push");
let hookExecutable = true;
try {
  accessSync(hookPath, constants.X_OK);
} catch {
  hookExecutable = false;
  fail(".githooks/pre-push is not executable; the no-push fence is inert");
}

const hookSource = readIfPresent(".githooks/pre-push");
if (hookSource === null) {
  fail(".githooks/pre-push is missing");
} else {
  const hookDigest = createHash("sha256").update(hookSource, "utf8").digest("hex");
  if (hookDigest !== PRE_PUSH_SHA256) {
    fail(
      ".githooks/pre-push digest is " +
        hookDigest +
        " but the pinned fence is " +
        PRE_PUSH_SHA256 +
        "; the no-push hook was modified",
    );
  } else {
    notes.push("pre-push hook matches its pinned digest");
  }
}

if (hookExecutable) {
  // Probe under a realistic hook environment. Git invokes pre-push with GIT_DIR
  // set and the remote name and URL as argv, so the probe must not accidentally
  // pass only because the hook was run bare.
  const attempt = spawnSync(hookPath, ["origin", "https://example.invalid/repo.git"], {
    cwd: REPO_ROOT,
    input: "refs/heads/main " + "0".repeat(40) + " refs/heads/main " + "0".repeat(40) + "\n",
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_DIR: join(REPO_ROOT, ".git"),
      GIT_WORK_TREE: REPO_ROOT,
      GIT_PUSH_OPTION_COUNT: "0",
    },
  });
  const output = ((attempt.stdout ?? "") + (attempt.stderr ?? "")).toLowerCase();
  if (attempt.status === 0) {
    fail(".githooks/pre-push exited zero; a push would be allowed");
  } else if (!output.includes("push denied")) {
    fail(".githooks/pre-push refused without a clear denial message");
  } else {
    notes.push("pre-push hook refuses with exit " + attempt.status);
  }
}

// --- 6. the hook path is actually active ----------------------------------

const hooksPath = git(["config", "--get", "core.hooksPath"]);
const configuredHooksPath = (hooksPath.stdout ?? "").trim();
if (configuredHooksPath !== ".githooks") {
  fail(
    "core.hooksPath is " +
      (configuredHooksPath === "" ? "<unset>" : configuredHooksPath) +
      " but must be .githooks; run: git config core.hooksPath .githooks",
  );
} else {
  notes.push("core.hooksPath is .githooks");
}

// --- 7. no remote ----------------------------------------------------------

const remotes = git(["remote"]);
const remoteList = (remotes.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
// Fail closed. P0 authorizes no remote locally. The single tolerated exception
// is a GitHub Actions checkout, which necessarily creates exactly one remote
// named origin. Any other remote, any extra remote, or the same remote outside
// GitHub Actions is a violation, not an environment quirk.
const inGithubActions = process.env.GITHUB_ACTIONS === "true";
const isExactlyOrigin = remoteList.length === 1 && remoteList[0] === "origin";
if (remoteList.length === 0) {
  notes.push("no git remote is configured");
} else if (inGithubActions && isExactlyOrigin) {
  notes.push(
    "CI EXCEPTION: exactly one remote named origin, tolerated only under GITHUB_ACTIONS",
  );
} else {
  fail(
    "P0 authorizes no remote" +
      (inGithubActions ? " other than a lone origin under GitHub Actions" : "") +
      ", found: " +
      remoteList.join(", "),
  );
}

// --- 8. no credential stores ----------------------------------------------

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const relativePath of present) {
    const basename = relativePath.split("/").pop() ?? "";
    if (FORBIDDEN_BASENAMES.has(basename)) {
      fail("forbidden credential store present in the repository: " + relativePath);
    }
    if (FORBIDDEN_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
      fail("forbidden key material present in the repository: " + relativePath);
    }
  }
}

// The credential store must also be ignored, so it can never be added later.
const ignoreCheck = git(["check-ignore", "-q", "accounts.local.json"]);
if (ignoreCheck.status !== 0) {
  fail("accounts.local.json is not ignored by .gitignore");
}

// --- 9. the native build exception is exactly one named package -----------

// P1A authorized better-sqlite3, and nothing else, to run an install-time
// build. The published tarball ships prebuilt binaries and declares no install
// script, so this entry is a fallback for a platform without a prebuild rather
// than a routine code execution path. A second name here would be a new
// authority, not a convenience.
const workspaceManifest = readIfPresent("pnpm-workspace.yaml");
if (workspaceManifest === null) {
  fail("pnpm-workspace.yaml is missing");
} else {
  const lines = workspaceManifest.split("\n");
  const anchor = lines.findIndex((line) => line.startsWith("onlyBuiltDependencies:"));
  if (anchor === -1) {
    fail("pnpm-workspace.yaml no longer declares onlyBuiltDependencies");
  } else {
    const inline = lines[anchor].slice("onlyBuiltDependencies:".length).trim();
    const entries = [];
    if (inline !== "") {
      for (const item of inline.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
        const value = item.trim().replace(/^["]|["]$/g, "");
        if (value !== "") entries.push(value);
      }
    } else {
      for (let index = anchor + 1; index < lines.length; index += 1) {
        const line = lines[index];
        const item = /^\s*-\s*(.+?)\s*$/.exec(line);
        if (item === null) {
          if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
          break;
        }
        entries.push(item[1].replace(/^["]|["]$/g, ""));
      }
    }

    if (entries.length !== 1 || entries[0] !== "better-sqlite3") {
      fail(
        "the install-time native build allow-list must be exactly [better-sqlite3], found: [" +
          entries.join(", ") +
          "]",
      );
    } else {
      notes.push("native build allow-list is exactly better-sqlite3");
    }
  }
}

// The allow-list only means anything while scripts are off by default, and a
// second allow-list in the root manifest would quietly bypass this check.
const npmrc = readIfPresent(".npmrc");
if (npmrc === null || !npmrc.includes("ignore-scripts=true")) {
  fail(".npmrc no longer disables dependency install scripts by default");
}
const rootManifest = readIfPresent("package.json");
if (rootManifest !== null && rootManifest.includes("onlyBuiltDependencies")) {
  fail("package.json declares a second install-time build allow-list");
}

// --- 10. the ledger depends on exactly what it was authorized to ----------

const LEDGER_DEPENDENCIES = ["@acp/contracts", "better-sqlite3"];
const LEDGER_DEV_DEPENDENCIES = ["@types/better-sqlite3", "vitest"];

const ledgerManifestText = readIfPresent("packages/ledger/package.json");
if (ledgerManifestText === null) {
  fail("packages/ledger/package.json is missing");
} else {
  let ledgerManifest = null;
  try {
    ledgerManifest = JSON.parse(ledgerManifestText);
  } catch {
    fail("packages/ledger/package.json is not valid JSON");
  }

  if (ledgerManifest !== null) {
    const actual = Object.keys(ledgerManifest.dependencies ?? {}).sort();
    const actualDev = Object.keys(ledgerManifest.devDependencies ?? {}).sort();
    const expected = [...LEDGER_DEPENDENCIES].sort();
    const expectedDev = [...LEDGER_DEV_DEPENDENCIES].sort();

    if (actual.join(",") !== expected.join(",")) {
      fail(
        "packages/ledger dependencies must be exactly [" +
          expected.join(", ") +
          "], found: [" +
          actual.join(", ") +
          "]",
      );
    }
    if (actualDev.join(",") !== expectedDev.join(",")) {
      fail(
        "packages/ledger devDependencies must be exactly [" +
          expectedDev.join(", ") +
          "], found: [" +
          actualDev.join(", ") +
          "]",
      );
    }
    if (ledgerManifest.private !== true) {
      fail("packages/ledger must stay private; this repository publishes nothing");
    }
    if (actual.join(",") === expected.join(",") && actualDev.join(",") === expectedDev.join(",")) {
      notes.push("ledger dependency surface is exactly what P1A authorized");
    }
  }
}

// --- 11. no product integration or cutover authority ----------------------

// The authority documents necessarily name the product repositories in order to
// forbid touching them, and this fence necessarily names them in order to search
// for them. Every other file in the repository must be silent about them: code
// that knows a product repository exists is one edit away from reaching it.
const PRODUCT_AUTHORITY_EXEMPT = new Set([
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/ROADMAP.md",
  "docs/architecture/0001-control-plane-authority.md",
  "docs/architecture/0002-sqlite-event-ledger.md",
  "scripts/check-architecture.mjs",
]);

const PRODUCT_TOKENS = [
  "modern rescue",
  "modern-rescue",
  "ui-design-system",
  "app-bithire",
  "app-evnto",
  "app-platform",
  "svc-auth",
  "dm-marketing",
  "tmux",
];

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  let scanned = 0;
  for (const relativePath of present) {
    if (PRODUCT_AUTHORITY_EXEMPT.has(relativePath)) continue;
    if (relativePath === "pnpm-lock.yaml") continue;
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    scanned += 1;
    const haystack = content.toLowerCase();
    for (const token of PRODUCT_TOKENS) {
      if (haystack.includes(token)) {
        fail(
          relativePath +
            " references the product environment (" +
            token +
            "); this repository has no product integration authority",
        );
      }
    }
  }
  notes.push(scanned + " non-authority files carry no product reference");
}

// --- 12. no credential material in any tracked file ----------------------

// The existing credential checks look at file names. This one looks at content,
// and it deliberately covers everything the write-set and the lane envelope
// allow, so a lane file gets exactly the same scrutiny as a shared one. The
// patterns are anchored on the shape of live credential material, not on the
// word "secret": a document that discusses secrets is fine, a file that carries
// one is not.
const CREDENTIAL_MATERIAL_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{16,}\b/],
  ["github fine grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["provider api key", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["json web token", /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

/**
 * The single exemption, and why it is narrow enough to be one.
 *
 * The contracts test suite proves that findCredentialViolations actually
 * rejects credential shaped values, and the only honest way to prove that is to
 * hand it credential shaped values. A scanner that failed the test asserting
 * the scanner works would force the guard's own evidence to be deleted.
 *
 * The exemption is bounded structurally rather than trusted: an exempt path
 * must be a test file AND must actually call the credential scanner. The check
 * is a call-site regex rather than a substring search: a file that merely names
 * findCredentialViolations in a comment or an import list is not exercising it,
 * and a substring match would let a file keep the exemption by mentioning the
 * function it no longer tests. A production source file can never take this
 * route at all.
 */
const CREDENTIAL_FIXTURE_EXEMPT = new Set(["packages/contracts/test/schemas/index.test.ts"]);

/** An actual invocation, not a mention. */
const CREDENTIAL_SCANNER_CALL_SITE = /\bfindCredentialViolations\s*\(/;

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  let scanned = 0;
  let laneFiles = 0;
  let exempted = 0;
  for (const relativePath of present) {
    // The lockfile is generated and carries integrity digests, not credentials.
    if (relativePath === "pnpm-lock.yaml") continue;
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    scanned += 1;
    if (P1B_LANE_ENVELOPES.some((prefix) => relativePath.startsWith(prefix))) {
      laneFiles += 1;
    }
    if (CREDENTIAL_FIXTURE_EXEMPT.has(relativePath)) {
      if (!relativePath.endsWith(".test.ts")) {
        fail(
          relativePath +
            " claims the credential fixture exemption but is not a test file",
        );
      } else if (!CREDENTIAL_SCANNER_CALL_SITE.test(content)) {
        fail(
          relativePath +
            " claims the credential fixture exemption but no longer exercises the credential scanner",
        );
      } else {
        exempted += 1;
      }
      continue;
    }
    for (const [name, pattern] of CREDENTIAL_MATERIAL_PATTERNS) {
      if (pattern.test(content)) {
        fail(relativePath + " carries credential material (" + name + ")");
      }
    }
  }
  notes.push(
    scanned -
      exempted +
      " files carry no credential material, including " +
      laneFiles +
      " under the lane prefixes; " +
      exempted +
      " guard-fixture exemption(s) verified",
  );
}

// --- 13. the P1B packages depend on exactly what they were authorized to --

// P1B exists to settle the dependency direction before three lanes run in
// parallel. Settling it in prose would be worth nothing: a lane that needs one
// more package would simply add it. Asserting the exact sets here means a lane
// cannot widen its own dependency surface without an integrator edit to this
// file, which is the whole point of pinning the foundation first.
const P1B_DEPENDENCY_LAW = [
  {
    manifest: "packages/api-contracts/package.json",
    dependencies: ["@acp/contracts", "zod"],
    devDependencies: ["vitest"],
    // The observation contract is the package the browser links. It may never
    // reach the ledger or a database driver, not even transitively by name.
    forbidden: ["@acp/ledger", "better-sqlite3"],
  },
  {
    manifest: "packages/cli/package.json",
    dependencies: ["@acp/api-contracts", "@acp/ledger"],
    devDependencies: ["vitest"],
    forbidden: ["better-sqlite3"],
  },
  {
    manifest: "packages/server/package.json",
    // P8-8A: `@acp/observation` joins the surface so the initiative plane can
    // fold token rollups. The direction is the lawful one — the server reads
    // the observation plane's pure folds; nothing in observation knows a
    // server exists — and the edge is declared everywhere it has to be: the
    // manifest, this law, the lockfile and the project reference.
    // P8-8F: `@acp/accounts` joins the surface so the plane can read the
    // owner's accounts with quota and reset confidence. Same lawful direction
    // as observation's — the server consumes the pure, clock-injected accounts
    // domain, and nothing in accounts names a server, transitively or
    // otherwise. Five declaration sites, all in this packet's write-set: the
    // manifest, this law, the lockfile, and both project references.
    dependencies: ["@acp/accounts", "@acp/api-contracts", "@acp/ledger", "@acp/observation", "fastify"],
    devDependencies: ["vitest"],
    forbidden: ["better-sqlite3"],
  },
  {
    manifest: "packages/ui/package.json",
    // P8-8B adds exactly two runtime dependencies, each with a use site in
    // this packet: `@tanstack/react-query` (the cache the app root owns) and
    // `@radix-ui/react-navigation-menu` (the shell's primary navigation).
    // Deferred adoption, not all-at-once: TanStack Table, TanStack Virtual,
    // @xyflow/react, Recharts and dnd-kit each have a named cohort and none is
    // in this graph.
    //
    // P8-8C adds exactly one more, the blueprint's own adjudicated primitive:
    // `@radix-ui/react-dropdown-menu` (the initiative switcher).
    //
    // P8-8D adds exactly one more again: `@radix-ui/react-dialog` (the
    // roadmap edit dialog, C6).
    //
    // P8-8E adds the deferred `@xyflow/react` named above: the task graph's
    // canvas (C6), mounted behind a client-only seam. `d3-*` and `zustand`
    // are transitive (its own graph), not a second manifest entry.
    dependencies: [
      "@acp/api-contracts",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-navigation-menu",
      "@tanstack/react-query",
      "@xyflow/react",
      "react",
      "react-dom",
    ],
    devDependencies: [
      "@types/react",
      "@types/react-dom",
      "@vitejs/plugin-react",
      "vite",
      "vitest",
    ],
    forbidden: ["@acp/ledger", "@acp/contracts", "better-sqlite3", "sqlite3", "node:sqlite"],
  },
  {
    manifest: "packages/runtime/package.json",
    // P8-W adds `@acp/accounts`: the switch executor plays a plan the accounts
    // module produced. The direction is the one this file already states --
    // runtime consumes accounts, never the reverse -- and the accounts entry
    // below still forbids `@acp/runtime` by name, so the cycle stays refused.
    dependencies: ["@acp/accounts", "@acp/contracts", "@acp/ledger", "@restatedev/restate-sdk"],
    devDependencies: ["vitest"],
    // The server package pulls @scarf/scarf, whose postinstall is a network
    // beacon. The 1.7.7 server is an external pinned binary, never a dependency.
    forbidden: ["@restatedev/restate-server", "@scarf/scarf", "@restatedev/restate"],
  },
  {
    manifest: "packages/accounts/package.json",
    // The ledger is a read-only dependency: P5D reads quota observations from
    // the event log, and the `.append(` scan below asserts that no production
    // source in the package ever writes one. `@acp/runtime` is forbidden by
    // name because the dependency direction runs the other way — runtime
    // consumes accounts in P6, never the reverse — and a cycle is far easier to
    // refuse here than to unpick later.
    dependencies: ["@acp/contracts", "@acp/ledger"],
    devDependencies: ["vitest"],
    forbidden: [
      "@acp/runtime",
      "@acp/daemon",
      "@acp/adapters",
      "@acp/api-contracts",
      "@restatedev/restate-sdk",
      "better-sqlite3",
      "node:sqlite",
    ],
  },
  {
    manifest: "packages/adapters/package.json",
    // The adapters are pure producers of normalized events. They never open,
    // append to or even name a ledger, which is what keeps the provider
    // boundary from acquiring an authority it has no business holding.
    dependencies: ["@acp/contracts"],
    devDependencies: ["vitest"],
    forbidden: ["@acp/ledger", "better-sqlite3", "node:sqlite", "@acp/api-contracts"],
  },
];

for (const law of P1B_DEPENDENCY_LAW) {
  const text = readIfPresent(law.manifest);
  if (text === null) {
    fail("required manifest is missing: " + law.manifest);
    continue;
  }

  let manifest = null;
  try {
    manifest = JSON.parse(text);
  } catch {
    fail(law.manifest + " is not valid JSON");
  }
  if (manifest === null) continue;

  const actual = Object.keys(manifest.dependencies ?? {}).sort();
  const actualDev = Object.keys(manifest.devDependencies ?? {}).sort();
  const expected = [...law.dependencies].sort();
  const expectedDev = [...law.devDependencies].sort();

  if (actual.join(",") !== expected.join(",")) {
    fail(
      law.manifest +
        " dependencies must be exactly [" +
        expected.join(", ") +
        "], found: [" +
        actual.join(", ") +
        "]",
    );
  }
  if (actualDev.join(",") !== expectedDev.join(",")) {
    fail(
      law.manifest +
        " devDependencies must be exactly [" +
        expectedDev.join(", ") +
        "], found: [" +
        actualDev.join(", ") +
        "]",
    );
  }
  if (manifest.private !== true) {
    fail(law.manifest + " must stay private; this repository publishes nothing");
  }

  // Name based, over the whole manifest text, so a forbidden package cannot be
  // reintroduced through peerDependencies, optionalDependencies or an override.
  for (const name of law.forbidden) {
    if (text.includes('"' + name + '"')) {
      fail(law.manifest + " names the forbidden dependency " + name);
    }
  }
}
notes.push(P1B_DEPENDENCY_LAW.length + " package dependency surfaces are exact");

// --- 14. the browser package links no ledger and no database driver -------

// The manifest check above is necessary but not sufficient: an import can name
// a package the manifest does not declare, and pnpm's node_modules layout would
// still resolve it in some configurations. The source is checked directly.
const UI_FORBIDDEN_IMPORTS = [
  "@acp/ledger",
  "better-sqlite3",
  "node:sqlite",
  "sqlite3",
];

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const uiFiles = present.filter((relativePath) => relativePath.startsWith("packages/ui/"));
  if (uiFiles.length === 0) {
    fail("packages/ui has no tracked files; the browser purity check is inert");
  }
  for (const relativePath of uiFiles) {
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    for (const name of UI_FORBIDDEN_IMPORTS) {
      if (content.includes(name)) {
        fail(
          relativePath +
            " references " +
            name +
            "; the browser package may depend on @acp/api-contracts only",
        );
      }
    }
  }
  notes.push(
    uiFiles.length + " browser package files name no ledger and no database driver",
  );
}

// --- report ----------------------------------------------------------------

// --- 15. P2A durability plane invariants ---------------------------------

// The local working root must be ignored before anything is allowed to write
// into it. Tools, drill databases, pid and log files all land there, and none
// of it is evidence.
const localRootIgnored = git(["check-ignore", "-q", ".acp-local/probe"]);
if (localRootIgnored.status !== 0) {
  fail(".acp-local/ is not ignored by .gitignore");
} else {
  notes.push(".acp-local/ is ignored");
}

// The SDK is pinned exactly. A range here would let a replay-determinism fix in
// a patch release arrive unreviewed, which is precisely the class of change
// this phase cannot absorb silently.
const workspaceText = readIfPresent("pnpm-workspace.yaml");
if (workspaceText === null || !workspaceText.includes('"@restatedev/restate-sdk": 1.16.9')) {
  fail("pnpm-workspace.yaml no longer pins @restatedev/restate-sdk at exactly 1.16.9");
} else {
  notes.push("restate sdk pinned exactly at 1.16.9");
}

// The Restate server and its telemetry dependency must never enter the graph.
// The server is an external pinned binary under .acp-local/tools/, acquired by
// an explicit operator command with a checksum, never by an install hook.
const lockText = readIfPresent("pnpm-lock.yaml");
if (lockText === null) {
  fail("pnpm-lock.yaml is missing");
} else {
  for (const forbidden of ["@scarf/scarf", "@restatedev/restate-server"]) {
    if (lockText.includes(forbidden)) {
      fail("pnpm-lock.yaml contains " + forbidden + ", which may never enter this graph");
    }
  }
  notes.push("lockfile carries no restate server and no install-time telemetry");
}

// What the durability plane may import.
//
// The list is the cheapest honest proof of what this package can do at all: a
// module that cannot import a socket API cannot open a socket, whatever its
// prose says it intends. Production sources get the narrow list; tests get two
// more, because a kill/restart drill has to spawn and kill a real process, and
// an in-process exception would prove nothing about durability.
const RUNTIME_ALLOWED_PACKAGES = new Set([
  // P8-W: the switch executor plays a plan `@acp/accounts` produced, so the
  // runtime may now name it. This is the import-level face of the same law the
  // P1B dependency table states at the manifest level, and both had to move
  // together -- a manifest edge the import scan still refuses is a dependency
  // that exists on paper and fails at the gate.
  "@acp/accounts",
  "@acp/contracts",
  "@acp/ledger",
  "@restatedev/restate-sdk",
]);
const RUNTIME_ALLOWED_BUILTINS = new Set(["node:crypto", "node:fs", "node:path", "node:url"]);
const RUNTIME_TEST_ONLY_IMPORTS = new Set([
  "vitest",
  "node:child_process",
  "node:os",
  "node:timers/promises",
]);

/**
 * The one file allowed to open a listener, and the one builtin that can.
 *
 * P2 used to add no network surface at all. P2C changes that by design: the ADR
 * pins three loopback ports, and something has to bind one of them. Rather than
 * relax the ban repository-wide, the allowance is scoped to a single file, and
 * the two checks below make that file prove it binds loopback.
 */
const HTTP2_ALLOWED_FILE = "packages/runtime/src/drivers/restate-endpoint/index.ts";

/**
 * The only two production files that may start a subprocess, by exact path and
 * stated purpose.
 *
 * Through P2C the server handle was classified test-only, because a production
 * module that spawned a process would have been a daemon and P2D was not
 * authorised. P2D authorises it, so the classification is replaced rather than
 * merely deleted: the allowance is still file-scoped, still two entries long,
 * and each entry is separately checked for the properties that make it safe.
 *
 * Duplicating either spawner elsewhere is the thing being prevented. Two
 * spawners drift, and the drift is discovered only when they disagree about how
 * to stop something.
 */
const SPAWN_ALLOWED_FILES = new Map([
  ["packages/runtime/src/restate/server-handle/index.ts", "the pinned Restate server"],
  ["packages/daemon/src/identity-probe/index.ts", "reading process identity via /bin/ps"],
  ["packages/adapters/src/process/spawn/index.ts", "the single provider spawn authority"],
]);

// Anything that could listen, connect or fan out. None of these belongs in a
// local durability plane, and P2 adds no network surface of any kind.
const RUNTIME_FORBIDDEN_BUILTINS = [
  "node:net",
  "node:http",
  "node:https",
  "node:tls",
  "node:dgram",
  "node:dns",
  "node:cluster",
  "node:worker_threads",
  "node:sqlite",
];

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const runtimeSources = present.filter(
    (relativePath) =>
      (relativePath.startsWith("packages/runtime/src/") ||
      relativePath.startsWith("packages/runtime/test/")) &&
    relativePath.endsWith(".ts"),
  );
  if (runtimeSources.length === 0) {
    fail("packages/runtime/src has no tracked sources; the import purity check is inert");
  }

  let productionSources = 0;
  const specifier = /(?:^|[\s({])(?:import|export)[^\n;]*?from\s*["']([^"']+)["']/g;
  for (const relativePath of runtimeSources) {
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    const isTest = relativePath.endsWith(".test.ts");
    if (!isTest) productionSources += 1;

    let match = specifier.exec(content);
    while (match !== null) {
      const name = match[1] ?? "";
      const relative = name.startsWith("./") || name.startsWith("../");
      // File-scoped, not repository-wide: exactly one file may open a listener,
      // and exactly one module may spawn the external server.
      const http2Here = name === "node:http2" && relativePath === HTTP2_ALLOWED_FILE;
      const spawnHere = name === "node:child_process" && SPAWN_ALLOWED_FILES.has(relativePath);
      const allowed =
        relative ||
        RUNTIME_ALLOWED_PACKAGES.has(name) ||
        RUNTIME_ALLOWED_BUILTINS.has(name) ||
        http2Here ||
        spawnHere ||
        (isTest && RUNTIME_TEST_ONLY_IMPORTS.has(name));

      if (!allowed) {
        fail(
          relativePath +
            " imports " +
            name +
            "; the durability plane may import only its own modules, the workspace" +
            " contracts and ledger, the Restate SDK, and a named set of node builtins",
        );
      }
      if (RUNTIME_FORBIDDEN_BUILTINS.includes(name)) {
        fail(
          relativePath +
            " imports " +
            name +
            "; the durability plane opens no socket and speaks to no network",
        );
      }
      if (name === "node:http2" && !http2Here) {
        fail(
          relativePath +
            " imports node:http2; only " +
            HTTP2_ALLOWED_FILE +
            " may open a listener, and the fence says so by name",
        );
      }
      match = specifier.exec(content);
    }
  }

  // A production source that spawned a process would be a daemon, which is P2D
  // and is not authorised yet.
  for (const relativePath of runtimeSources) {
    if (relativePath.endsWith(".test.ts")) continue;
    // The two purpose-bound spawn sites are exempt; section 17 checks each of
    // them for the properties that make the allowance safe.
    if (SPAWN_ALLOWED_FILES.has(relativePath)) continue;
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    if (/from\s+["']node:child_process["']/.test(content)) {
      fail(relativePath + " spawns a process; only the two allow-listed sites may do that");
    }
  }

  notes.push(
    runtimeSources.length +
      " runtime sources import only what the durability plane is allowed (" +
      productionSources +
      " production, no network, no process spawn outside drills)",
  );
}

// launchd is last, and never automatic. A template may exist and be linted; an
// automated load would make a phase that has run no drills start a daemon.
const LAUNCHCTL_EXEMPT = new Set([
  "docs/architecture/0004-durability-and-supervisor.md",
  "scripts/check-architecture.mjs",
  // Prose only. The comment used to say "no code is exempt" while a test file
  // sat on this list, which is the kind of exemption that quietly becomes the
  // rule. Code constructs the token from pieces instead of being excused.
  "packages/daemon/launchd/README.md",
  "docs/architecture/0007-launchd-template-and-p2-closure.md",
  "docs/architecture/0008-packaged-entry-and-launchd-lifecycle.md",
]);

/**
 * The one file that may drive launchd, and the only verbs it may use.
 *
 * P2F replaces the blanket ban, which was a placeholder from a phase with
 * nothing to start. The verbs that persist a job — load, unload, enable,
 * disable — stay forbidden everywhere, including here. The four permitted verbs
 * are the ones a disposable lifecycle needs and no more.
 */
const LAUNCH_DRILL_FILE = "packages/daemon/test/launchd/lifecycle/index.test.ts";
const LAUNCH_PERMITTED_VERBS = ["bootstrap", "kickstart", "print", "bootout"];
const LAUNCH_FORBIDDEN_VERBS = ["load", "unload", "enable", "disable"];
const DRILL_LABEL_PREFIX = "com.rottay.acp-drill-";
if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const relativePath of present) {
    if (LAUNCHCTL_EXEMPT.has(relativePath)) continue;
    if (relativePath === "pnpm-lock.yaml") continue;
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    // Two checks, because the first one alone had a blind spot. The
    // whitespace-shaped pattern only ever matched prose-like text, so any code
    // that built the command differently would have passed. In non-prose files
    // the bare token is refused outright, after comments are stripped: a source
    // file has no legitimate reason to contain it, and a drill that needs it can
    // assemble it from pieces.
    const code = stripComments(content);

    // The persisting verbs are refused everywhere, in every file, including the
    // drill. These are the ones that would leave a job behind.
    for (const verb of LAUNCH_FORBIDDEN_VERBS) {
      if (new RegExp("launchctl\\s+" + verb).test(content)) {
        fail(relativePath + " uses launchctl " + verb + ", which persists a job");
      }
      if (relativePath === LAUNCH_DRILL_FILE && new RegExp('"' + verb + '"').test(code)) {
        fail(LAUNCH_DRILL_FILE + " names the persisting verb " + verb);
      }
    }

    if (relativePath.endsWith(".md")) continue;
    if (!code.includes("launchctl")) continue;

    // Exactly one file may drive launchd. Everything else builds the token from
    // pieces or does not mention it.
    if (relativePath !== LAUNCH_DRILL_FILE) {
      fail(relativePath + " names launchctl in code; only the lifecycle drill may drive launchd");
      continue;
    }
    // And it may target only a disposable label: a drill that could act on the
    // tracked template's own label would be an installation, not a drill.
    if (!code.includes(DRILL_LABEL_PREFIX)) {
      fail(LAUNCH_DRILL_FILE + " must target only the disposable " + DRILL_LABEL_PREFIX + " label");
    }
    for (const verb of LAUNCH_PERMITTED_VERBS) {
      if (!new RegExp('"' + verb + '"').test(code)) {
        fail(LAUNCH_DRILL_FILE + " no longer uses the permitted verb " + verb);
      }
    }
    // Bootout must be unconditional on every path out of the lifecycle.
    if (!/finally\s*\{[\s\S]*?bootout/.test(code)) {
      fail(LAUNCH_DRILL_FILE + " must boot the job out in a finally block");
    }
  }
  notes.push("no file invokes launchctl load or bootstrap");
}

// --- 16. P2C: the one listener, the one spawner, the one pin --------------

// The endpoint must prove it binds loopback, and must not reach for the SDK
// helpers that cannot. `NodeEndpoint.listen(port)` binds every interface, so a
// bare `serve(` or a numeric `.listen(` here would silently undo the ADR's pin.
// Made unrepeatable by the fence rather than remembered by a reviewer.
const endpointSource = readIfPresent(HTTP2_ALLOWED_FILE);
if (endpointSource === null) {
  fail("the endpoint file is missing: " + HTTP2_ALLOWED_FILE);
} else {
  // Comments are stripped first: this file necessarily NAMES the forbidden
  // helpers in order to explain why it does not use them, and a check that
  // cannot tell code from prose would fail on its own documentation.
  const endpointCode = endpointSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  if (!endpointCode.includes("host: LOOPBACK_HOST")) {
    fail(HTTP2_ALLOWED_FILE + " does not pin the listener to LOOPBACK_HOST");
  }
  if (/\bserve\s*\(/.test(endpointCode)) {
    fail(HTTP2_ALLOWED_FILE + " calls serve(), which cannot bind loopback");
  }
  if (/\.listen\s*\(\s*\d/.test(endpointCode)) {
    fail(HTTP2_ALLOWED_FILE + " calls listen(<number>), which binds every interface");
  }
  notes.push("the endpoint pins loopback and calls neither serve() nor a numeric listen");
}

// --- 17. P2D: the promoted server handle and the daemon package -------------

/**
 * Strip comments before analysing code.
 *
 * The files checked below necessarily NAME the things they must not do, in
 * order to explain why they do not do them. A check that cannot tell code from
 * prose fails on its own documentation, which P2C already learned once.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
//
// Through P2C no production module could reach the server handle at all. P2D
// lifts that so the daemon can start the pinned server without a second
// spawner, and pays for it here: the promotion is only safe while the public
// surface stays narrow, so each narrowing is asserted rather than described.
const SERVER_HANDLE_FILE = "packages/runtime/src/restate/server-handle/index.ts";
const serverHandleCode = stripComments(readIfPresent(SERVER_HANDLE_FILE) ?? "");
if (serverHandleCode === "") {
  fail(SERVER_HANDLE_FILE + " is missing");
} else {
  // A string root would let any caller name a directory, which is the toy
  // boundary P2B closed. Public, that would hand out a path-named spawner.
  for (const entry of ["writeServerConfig", "startServer", "startVerifiedServer"]) {
    const signature = new RegExp(entry + "\\s*\\([^)]*scenarioRoot:\\s*ScenarioRoot");
    if (!signature.test(serverHandleCode)) {
      fail(SERVER_HANDLE_FILE + ": " + entry + " must take a ScenarioRoot, never a string");
    }
  }
  // The public handle must expose neither the child nor the absolute data root.
  const safeBlock = /export interface SafeServerHandle\s*\{([\s\S]*?)\}/.exec(serverHandleCode);
  if (safeBlock === null) {
    fail(SERVER_HANDLE_FILE + " no longer declares SafeServerHandle");
  } else {
    const body = safeBlock[1] ?? "";
    if (/\bchild\b/.test(body)) {
      fail("SafeServerHandle exposes the raw child; a caller could signal it out of band");
    }
    if (/\bdataRoot\b/.test(body)) {
      fail("SafeServerHandle exposes dataRoot, which is an absolute path");
    }
  }
  notes.push("the promoted server lifecycle keeps its narrow public shape");
}

// The package entry point exports only the safe pair.
const runtimeIndex = stripComments(readIfPresent("packages/runtime/src/index.ts") ?? "");
if (runtimeIndex !== "") {
  if (/export\s*\{[^}]*\bstartServer\b/.test(runtimeIndex)) {
    fail("packages/runtime/src/index.ts exports startServer; only startVerifiedServer may leave");
  }
  if (/export\s+type\s*\{[^}]*\bServerHandle\b(?!\s*as)/.test(runtimeIndex.replace(/SafeServerHandle/g, "Safe"))) {
    fail("packages/runtime/src/index.ts exports the internal ServerHandle type");
  }
  notes.push("the runtime entry point exports only the narrowed server lifecycle");
}

// The identity probe: an absolute binary, fixed argv, no shell, bounded.
const PROBE_FILE = "packages/daemon/src/identity-probe/index.ts";
const probeCode = stripComments(readIfPresent(PROBE_FILE) ?? "");
if (probeCode === "") {
  fail(PROBE_FILE + " is missing");
} else {
  if (!/execFile\s*\(/.test(probeCode)) fail(PROBE_FILE + " must use execFile");
  // Not `\bexec\(`: that also matches `pattern.exec(...)`, which is a regular
  // expression method and has nothing to do with a shell.
  if (/(^|[^.\w])exec\s*\(/.test(probeCode)) {
    fail(PROBE_FILE + " must not use exec(), which runs a shell");
  }
  if (/shell\s*:/.test(probeCode)) fail(PROBE_FILE + " must not pass a shell option");
  if (!/"\/bin\/ps"/.test(probeCode + (readIfPresent("packages/daemon/src/constants/index.ts") ?? ""))) {
    fail(PROBE_FILE + " must invoke an absolute /bin/ps so PATH cannot choose the program");
  }
  if (!/LC_ALL/.test(probeCode)) fail(PROBE_FILE + " must pin LC_ALL=C for a stable date format");
  if (!/timeout\s*:/.test(probeCode)) fail(PROBE_FILE + " must bound the probe in time");
  if (!/maxBuffer\s*:/.test(probeCode)) fail(PROBE_FILE + " must bound the probe's output");
  notes.push("the identity probe is absolute, shell-free and bounded");
}

// The daemon package: no bin, no deep imports, no network, no status in the
// decision path.
if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const daemonSources = present.filter(
    (relativePath) =>
      (relativePath.startsWith("packages/daemon/src/") ||
      relativePath.startsWith("packages/daemon/test/")) &&
    relativePath.endsWith(".ts"),
  );

  const manifest = readIfPresent("packages/daemon/package.json");
  if (manifest === null) {
    fail("packages/daemon/package.json is missing");
  } else {
    const parsed = JSON.parse(manifest);
    // P2F replaces the blanket ban with an exact one. The ban was a
    // repository-internal placeholder from P2D, adopted when there was no
    // executable and no drill that needed to start one; it was never the
    // owner's law, which is about product adoption and is untouched. Exactly
    // one bin is permitted, by name and by target.
    const bin = parsed.bin;
    const EXPECTED_BIN = { "acp-daemon": "./dist/bin/acp-daemon/index.js" };
    if (bin === undefined) {
      fail("packages/daemon must declare its one packaged entry");
    } else if (
      typeof bin !== "object" ||
      bin === null ||
      Object.keys(bin).length !== 1 ||
      bin["acp-daemon"] !== EXPECTED_BIN["acp-daemon"]
    ) {
      fail(
        "packages/daemon may declare exactly one bin, acp-daemon -> " +
          EXPECTED_BIN["acp-daemon"],
      );
    }
    // The entry must exist as tracked source, carry the portable shebang, and
    // be made executable by the build. A bin pointing at nothing is a claim.
    const entrySource = readIfPresent("packages/daemon/src/bin/acp-daemon/index.ts");
    if (entrySource === null) {
      fail("packages/daemon/src/bin/acp-daemon/index.ts is missing");
    } else if (entrySource.split("\n")[0] !== "#!/usr/bin/env node") {
      fail("the packaged entry must keep the portable shebang in tracked source");
    }
    const buildScript = String(parsed.scripts?.build ?? "");
    if (!buildScript.includes("chmod") || !buildScript.includes("process.execPath")) {
      fail(
        "packages/daemon build must materialize the interpreter and set the executable bit; " +
          "a launchd gui job runs with PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      );
    }
    // Fable B2: the dependency surface is exact in both directions.
    const deps = Object.keys(parsed.dependencies ?? {}).sort();
    const devDeps = Object.keys(parsed.devDependencies ?? {}).sort();
    const expected = ["@acp/contracts", "@acp/ledger", "@acp/runtime"];
    if (deps.join(",") !== expected.join(",")) {
      fail("packages/daemon dependencies must be exactly " + expected.join(", "));
    }
    if (devDeps.join(",") !== "vitest") {
      fail("packages/daemon devDependencies must be exactly vitest");
    }
    for (const forbidden of ["better-sqlite3", "@restatedev/restate-sdk"]) {
      if (deps.includes(forbidden)) {
        fail("packages/daemon must not depend on " + forbidden + " directly");
      }
    }
    // Corrected in Stage B. This note still said "declares no bin" after P2F
    // Stage A began requiring exactly one — non-functional, since it is only a
    // note, but false, and a green line that says the opposite of what the
    // check enforces is precisely how an untrue claim survives review.
    notes.push("the daemon manifest declares the one exact bin and an exact dependency surface");
  }

  const DAEMON_ALLOWED_PACKAGES = new Set(["@acp/contracts", "@acp/ledger", "@acp/runtime"]);
  const DAEMON_ALLOWED_BUILTINS = new Set(["node:crypto", "node:fs", "node:path", "node:url"]);
  const DAEMON_TEST_ONLY_IMPORTS = new Set(["vitest", "node:child_process", "node:os"]);

  for (const relativePath of daemonSources) {
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    const isTest = relativePath.endsWith(".test.ts");

    // Deep imports would let the daemon reach past the runtime's public surface
    // and undo every narrowing the promotion above depends on.
    if (/@acp\/runtime\/(src|dist)/.test(content)) {
      fail(relativePath + " deep-imports @acp/runtime; only its public entry point is allowed");
    }

    const pattern = /(?:^|[\s({])(?:import|export)[^\n;]*?from\s*["']([^"']+)["']/g;
    let match = pattern.exec(content);
    while (match !== null) {
      const name = match[1] ?? "";
      const relative = name.startsWith("./") || name.startsWith("../");
      const spawnHere = name === "node:child_process" && SPAWN_ALLOWED_FILES.has(relativePath);
      const allowed =
        relative ||
        DAEMON_ALLOWED_PACKAGES.has(name) ||
        DAEMON_ALLOWED_BUILTINS.has(name) ||
        spawnHere ||
        (isTest && DAEMON_TEST_ONLY_IMPORTS.has(name));
      if (!allowed) {
        fail(relativePath + " imports " + name + ", which the daemon may not use");
      }
      if (RUNTIME_FORBIDDEN_BUILTINS.includes(name)) {
        fail(relativePath + " imports " + name + "; the daemon opens no network surface");
      }
      match = pattern.exec(content);
    }
  }

  // The status document is an observation. The moment a decision reads it, it
  // becomes a second authority that can disagree with the ledger.
  for (const decisionPath of [
    "packages/daemon/src/lifecycle/index.ts",
    "packages/daemon/src/singleton/index.ts",
    "packages/daemon/src/mode-sqlite/index.ts",
    "packages/daemon/src/mode-restate/index.ts",
  ]) {
    const content = readIfPresent(decisionPath);
    if (content !== null && /from\s+["']\.\.\/status\/index\.js["']/.test(content)) {
      fail(decisionPath + " imports the status observation; lifecycle decisions may not read it");
    }
  }

  // The child entry runs only when executed, never on import.
  const childCode = readIfPresent("packages/daemon/src/daemon-child/index.ts");
  if (childCode !== null && !/process\.argv\[1\]/.test(childCode)) {
    fail("packages/daemon/src/daemon-child/index.ts must guard its entry point on process.argv[1]");
  }

  // The public surface is closed, and stays closed.
  //
  // The first version of this entry point re-exported the root brand and its
  // resolver, the logger, signal installation, the identity inspector, the
  // unwind stack and every constant: a second wide surface around exactly the
  // boundaries this package exists to draw. A consumer handed
  // `resolveDaemonRoot` and `installSignalHandlers` can assemble a second
  // daemon beside this one, and then the singleton means nothing.
  /**
   * The launchd surface, pinned as an exact set.
   *
   * Every name here must be exported, and every launchd name exported must be
   * here. Equality in both directions is the point: it catches a withdrawn
   * internal coming back, which membership alone cannot.
   */
  const LAUNCHD_PUBLIC_EXPORTS = [
    "renderLaunchAgent",
    "writeLaunchAgent",
    "validateTemplate",
    "validatePlist",
    "LaunchAgentValues",
    "LaunchdRefusal",
    "LaunchdVerdict",
  ];

  const DAEMON_PUBLIC_EXPORTS = new Set([
    // lifecycle
    "startDaemon",
    "stopDaemon",
    "terminateDaemon",
    "DaemonOptions",
    "DaemonRun",
    "StopResult",
    "DaemonMode",
    // observation and recovery
    "readOwnStatus",
    "recoverOwnStaleLock",
    "DaemonPhase",
    "DaemonStatusDocument",
    "RecoveryResult",
    "IdentityVerdict",
    // the classified failure contract
    "DaemonErrorCode",
    "DaemonError",
    "DaemonRootError",
    "IdentityProbeError",
    "ModeError",
    "ShutdownError",
    "SingletonError",
    "StaleLockError",
    "StartupError",
    "SupervisionError",
    // P2E: the launchd rendering and validation surface, exactly seven names.
    // A rendering surface, not an adoption API: nothing here installs, loads,
    // copies or schedules anything.
    //
    // These seven are pinned by EQUALITY below, not merely allowed. An earlier
    // version of this list still authorised eight internals that C3 had already
    // withdrawn from the entry point, so each of them could have been silently
    // re-exported with the fence green — an allow-list is an upper bound, and an
    // upper bound cannot detect a surface growing back to it.
    ...LAUNCHD_PUBLIC_EXPORTS,
  ]);

  const indexCode = readIfPresent("packages/daemon/src/index.ts");
  if (indexCode === null) {
    fail("packages/daemon/src/index.ts is missing");
  } else {
    if (/export\s*\*\s*from/.test(indexCode)) {
      fail("packages/daemon/src/index.ts uses `export *`, which cannot stay closed");
    }
    const exported = new Set();
    // Named re-export and export blocks.
    const blocks = indexCode.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g);
    for (const block of blocks) {
      for (const piece of (block[1] ?? "").split(",")) {
        const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
        if (name !== undefined && name !== "") exported.add(name);
      }
    }
    // Direct declarations.
    const declared = indexCode.matchAll(
      /export\s+(?:async\s+)?(?:function|interface|class|const|type)\s+([A-Za-z0-9_$]+)/g,
    );
    for (const item of declared) exported.add(item[1]);

    for (const name of exported) {
      if (!DAEMON_PUBLIC_EXPORTS.has(name)) {
        fail("packages/daemon exports " + name + ", which is outside its closed public surface");
      }
    }

    // Equality for the launchd subset, in both directions. Membership alone is
    // an upper bound: it fails a name nobody authorised, and says nothing about
    // an authorised name quietly returning to the entry point. Both halves are
    // needed, and both are cheap.
    const launchdExported = LAUNCHD_PUBLIC_EXPORTS.filter((name) => exported.has(name));
    if (launchdExported.length !== LAUNCHD_PUBLIC_EXPORTS.length) {
      const missing = LAUNCHD_PUBLIC_EXPORTS.filter((name) => !exported.has(name));
      fail("packages/daemon no longer exports pinned launchd name(s): " + missing.join(", "));
    }
    const LAUNCHD_WITHDRAWN = [
      "PlistValue",
      "KNOWN_KEYS",
      "FORBIDDEN_KEYS",
      "placeholdersIn",
      "checkValues",
      "checkReferencedPaths",
      "parseFixedPlist",
      "readValues",
      "writeLaunchAgentAt",
    ];
    for (const name of LAUNCHD_WITHDRAWN) {
      if (exported.has(name)) {
        fail(
          "packages/daemon re-exports " +
            name +
            ", which C3 withdrew from the public surface; tests import it by relative path",
        );
      }
    }
    notes.push(
      exported.size +
        " daemon exports, all inside the closed public surface; the launchd subset is pinned by equality",
    );
  }

  notes.push(
    daemonSources.length + " daemon sources import only what a supervised process is allowed",
  );
}

// --- 18. P2E: the template is inert, and adoption is impossible from here ---

const TEMPLATE_PATH = "packages/daemon/launchd/com.rottay.agent-control-plane.plist.template";
const templateSource = readIfPresent(TEMPLATE_PATH);
if (templateSource === null) {
  fail("the launchd template is missing: " + TEMPLATE_PATH);
} else {
  // Path neutral: nothing in a tracked artifact may tie it to one machine.
  for (const literal of ["/Users/", "$HOME", "~/", "LaunchAgents", "/private/var/root"]) {
    if (templateSource.includes(literal)) {
      fail("the launchd template names " + literal + ", which ties it to one machine");
    }
  }
  // Inert on its face: present and false, not merely absent and defaulted.
  for (const key of ["RunAtLoad", "KeepAlive"]) {
    const inert = new RegExp("<key>" + key + "</key>\\s*<false/>");
    if (!inert.test(templateSource)) {
      fail("the launchd template must declare " + key + " explicitly false");
    }
  }
  for (const key of [
    "StartInterval",
    "StartCalendarInterval",
    "WatchPaths",
    "QueueDirectories",
    "StartOnMount",
    "Sockets",
    "MachServices",
    "inetdCompatibility",
  ]) {
    if (templateSource.includes(key)) {
      fail("the launchd template carries " + key + ", which would start the daemon on its own");
    }
  }
  notes.push("the launchd template is path-neutral and inert on its face");
}

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);

  // The two-spawn-site law is unchanged by P2E. `plutil` runs in the drills,
  // where node:child_process is already a test-only import, and never in a
  // production module: a lint is not a reason to add a third spawner.
  for (const relativePath of present) {
    if (!relativePath.startsWith("packages/daemon/src/launchd/")) continue;
    if (relativePath.endsWith(".test.ts")) continue;
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    if (/from\s+["']node:child_process["']/.test(content)) {
      fail(relativePath + " spawns a process; plutil belongs in the drills, not in production");
    }
  }

  // Nothing anywhere may write into the user's launch agent directory. Prose
  // may name it; code may not — and that now includes test code, which used to
  // be skipped wholesale. A drill that needs the token assembles it.
  //
  // `validate.ts` is not blanket-exempt either. It carries the string exactly
  // once, as a denylist entry, and the allowance is written that narrowly: the
  // single permitted line, plus a check that the file has acquired no Node
  // import at all, so the exemption cannot become cover for a module that grew
  // filesystem or process access.
  const DENYLIST_FILE = "packages/daemon/src/launchd/validate/index.ts";
  const AGENT_DIR_TOKEN = ["Launch", "Agents"].join("");
  for (const relativePath of present) {
    if (relativePath.endsWith(".md")) continue;
    if (relativePath === "scripts/check-architecture.mjs") continue;
    if (relativePath === "pnpm-lock.yaml") continue;
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    const code = stripComments(content);
    if (!code.includes(AGENT_DIR_TOKEN)) continue;

    if (relativePath !== DENYLIST_FILE) {
      fail(relativePath + " names the user agent directory in code; nothing may write there");
      continue;
    }
    // The exact allowance: one occurrence, inside the host-specific denylist.
    const occurrences = code.split(AGENT_DIR_TOKEN).length - 1;
    if (occurrences !== 1) {
      fail(DENYLIST_FILE + " names the user agent directory more than once");
    }
    if (!new RegExp('"' + AGENT_DIR_TOKEN + '",').test(code)) {
      fail(DENYLIST_FILE + " may name the user agent directory only as a denylist literal");
    }
    if (/from\s+["']node:/.test(code)) {
      fail(DENYLIST_FILE + " must import nothing from node:; it is a pure reader");
    }
  }
  notes.push("no module spawns for plutil, and only the denylist names the agent directory");

  // The packaged entry reads a file, never the environment. launchd controls
  // the environment of a job it starts, so an entry that read from it would
  // take instructions from something no reviewer sees.
  for (const relativePath of present) {
    if (!relativePath.startsWith("packages/daemon/src/bin/")) continue;
    if (relativePath.endsWith(".test.ts")) continue;
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    if (/process\.env/.test(stripComments(content))) {
      fail(relativePath + " reads process.env; the packaged entry takes a config file only");
    }
  }
  notes.push("the packaged entry takes a config file and reads no environment");
}

// --- 19. P3A: the shadow observation boundary --------------------------------
//
// The one new manifest in P3 is the only one the dependency law would otherwise
// not verify — the same gap that was found in the daemon manifest at P2D and
// made binding then. A stray dependency must fail `pnpm check`.
const OBSERVATION_ALLOWED_PACKAGES = new Set(["@acp/contracts", "@acp/ledger"]);
const OBSERVATION_ALLOWED_BUILTINS = new Set(["node:fs", "node:path", "node:url"]);
const OBSERVATION_TEST_ONLY_IMPORTS = new Set(["vitest", "node:os", "node:crypto"]);

// Capability the package must not have. It observes; it cannot attach, signal,
// reach out, or write — including into its own roots.
const OBSERVATION_FORBIDDEN_BUILTINS = [
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "node:tls",
  "node:dgram",
  "node:dns",
  "node:cluster",
  "node:worker_threads",
];
const OBSERVATION_FORBIDDEN_CALLS = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
  "unlinkSync",
  "renameSync",
  "chmodSync",
  "process.env",
  "process.kill",
];

// `openSync` is no longer banned outright, because the honest fix for the
// admission-then-read gap needs a descriptor: only an open file can be
// `fstat`ed and bounded as the same inode admission approved. A blanket token
// ban would have forced the dishonest version — re-checking the path and
// hoping it still named the same file.
//
// So the ban becomes an exception with exactly one member, and it is
// fail-closed in every direction: one file, one open, read-only flags present,
// no write-capable flag anywhere, and every other observation source still
// refused for naming `openSync` at all.
const OBSERVATION_OPEN_SITE = "packages/observation/src/collect/artifact/index.ts";

// P3C's sole writer. Every other observation production module — the
// collectors above all — stays a reader, and none of them may name a database
// driver or raw SQL: the one permitted path to storage is the public ledger
// API, in exactly one file.
const OBSERVATION_LEDGER_SITE = "packages/observation/src/shadow-ledger/index.ts";
const OBSERVATION_FORBIDDEN_DATA_ACCESS = [
  "better-sqlite3",
  "node:sqlite",
  "CREATE TABLE",
  "INSERT INTO",
  "SELECT ",
];
// The exact normalized call, not a set of tokens that must appear somewhere.
// Checking only that `O_RDONLY` and `O_NOFOLLOW` are present anywhere in the
// file would admit `openSync(other, constants.O_RDONLY | constants.O_NOFOLLOW | 2)`
// — a different handle, or a numeric flag the name-based scan cannot read.
// Equality against the whole call is the only form that cannot drift.
const OBSERVATION_OPEN_CALL = "openSync(handle, constants.O_RDONLY | constants.O_NOFOLLOW)";
const OBSERVATION_WRITE_FLAGS = [
  "O_WRONLY",
  "O_RDWR",
  "O_CREAT",
  "O_TRUNC",
  "O_APPEND",
  "O_EXCL",
];

/** Every `openSync(...)` call in a source, whitespace-normalized. */
function openSyncCalls(code) {
  return [...code.matchAll(/openSync\([^()]*\)/g)].map((match) =>
    match[0].replace(/\s+/g, " ").trim(),
  );
}

const observationManifest = readIfPresent("packages/observation/package.json");
if (observationManifest === null) {
  fail("packages/observation/package.json is missing");
} else {
  const parsed = JSON.parse(observationManifest);
  if (parsed.bin !== undefined) {
    fail("packages/observation declares a bin; observation exposes no executable");
  }
  const deps = Object.keys(parsed.dependencies ?? {}).sort();
  const devDeps = Object.keys(parsed.devDependencies ?? {}).sort();
  const expected = ["@acp/contracts", "@acp/ledger"];
  if (deps.join(",") !== expected.join(",")) {
    fail("packages/observation dependencies must be exactly " + expected.join(", "));
  }
  if (devDeps.join(",") !== "vitest") {
    fail("packages/observation devDependencies must be exactly vitest");
  }
  for (const forbidden of ["better-sqlite3", "@restatedev/restate-sdk", "@scarf/scarf"]) {
    if (deps.includes(forbidden)) {
      fail("packages/observation must not depend on " + forbidden + " directly");
    }
  }
  notes.push("the observation manifest declares no bin and an exact dependency surface");
}

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  // Both trees. B5b: when a cohort moves this package's tests into the mirrored
  // `test/` tree they leave the `src/` prefix, and the import allowlist below
  // would silently stop applying to them — nothing failing, the rules simply
  // covering nothing. Observation is the first normalized package the fence
  // actually scans, so it extends its scan rather than declaring itself
  // unscanned. The production-only checks further down still skip tests, by the
  // `isTest` guard, exactly as before.
  const sources = present.filter(
    (relativePath) =>
      (relativePath.startsWith("packages/observation/src/") ||
        relativePath.startsWith("packages/observation/test/")) &&
      relativePath.endsWith(".ts"),
  );

  for (const relativePath of sources) {
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    const isTest = relativePath.endsWith(".test.ts");
    const code = stripComments(content);

    const pattern = /(?:^|[\s({])(?:import|export)[^\n;]*?from\s*["']([^"']+)["']/g;
    let match = pattern.exec(content);
    while (match !== null) {
      const name = match[1] ?? "";
      const relative = name.startsWith("./") || name.startsWith("../");
      const allowed =
        relative ||
        OBSERVATION_ALLOWED_PACKAGES.has(name) ||
        OBSERVATION_ALLOWED_BUILTINS.has(name) ||
        (isTest && OBSERVATION_TEST_ONLY_IMPORTS.has(name));
      if (!allowed) {
        fail(relativePath + " imports " + name + ", which observation may not use");
      }
      if (OBSERVATION_FORBIDDEN_BUILTINS.includes(name)) {
        fail(relativePath + " imports " + name + "; observation attaches to and signals nothing");
      }
      match = pattern.exec(content);
    }

    // Production modules may not even name a mutating call. The guarantee is
    // that the code has no means, not that it declines. P3C does not soften
    // this: `shadow-ledger.ts` writes, but only through `@acp/ledger`'s public
    // API into a disposable fixture, and it still may not touch the filesystem
    // itself — it creates no directory and removes nothing.
    if (isTest) continue;
    for (const call of OBSERVATION_FORBIDDEN_CALLS) {
      if (code.includes(call)) {
        fail(relativePath + " uses " + call + "; observation production modules only read");
      }
    }

    // The descriptor exception, enforced in both directions.
    const tokens = code.split("openSync(").length - 1;
    const calls = openSyncCalls(code);
    if (relativePath === OBSERVATION_OPEN_SITE) {
      // Token count and parsed-call count must agree, so a call this regex
      // cannot read is a failure rather than an omission.
      if (tokens !== 1 || calls.length !== 1) {
        fail(
          relativePath +
            " performs " +
            String(tokens) +
            " openSync token(s) and " +
            String(calls.length) +
            " parseable call(s); the exception permits exactly one of each",
        );
      } else if (calls[0] !== OBSERVATION_OPEN_CALL) {
        fail(
          relativePath +
            " opens with " +
            calls[0] +
            " rather than the exact permitted call " +
            OBSERVATION_OPEN_CALL,
        );
      }
      for (const flag of OBSERVATION_WRITE_FLAGS) {
        if (code.includes(flag)) {
          fail(relativePath + " names the write-capable flag " + flag + "; observation only reads");
        }
      }
    } else if (tokens > 0) {
      fail(relativePath + " uses openSync; only " + OBSERVATION_OPEN_SITE + " may open a descriptor");
    }

    // Exactly one module may reach the ledger, and the collectors may not. A
    // passive collector that could open a ledger would stop being passive, and
    // a second writer would make "the sole writer" a claim rather than a fact.
    const importsLedger = /from\s*["']@acp\/ledger["']/.test(code);
    if (relativePath === OBSERVATION_LEDGER_SITE) {
      if (!importsLedger) {
        fail(relativePath + " no longer imports @acp/ledger; it is the package's only writer");
      }
    } else if (importsLedger) {
      fail(
        relativePath +
          " imports @acp/ledger; only " +
          OBSERVATION_LEDGER_SITE +
          " may, and collect/** stays passive",
      );
    }
    for (const banned of OBSERVATION_FORBIDDEN_DATA_ACCESS) {
      if (code.includes(banned)) {
        fail(
          relativePath + " names " + banned + "; observation reaches storage only through @acp/ledger",
        );
      }
    }
  }
  notes.push(
    sources.length +
      " observation sources: collectors passive, one read-only descriptor site, and one sole writer" +
      " (a disposable non-product ledger fixture through the public @acp/ledger API)",
  );
}

// The closed export surface, pinned by equality in both directions. The
// upper-bound form failed once in this repository — a withdrawn name could be
// re-exported with the fence green — so equality is the form used from here on.
const OBSERVATION_PUBLIC_EXPORTS = [
  "ObservationRefusal",
  "ObservationRefused",
  "ObservationVerdict",
  "ObservationError",
  "ArtifactAdmission",
  "ArtifactHandle",
  "ObservationKind",
  "ObservationRoot",
  "ARTIFACT_MAX_BYTES",
  "OBSERVATION_KINDS",
  "OBSERVATION_ROOT_SEGMENTS",
  "admitArtifact",
  "checkArtifactName",
  "observationRootPath",
  "redactObservationPath",
  "resolveObservationRoot",
  // P3C: the baseline and the disposable shadow ledger.
  "AcceptanceBaseline",
  "Baseline",
  "BaselineStopReason",
  "OutcomeCount",
  "ReasonCount",
  "ReworkBaseline",
  "RoutingBaseline",
  "TaskDuration",
  "TaskReworkCount",
  "TimeBaseline",
  "TokensBaseline",
  "VerdictCount",
  "AUDIT_VERDICTS",
  "BaselineStopError",
  "REASON_MAX_LENGTH",
  "TERMINAL_OUTCOME_TYPES",
  "TOKENS_USED_MAX",
  "computeBaseline",
  "serializeBaseline",
  "ShadowReceipt",
  "ShadowRefusal",
  "ShadowSnapshot",
  "SHADOW_LEDGER_DIRECTORY",
  "ShadowLedgerError",
  "buildShadowLedger",
  "shadowLedgerDirectory",
  // P7I-3: the token rollups. A pure fold over the task stream, with its own
  // bounded value shapes -- no accounts edge, and no ledger import outside the
  // one site that is allowed one.
  "InitiativeTokenRollup",
  "TaskTokenRollup",
  "TokenRollupInput",
  "TokenRollups",
  "ROLLUP_ACCOUNT_ID_MAX_LENGTH",
  "ROLLUP_RESERVATION_TYPE",
  "ROLLUP_TOKENS_MAX",
  "ROLLUP_USAGE_TYPE",
  "UNSCOPED_INITIATIVE",
  "computeTokenRollups",
  // P8-7: neutral telemetry (law 9) and the optional Langfuse boundary.
  "TelemetryAttribute",
  "TelemetryBatch",
  "TelemetryEvent",
  "TelemetryRefusal",
  "TelemetryRefusalReason",
  "TelemetryStatus",
  "TELEMETRY_ATTRIBUTE_KEYS",
  "TELEMETRY_REFUSAL_REASONS",
  "TELEMETRY_SPAN_KIND",
  "emitTelemetry",
  "telemetrySpanName",
  "LangfuseObservation",
  "LangfuseTrace",
  "LANGFUSE_TRACE_NAME",
  "toLangfuseTrace",
];

const observationIndex = readIfPresent("packages/observation/src/index.ts");
if (observationIndex === null) {
  fail("packages/observation/src/index.ts is missing");
} else {
  if (/export\s*\*\s*from/.test(observationIndex)) {
    fail("packages/observation/src/index.ts uses `export *`, which cannot stay closed");
  }
  const exported = new Set();
  for (const block of observationIndex.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const piece of (block[1] ?? "").split(",")) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name !== "") exported.add(name);
    }
  }
  for (const name of exported) {
    if (!OBSERVATION_PUBLIC_EXPORTS.includes(name)) {
      fail("packages/observation exports " + name + ", which is outside its closed surface");
    }
  }
  for (const name of OBSERVATION_PUBLIC_EXPORTS) {
    if (!exported.has(name)) {
      fail("packages/observation no longer exports the pinned name " + name);
    }
  }
  notes.push(exported.size + " observation exports, pinned by equality");
}

// --- 20. P5A: the accounts registry ------------------------------------------
//
// The accounts package reads the one document in this system that legitimately
// names where credentials live. Every law it claims about that is asserted here
// rather than described in its README, because a README cannot fail a build.
const ACCOUNTS_ALLOWED_PACKAGES = new Set(["@acp/contracts", "@acp/ledger"]);
const ACCOUNTS_ALLOWED_BUILTINS = new Set(["node:fs", "node:path"]);
const ACCOUNTS_TEST_ONLY_IMPORTS = new Set(["vitest", "node:os", "node:crypto", "node:url"]);

// Capability the package must not have. It reads a file and computes; it
// cannot spawn, signal or reach out.
const ACCOUNTS_FORBIDDEN_BUILTINS = [
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "node:tls",
  "node:dgram",
  "node:dns",
  "node:cluster",
  "node:worker_threads",
];

// Tokens no production source in this package may name.
//
// `process.env` covers `HOME` on its own, and `HOME` is listed separately
// anyway: the loader's whole hermeticity argument is that it cannot find the
// owner file without being told where it is, and a package that reads one
// environment variable is a package that can be given a default path by
// somebody's shell. The owner-file name and its directory are here for the
// same reason — they belong in prose, where a reader sees them and no code can
// reach them.
const ACCOUNTS_FORBIDDEN_TOKENS = [
  "process.env",
  "HOME",
  "homedir",
  "accounts.local.json",
  ".rottay-agent-control-plane",
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "rmSync",
  "unlinkSync",
  "renameSync",
  "chmodSync",
  "chownSync",
  ".append(",
];

const accountsManifest = readIfPresent("packages/accounts/package.json");
if (accountsManifest === null) {
  fail("packages/accounts/package.json is missing");
} else {
  const parsed = JSON.parse(accountsManifest);
  if (parsed.bin !== undefined) {
    fail("packages/accounts declares a bin; the accounts domain exposes no executable");
  }
  notes.push("the accounts manifest declares no bin");
}

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  // A path this packet creates may not be in the index yet, and a law that only
  // applied to committed files would not apply to the commit that introduced
  // the break. The declared write-set is added so a new source is scanned the
  // moment it exists.
  const declared = new Set(present);
  for (const relativePath of WRITE_SET) {
    if ((relativePath.startsWith("packages/accounts/src/") ||
      relativePath.startsWith("packages/accounts/test/")) && relativePath.endsWith(".ts")) {
      declared.add(relativePath);
    }
  }
  const sources = [...declared]
    .filter(
      (relativePath) =>
        (relativePath.startsWith("packages/accounts/src/") ||
      relativePath.startsWith("packages/accounts/test/")) && relativePath.endsWith(".ts"),
    )
    .filter((relativePath) => readIfPresent(relativePath) !== null)
    .sort();

  for (const relativePath of sources) {
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    const isTest = relativePath.endsWith(".test.ts");
    const code = stripComments(content);

    const pattern = /(?:^|[\s({])(?:import|export)[^\n;]*?from\s*["']([^"']+)["']/g;
    let match = pattern.exec(content);
    while (match !== null) {
      const name = match[1] ?? "";
      const relative = name.startsWith("./") || name.startsWith("../");
      const allowed =
        relative ||
        ACCOUNTS_ALLOWED_PACKAGES.has(name) ||
        ACCOUNTS_ALLOWED_BUILTINS.has(name) ||
        (isTest && ACCOUNTS_TEST_ONLY_IMPORTS.has(name));
      if (!allowed) {
        fail(relativePath + " imports " + name + ", which the accounts domain may not use");
      }
      if (ACCOUNTS_FORBIDDEN_BUILTINS.includes(name)) {
        fail(relativePath + " imports " + name + "; the accounts domain reaches nothing");
      }
      match = pattern.exec(content);
    }

    // Tests need fixtures, so they may write, chmod and read an environment.
    // Production sources may do none of it, and the guarantee is that the code
    // has no means rather than that it declines.
    if (isTest) continue;
    for (const token of ACCOUNTS_FORBIDDEN_TOKENS) {
      if (code.includes(token)) {
        fail(
          relativePath +
            " names " +
            token +
            "; accounts production sources read one explicitly-supplied path and write nothing",
        );
      }
    }
  }
  notes.push(
    sources.length +
      " accounts sources: no environment, no default owner-file path, no append, no spawn",
  );
}

// --- P8-5: the capability/policy registry's editorial law ---------------------
//
// **A content change to the registry requires a version change.** Same content
// under a new version is lawful — a re-cut, when an evaluation is repeated and
// nothing moved. Same version under different content is invalid, and invalid
// in the way that matters: every `capabilityPolicyVersion` already written into
// a route or an event becomes a lie about what was in force when it was chosen.
//
// The loader cannot enforce this. It sees one document and has no idea what
// that version meant yesterday. The fence can, by pinning each published
// version to the digest of the content published under it: change the bytes
// without changing the version and the digest stops matching that version's
// pin; change the version and a new row has to be added deliberately.
const POLICY_VERSION_DIGESTS = {
  "2026-08-30.1": "6fee0b392f19e44ebcd01b29d83d23ee09941e839d1f13c9243a141613d83922",
};

const policyDocumentPath = "packages/accounts/policy/capability-policy.json";
const policyDocument = readIfPresent(policyDocumentPath);
if (policyDocument !== null) {
  let policy = null;
  try {
    policy = JSON.parse(policyDocument);
  } catch {
    fail(policyDocumentPath + " is not JSON");
  }
  if (policy !== null) {
    const version = policy.policyVersion;
    if (typeof version !== "string" || version === "") {
      fail(policyDocumentPath + " declares no policyVersion");
    } else {
      const digest = createHash("sha256").update(policyDocument, "utf8").digest("hex");
      const pinned = Object.hasOwn(POLICY_VERSION_DIGESTS, version)
        ? POLICY_VERSION_DIGESTS[version]
        : null;
      if (pinned === null) {
        fail(
          policyDocumentPath +
            " publishes policyVersion " +
            version +
            ", which POLICY_VERSION_DIGESTS does not pin; add its digest in the same commit",
        );
      } else if (pinned !== digest) {
        fail(
          policyDocumentPath +
            " changed content under an unchanged policyVersion " +
            version +
            "; a content change requires a version change",
        );
      } else {
        notes.push("the capability policy " + version + " matches its pinned digest");
      }
    }
  }
}

// --- 21. the mirrored-topology law (owner rule, P5N) -------------------------
//
// Owner law, repository-wide once every tree is activated:
//
//   • product code lives at `packages/<pkg>/src/<domain>[/<subdomain>]/index.ts[x]`;
//   • tests live at `packages/<pkg>/test/<domain>[/<subdomain>]/index.test.ts[x]`,
//     a **separate mirrored tree**, with fixtures and helpers under the
//     corresponding mirrored test domain;
//   • **zero** `*.test.*` or `*.spec.*` anywhere under `src/`;
//   • the only package-root product exception is `src/index.ts[x]`, a stable
//     public barrel, and the only mirrored root exception is
//     `test/index.test.ts[x]` for whole-package assertions — never
//     `test/index.ts`, since a helper at the test root belongs to no domain;
//   • inside a test domain, `index.ts[x]` is permitted alongside the test, so
//     the fixtures and helpers the owner law places under the mirrored domain
//     have somewhere to be;
//   • there is **no `errors.ts` exception**: an error module is a domain and
//     lives at `src/errors/index.ts` like any other.
//
// **Naming law**, enforced mechanically alongside the structure: every domain
// directory segment is lowercase kebab-case, mirrored identically under
// `test/`; no adjacent duplicate semantic segment (`format/format/` is
// refused); and a leaf file that repeats its parent domain folds into that
// domain's own `index.ts` rather than growing a `<name>/<name>/` wrapper —
// which the non-index basename rule already refuses.
//
// This section **retires the P5B folder/index law** it replaces. That rule
// required `index.test.ts` *beside* an implementation-bearing `index.ts` and
// granted an `errors.ts` root exception; both are now false, and leaving it
// live would have fired on the first relocation this checkpoint performs.
//
// **The activation list starts empty, and that is the design.** Sixty
// committed tests sit under `src/` today and a hundred and one non-index
// product modules with them; a law switched on repo-wide in one step would
// fail every gate until the last cohort landed, which is a fence nobody can
// commit against. Each cohort activates its own tree in the same commit that
// makes that tree compliant, so the law and the code arrive together and every
// commit in between is green.
const TOPOLOGY_ACTIVE_TREES = [
  "contracts",
  "ledger",
  "api-contracts",
  "observation",
  "cli",
  "adapters",
  "daemon",
  "runtime",
  "ui",
  "server",
  "accounts",
];

/** The only basename a product module may carry, anywhere under `src/`. */
const TOPOLOGY_PRODUCT_INDEX = new Set(["index.ts", "index.tsx"]);

/**
 * What a test tree may hold, and it differs by depth.
 *
 * At the root: only `index.test.ts[x]`, the whole-package assertion mirroring
 * the `src/index.ts[x]` barrel. **Not** `test/index.ts` — a helper at the root
 * of the test tree belongs to no domain, which is the shape the mirror exists
 * to prevent.
 *
 * Inside a domain: the test itself, and also `index.ts[x]`, because the owner
 * law puts fixtures and helpers under the mirrored test domain they serve.
 * A scripted child process, a fake, a shared builder — each is a domain's own
 * supporting module and is entered through an index like anything else. The
 * accepted inventory moves five of them, and a gate that admitted only
 * `index.test.ts` would have refused every one.
 */
const TOPOLOGY_TEST_ROOT = new Set(["index.test.ts", "index.test.tsx"]);
const TOPOLOGY_TEST_DOMAIN = new Set([
  "index.test.ts",
  "index.test.tsx",
  "index.ts",
  "index.tsx",
]);
/** Lowercase kebab-case: no uppercase, no underscore, no leading or double dash. */
const TOPOLOGY_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** What may never appear under `src/`, whatever else is true of it. */
const TOPOLOGY_TEST_MARKER = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Check one file's path against the topology.
 *
 * `segments` is the path below the tree root, so `["quota", "index.ts"]` for
 * `packages/accounts/src/quota/index.ts`. The rules are the same either side of
 * the mirror; only the permitted basenames differ, which is what makes the two
 * trees genuinely mirror images rather than two conventions that happen to
 * rhyme.
 */
function checkTopologyPath(relativePath, segments, rootBasenames, domainBasenames, treeLabel) {
  const basename = segments[segments.length - 1] ?? "";
  const directories = segments.slice(0, -1);
  const atRoot = directories.length === 0;
  const permitted = atRoot ? rootBasenames : domainBasenames;

  if (!permitted.has(basename)) {
    if (atRoot) {
      fail(
        relativePath +
          " is a non-index module at the root of " +
          treeLabel +
          "; the only root exception is " +
          [...permitted].sort().join(" or "),
      );
    } else {
      fail(
        relativePath +
          " is not " +
          [...permitted].sort().join(" or ") +
          "; a domain is entered through its own index, and a leaf repeating its" +
          " parent folds into that index",
      );
    }
    return;
  }

  for (let depth = 0; depth < directories.length; depth += 1) {
    const segment = directories[depth] ?? "";
    if (!TOPOLOGY_SEGMENT.test(segment)) {
      fail(
        relativePath +
          " has the domain segment " +
          JSON.stringify(segment) +
          ", which is not lowercase kebab-case",
      );
    }
    // Adjacent only. `status/badge/status/index.ts` is a legitimate shape; it
    // is the immediate repetition that means a folder was created to hold a
    // file that should have been its parent's index.
    if (depth > 0 && directories[depth - 1] === segment) {
      fail(
        relativePath +
          " repeats the domain segment " +
          JSON.stringify(segment) +
          " immediately inside itself; fold it into the parent's index",
      );
    }
  }
}

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  // Declared-but-uncommitted paths count too: a law that only applied to
  // committed files would not apply to the commit that introduced the break.
  const candidates = new Set(present);
  for (const relativePath of WRITE_SET) candidates.add(relativePath);

  let checkedFiles = 0;
  for (const pkg of TOPOLOGY_ACTIVE_TREES) {
    const srcRoot = "packages/" + pkg + "/src/";
    const testRoot = "packages/" + pkg + "/test/";
    for (const relativePath of [...candidates].sort()) {
      if (!/\.[cm]?[jt]sx?$/.test(relativePath)) continue;
      if (readIfPresent(relativePath) === null) continue;

      if (relativePath.startsWith(srcRoot)) {
        checkedFiles += 1;
        if (TOPOLOGY_TEST_MARKER.test(relativePath)) {
          fail(
            relativePath +
              " is a test under src/; tests live in the mirrored " +
              testRoot +
              " tree",
          );
          continue;
        }
        checkTopologyPath(
          relativePath,
          relativePath.slice(srcRoot.length).split("/"),
          TOPOLOGY_PRODUCT_INDEX,
          TOPOLOGY_PRODUCT_INDEX,
          srcRoot,
        );
      } else if (relativePath.startsWith(testRoot)) {
        checkedFiles += 1;
        checkTopologyPath(
          relativePath,
          relativePath.slice(testRoot.length).split("/"),
          TOPOLOGY_TEST_ROOT,
          TOPOLOGY_TEST_DOMAIN,
          testRoot,
        );
      }
    }
  }

  notes.push(
    TOPOLOGY_ACTIVE_TREES.length === 0
      ? "the mirrored-topology law is scaffolded with no tree activated yet; cohorts activate their own"
      : checkedFiles +
          " files in " +
          TOPOLOGY_ACTIVE_TREES.length +
          " activated tree(s) satisfy the mirrored-topology and naming laws",
  );
}

// --- 21b. every test tree stays inside some scan (preaudit B5b) -------------
//
// The per-package source scans select files by the `packages/<pkg>/src/`
// prefix and apply that package's test-only allowlist — no `node:net`, no
// `process.env`, no spawn outside named files — to the `.test.ts` files found
// there. The moment a cohort moves those tests to `packages/<pkg>/test/`, they
// leave every scanned prefix and the allowlists **silently stop applying**.
// Nothing fails; the rules simply cover nothing.
//
// That is the failure mode this assertion exists for: coverage lost by
// omission rather than by decision. Every tracked file under any
// `packages/*/test/` tree must be inside a prefix some scan actually reads, or
// its package must be named below as having no per-package scan at all. A
// cohort that relocates tests without extending its scan fails here, by name.
//
// Both lists start where the repository actually is. No cohort has yet
// extended a scan to a `test/` tree, so the scanned list is empty; `contracts`
// is the first normalized package and the fence has never had a per-package
// source scan for it, so the exemption is a statement of fact rather than a
// waiver. A package that *does* have a scan may never be added to it.
const TEST_TREE_SCANNED_PREFIXES = [
  "packages/observation/test/",
  "packages/adapters/test/",
  "packages/daemon/test/",
  "packages/runtime/test/",
  "packages/ui/test/",
  "packages/server/test/",
  "packages/accounts/test/",
];

/**
 * Packages the fence runs no per-package source scan for.
 *
 * There is nothing to extend for these, so their test trees are uncovered by
 * construction rather than by oversight. Naming them keeps the difference
 * visible: an entry here is a package whose sources the fence never inspected,
 * not a package whose inspection was dropped.
 */
const TEST_TREE_NO_PACKAGE_SCAN = ["contracts", "ledger", "api-contracts", "cli"];

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const candidates = new Set(present);
  for (const relativePath of WRITE_SET) candidates.add(relativePath);

  let covered = 0;
  const uncovered = [];
  for (const relativePath of [...candidates].sort()) {
    const match = /^packages\/([^/]+)\/test\//.exec(relativePath);
    if (match === null) continue;
    if (readIfPresent(relativePath) === null) continue;
    const pkg = match[1] ?? "";
    const scanned = TEST_TREE_SCANNED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
    if (scanned || TEST_TREE_NO_PACKAGE_SCAN.includes(pkg)) {
      covered += 1;
      continue;
    }
    uncovered.push(relativePath);
  }

  for (const relativePath of uncovered) {
    fail(
      relativePath +
        " is in a test tree no package scan reads; extend the package's scan to" +
        " its test/ prefix, or name the package as having no scan",
    );
  }
  if (uncovered.length === 0) {
    notes.push(
      covered +
        " test-tree file(s) are inside a package scan or an explicit no-scan package",
    );
  }
}

// The closed export surface, pinned by equality in both directions.
const ACCOUNTS_PUBLIC_EXPORTS = [
  // P5A
  "AccountsRefusal",
  "AccountsRefused",
  "ACCOUNTS_REFUSALS",
  "AccountsFile",
  "AccountsRegistry",
  "LoadOutcome",
  "ACCOUNTS_FILE_KEYS",
  "ACCOUNTS_FILE_MAX_BYTES",
  "buildRegistry",
  "loadAccountsFile",
  // P5B
  "QuotaEstimate",
  "QuotaEstimateInput",
  "QuotaOutcome",
  "QuotaRefusal",
  "QuotaRefused",
  "ResetCalendar",
  "ResetOutcome",
  "TokenObservation",
  "CONFIDENCE_ORDER",
  "OBSERVATIONS_MAX",
  "QUOTA_REFUSALS",
  "TOKENS_USED_MAX",
  "estimateQuota",
  "resetCalendar",
  "weakerConfidence",
  // P5C
  "CandidateEvidence",
  "EvidenceSample",
  "RankedAccount",
  "RejectedAccount",
  "RoutingConfig",
  "RoutingOutcome",
  "RoutingRecommendation",
  "RoutingRefusal",
  "RoutingRefused",
  "RoutingRequest",
  "RoutingTerm",
  "TaskProfile",
  "CANDIDATES_MAX",
  "DEFAULT_ROUTING_CONFIG",
  "EVIDENCE_ABSENT",
  "ROUTING_REFUSALS",
  "ROUTING_TERMS",
  "rankAccounts",
  // P5D: the switching policy. It recommends and never acts; the plan is named
  // steps and candidate events as values, and quota and selection are composed
  // from P5B and P5C rather than re-decided.
  "SwitchAccountStatus",
  "SwitchEvent",
  "SwitchOutcome",
  "SwitchPlan",
  "SwitchRefusal",
  "SwitchRefused",
  "SwitchRequest",
  "SwitchStep",
  "SwitchTrigger",
  "SWITCH_REFUSALS",
  "SWITCH_STEPS",
  "SWITCH_TRIGGERS",
  "decideSwitch",
  // P8-5: the versioned capability/policy registry (law 4).
  "PolicyConfidence",
  "PolicyEntry",
  "PolicyLoadOutcome",
  "PolicyRefusal",
  "PolicyRefused",
  "PolicyRegistry",
  "PolicyRouteChoice",
  "PolicyRouteOutcome",
  "PolicyRouteRequest",
  "PolicySupport",
  "POLICY_FILE_MAX_BYTES",
  "POLICY_REFUSALS",
  "buildPolicyRegistry",
  "loadPolicyRegistry",
  "routeWithPolicy",
];

const accountsIndex = readIfPresent("packages/accounts/src/index.ts");
if (accountsIndex === null) {
  fail("packages/accounts/src/index.ts is missing");
} else {
  if (/export\s*\*\s*from/.test(accountsIndex)) {
    fail("packages/accounts/src/index.ts uses `export *`, which cannot stay closed");
  }
  const exported = new Set();
  for (const block of accountsIndex.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const piece of (block[1] ?? "").split(",")) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name !== "") exported.add(name);
    }
  }
  for (const name of exported) {
    if (!ACCOUNTS_PUBLIC_EXPORTS.includes(name)) {
      fail("packages/accounts exports " + name + ", which is outside its closed surface");
    }
  }
  for (const name of ACCOUNTS_PUBLIC_EXPORTS) {
    if (!exported.has(name)) {
      fail("packages/accounts no longer exports the pinned name " + name);
    }
  }
  notes.push(exported.size + " accounts exports, pinned by equality");
}

// The P3D deep aliases: exactly two, pointing at exactly these two modules, and
// importable only by the parity test. Aliasing rather than widening either
// package's entry point is what keeps both closed surfaces byte-untouched.
const vitestConfig = readIfPresent("vitest.config.ts");
if (vitestConfig !== null) {
  const aliasTargets = [
    ["@acp/cli/observation-rows", "packages/cli/src/observation/index.ts"],
    ["@acp/ui/row-model", "packages/ui/src/api/client/index.ts"],
  ];
  for (const [specifier, target] of aliasTargets) {
    if (!vitestConfig.includes(target)) {
      fail("vitest.config.ts no longer aliases " + specifier + " to " + target);
    }
  }
  if (tracked.status === 0) {
    const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const relativePath of present) {
      if (relativePath === "vitest.config.ts") continue;
      if (relativePath === "scripts/check-architecture.mjs") continue;
      if (relativePath === "packages/server/test/parity/index.test.ts") continue;
      // The TypeScript counterpart of the same two aliases. `tsc` and
      // type-aware eslint never read `vitest.config.ts`, so without this the
      // parity test resolves at run time and fails both other gates. A
      // tsconfig is not a module: it declares resolution, it imports nothing,
      // so the law this check protects — that no shipped module resolves these
      // specifiers — is untouched. The declaration is pinned by equality
      // immediately below rather than merely excused here.
      if (relativePath === "packages/server/tsconfig.json") continue;
      // The test tree's own tsconfig carries the same two aliases,
      // depth-corrected, for the same reason and under the same rationale —
      // adjudication A (C10). A tsconfig `paths` declaration is not an import.
      if (relativePath === "packages/server/test/tsconfig.json") continue;
      const content = readIfPresent(relativePath);
      if (content === null) continue;
      for (const [specifier] of aliasTargets) {
        if (content.includes(specifier)) {
          fail(
            relativePath +
              " imports " +
              specifier +
              "; the deep aliases exist only for the parity test",
          );
        }
      }
    }
  }
  notes.push("the parity deep aliases point at two modules and are used by one test");
}

// The TypeScript side of the same two aliases. `tsc` and type-aware eslint
// never read `vitest.config.ts`, so without this declaration the parity test
// resolves at run time and fails both other gates. Pinned by equality in both
// directions, exactly as the Vitest law above is: exactly two specifiers,
// exactly these targets, exactly four project references.
//
// The targets are emitted declarations, never sources. A source mapping pulls
// foreign files into this project's `rootDir` (TS6059/TS6307) and makes `tsc`
// emit `.js`/`.d.ts` next to the CLI and UI sources — an observed failure
// while this was built, not a hypothetical.
const SERVER_TS_ALIASES = {
  "@acp/cli/observation-rows": "../cli/dist/observation/index.d.ts",
  "@acp/ui/row-model": "../ui/dist/app/api/client/index.d.ts",
};
// P8-8A adds `../observation`: the initiative plane folds token rollups, and
// `tsc --build` resolves a workspace package through project references rather
// than through the manifest, so the edge has to be declared here as well as
// there. Sorted, because the pin is an equality and an unsorted list would
// make a reordering look like a change.
const SERVER_TS_REFERENCES = [
  "../accounts",
  "../api-contracts",
  "../cli",
  "../ledger",
  "../observation",
  "../ui",
];
const serverTsconfigRaw = readIfPresent("packages/server/tsconfig.json");
if (serverTsconfigRaw !== null) {
  let parsed = null;
  try {
    parsed = JSON.parse(serverTsconfigRaw);
  } catch {
    fail("packages/server/tsconfig.json is not parseable JSON");
  }
  if (parsed !== null) {
    const declared = parsed.compilerOptions?.paths ?? {};
    const expectedAliases = Object.keys(SERVER_TS_ALIASES).sort().join(", ");
    const actualAliases = Object.keys(declared).sort().join(", ");
    if (actualAliases !== expectedAliases) {
      fail(
        "packages/server/tsconfig.json paths are not exactly [" +
          expectedAliases +
          "]: found [" +
          actualAliases +
          "]",
      );
    }
    for (const [specifier, target] of Object.entries(SERVER_TS_ALIASES)) {
      const mapped = Array.isArray(declared[specifier]) ? declared[specifier] : [];
      if (mapped.length !== 1 || mapped[0] !== target) {
        fail(
          "packages/server/tsconfig.json maps " +
            specifier +
            " to " +
            JSON.stringify(mapped) +
            " rather than to [" +
            target +
            "]",
        );
      } else if (!target.endsWith(".d.ts")) {
        fail(
          "packages/server/tsconfig.json aliases " + specifier + " to a source, not a declaration",
        );
      }
    }
    const references = Array.isArray(parsed.references) ? parsed.references : [];
    const actualReferences = references
      .map((entry) => (entry === null || entry === undefined ? "" : entry.path))
      .sort()
      .join(", ");
    if (actualReferences !== SERVER_TS_REFERENCES.join(", ")) {
      fail(
        "packages/server/tsconfig.json references are not exactly [" +
          SERVER_TS_REFERENCES.join(", ") +
          "]: found [" +
          actualReferences +
          "]",
      );
    }
    notes.push("the server tsconfig pins two declaration aliases and four references, by equality");
  }
}

// ---------------------------------------------------------------------------
// P4A: the provider adapter boundary
// ---------------------------------------------------------------------------

/** What an adapter source may import. Nothing here can reach a ledger. */
const ADAPTERS_ALLOWED_PACKAGES = new Set(["@acp/contracts"]);
const ADAPTERS_ALLOWED_BUILTINS = new Set([
  "node:fs",
  "node:path",
  "node:string_decoder",
]);
const ADAPTERS_TEST_ONLY_IMPORTS = new Set(["vitest", "node:crypto", "node:os", "node:url"]);
const ADAPTERS_FORBIDDEN_BUILTINS = [
  "node:net",
  "node:http",
  "node:https",
  "node:tls",
  "node:dgram",
  "node:dns",
  "node:cluster",
  "node:worker_threads",
];

/** Exactly one file spawns, and exactly one file calls it. */
const ADAPTERS_SPAWN_SITE = "packages/adapters/src/process/spawn/index.ts";
const ADAPTERS_SPAWN_CALLER = "packages/adapters/src/session/index.ts";

/**
 * The closed public surface, pinned by equality in both directions.
 *
 * `src/testing/fake-provider.ts` is deliberately absent: it is test
 * scaffolding, imported by relative path. A fake on the public surface would
 * eventually be mistaken for evidence.
 */
const ADAPTERS_PUBLIC_EXPORTS = [
  "AdapterErrorCode",
  "ADAPTER_ERROR_CODES",
  "AdapterError",
  "AdmittedBinary",
  "AdmittedConfigRoot",
  "AdmittedWorkdir",
  "CapabilityEvidence",
  "CapabilityName",
  "CapabilityOutcome",
  "CapabilityRecord",
  "CapabilityState",
  "ParseCursor",
  "ParseOutcome",
  "ProviderAdapter",
  "ProviderName",
  "ProviderSignal",
  "SessionDescriptor",
  "SessionLimits",
  "SessionRequest",
  "SessionState",
  "CAPABILITY_NAMES",
  "EMPTY_CURSOR",
  "LEGAL_TRANSITIONS",
  "PROVIDER_NAMES",
  "SESSION_STATES",
  "capability",
  "confirmsProviderCapability",
  "isLegalTransition",
  "unknownCapabilities",
  "NormalizedEvent",
  "NormalizedEventName",
  "FROZEN_TYPE_BY_EVENT",
  "NORMALIZED_EVENT_NAMES",
  "TOKENS_USED_MAX",
  "isReportableTokenCount",
  "normalizedEvent",
  "toNormalized",
  "PAYLOAD_BYTES_MAX",
  "PAYLOAD_STRING_MAX",
  "boundString",
  "hasPrivacyViolation",
  "shapePayload",
  "BASE_ENV_KEYS",
  "PROVIDER_CONFIG_ENV",
  "admitConfigRoot",
  "admitWorkdir",
  "allowedEnvKeys",
  "buildEnv",
  "InterruptRecord",
  "LadderStep",
  "admitBinary",
  "AdapterSession",
  "descriptorEnablesWrites",
  "isReadOnlyIdentity",
  "startSession",
  // P8-2/P8-3/P8-4: the execution port. The admitted values arrive per account
  // through `CliBinding`, so the contract's request stays transport-neutral.
  // P8-3 renamed the factory and the session-id helper: one factory now builds
  // a port serving more than one transport, and a name that said CLI would
  // invite the second (and now third) factory the design refused.
  "CliBinding",
  "ExecutionPortInput",
  "CLI_TRANSPORT_KIND",
  "createExecutionPort",
  "executionSessionId",
  "toExecutionEvent",
  // P8-3: the API_KEY transport, over an interface this repository owns.
  "ApiAdmission",
  "ApiKeyBinding",
  "ApiStreamChunk",
  "ApiStreamRequest",
  "ApiStreamingClient",
  "API_TRANSPORT_KIND",
  "admitApiRoute",
  "apiExecutionEvents",
  // P8-4: the LOCAL_OR_SELF_HOSTED transport, over the same shape of owned,
  // credential-free client interface as the API leg.
  "LocalAdmission",
  "LocalBinding",
  "LocalChatChunk",
  "LocalChatClient",
  "LocalChatRequest",
  "LOCAL_TRANSPORT_KIND",
  "admitLocalRoute",
  "localExecutionEvents",
  // P4B
  "CLAUDE_STREAM_PROTOCOL",
  "claudeAdapter",
  // P4C
  "KIMI_ACP_PROTOCOL",
  "KIMI_ACP_PROTOCOL_VERSION",
  "kimiAdapter",
  // P4D
  "CODEX_APP_SERVER_PROTOCOL",
  "CODEX_PROTOCOL_RECORD",
  "codexAdapter",
];

/** The environment allowlist, pinned so a fourth variable cannot appear. */
const ADAPTERS_ENV_ALLOWLIST = {
  claude: ["CLAUDE_CONFIG_DIR", "HOME", "LC_ALL", "PATH"],
  kimi: ["HOME", "KIMI_CODE_HOME", "LC_ALL", "PATH"],
  codex: ["CODEX_HOME", "HOME", "LC_ALL", "PATH"],
};

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const declared = new Set(present);
  for (const relativePath of WRITE_SET) {
    if (
      (relativePath.startsWith("packages/adapters/src/") ||
        relativePath.startsWith("packages/adapters/test/")) &&
      relativePath.endsWith(".ts")
    ) {
      declared.add(relativePath);
    }
  }
  const sources = [...declared]
    .filter(
      (relativePath) =>
        relativePath.startsWith("packages/adapters/src/") ||
        relativePath.startsWith("packages/adapters/test/"),
    )
    .filter((relativePath) => relativePath.endsWith(".ts"))
    .sort();

  let checked = 0;
  for (const relativePath of sources) {
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    checked += 1;
    const isTest = relativePath.endsWith(".test.ts");
    const code = stripComments(content);

    const pattern = /(?:^|[\s({])(?:import|export)[^\n;]*?from\s*["']([^"']+)["']/g;
    let match = pattern.exec(content);
    while (match !== null) {
      const name = match[1] ?? "";
      const relative = name.startsWith("./") || name.startsWith("../");
      const spawnHere = name === "node:child_process" && relativePath === ADAPTERS_SPAWN_SITE;
      const allowed =
        relative ||
        ADAPTERS_ALLOWED_PACKAGES.has(name) ||
        ADAPTERS_ALLOWED_BUILTINS.has(name) ||
        spawnHere ||
        (isTest && ADAPTERS_TEST_ONLY_IMPORTS.has(name));
      if (!allowed) {
        fail(relativePath + " imports " + name + ", which adapters may not use");
      }
      if (ADAPTERS_FORBIDDEN_BUILTINS.includes(name)) {
        fail(relativePath + " imports " + name + "; adapters reach no network");
      }
      match = pattern.exec(content);
    }

    // No adapter source may name a ledger, in any form. Adapters produce
    // normalized events; the caller decides what to persist.
    if (code.includes("@acp/ledger")) {
      fail(relativePath + " names @acp/ledger; adapters append nothing");
    }

    if (isTest) continue;

    // Exactly one spawner, and exactly one caller of it.
    if (/from\s*["']node:child_process["']/.test(code) && relativePath !== ADAPTERS_SPAWN_SITE) {
      fail(relativePath + " imports node:child_process; only " + ADAPTERS_SPAWN_SITE + " may");
    }
    // The law is about *calling* the spawner, not naming its module: the index
    // re-exports `admitBinary` from it, which grants no ability to spawn.
    if (code.includes("spawnAdmitted(") && relativePath !== ADAPTERS_SPAWN_CALLER && relativePath !== ADAPTERS_SPAWN_SITE) {
      fail(relativePath + " calls the spawner; only " + ADAPTERS_SPAWN_CALLER + " may");
    }

    // Provider modules are pure descriptors and parsers. Reaching into the
    // session controller or the process modules — even for a pure predicate —
    // makes a provider a participant in the boundary it is deliberately kept
    // outside of, and it is how three providers would end up with three
    // opinions about stopping a process.
    if (relativePath.startsWith("packages/adapters/src/providers/")) {
      if (/from\s*["'][^"']*session\.js["']/.test(code)) {
        fail(relativePath + " imports the session controller; providers stay pure");
      }
      if (/from\s*["'][^"']*\/process\//.test(code)) {
        fail(relativePath + " imports a process module; providers stay pure");
      }
    }

    if (relativePath === ADAPTERS_SPAWN_SITE) {
      // `shell:` would hand argv to a shell; `...process.env` would inherit an
      // ambient environment the allowlist was built to replace; `maxBuffer` is
      // an exec-only option `spawn` ignores, so requiring it would enforce a
      // dead argument while the real bound went unimplemented.
      for (const banned of ["shell:", "...process.env", "maxBuffer"]) {
        if (code.includes(banned)) {
          fail(relativePath + " names " + banned + "; the spawn authority forbids it");
        }
      }
      for (const required of ["stdio:", "timeout:", "killSignal:"]) {
        if (!code.includes(required)) {
          fail(relativePath + " omits " + required + "; spawn options are explicit, never default");
        }
      }
    } else if (code.includes("process.env") && relativePath !== "packages/adapters/src/config-root/index.ts") {
      fail(relativePath + " reads process.env; only config-root/index.ts builds an environment");
    }
  }

  if (checked > 0) {
    notes.push(
      checked + " adapter sources: one spawn authority, one caller, no ledger and no network",
    );
  }
}

const adaptersIndex = readIfPresent("packages/adapters/src/index.ts");
if (adaptersIndex !== null) {
  if (/export\s*\*\s*from/.test(adaptersIndex)) {
    fail("packages/adapters/src/index.ts uses `export *`, which cannot stay closed");
  }
  if (stripComments(adaptersIndex).includes("testing/fake-provider")) {
    fail("packages/adapters/src/index.ts exports the fake provider; it is not public surface");
  }
  const exported = new Set();
  for (const block of adaptersIndex.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const raw of (block[1] ?? "").split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name !== "") exported.add(name);
    }
  }
  for (const name of exported) {
    if (!ADAPTERS_PUBLIC_EXPORTS.includes(name)) {
      fail("packages/adapters exports " + name + ", which is outside its closed surface");
    }
  }
  for (const name of ADAPTERS_PUBLIC_EXPORTS) {
    if (!exported.has(name)) {
      fail("packages/adapters no longer exports the pinned name " + name);
    }
  }
  notes.push(exported.size + " adapter exports, pinned by equality");
}

// ---------------------------------------------------------------------------
// P8-3: the API_KEY transport's shape
// ---------------------------------------------------------------------------

/**
 * The owned streaming client, pinned member by member.
 *
 * This is how "credentials are unrepresentable" is enforced rather than
 * promised. A key, a token, an authorization header or a credential reference
 * cannot be added to either type without this pin moving, and moving it is a
 * deliberate act a reviewer sees. Scanning the file for credential-sounding
 * words would be the brittle version of the same idea: the doc comments here
 * legitimately discuss credentials at length, and a scan that cannot tell a
 * sentence from a field is a scan that gets disabled the first time it is
 * wrong.
 */
const API_CLIENT_SHAPE = {
  ApiStreamRequest: ["model", "taskId", "attempt", "identity"],
  ApiStreamingClient: ["provider", "models", "stream"],
};

/**
 * The same pin for the local leg. (P8-4, C1.)
 *
 * Identical shape to the API leg's, and pinned for a sharper reason: a local
 * or self-hosted server sitting behind an optional bearer token is exactly the
 * case a future contributor would reach for a credential field to serve. The
 * pin is what makes that reach fail rather than land.
 */
const LOCAL_CLIENT_SHAPE = {
  LocalChatRequest: ["model", "taskId", "attempt", "identity"],
  LocalChatClient: ["provider", "models", "stream"],
};

/**
 * Every module a client library could be smuggled into, and what it may not
 * import.
 *
 * The API leg refuses the AI SDK families; the local leg refuses those plus
 * the OpenAI client and the fetch-client families, because "OpenAI-compatible"
 * is precisely the phrase that makes reaching for `openai` or `undici` feel
 * reasonable. Taking any of them would make an optional dependency a
 * compile-time one, which is what law 6 forbids.
 */
const OWNED_CLIENT_MODULES = [
  {
    path: "packages/adapters/src/providers/api-key/index.ts",
    shape: API_CLIENT_SHAPE,
    forbidden: ["ai", "@ai-sdk/", "@vercel/"],
    note: "the API client interface is credential-free by shape, pinned member by member",
  },
  {
    path: "packages/adapters/src/providers/local/index.ts",
    shape: LOCAL_CLIENT_SHAPE,
    forbidden: [
      "ai",
      "@ai-sdk/",
      "@vercel/",
      "openai",
      "undici",
      "axios",
      "node-fetch",
      "got",
      "ky",
    ],
    note: "the local client interface is credential-free by shape, pinned member by member",
  },
];

/**
 * Read one interface's member names, in declaration order.
 *
 * Written once and used for every owned client rather than copied per module:
 * a pin that exists to stop two shapes drifting apart is a poor place to keep
 * two copies of the same check.
 */
function interfaceMembers(source, name) {
  const declaration = source.match(new RegExp("export interface " + name + "\\s*\\{([^}]*)\\}"));
  if (declaration === null) return null;
  const members = [];
  for (const line of (declaration[1] ?? "").split("\n")) {
    const member = line.trim().replace(/^readonly\s+/, "").match(/^([A-Za-z_$][\w$]*)\s*[(:?]/);
    if (member !== null) members.push(member[1]);
  }
  return members;
}

for (const owned of OWNED_CLIENT_MODULES) {
  const module = readIfPresent(owned.path);
  if (module === null) continue;
  const source = stripComments(module);

  for (const [name, expected] of Object.entries(owned.shape)) {
    const members = interfaceMembers(source, name);
    if (members === null) {
      fail(owned.path + " no longer declares " + name);
      continue;
    }
    if (members.join(",") !== expected.join(",")) {
      fail(
        name +
          " no longer has exactly its pinned members: expected [" +
          expected.join(", ") +
          "], found [" +
          members.join(", ") +
          "]",
      );
    }
  }

  // The transport is bound through an interface this repository owns. A client
  // library imported here would make the optional dependency a compile-time
  // one, which is precisely what law 6 forbids and what P8-3b exists to do
  // deliberately.
  for (const forbidden of owned.forbidden) {
    if (new RegExp('from "' + forbidden).test(source)) {
      fail(owned.path + " imports " + forbidden + "; law 6 keeps the client binding optional");
    }
  }
  notes.push(owned.note);
}

const adaptersConfigRoot = readIfPresent("packages/adapters/src/config-root/index.ts");
if (adaptersConfigRoot !== null) {
  for (const [provider, keys] of Object.entries(ADAPTERS_ENV_ALLOWLIST)) {
    for (const key of keys) {
      if (!adaptersConfigRoot.includes(key)) {
        fail("packages/adapters/src/config-root/index.ts no longer names " + key + " for " + provider);
      }
    }
  }
  // Equality the other way, read from the two declarations rather than from
  // every uppercase literal in the file: a refusal code is not an environment
  // variable, and a scan that cannot tell them apart is a scan that fails on
  // its own vocabulary.
  const permitted = new Set(Object.values(ADAPTERS_ENV_ALLOWLIST).flat());
  const baseBlock = adaptersConfigRoot.match(/BASE_ENV_KEYS[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/);
  const providerBlock = adaptersConfigRoot.match(/PROVIDER_CONFIG_ENV[^=]*=\s*Object\.freeze\(\{([^}]*)\}/);
  const declaredKeys = [
    ...[...(baseBlock?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    ...[...(providerBlock?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  ];
  if (declaredKeys.length === 0) {
    fail("packages/adapters/src/config-root/index.ts declares no environment allowlist");
  }
  for (const key of declaredKeys) {
    if (key !== undefined && !permitted.has(key)) {
      fail("packages/adapters/src/config-root/index.ts names " + key + ", outside the env allowlist");
    }
  }
  notes.push("the adapter environment allowlist is exactly four variables per provider");
}

// The server may not reach @acp/contracts. `packages/server/src/mappers/index.ts`
// records that exclusion as a design decision, and the parity test honours it
// by asking @acp/api-contracts for the privacy verdict through its named
// helper instead. Enforced in all three forms the reach could take: a manifest
// dependency, a tsconfig path, or an import in any server source. Prose may
// name it — comments are stripped before matching — because the point is
// resolution, not vocabulary.
//
// The source check is a fail-closed substring test rather than a match on
// `from "…"`. A regex shaped like one import spelling answers only for that
// spelling: `import("@acp/contracts")`, `require("@acp/contracts")`,
// `import type … from`, `export … from`, and a bare reference in a
// dependency-injected identifier all reach the same package while sliding past
// it. Naming the package anywhere in live code is the thing being forbidden,
// so that is what is matched.
const serverManifestRaw = readIfPresent("packages/server/package.json");
if (serverManifestRaw !== null) {
  let manifest = null;
  try {
    manifest = JSON.parse(serverManifestRaw);
  } catch {
    fail("packages/server/package.json is not parseable JSON");
  }
  if (manifest !== null) {
    const declaredDependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    };
    if (Object.hasOwn(declaredDependencies, "@acp/contracts")) {
      fail("packages/server/package.json depends on @acp/contracts; that reach is excluded");
    }
  }
}
if (serverTsconfigRaw !== null && serverTsconfigRaw.includes('"@acp/contracts"')) {
  fail("packages/server/tsconfig.json maps @acp/contracts; that reach is excluded");
}
const serverSources = new Set(
  (tracked.status === 0 ? tracked.stdout.split("\n").map((line) => line.trim()) : []).filter(
    (relativePath) =>
      (relativePath.startsWith("packages/server/src/") ||
        relativePath.startsWith("packages/server/test/")) &&
      relativePath.endsWith(".ts"),
  ),
);
for (const relativePath of WRITE_SET) {
  if (
    (relativePath.startsWith("packages/server/src/") ||
      relativePath.startsWith("packages/server/test/")) &&
    relativePath.endsWith(".ts")
  ) {
    serverSources.add(relativePath);
  }
}
let serverSourcesChecked = 0;
for (const relativePath of [...serverSources].sort()) {
  const content = readIfPresent(relativePath);
  if (content === null) continue;
  serverSourcesChecked += 1;
  if (stripComments(content).includes("@acp/contracts")) {
    fail(
      relativePath +
        " names @acp/contracts in live code; that reach is excluded — use the" +
        " @acp/api-contracts privacy helper instead",
    );
  }
}
notes.push(
  serverSourcesChecked +
    " server sources name @acp/contracts nowhere in live code, and neither manifest nor tsconfig reaches it",
);

// Names that must never enter the graph, matched as whole tokens so the
// permitted SDK does not trip the ban on its own parent package.
const P2C_FORBIDDEN_NAMES = [
  ["@scarf/scarf", /@scarf\/scarf/],
  ["@restatedev/restate-server", /@restatedev\/restate-server/],
  ["the @restatedev/restate CLI", /@restatedev\/restate(?![-\w])/],
  ["testcontainers", /testcontainers/i],
];
const P2C_NAME_EXEMPT = new Set([
  "scripts/check-architecture.mjs",
  "scripts/acquire-restate-server.mjs",
  "docs/architecture/0004-durability-and-supervisor.md",
  "docs/architecture/0005-restate-driver-and-adoption.md",
  "packages/runtime/README.md",
  "packages/runtime/src/constants/index.ts",
  "pnpm-workspace.yaml",
]);
if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const relativePath of present) {
    if (P2C_NAME_EXEMPT.has(relativePath)) continue;
    if (relativePath === "pnpm-lock.yaml") continue;
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    for (const [label, pattern] of P2C_FORBIDDEN_NAMES) {
      if (pattern.test(content)) {
        fail(relativePath + " names " + label + ", which may not enter this graph");
      }
    }
  }
  notes.push("no tracked file names the server package, its telemetry dependency or containers");
}

// The acquisition script must never fetch at import time.
const acquireSource = readIfPresent("scripts/acquire-restate-server.mjs");
if (acquireSource === null) {
  fail("scripts/acquire-restate-server.mjs is missing");
} else {
  if (!/const invoked = process\.argv\[1\]/.test(acquireSource)) {
    fail("the acquisition script does not guard its run behind an explicit invocation check");
  } else {
    notes.push("the acquisition script fetches only when invoked as an entry point");
  }
}

// The pin is the content authority for a binary that never passes through the
// package manager, so the fence parses it rather than grepping it for the word
// UNPINNED. Both digests must be established: pinning the archive alone leaves
// the extracted binary attested by nothing but its own receipt, which is what a
// substituted binary would also carry.
const PIN_DIGEST = /^[0-9a-f]{64}$/;
const pinSource = readIfPresent("scripts/restate-server.pin.json");
if (pinSource === null) {
  fail("scripts/restate-server.pin.json is missing");
} else {
  let pin = null;
  try {
    pin = JSON.parse(pinSource);
  } catch {
    fail("scripts/restate-server.pin.json is not valid JSON");
  }
  if (pin !== null) {
    const platforms = pin.platforms;
    const keys =
      platforms !== null && typeof platforms === "object" ? Object.keys(platforms) : [];
    if (keys.length === 0) {
      fail("the server pin establishes no platform, so it pins nothing");
    } else {
      let established = true;
      for (const key of keys) {
        for (const field of ["sha256", "binarySha256"]) {
          const digest = platforms[key]?.[field];
          if (typeof digest !== "string" || !PIN_DIGEST.test(digest)) {
            fail(
              "the server pin's " +
                key +
                "." +
                field +
                " is not an established 64-lowercase-hex digest; there is no " +
                "trust-on-first-use here",
            );
            established = false;
          }
        }
      }
      if (established) {
        notes.push("the Restate server pin establishes both archive and binary digests");
      }
    }
  }
}

for (const note of notes) {
  console.log("  ✓ " + note);
}

if (failures.length > 0) {
  console.error("");
  console.error("Architecture fence FAILED with " + failures.length + " violation(s):");
  for (const message of failures) {
    console.error("  ✗ " + message);
  }
  console.error("");
  process.exit(1);
}

console.log("  ✓ architecture fence passed");

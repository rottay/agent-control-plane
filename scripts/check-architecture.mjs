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
import { accessSync, constants, readFileSync, statSync } from "node:fs";
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
  "packages/contracts/src/schemas.ts",
  "packages/contracts/src/schemas.test.ts",
];

/** The exact P1A additions. No twenty-fourth ledger path is authorized. */
const P1A_WRITE_SET = [
  "docs/architecture/0002-sqlite-event-ledger.md",
  "packages/ledger/package.json",
  "packages/ledger/tsconfig.json",
  "packages/ledger/README.md",
  "packages/ledger/src/index.ts",
  "packages/ledger/src/types.ts",
  "packages/ledger/src/errors.ts",
  "packages/ledger/src/canonical-json.ts",
  "packages/ledger/src/migrations.ts",
  "packages/ledger/src/projection.ts",
  "packages/ledger/src/ledger.ts",
  "packages/ledger/src/concurrent-writer-worker.ts",
  "packages/ledger/src/ledger.test.ts",
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
  "packages/api-contracts/src/version.ts",
  "packages/api-contracts/src/routes.ts",
  "packages/api-contracts/src/schemas.ts",
  "packages/api-contracts/src/schemas.test.ts",
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
  "packages/ui/src/main.tsx",
  "packages/ui/src/App.tsx",
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
  "packages/cli/src/cli.test.ts",
  "packages/cli/src/cli.ts",
  "packages/cli/src/format.ts",
  "packages/cli/src/observation.ts",
  "packages/server/src/aggregates.ts",
  "packages/server/src/build-server.test.ts",
  "packages/server/src/build-server.ts",
  "packages/server/src/constants.ts",
  "packages/server/src/database-identity.ts",
  "packages/server/src/errors.ts",
  "packages/server/src/ledger-source.ts",
  "packages/server/src/mappers.ts",
  "packages/server/src/query-schemas.ts",
  "packages/server/src/routes.ts",
  "packages/server/src/start.ts",
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
  "packages/ui/src/routing/hashRoute.test.ts",
  "packages/ui/src/routing/hashRoute.ts",
  "packages/ui/src/routing/useHashRoute.ts",
  "packages/ui/src/styles/base.css",
  "packages/ui/src/styles/components.css",
  "packages/ui/src/styles/index.css",
  "packages/ui/src/styles/layout.css",
  "packages/ui/src/styles/tokens.css",
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
  "packages/runtime/src/contracts.ts",
  "packages/runtime/src/constants.ts",
];

/**
 * The exact P2B additions: one shared core, one driver, and their evidence.
 *
 * P2B implements the lifecycle engine and the SQLite supervisor. The Restate
 * driver, the daemon, the launchd template and any observation route are not
 * here, and no eighth path is authorized.
 */
const P2B_WRITE_SET = [
  "packages/runtime/src/errors.ts",
  "packages/runtime/src/core/coordinates.ts",
  "packages/runtime/src/core/coordinates.test.ts",
  "packages/runtime/src/core/events.ts",
  "packages/runtime/src/core/events.test.ts",
  "packages/runtime/src/core/lifecycle.ts",
  "packages/runtime/src/core/lifecycle.test.ts",
  "packages/runtime/src/toy/repository.ts",
  "packages/runtime/src/toy/repository.test.ts",
  "packages/runtime/src/drivers/sqlite-supervisor.ts",
  "packages/runtime/src/drivers/sqlite-supervisor-child.ts",
  "packages/runtime/src/drivers/sqlite-supervisor.test.ts",
];

/**
 * The exact P2C additions: the Restate driver and its external server pin.
 *
 * P2C is single-writer, so there is no lane envelope. No thirteenth path is
 * authorized.
 */
const P2C_WRITE_SET = [
  "docs/architecture/0005-restate-driver-and-adoption.md",
  "packages/runtime/src/core/step-executor.ts",
  "packages/runtime/src/core/step-executor.test.ts",
  "packages/runtime/src/drivers/restate-driver.ts",
  "packages/runtime/src/drivers/restate-endpoint.ts",
  "packages/runtime/src/drivers/restate-driver.test.ts",
  "packages/runtime/src/drivers/restate-drills.test.ts",
  "packages/runtime/src/drivers/restate-child.ts",
  "packages/runtime/src/restate/server-handle.ts",
  "packages/runtime/src/restate/submit.ts",
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
  "packages/daemon/src/constants.ts",
  "packages/daemon/src/errors.ts",
  "packages/daemon/src/paths.ts",
  "packages/daemon/src/paths.test.ts",
  "packages/daemon/src/singleton.ts",
  "packages/daemon/src/singleton.test.ts",
  "packages/daemon/src/identity-probe.ts",
  "packages/daemon/src/identity-probe.test.ts",
  "packages/daemon/src/status.ts",
  "packages/daemon/src/status.test.ts",
  "packages/daemon/src/log.ts",
  "packages/daemon/src/log.test.ts",
  "packages/daemon/src/lifecycle.ts",
  "packages/daemon/src/lifecycle.test.ts",
  "packages/daemon/src/mode-sqlite.ts",
  "packages/daemon/src/mode-restate.ts",
  "packages/daemon/src/signals.ts",
  "packages/daemon/src/daemon-child.ts",
  "packages/daemon/src/daemon-drills.test.ts",
  "packages/daemon/src/import-purity.test.ts",
  "docs/architecture/0006-daemon-process-lifecycle.md",
  "packages/runtime/src/restate/server-handle.ts",
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
  "packages/daemon/src/launchd/render.ts",
  "packages/daemon/src/launchd/render.test.ts",
  "packages/daemon/src/launchd/validate.ts",
  "packages/daemon/src/launchd/validate.test.ts",
  "packages/daemon/src/launchd/launchd-drills.test.ts",
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
  "packages/daemon/src/bin/acp-daemon.ts",
  "packages/daemon/src/bin/config-file.ts",
  "packages/daemon/src/bin/acp-daemon.test.ts",
  "packages/daemon/src/launchd/launchd-lifecycle.test.ts",
  "docs/architecture/0008-packaged-entry-and-launchd-lifecycle.md",
  "packages/daemon/package.json",
  "packages/daemon/src/daemon-child.ts",
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
 * 37 − (1 + 1 + 1 + 3) = 31. `packages/server/src/routes.ts` and
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
  "packages/observation/src/roots.ts",
  "packages/observation/src/roots.test.ts",
  "packages/observation/src/errors.ts",
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
  "packages/observation/src/collect/artifact.ts",
  "packages/observation/src/collect/artifact.test.ts",
  "packages/observation/src/collect/scenario.ts",
  "packages/observation/src/collect/scenario.test.ts",
  "packages/observation/src/collect/index.ts",
  "vitest.config.ts",
];

/** P3C: the baseline and its disposable shadow ledger. */
const P3C_WRITE_SET = [
  "packages/observation/src/baseline.ts",
  "packages/observation/src/baseline.test.ts",
  "packages/observation/src/shadow-ledger.ts",
  "packages/observation/src/shadow-ledger.test.ts",
  "packages/observation/src/index.ts",
  // The export re-pin, the sole-writer law and the count restatement all live
  // in the fence, so P3C touches it like P3A and P3D did.
  "scripts/check-architecture.mjs",
];

/** P3D: the ledger-to-client parity contract and its three-way proof. */
const P3D_WRITE_SET = [
  "packages/api-contracts/src/parity.ts",
  "packages/api-contracts/src/parity.test.ts",
  "packages/api-contracts/src/index.ts",
  "packages/cli/src/observation.ts",
  "packages/ui/src/api/client.ts",
  "packages/server/src/parity.test.ts",
  "scripts/check-architecture.mjs",
  // Sorting only, at the two aggregate emit sites. The server was emitting
  // `Map` insertion order while the CLI sorted; ordering is part of the parity
  // law, so the server converges onto the CLI's existing deterministic order.
  "packages/server/src/routes.ts",
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
  "packages/adapters/src/errors.ts",
  "packages/adapters/src/contract.ts",
  "packages/adapters/src/events.ts",
  "packages/adapters/src/redact.ts",
  "packages/adapters/src/config-root.ts",
  "packages/adapters/src/session.ts",
  "packages/adapters/src/process/spawn.ts",
  "packages/adapters/src/process/handle.ts",
  "packages/adapters/src/testing/fake-provider.ts",
  "packages/adapters/src/contract.test.ts",
  "packages/adapters/src/events.test.ts",
  "packages/adapters/src/redact.test.ts",
  "packages/adapters/src/config-root.test.ts",
  "packages/adapters/src/session.test.ts",
  "packages/adapters/src/process/spawn.test.ts",
  "tsconfig.base.json",
  "vitest.config.ts",
  "pnpm-lock.yaml",
  "scripts/check-architecture.mjs",
  "docs/architecture/0010-provider-adapter-boundary.md",
];

/** P4B: the Claude headless descriptor. */
const P4B_WRITE_SET = [
  "packages/adapters/src/providers/claude/index.ts",
  "packages/adapters/src/providers/claude/index.test.ts",
  "packages/adapters/src/index.ts",
  "scripts/check-architecture.mjs",
];

/** P4C: the Kimi ACP descriptor. */
const P4C_WRITE_SET = [
  "packages/adapters/src/providers/kimi/index.ts",
  "packages/adapters/src/providers/kimi/index.test.ts",
  "packages/adapters/src/index.ts",
  "scripts/check-architecture.mjs",
];

/** P4D: the Codex App Server descriptor. */
const P4D_WRITE_SET = [
  "packages/adapters/src/providers/codex/index.ts",
  "packages/adapters/src/providers/codex/index.test.ts",
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
  "packages/accounts/src/errors.ts",
  "packages/accounts/src/registry/index.ts",
  "packages/accounts/src/registry/index.test.ts",
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
  "packages/accounts/src/quota/index.test.ts",
  "packages/accounts/src/index.ts",
  "scripts/check-architecture.mjs",
];

const P5C_WRITE_SET = [
  "packages/accounts/src/router/index.ts",
  "packages/accounts/src/router/index.test.ts",
  "packages/accounts/src/index.ts",
  "scripts/check-architecture.mjs",
];

const P5D_WRITE_SET = [
  "packages/accounts/src/switching/index.ts",
  "packages/accounts/src/switching/index.test.ts",
  "packages/accounts/src/index.ts",
  "scripts/check-architecture.mjs",
];

/** P5E: closure. The status line moves here and nowhere else. */
const P5E_WRITE_SET = [
  "docs/ROADMAP.md",
  "README.md",
  "packages/accounts/README.md",
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
const ROADMAP_SHA256 =
  "e41264e7bd52236fe19741c7fa2b06181511334ee435875123a78d1e573ca092";

/**
 * The Estado line P4 closure is allowed to have produced.
 *
 * P4 is complete on five committed commits and the independently verified
 * receipts behind them: the adapter contract and session boundary, the Claude
 * headless descriptor, the Kimi ACP descriptor, the provider-folder
 * relocation, and the Codex App Server descriptor. The literal is exact, and
 * because it still does not contain P1_INCOMPLETE it also keeps the lane
 * envelope closed.
 *
 * What P4 completion does NOT mean is worth stating where the claim is made.
 * Every provider capability leaves P4 `UNKNOWN`: no adapter was pointed at a
 * running provider, no handshake was performed and no account was touched, so
 * the adapters are complete while the warranties about the providers are
 * simply absent. P5 opens as *next*, not as started.
 *
 * NO_PRODUCT_CUTOVER stays in the same line and must stay there. Nothing P4
 * built is in service, and adoption happens once, after P8 certification and
 * under a separate P9 authorisation.
 */
const ROADMAP_STATUS_LITERAL =
  "Estado: `P0_COMPLETE / P1_COMPLETE / P2_COMPLETE / P3_COMPLETE / P4_COMPLETE / NEXT_P5 / NO_PRODUCT_CUTOVER`";

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
    "P2D is not P2 completion",
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
    "GET only",
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
  ],
  "packages/runtime/src/index.ts": ["This is P2B"],
  "packages/runtime/package.json": ["the SQLite supervisor driver over the append-only ledger"],
  "README.md": [
    "There is no orchestrator",
    "P0 and P1 complete. Next: P2.",
    "P0, P1 and P2 complete. Next: P3.",
    "P0, P1, P2 and P3 complete. Next: P4.",
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
const CREDENTIAL_FIXTURE_EXEMPT = new Set(["packages/contracts/src/schemas.test.ts"]);

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
    dependencies: ["@acp/api-contracts", "@acp/ledger", "fastify"],
    devDependencies: ["vitest"],
    forbidden: ["better-sqlite3"],
  },
  {
    manifest: "packages/ui/package.json",
    dependencies: ["@acp/api-contracts", "react", "react-dom"],
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
    dependencies: ["@acp/contracts", "@acp/ledger", "@restatedev/restate-sdk"],
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
const HTTP2_ALLOWED_FILE = "packages/runtime/src/drivers/restate-endpoint.ts";

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
  ["packages/runtime/src/restate/server-handle.ts", "the pinned Restate server"],
  ["packages/daemon/src/identity-probe.ts", "reading process identity via /bin/ps"],
  ["packages/adapters/src/process/spawn.ts", "the single provider spawn authority"],
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
      relativePath.startsWith("packages/runtime/src/") && relativePath.endsWith(".ts"),
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
const LAUNCH_DRILL_FILE = "packages/daemon/src/launchd/launchd-lifecycle.test.ts";
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
const SERVER_HANDLE_FILE = "packages/runtime/src/restate/server-handle.ts";
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
const PROBE_FILE = "packages/daemon/src/identity-probe.ts";
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
  if (!/"\/bin\/ps"/.test(probeCode + (readIfPresent("packages/daemon/src/constants.ts") ?? ""))) {
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
      relativePath.startsWith("packages/daemon/src/") && relativePath.endsWith(".ts"),
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
    const EXPECTED_BIN = { "acp-daemon": "./dist/bin/acp-daemon.js" };
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
    const entrySource = readIfPresent("packages/daemon/src/bin/acp-daemon.ts");
    if (entrySource === null) {
      fail("packages/daemon/src/bin/acp-daemon.ts is missing");
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
    "packages/daemon/src/lifecycle.ts",
    "packages/daemon/src/singleton.ts",
    "packages/daemon/src/mode-sqlite.ts",
    "packages/daemon/src/mode-restate.ts",
  ]) {
    const content = readIfPresent(decisionPath);
    if (content !== null && /from\s+["']\.\/status\.js["']/.test(content)) {
      fail(decisionPath + " imports the status observation; lifecycle decisions may not read it");
    }
  }

  // The child entry runs only when executed, never on import.
  const childCode = readIfPresent("packages/daemon/src/daemon-child.ts");
  if (childCode !== null && !/process\.argv\[1\]/.test(childCode)) {
    fail("packages/daemon/src/daemon-child.ts must guard its entry point on process.argv[1]");
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
  const DENYLIST_FILE = "packages/daemon/src/launchd/validate.ts";
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
const OBSERVATION_OPEN_SITE = "packages/observation/src/collect/artifact.ts";

// P3C's sole writer. Every other observation production module — the
// collectors above all — stays a reader, and none of them may name a database
// driver or raw SQL: the one permitted path to storage is the public ledger
// API, in exactly one file.
const OBSERVATION_LEDGER_SITE = "packages/observation/src/shadow-ledger.ts";
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
  const sources = present.filter(
    (relativePath) =>
      relativePath.startsWith("packages/observation/src/") && relativePath.endsWith(".ts"),
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
    if (relativePath.startsWith("packages/accounts/src/") && relativePath.endsWith(".ts")) {
      declared.add(relativePath);
    }
  }
  const sources = [...declared]
    .filter(
      (relativePath) =>
        relativePath.startsWith("packages/accounts/src/") && relativePath.endsWith(".ts"),
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

// --- 21. the folder/index organization law (owner rule, P5B) -----------------
//
// Owner law: inside the two trees named below, a source file is either the
// tree's own `index.ts`/`errors.ts` or it lives in a domain folder as
// `index.ts` with `index.test.ts` beside it when the index carries
// implementation. Domains nest: each folder level is a domain in its own right
// and needs its own `index.ts`.
//
// The point is that a domain is a *folder*, so its implementation and its
// evidence are one directory listing apart and can never drift into separate
// halves of a package. Three things are refused, and each has been an actual
// failure mode somewhere:
//
//   • a flat `src/quota.ts` beside `src/quota/` — two homes for one domain,
//     and a reader who finds the wrong one first;
//   • a folder that is entered without an `index.ts` — a directory of loose
//     modules wearing a domain's name;
//   • an implementation-bearing `index.ts` with no `index.test.ts` beside it,
//     which is the shape code takes just before it stops being tested.
//
// A **pure re-export barrel** needs no test, and the criterion is mechanical
// rather than a judgement call: strip the comments and every `import`/`export
// … from "…"` statement, and if nothing but whitespace remains the file
// declares nothing of its own and has nothing to test. Requiring a test for a
// file that only forwards names would be requiring a test of the module
// system.
//
// Scoped to exactly these two trees. The older packages predate the law and are
// not retrofitted by it: applying a new organizational rule retroactively would
// turn one packet into a repository-wide refactor, which is how a fence stops
// being something anyone can afford to satisfy.
const FOLDER_INDEX_TREES = ["packages/accounts/src/", "packages/adapters/src/providers/"];

/** The only basenames permitted directly at a tree's root. */
const FOLDER_INDEX_ROOT_FILES = new Set(["index.ts", "errors.ts"]);

/**
 * Does this module declare anything of its own, or only forward names?
 *
 * Comments go first, then every import and re-export statement — including the
 * multi-line braced form and `export * from`. Whatever is left is the file's
 * own content.
 */
function declaresImplementation(source) {
  const stripped = stripComments(source)
    .replace(
      /\b(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\}|[\w$]+)?\s*from\s*["'][^"']+["']\s*;?/g,
      "",
    )
    .replace(/\bimport\s*["'][^"']+["']\s*;?/g, "");
  return stripped.trim() !== "";
}

if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  // Declared-but-uncommitted paths count too: a law that only applied to
  // committed files would not apply to the commit that introduced the break.
  const candidates = new Set(present);
  for (const relativePath of WRITE_SET) candidates.add(relativePath);

  /** domain folder → the basenames it holds. */
  const domainFolders = new Map();
  let checked = 0;

  for (const relativePath of [...candidates].sort()) {
    const tree = FOLDER_INDEX_TREES.find((prefix) => relativePath.startsWith(prefix));
    if (tree === undefined || !relativePath.endsWith(".ts")) continue;
    if (readIfPresent(relativePath) === null) continue;
    checked += 1;

    const segments = relativePath.slice(tree.length).split("/");
    const basename = segments[segments.length - 1] ?? "";

    if (segments.length === 1) {
      if (!FOLDER_INDEX_ROOT_FILES.has(basename)) {
        fail(
          relativePath +
            " is a flat file in " +
            tree +
            "; a domain lives in a folder as index.ts with index.test.ts beside it",
        );
      }
      continue;
    }

    if (basename !== "index.ts" && basename !== "index.test.ts") {
      fail(
        relativePath +
          " is not index.ts or index.test.ts; a domain folder in " +
          tree +
          " holds exactly those two",
      );
      continue;
    }

    // Every level is a domain, so every level is registered. `a/b/index.ts`
    // makes both `a` and `a/b` folders that must each be entered through an
    // index of their own.
    const folders = segments.slice(0, -1);
    for (let depth = 1; depth <= folders.length; depth += 1) {
      const key = tree + folders.slice(0, depth).join("/");
      const held = domainFolders.get(key) ?? new Set();
      if (depth === folders.length) held.add(basename);
      domainFolders.set(key, held);
    }
  }

  for (const [folder, held] of [...domainFolders].sort()) {
    if (!held.has("index.ts")) {
      fail(folder + " has no index.ts; every folder level is a domain entered through one");
      continue;
    }
    const source = readIfPresent(folder + "/index.ts");
    if (source === null) continue;
    if (declaresImplementation(source) && !held.has("index.test.ts")) {
      fail(
        folder +
          "/index.ts declares implementation with no index.test.ts beside it;" +
          " a domain folder carries its own evidence",
      );
    }
  }

  if (checked > 0) {
    notes.push(
      checked +
        " sources in " +
        FOLDER_INDEX_TREES.length +
        " trees follow the folder/index law across " +
        domainFolders.size +
        " domain folders",
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
    ["@acp/cli/observation-rows", "packages/cli/src/observation.ts"],
    ["@acp/ui/row-model", "packages/ui/src/api/client.ts"],
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
      if (relativePath === "packages/server/src/parity.test.ts") continue;
      // The TypeScript counterpart of the same two aliases. `tsc` and
      // type-aware eslint never read `vitest.config.ts`, so without this the
      // parity test resolves at run time and fails both other gates. A
      // tsconfig is not a module: it declares resolution, it imports nothing,
      // so the law this check protects — that no shipped module resolves these
      // specifiers — is untouched. The declaration is pinned by equality
      // immediately below rather than merely excused here.
      if (relativePath === "packages/server/tsconfig.json") continue;
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
  "@acp/cli/observation-rows": "../cli/dist/observation.d.ts",
  "@acp/ui/row-model": "../ui/dist/app/api/client.d.ts",
};
const SERVER_TS_REFERENCES = ["../api-contracts", "../cli", "../ledger", "../ui"];
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
const ADAPTERS_SPAWN_SITE = "packages/adapters/src/process/spawn.ts";
const ADAPTERS_SPAWN_CALLER = "packages/adapters/src/session.ts";

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
    if (relativePath.startsWith("packages/adapters/src/") && relativePath.endsWith(".ts")) {
      declared.add(relativePath);
    }
  }
  const sources = [...declared]
    .filter((relativePath) => relativePath.startsWith("packages/adapters/src/"))
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
    } else if (code.includes("process.env") && relativePath !== "packages/adapters/src/config-root.ts") {
      fail(relativePath + " reads process.env; only config-root.ts builds an environment");
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

const adaptersConfigRoot = readIfPresent("packages/adapters/src/config-root.ts");
if (adaptersConfigRoot !== null) {
  for (const [provider, keys] of Object.entries(ADAPTERS_ENV_ALLOWLIST)) {
    for (const key of keys) {
      if (!adaptersConfigRoot.includes(key)) {
        fail("packages/adapters/src/config-root.ts no longer names " + key + " for " + provider);
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
    fail("packages/adapters/src/config-root.ts declares no environment allowlist");
  }
  for (const key of declaredKeys) {
    if (key !== undefined && !permitted.has(key)) {
      fail("packages/adapters/src/config-root.ts names " + key + ", outside the env allowlist");
    }
  }
  notes.push("the adapter environment allowlist is exactly four variables per provider");
}

// The server may not reach @acp/contracts. `packages/server/src/mappers.ts`
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
      relativePath.startsWith("packages/server/src/") && relativePath.endsWith(".ts"),
  ),
);
for (const relativePath of WRITE_SET) {
  if (relativePath.startsWith("packages/server/src/") && relativePath.endsWith(".ts")) {
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
  "packages/runtime/src/constants.ts",
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

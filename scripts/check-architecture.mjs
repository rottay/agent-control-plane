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
 */
const RETIRED_PATHS = ["vitest.workspace.ts"];

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

const RETIRED = new Set(RETIRED_PATHS);

const WRITE_SET = [
  ...P0_WRITE_SET,
  ...P1A_WRITE_SET,
  ...P1B_SHARED_WRITE_SET,
  ...P1_WRITE_SET,
  ...P2A_WRITE_SET,
].filter((relativePath) => !RETIRED.has(relativePath));

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
  "ac22401fe334126c0b5f37f235a645f21c2f8a4f890dd7a1a394dc6d65c5c5e8";

/**
 * The Estado line P1 closure is allowed to have produced.
 *
 * P1 is complete: the server serves the frozen contract, the CLI reads it and
 * the UI renders it, all three under an independent verifier's receipt. The
 * literal is exact, and because it no longer contains P1_INCOMPLETE it is also
 * what closes the lane envelope below.
 *
 * What completion does NOT mean is stated in the same line and must stay there:
 * NO_PRODUCT_CUTOVER. A finished observation plane is still not in service.
 * Adoption happens once, after P8 certification and under a separate P9
 * authorisation.
 */
const ROADMAP_STATUS_LITERAL =
  "Estado: `P0_COMPLETE / P1_COMPLETE / NEXT_P2 / NO_PRODUCT_CUTOVER`";

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
 */
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
    "P2A is not P2 completion",
    "no product adoption",
  ],
  "packages/api-contracts/README.md": [
    "browser-safe",
    "P1B is not P1 completion",
    "no product adoption",
    "GET only",
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

for (const relativePath of WRITE_SET) {
  if (relativePath === "pnpm-lock.yaml") continue;
  try {
    statSync(join(REPO_ROOT, relativePath));
  } catch {
    fail("required path is missing: " + relativePath);
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
      WRITE_SET.length +
      " exact paths across P0, P1A, P1B and P1; " +
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
    notes.push("docs/ROADMAP.md matches the pinned P1 closure digest");
  }

  // The digest alone would let a re-pin smuggle in a rewritten roadmap, so the
  // structural statements are checked independently of it.
  if (!roadmap.includes(ROADMAP_STATUS_LITERAL)) {
    fail("docs/ROADMAP.md no longer carries the authorized P1A status line");
  } else {
    notes.push("roadmap status is P0 and P1 complete, next P2, no product cutover");
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
  // Case-insensitive: the fence checks that the statement is still made, not
  // how a sentence happened to capitalise it.
  const haystack = content.toLowerCase();
  for (const literal of literals) {
    if (!haystack.includes(literal.toLowerCase())) {
      fail(relativePath + " no longer states the authority literal: " + literal);
    }
  }
}

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
    dependencies: ["@acp/contracts", "@restatedev/restate-sdk"],
    devDependencies: [],
    // The server package pulls @scarf/scarf, whose postinstall is a network
    // beacon. The 1.7.7 server is an external pinned binary, never a dependency.
    forbidden: ["@restatedev/restate-server", "@scarf/scarf", "@restatedev/restate"],
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

// The P2A scaffold executes nothing. Restricting its import specifiers is the
// cheapest honest proof: without node builtins it cannot open a socket, spawn a
// process or touch the filesystem, whatever its source says it intends to do.
const RUNTIME_ALLOWED_IMPORTS = new Set(["@acp/contracts", "@restatedev/restate-sdk"]);
if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const runtimeSources = present.filter(
    (relativePath) =>
      relativePath.startsWith("packages/runtime/src/") && relativePath.endsWith(".ts"),
  );
  if (runtimeSources.length === 0) {
    fail("packages/runtime/src has no tracked sources; the scaffold purity check is inert");
  }
  const specifier = /(?:^|[\s({])(?:import|export)[^\n;]*?from\s*["']([^"']+)["']/g;
  for (const relativePath of runtimeSources) {
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    let match = specifier.exec(content);
    while (match !== null) {
      const name = match[1] ?? "";
      if (!name.startsWith("./") && !RUNTIME_ALLOWED_IMPORTS.has(name)) {
        fail(
          relativePath +
            " imports " +
            name +
            "; the P2A scaffold may import only @acp/contracts, the Restate SDK and its own modules",
        );
      }
      match = specifier.exec(content);
    }
  }
  notes.push(runtimeSources.length + " runtime scaffold sources import no node builtin");
}

// launchd is last, and never automatic. A template may exist and be linted; an
// automated load would make a phase that has run no drills start a daemon.
const LAUNCHCTL_EXEMPT = new Set([
  "docs/architecture/0004-durability-and-supervisor.md",
  "scripts/check-architecture.mjs",
]);
if (tracked.status === 0) {
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const relativePath of present) {
    if (LAUNCHCTL_EXEMPT.has(relativePath)) continue;
    if (relativePath === "pnpm-lock.yaml") continue;
    const content = readIfPresent(relativePath);
    if (content === null) continue;
    if (/launchctl\s+(load|bootstrap|kickstart|enable)/.test(content)) {
      fail(relativePath + " invokes launchctl; P2 may never load a daemon automatically");
    }
  }
  notes.push("no file invokes launchctl load or bootstrap");
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

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
 *   1. the exact 23 path write-set is respected;
 *   2. docs/ROADMAP.md is still the byte-exact kickoff roadmap;
 *   3. the authority documents still carry their critical literals;
 *   4. the pre-push hook exists, is executable and always refuses;
 *   5. core.hooksPath is actually pointed at .githooks, so the fence is live;
 *   6. no remote is configured;
 *   7. no credential store is present in the repository.
 *
 * Every check is read-only. This script never writes, stages or commits.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The exact P0 write-set. No 24th path is authorized. */
const WRITE_SET = [
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

/** docs/ROADMAP.md must remain a byte-for-byte copy of the kickoff roadmap. */
const ROADMAP_SHA256 =
  "d0e3ccc76615f909bf9bf441953e3ac6eb96836d2f06ca654473e1e435d2f281";

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

// --- 1. required paths -----------------------------------------------------

for (const relativePath of WRITE_SET) {
  if (relativePath === "pnpm-lock.yaml") continue;
  try {
    statSync(join(REPO_ROOT, relativePath));
  } catch {
    fail("required path is missing: " + relativePath);
  }
}

// --- 2. write-set conformance ---------------------------------------------

const tracked = git(["ls-files", "--cached", "--others", "--exclude-standard"]);
if (tracked.status !== 0) {
  fail("git ls-files failed; is this a git repository?");
} else {
  const allowed = new Set(WRITE_SET);
  const present = tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const relativePath of present) {
    if (!allowed.has(relativePath)) {
      fail("path is outside the exact P0 write-set: " + relativePath);
    }
  }
  notes.push(present.length + " repository files, all within the write-set");
}

// --- 3. roadmap authority digest ------------------------------------------

const roadmap = readIfPresent("docs/ROADMAP.md");
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
    notes.push("docs/ROADMAP.md matches the frozen kickoff digest");
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

// --- report ----------------------------------------------------------------

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

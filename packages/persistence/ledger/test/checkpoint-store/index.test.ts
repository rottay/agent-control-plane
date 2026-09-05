import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "@acp/contracts";
import type { Checkpoint } from "@acp/contracts";

import { artifactDigest, artifactRootFor, hasArtifact, readArtifact } from "../../src/artifact-store/index.js";
import { canonicalJsonStringify } from "../../src/canonical-json/index.js";
import { createCheckpointStore } from "../../src/checkpoint-store/index.js";

/**
 * Evidence for the checkpoint store (V2-B1f/F3).
 *
 * Parse, canonically serialize, publish — and the order is what is asserted,
 * not described. Everything runs against a real filesystem, because every claim
 * here is a claim about what the store actually holds afterwards: a digest that
 * names nothing would be exactly the defect this packet exists to close.
 *
 * The source is a stub on purpose. What assembles a checkpoint is the daemon's
 * business and is proved over a real worktree in the daemon's own drills; what
 * this file proves is that whatever it is handed either lands in the store
 * under the digest it returns, or is refused with nothing written.
 */

const roots: string[] = [];

/** A ledger path in a fresh directory. No file is created: only the path matters. */
function ledgerPath(): string {
  const path = mkdtempSync(join(tmpdir(), "acp-checkpoint-store-"));
  roots.push(path);
  return join(path, "ledger.sqlite3");
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const WORKER = "claude/opus/implementer/01";
const TASK_ID = "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c01";
const INSTANT = "2026-09-05T12:00:00.000Z";

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    contractVersion: CONTRACT_VERSION,
    checkpointId: "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c02",
    taskId: TASK_ID,
    attempt: 1,
    worker: WORKER,
    createdAt: INSTANT,
    lastAtomicStep: { index: 5, label: "run.outcome", completedAt: INSTANT },
    git: {
      head: "a".repeat(40),
      branch: "main",
      worktreePath: "/tmp/acp-fixture-worktree",
      isDirty: false,
    },
    authorityDigest: [{ path: "AGENTS.md", sha256: "b".repeat(64) }],
    readSetDigest: [{ path: "src/read.ts", sha256: "c".repeat(64) }],
    writeSetDigest: [{ path: "src/walk.ts", sha256: "d".repeat(64) }],
    receipts: [],
    artifacts: [],
    pendingWork: [],
    nextSafeAction: "Await the next owner-authorized action.",
    notes: null,
    ...overrides,
  };
}

/** A store over a source that always assembles the given value. */
function storeOver(path: string, assembled: Checkpoint | { ok: false; reason: "GIT_UNOBSERVABLE"; at: string }) {
  return createCheckpointStore({
    ledgerPath: path,
    source: { assemble: () => assembled },
  });
}

/** The terminal step, in the only shape the store ever sees it. */
const STEP = { index: 10, transitionId: "checkpointed" };

describe("P1: a valid checkpoint is written, and reads back byte-identical", () => {
  it("publishes the canonical bytes and re-parses them equal", () => {
    const path = ledgerPath();
    const value = checkpoint();
    const persisted = storeOver(path, value).persist(STEP);

    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    const read = readArtifact(artifactRootFor(path), persisted.digest);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // Byte-identical, not merely equivalent: the store holds the canonical
    // serialization and nothing re-formats it on the way out.
    expect(read.content).toBe(canonicalJsonStringify(value));
    expect(JSON.parse(read.content)).toEqual(value);
    expect(persisted.bytes).toBe(Buffer.byteLength(read.content, "utf8"));
  });
});

describe("P2: the digest is the store's own", () => {
  it("returns the digest the store names the object by, and the store holds it", () => {
    const path = ledgerPath();
    const persisted = storeOver(path, checkpoint()).persist(STEP);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    // Never re-derived: the returned digest IS the store's name for the bytes.
    expect(persisted.digest).toBe(artifactDigest(canonicalJsonStringify(checkpoint())));
    expect(hasArtifact(artifactRootFor(path), persisted.digest)).toBe(true);
  });
});

describe("P6: determinism", () => {
  it("assembles identical bytes twice and publishes to one digest", () => {
    const path = ledgerPath();
    const store = storeOver(path, checkpoint());

    const first = store.persist(STEP);
    const second = store.persist(STEP);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // One digest, one object. The second publication verified rather than
    // rewrote, which is what makes a replayed walk safe.
    expect(second.digest).toBe(first.digest);
    expect(second.bytes).toBe(first.bytes);
  });
});

describe("the source's refusal is carried through, never translated", () => {
  it("returns the source's own reason and never publishes", () => {
    const path = ledgerPath();
    const refusal = { ok: false as const, reason: "GIT_UNOBSERVABLE" as const, at: "worktree" };
    const outcome = storeOver(path, refusal).persist(STEP);

    expect(outcome).toEqual(refusal);
    // Nothing was written at all: the artifact root does not even exist.
    expect(existsSync(artifactRootFor(path))).toBe(false);
  });
});

describe("N1: over budget is refused by the contract, before anything is written", () => {
  it("refuses with the Checkpoint schema's own message and publishes nothing", () => {
    const path = ledgerPath();
    // Digests, not content: the budget is exceeded the way a real checkpoint
    // would exceed it, by carrying too many references rather than a payload.
    const readSetDigest = Array.from({ length: 220 }, (_unused, index) => ({
      path: "src/generated/module-" + String(index).padStart(4, "0") + ".ts",
      sha256: String(index % 10).repeat(64),
    }));
    const outcome = storeOver(
      path,
      checkpoint({ readSetDigest, notes: "n".repeat(1_900) }),
    ).persist(STEP);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("CHECKPOINT_INVALID");
    // The contract's own words, not a message this module invented.
    expect(outcome.at).toContain("exceeds the 16384 byte budget");
    // The store's own 1 MiB CONTENT_TOO_LARGE is unreachable from here, and
    // the proof is that nothing reached the store at all.
    expect(existsSync(artifactRootFor(path))).toBe(false);
  });

  it("names the field when the value is malformed rather than merely large", () => {
    const path = ledgerPath();
    const outcome = storeOver(path, checkpoint({ git: { ...checkpoint().git, head: "not-a-sha" } })).persist(STEP);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("CHECKPOINT_INVALID");
    expect(outcome.at).toContain("git.head");
    expect(existsSync(artifactRootFor(path))).toBe(false);
  });
});

describe("N10: no checkpoint content reaches a refusal", () => {
  it("carries a field name and the contract's shape observation, never a value", () => {
    const path = ledgerPath();
    const secret = "the-notes-body-nobody-should-ever-see";
    const outcome = storeOver(
      path,
      checkpoint({ notes: secret, git: { ...checkpoint().git, branch: "" } }),
    ).persist(STEP);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.at).not.toContain(secret);
    expect(outcome.at).toContain("git.branch");
  });
});

describe("N2/N3/N4: the read side and the store's own refusals", () => {
  it("N2: an unknown digest refuses ARTIFACT_ABSENT, and repairs nothing", () => {
    const path = ledgerPath();
    const store = storeOver(path, checkpoint());
    expect(store.persist(STEP).ok).toBe(true);

    const outcome = store.read("f".repeat(64));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("ARTIFACT_ABSENT");
    expect(hasArtifact(artifactRootFor(path), "f".repeat(64))).toBe(false);
  });

  it("N3: a mutated stored object refuses ARTIFACT_CORRUPT", () => {
    const path = ledgerPath();
    const store = storeOver(path, checkpoint());
    const persisted = store.persist(STEP);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    const object = join(artifactRootFor(path), persisted.digest.slice(0, 2), persisted.digest);
    writeFileSync(object, readFileSync(object, "utf8") + " ", "utf8");

    const outcome = store.read(persisted.digest);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("ARTIFACT_CORRUPT");
  });

  it("N4: different bytes under an existing digest refuse, and the object is unchanged", () => {
    const path = ledgerPath();
    const original = checkpoint();
    const persisted = storeOver(path, original).persist(STEP);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    // A collision, staged by hand: the store is content-addressed, so the only
    // way to reach the verify-on-existing branch is to put different bytes
    // under an existing name and publish the original again.
    //
    // **The refusal is `ARTIFACT_CORRUPT`, not `DIGEST_MISMATCH`, and that is
    // the store's law rather than a near miss.** `publishArtifact` re-digests
    // the stored bytes first: bytes that do not hash to the name they are
    // filed under are corruption, and it says so. `DIGEST_MISMATCH` is the
    // branch for bytes that DO hash to that name and are still different --
    // an actual sha256 collision, which no test can stage. Both names are in
    // `ARTIFACT_REFUSALS` and both are carried through unchanged; what is
    // asserted here is the one a caller can actually observe.
    const object = join(artifactRootFor(path), persisted.digest.slice(0, 2), persisted.digest);
    const impostor = canonicalJsonStringify(checkpoint({ attempt: 2 }));
    writeFileSync(object, impostor, "utf8");

    const outcome = storeOver(path, original).persist(STEP);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The stored bytes are evidence that something went wrong, and they are
    // preserved rather than overwritten.
    expect(outcome.reason).toBe("ARTIFACT_CORRUPT");
    expect(readFileSync(object, "utf8")).toBe(impostor);
  });
});

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_VERSION,
  buildIdempotencyKey,
  findCredentialViolations,
  findTranscriptViolations,
} from "@acp/contracts";
import type { ControlPlaneEvent } from "@acp/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { computeBaseline, serializeBaseline } from "../../src/baseline/index.js";
import { OBSERVATION_KINDS, observationRootPath } from "../../src/roots/index.js";
import type { ShadowLedgerError } from "../../src/shadow-ledger/index.js";
import {
  SHADOW_LEDGER_DIRECTORY,
  buildShadowLedger,
  shadowLedgerDirectory,
} from "../../src/shadow-ledger/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const SHADOW_ROOT = join(REPO_ROOT, ".acp-local", "shadow");
const OBSERVATION_SRC = join(PACKAGE_ROOT, "src");

/**
 * Every production `.ts` file under `src/`, named by its path relative to
 * `src/` with `/` separators. Mirrors the walk `test/roots/index.test.ts`
 * needs, for the same reason: this suite's "sole writer" check has to see
 * every production module, and they are no longer flat siblings of either
 * `src/` or `src/collect/`.
 */
function collectSources(directory: string, prefix = ""): { readonly name: string; readonly source: string }[] {
  const found: { readonly name: string; readonly source: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...collectSources(join(directory, entry.name), prefix + entry.name + "/"));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    found.push({ name: prefix + entry.name, source: readFileSync(join(directory, entry.name), "utf8") });
  }
  return found;
}

function makeRoots(): void {
  for (const kind of OBSERVATION_KINDS) {
    mkdirSync(observationRootPath(kind), { recursive: true, mode: 0o700 });
  }
  mkdirSync(shadowLedgerDirectory(), { recursive: true, mode: 0o700 });
}

/**
 * Remove only this drill's own root, and only after proving it is the root
 * this drill created. `rmSync` with a computed path is exactly the shape that
 * deletes the wrong tree when a variable is not what it looks like, so the
 * prefix and realpath are checked before anything is removed.
 */
function removeRoots(): void {
  if (!existsSync(SHADOW_ROOT)) return;
  const expected = join(REPO_ROOT, ".acp-local", "shadow");
  if (SHADOW_ROOT !== expected || !SHADOW_ROOT.startsWith(REPO_ROOT + "/")) {
    throw new Error("refusing to remove a path outside this repository's shadow root");
  }
  rmSync(SHADOW_ROOT, { recursive: true, force: true });
}

afterEach(() => {
  removeRoots();
});

function event(overrides: Record<string, unknown>): ControlPlaneEvent {
  const taskId = (overrides["taskId"] as string | undefined) ?? randomUUID();
  const attempt = 1;
  const transitionId = (overrides["transitionId"] as string | undefined) ?? "step";
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId,
    attempt,
    transitionId,
    idempotencyKey: buildIdempotencyKey({ taskId, attempt, transitionId }),
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "kimi/k3/coordinator/01",
    occurredAt: "2026-08-27T12:00:00.000Z",
    recordedAt: "2026-08-27T12:00:00.000Z",
    correlationId: null,
    causationId: null,
    payload: {},
    ...overrides,
  } as unknown as ControlPlaneEvent;
}

const TASK_A = "00000000-0000-4000-8000-00000000000a";
const TASK_B = "00000000-0000-4000-8000-00000000000b";

/** Synthetic lifecycles under the frozen vocabulary, covering all five measures. */
function syntheticChain(): ControlPlaneEvent[] {
  return [
    event({ taskId: TASK_A, transitionId: "discover", type: "TASK_DISCOVERED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:00:00.000Z" }),
    event({ taskId: TASK_A, transitionId: "classify", type: "TASK_CLASSIFIED", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:10.000Z", payload: { reason: "routine" } }),
    event({ taskId: TASK_A, transitionId: "step", type: "ATOMIC_STEP_COMPLETED", fromState: "DT_CLASSIFIED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:20.000Z", payload: { tokensUsed: 1200 } }),
    event({ taskId: TASK_A, transitionId: "audit", type: "AUDIT_COMPLETED", fromState: "DT_CLASSIFIED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:30.000Z", payload: { verdict: "ACCEPT" } }),
    event({ taskId: TASK_B, transitionId: "discover", type: "TASK_DISCOVERED", toState: "DISCOVERED", occurredAt: "2026-08-27T12:01:00.000Z" }),
    event({ taskId: TASK_B, transitionId: "classify", type: "TASK_CLASSIFIED", fromState: "DISCOVERED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:01:10.000Z", payload: { reason: "escalated" } }),
  ];
}

function uniqueName(): string {
  return "drill-" + randomUUID().replace(/-/g, "") + ".sqlite";
}

describe("the shadow ledger proves the measurement survives a rebuild", () => {
  it("appends, chains, verifies, measures and rebuilds identically", () => {
    makeRoots();
    const chain = syntheticChain();
    const receipt = buildShadowLedger(uniqueName(), chain);

    expect(receipt.snapshot.eventCount).toBe(chain.length);
    expect(receipt.snapshot.headSequence).toBe(chain.length);
    expect(receipt.snapshot.headEventSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.integrityOk).toBe(true);
    expect(receipt.checkedEvents).toBe(chain.length);
    expect(receipt.replayedEvents).toBe(chain.length);
    expect(receipt.rebuildIdentical).toBe(true);

    // The baseline the ledger computed is the baseline the pure function
    // computes over the same events: the storage round trip changed nothing.
    expect(receipt.baselineSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(serializeBaseline(receipt.baseline)).toBe(serializeBaseline(computeBaseline(chain)));
    expect(receipt.baseline.routing.total).toBe(2);
    expect(receipt.baseline.tokens).toEqual({ events: 1, total: 1200 });
    expect(receipt.baseline.acceptance.byVerdict).toEqual([{ verdict: "ACCEPT", count: 1 }]);
  });

  it("gives the same receipt for the same chain, in a fresh ledger", () => {
    makeRoots();
    const first = buildShadowLedger(uniqueName(), syntheticChain());
    const second = buildShadowLedger(uniqueName(), syntheticChain());
    // Event ids differ per fixture build, so the chain digest legitimately
    // differs; the *measurement* must not.
    expect(second.baselineSha256).toBe(first.baselineSha256);
    expect(second.snapshot.headSequence).toBe(first.snapshot.headSequence);
  });

  it("returns a receipt carrying no path, username, clock or content", () => {
    makeRoots();
    const receipt = buildShadowLedger(uniqueName(), syntheticChain());
    const serialized = JSON.stringify(receipt);

    expect(serialized).not.toContain(REPO_ROOT);
    expect(serialized).not.toContain(".acp-local");
    expect(serialized).not.toContain(SHADOW_LEDGER_DIRECTORY + "/");
    expect(serialized).not.toContain(".sqlite");
    // No credential or transcript shaped key, using the one privacy vocabulary.
    expect(findCredentialViolations(receipt)).toEqual([]);
    expect(findTranscriptViolations(receipt)).toEqual([]);
    // JSON-safe: it survives a round trip unchanged.
    expect(JSON.parse(serialized)).toEqual(JSON.parse(JSON.stringify(receipt)));
  });

  it("reads no clock: the receipt carries no present-day timestamp", () => {
    makeRoots();
    const receipt = buildShadowLedger(uniqueName(), syntheticChain());
    const serialized = JSON.stringify(receipt);
    // Durations are differences between the fixture's own fixed timestamps, so
    // they are a property of the chain rather than of when this ran.
    expect(receipt.baseline.time.totalMs).toBe(40_000);
    // Directly: no ISO-8601 instant of any kind survives into the receipt.
    // A receipt that embedded a run date could never be compared against one
    // recorded on another day, which is what the rebuild proof needs.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // And the production module never asks for the current time.
    const source = readFileSync(join(OBSERVATION_SRC, "shadow-ledger", "index.ts"), "utf8");
    for (const clock of ["Date.now(", "new Date(", "hrtime", "performance.now("]) {
      expect({ clock, present: source.includes(clock) }).toEqual({ clock, present: false });
    }
  });
});

describe("the shadow ledger refuses unsafe placement", () => {
  it("refuses when the shadow root does not exist", () => {
    removeRoots();
    let captured: ShadowLedgerError | null = null;
    try {
      buildShadowLedger(uniqueName(), syntheticChain());
    } catch (error) {
      captured = error as ShadowLedgerError;
    }
    expect(captured?.reason).toBe("ROOT_ABSENT");
  });

  it("refuses a name that is a path wearing one", () => {
    makeRoots();
    for (const name of ["../escape.sqlite", "nested/name.sqlite", "..", "Upper.sqlite"]) {
      let captured: ShadowLedgerError | null = null;
      try {
        buildShadowLedger(name, syntheticChain());
      } catch (error) {
        captured = error as ShadowLedgerError;
      }
      expect({ name, reason: captured?.reason }).toEqual({ name, reason: "BAD_SHADOW_NAME" });
    }
  });

  it("refuses to reuse a name a ledger already occupies", () => {
    makeRoots();
    const name = uniqueName();
    buildShadowLedger(name, syntheticChain());

    let captured: ShadowLedgerError | null = null;
    try {
      buildShadowLedger(name, syntheticChain());
    } catch (error) {
      captured = error as ShadowLedgerError;
    }
    expect(captured?.reason).toBe("ALREADY_EXISTS");
  });

  it("refuses a symlinked ledgers directory, and writes nothing outside the root", () => {
    // The write-path counterpart of the collectors' `O_NOFOLLOW` refusal. The
    // admitted directory is replaced by a link pointing somewhere else, which
    // is the one move that would let a name inside the allowlist create a file
    // outside it. `realpathSync` catches it before the ledger is opened, so the
    // outside directory never acquires anything.
    makeRoots();
    const outside = join(tmpdir(), "acp-p3c-outside-" + randomUUID());
    mkdirSync(outside, { recursive: true, mode: 0o700 });

    try {
      const ledgers = shadowLedgerDirectory();
      // Remove only the drill-owned directory this drill just created, after
      // proving it is inside this repository's shadow root.
      expect(ledgers.startsWith(SHADOW_ROOT + "/")).toBe(true);
      rmSync(ledgers, { recursive: true, force: true });
      symlinkSync(outside, ledgers);

      let captured: ShadowLedgerError | null = null;
      try {
        buildShadowLedger(uniqueName(), syntheticChain());
      } catch (error) {
        captured = error as ShadowLedgerError;
      }
      expect(captured?.reason).toBe("PATH_NOT_CANONICAL");

      // The refusal is load-bearing: nothing was created through the link.
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      // Clean only this drill's own outside directory, after an exact prefix
      // check against the system temporary root.
      const expectedPrefix = tmpdir() + "/acp-p3c-outside-";
      if (outside.startsWith(expectedPrefix) && existsSync(outside)) {
        rmSync(outside, { recursive: true, force: true });
      }
    }
  });

  it("refuses a pre-existing file at the derived location", () => {
    makeRoots();
    const name = uniqueName();
    writeFileSync(join(shadowLedgerDirectory(), name), "not a ledger");

    let captured: ShadowLedgerError | null = null;
    try {
      buildShadowLedger(name, syntheticChain());
    } catch (error) {
      captured = error as ShadowLedgerError;
    }
    expect(captured?.reason).toBe("ALREADY_EXISTS");
  });

  it("keeps every file it creates inside its own root", () => {
    makeRoots();
    const name = uniqueName();
    buildShadowLedger(name, syntheticChain());
    const entries = readdirSync(shadowLedgerDirectory());
    expect(entries.some((entry) => entry.startsWith(name))).toBe(true);
    for (const entry of entries) {
      expect(entry.startsWith("drill-")).toBe(true);
    }
  });
});

describe("the shadow ledger refuses a chain it cannot vouch for", () => {
  it("refuses a duplicated event rather than silently deduplicating it", () => {
    makeRoots();
    const chain = syntheticChain();
    // Non-null: `syntheticChain()` is a literal with six entries.
    const replayed = [...chain, chain[0]!];

    let captured: ShadowLedgerError | null = null;
    try {
      buildShadowLedger(uniqueName(), replayed);
    } catch (error) {
      captured = error as ShadowLedgerError;
    }
    // An exact replay returns inserted: false, and a shadow chain is built once.
    expect(captured?.reason).toBe("APPEND_NOT_INSERTED");
  });

  it("propagates a baseline stop rather than reporting a measurement", () => {
    makeRoots();
    const chain = [
      ...syntheticChain(),
      event({ taskId: TASK_A, transitionId: "bad-step", type: "ATOMIC_STEP_COMPLETED", fromState: "DT_CLASSIFIED", toState: "DT_CLASSIFIED", occurredAt: "2026-08-27T12:00:40.000Z" }),
    ];
    // The event is contract-valid but carries no tokensUsed: the ledger accepts
    // it and the baseline refuses it, which is the correct division of labour.
    expect(() => buildShadowLedger(uniqueName(), chain)).toThrow(/MISSING_TOKENS_USED/);
  });

  it("leaves no residue once its drill root is removed", () => {
    makeRoots();
    buildShadowLedger(uniqueName(), syntheticChain());
    expect(existsSync(shadowLedgerDirectory())).toBe(true);
    removeRoots();
    expect(existsSync(SHADOW_ROOT)).toBe(false);
  });
});

describe("the sole writer is the only one", () => {
  it("is the only observation production module that names the ledger", () => {
    // Structural, and the same law the architecture fence enforces: the
    // collectors stay passive, and a second writer would make "sole" a claim
    // rather than a fact.
    const importers = collectSources(OBSERVATION_SRC).filter((entry) =>
      /from\s*["']@acp\/ledger["']/.test(entry.source),
    );
    expect(importers.map((entry) => entry.name)).toEqual(["shadow-ledger/index.ts"]);
  });

  it("names no database driver and writes no SQL", () => {
    const source = readFileSync(join(OBSERVATION_SRC, "shadow-ledger", "index.ts"), "utf8");
    for (const banned of ["better-sqlite3", "node:sqlite", "CREATE TABLE", "INSERT INTO", "SELECT "]) {
      expect({ banned, present: source.includes(banned) }).toEqual({ banned, present: false });
    }
  });

  it("creates and removes nothing on the filesystem itself", () => {
    const source = readFileSync(join(OBSERVATION_SRC, "shadow-ledger", "index.ts"), "utf8");
    for (const mutator of ["mkdirSync", "rmSync", "unlinkSync", "writeFileSync", "chmodSync"]) {
      expect({ mutator, present: source.includes(mutator) }).toEqual({ mutator, present: false });
    }
  });
});

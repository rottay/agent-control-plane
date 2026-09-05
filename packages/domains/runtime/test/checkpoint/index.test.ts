import { describe, expect, it } from "vitest";

import { ARTIFACT_REFUSALS } from "@acp/ledger";

import { CHECKPOINT_REFUSALS } from "../../src/checkpoint/index.js";
import type {
  CheckpointPort,
  CheckpointRefused,
  CheckpointSource,
} from "../../src/checkpoint/index.js";
import { LIFECYCLE_PLAN, READ_ONLY_PLAN } from "../../src/core/lifecycle/index.js";

/**
 * Evidence for the checkpoint vocabulary and the two injected surfaces.
 *
 * This module declares and never implements, so what can be asserted here is
 * exactly that: the refusal vocabulary is closed and complete, the source and
 * the port are satisfiable by an ordinary object, and no implementation of
 * either is reachable from this package. The behaviour of a real source lives
 * where the facts are — the daemon's own drills, over a real worktree — and
 * the behaviour of a real store lives in `@acp/ledger`'s suite.
 */

describe("the refusal vocabulary is closed, and complete", () => {
  it("names its own four reasons and carries the store's through unchanged", () => {
    const own = ["CHECKPOINT_INVALID", "GIT_HEAD_UNBORN", "GIT_UNOBSERVABLE", "PATH_MISSING"];

    // The four this module owns, in sorted order, first.
    expect(CHECKPOINT_REFUSALS.slice(0, own.length)).toEqual(own);
    expect([...own].sort()).toEqual(own);

    // Then the store's own, carried through **unchanged** rather than
    // re-spelled: a second vocabulary for the same refusal is two answers to
    // one question, and a name added upstream cannot fail to arrive here.
    expect(CHECKPOINT_REFUSALS.slice(own.length)).toEqual([...ARTIFACT_REFUSALS]);
    expect(CHECKPOINT_REFUSALS.length).toBe(own.length + ARTIFACT_REFUSALS.length);
  });

  it("is frozen, so a caller cannot widen the vocabulary it exhausts", () => {
    expect(Object.isFrozen(CHECKPOINT_REFUSALS)).toBe(true);
    expect(new Set(CHECKPOINT_REFUSALS).size).toBe(CHECKPOINT_REFUSALS.length);
  });
});

describe("the two surfaces are declarations, satisfiable from outside", () => {
  it("a source assembles for a step, or refuses in the store's own shape", () => {
    const refusal: CheckpointRefused = {
      ok: false,
      reason: "GIT_HEAD_UNBORN",
      at: "git.head",
    };
    const source: CheckpointSource = { assemble: () => refusal };

    // Both plans terminate in the same step object, so a source written against
    // one is written against both.
    const writerTerminal = LIFECYCLE_PLAN[LIFECYCLE_PLAN.length - 1];
    const readOnlyTerminal = READ_ONLY_PLAN[READ_ONLY_PLAN.length - 1];
    expect(writerTerminal?.eventType).toBe("CHECKPOINT_WRITTEN");
    expect(readOnlyTerminal?.eventType).toBe("CHECKPOINT_WRITTEN");
    if (writerTerminal === undefined || readOnlyTerminal === undefined) return;

    expect(source.assemble(writerTerminal)).toEqual(refusal);
    expect(source.assemble(readOnlyTerminal)).toEqual(refusal);
    expect(CHECKPOINT_REFUSALS).toContain(refusal.reason);
  });

  it("a port persists and reads, and both refusals are the one vocabulary", () => {
    const port: CheckpointPort = {
      persist: () => ({ ok: true, digest: "a".repeat(64), bytes: 12 }),
      read: () => ({ ok: false, reason: "ARTIFACT_ABSENT", at: "a".repeat(64) }),
    };

    const terminal = LIFECYCLE_PLAN[LIFECYCLE_PLAN.length - 1];
    if (terminal === undefined) return;

    const persisted = port.persist(terminal);
    expect(persisted.ok).toBe(true);
    const read = port.read("a".repeat(64));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // The read side draws from the same closed list, so a caller exhausting
    // `CHECKPOINT_REFUSALS` has exhausted both members.
    expect(CHECKPOINT_REFUSALS).toContain(read.reason);
  });
});

describe("the domain declares and never implements", () => {
  it("exports no source, no port and no factory that could build one", async () => {
    // The whole module, asked what it actually exports. A value here would be
    // an implementation in the one package that must not hold one: this domain
    // can spawn no git and owns no store, so anything it built would have to
    // invent one of the two.
    const module: Record<string, unknown> = await import("../../src/checkpoint/index.js");
    expect(Object.keys(module).sort()).toEqual(["CHECKPOINT_REFUSALS"]);
    expect(typeof module["CHECKPOINT_REFUSALS"]).toBe("object");
  });
});

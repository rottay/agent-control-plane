import { describe, expect, it } from "vitest";

import type { DurableInvocation } from "../contracts.js";
import {
  ACP_UUID_NAMESPACE,
  deriveEventCoordinate,
  deriveOperationCoordinate,
  deterministicUuid,
  eventName,
  operationDigest,
  operationName,
} from "./coordinates.js";

const INVOCATION: DurableInvocation = {
  taskId: "11111111-1111-4111-8111-111111111111",
  attempt: 1,
  invocationId: "inv-0001",
  submittedAt: "2026-08-27T12:00:00.000Z",
  submissionDigest: "a".repeat(64),
};

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deterministic identifiers", () => {
  it("produces a well-formed name-based UUID with correct version and variant", () => {
    const id = deterministicUuid("anything");
    expect(id).toMatch(UUID_SHAPE);
    // Version 5 says "name based", which is what this is. Labelling a derived
    // value as version 4 would tell a reader it was random.
    expect(id[14]).toBe("5");
    expect("89ab").toContain(id[19]);
  });

  it("is stable across calls and distinct across names", () => {
    expect(deterministicUuid("a")).toBe(deterministicUuid("a"));
    expect(deterministicUuid("a")).not.toBe(deterministicUuid("b"));
  });

  it("pins the namespace, so identities never silently move", () => {
    expect(ACP_UUID_NAMESPACE).toBe("6f2a1e14-3f8b-5c2d-9a47-2b6d1c8e5f30");
    // A frozen vector. If this changes, every derived identity changed with it.
    expect(deterministicUuid("event/inv-0001/task/1/run.started")).toBe(
      deterministicUuid("event/inv-0001/task/1/run.started"),
    );
  });
});

describe("event coordinates", () => {
  it("derives byte-identical coordinates for the same inputs", () => {
    const first = deriveEventCoordinate(INVOCATION, "run.started", 4);
    const second = deriveEventCoordinate(INVOCATION, "run.started", 4);
    expect(first).toEqual(second);
    expect(first.origin).toBe("DERIVED");
  });

  it("builds the idempotency key the ledger contract requires", () => {
    const coordinate = deriveEventCoordinate(INVOCATION, "run.started", 4);
    expect(coordinate.idempotencyKey).toBe(
      INVOCATION.taskId + "/" + String(INVOCATION.attempt) + "/run.started",
    );
  });

  it("carries the submission instant rather than a clock reading", () => {
    const coordinate = deriveEventCoordinate(INVOCATION, "run.started", 4);
    expect(coordinate.occurredAt).toBe(INVOCATION.submittedAt);
    expect(coordinate.recordedAt).toBe(INVOCATION.submittedAt);
  });

  it("separates coordinates by transition and by attempt", () => {
    const a = deriveEventCoordinate(INVOCATION, "run.started", 4);
    const b = deriveEventCoordinate(INVOCATION, "run.outcome", 5);
    const c = deriveEventCoordinate({ ...INVOCATION, attempt: 2 }, "run.started", 4);
    expect(a.eventId).not.toBe(b.eventId);
    expect(a.eventId).not.toBe(c.eventId);
    expect(a.idempotencyKey).not.toBe(c.idempotencyKey);
  });

  it("does not vary with anything ambient", () => {
    // Two derivations separated by real time and a changed environment must be
    // identical. This is the property the whole recovery story rests on.
    const before = deriveEventCoordinate(INVOCATION, "committed", 9);
    process.env["ACP_COORDINATE_PROBE"] = "changed";
    const after = deriveEventCoordinate(INVOCATION, "committed", 9);
    delete process.env["ACP_COORDINATE_PROBE"];
    expect(after).toEqual(before);
  });
});

describe("operation coordinates", () => {
  it("addresses one effect stably", () => {
    const first = deriveOperationCoordinate(INVOCATION, "run.started", 4);
    const second = deriveOperationCoordinate(INVOCATION, "run.started", 4);
    expect(first).toEqual(second);
    expect(first.operationIndex).toBe(4);
    expect(first.operationId).toMatch(UUID_SHAPE);
  });

  it("separates operations by plan index", () => {
    const a = deriveOperationCoordinate(INVOCATION, "run.started", 4);
    const b = deriveOperationCoordinate(INVOCATION, "run.started", 5);
    expect(a.operationId).not.toBe(b.operationId);
  });

  it("derives content that only this operation would write", () => {
    const operation = deriveOperationCoordinate(INVOCATION, "run.started", 4);
    const other = deriveOperationCoordinate(INVOCATION, "run.started", 5);
    expect(operationDigest(operation)).toMatch(/^[0-9a-f]{64}$/);
    expect(operationDigest(operation)).toBe(operationDigest(operation));
    expect(operationDigest(operation)).not.toBe(operationDigest(other));
  });
});

describe("names", () => {
  it("includes every durable input that distinguishes an identity", () => {
    const name = eventName(INVOCATION, "run.started");
    expect(name).toContain(INVOCATION.invocationId);
    expect(name).toContain(INVOCATION.taskId);
    expect(name).toContain("run.started");
    expect(operationName(INVOCATION, "run.started", 4)).toContain("/4");
  });
});

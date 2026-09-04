import { canonicalJsonStringify } from "@acp/ledger";
import { describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import type { LedgerPort } from "../../src/core/step-executor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import { deriveInvocation } from "../../src/submission/index.js";
import { runToolCall, toolOperationScopeId } from "../../src/tool-call/index.js";
import type { ToolCallExecution, ToolCallPort, ToolCallPortOutcome } from "../../src/tool-call/index.js";
import type { ToolCallFacts } from "../../src/tool-receipt/index.js";

/**
 * Evidence for the explicit tool-call operation (V2-B4b stage 3B).
 *
 * The module's whole contract is an ordering invariant — *throw = the request
 * never became an operation, return = there is always a row* — so the evidence
 * is built to falsify exactly that. The port is a **counting** fake, and every
 * refusal case asserts the call count is still zero rather than merely that
 * something threw: a check that runs after the port was touched would still
 * throw, and only the counter can tell the two apart.
 *
 * The ledger fake **throws on a repeated idempotency key**, deliberately. That
 * is what the real ledger does, and it makes the replay claim non-vacuous: if
 * `runToolCall` ever fell through to a second append under a spent coordinate,
 * these tests would fail loudly instead of quietly recording a second row.
 */

const TASK = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a02";
const OTHER_TASK = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a03";
const IDENTITY = "claude/opus/implementer/01";
const ACCOUNT = "acct-primary";
const SUBMITTED_AT = "2026-09-03T12:00:00.000Z";
const DIGEST = "a".repeat(64);

const COMPLETED: ToolCallFacts = {
  serverId: "fs-local",
  toolName: "read_file",
  transport: "STDIO",
  outcome: "COMPLETED",
  refusal: null,
  argumentBytes: 128,
  resultBytes: 4_096,
  contentBlocks: 2,
};

const REFUSED: ToolCallFacts = {
  serverId: "fs-local",
  toolName: "read_file",
  transport: "STDIO",
  outcome: "REFUSED",
  refusal: "TOOL_NOT_ALLOWED",
  argumentBytes: 128,
  resultBytes: 0,
  contentBlocks: 0,
};

const PAYLOAD_KEYS = [
  "accountId",
  "argumentBytes",
  "contentBlocks",
  "outcome",
  "refusal",
  "resultBytes",
  "serverId",
  "toolName",
  "transport",
];

interface FakeLedger extends LedgerPort {
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * A ledger that holds one discovered task and refuses a spent coordinate.
 *
 * `latestAttempt` is a parameter because attempt bounds are one of the nine
 * prechecks, and `taskId` is too so that "the task the ledger has never seen"
 * is a real absence rather than a flag.
 */
function fakeLedger(options?: {
  readonly taskId?: string;
  readonly latestAttempt?: number;
}): FakeLedger {
  const taskId = options?.taskId ?? TASK;
  const latestAttempt = options?.latestAttempt ?? 1;
  const byKey = new Map<string, string>();
  const rows: Record<string, unknown>[] = [];

  return {
    rows,
    append(candidate: unknown) {
      const event = candidate as Record<string, unknown>;
      const key = String(event["idempotencyKey"]);
      if (byKey.has(key)) {
        throw new Error("idempotency conflict: " + key + " is already spent");
      }
      byKey.set(key, canonicalJsonStringify(event));
      rows.push(event);
      return { inserted: true, record: { event: event as never } };
    },
    getTask(requested: string) {
      if (requested !== taskId) return null;
      return { currentState: "RUNNING" as const, latestAttempt, firstSequence: 1 };
    },
    getEventBySequence() {
      return null;
    },
    getEventByIdempotencyKey(key: string) {
      const canonicalJson = byKey.get(key);
      return canonicalJson === undefined ? null : { canonicalJson };
    },
  };
}

interface CountingPort extends ToolCallPort {
  readonly calls: () => number;
}

function countingPort(
  outcome: ToolCallPortOutcome,
  options?: { readonly scopeId?: string },
): CountingPort {
  let calls = 0;
  return {
    scopeId: options?.scopeId ?? toolOperationScopeId(TASK, 1, 0),
    calls: () => calls,
    callTool: () => {
      calls += 1;
      return Promise.resolve(outcome);
    },
  };
}

function completedOutcome(receipt: ToolCallFacts = COMPLETED): ToolCallPortOutcome {
  return { ok: true, receipt, content: ["the file body", "a second block"] };
}

function invocationFor(taskId = TASK, attempt = 1, submittedAt = SUBMITTED_AT): DurableInvocation {
  return deriveInvocation(taskId, attempt, submittedAt, DIGEST);
}

function executionFor(overrides?: Partial<ToolCallExecution>): ToolCallExecution {
  return {
    invocation: invocationFor(),
    operationIndex: 0,
    callIndex: 0,
    accountId: ACCOUNT,
    identity: IDENTITY,
    serverId: "fs-local",
    toolName: "read_file",
    arguments: { path: "/etc/hosts" },
    ...overrides,
  };
}

describe("a coordinate is spent once", () => {
  it("replays the recorded row without calling the port a second time", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    const first = await runToolCall(ledger, port, executionFor());
    const second = await runToolCall(ledger, port, executionFor());

    expect(first.replayed).toBe(false);
    expect(first.content).toEqual(["the file body", "a second block"]);

    expect(second.replayed).toBe(true);
    expect(port.calls()).toBe(1);
    expect(ledger.rows).toHaveLength(1);
    expect(second.eventId).toBe(first.eventId);
    expect(second.transitionId).toBe(first.transitionId);
    expect(second.content).toEqual([]);
    expect(second.at).toBeNull();
    expect(second.outcome).toBe("COMPLETED");
    expect(second.serverId).toBe("fs-local");
    expect(second.accountId).toBe(ACCOUNT);
    expect(second.argumentBytes).toBe(128);
    expect(second.resultBytes).toBe(4_096);
    expect(second.contentBlocks).toBe(2);
  });

  it("returns the first row under a different submittedAt, and does not conflict", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    const first = await runToolCall(ledger, port, executionFor());
    // Same coordinate, different instant. The idempotency key is built from
    // (taskId, attempt, transitionId) alone, so this is the same key over
    // different canonical bytes -- the case a second append would throw on.
    const replayed = await runToolCall(
      ledger,
      port,
      executionFor({ invocation: invocationFor(TASK, 1, "2026-09-03T18:00:00.000Z") }),
    );

    expect(replayed.replayed).toBe(true);
    expect(replayed.eventId).toBe(first.eventId);
    expect(port.calls()).toBe(1);
    expect(ledger.rows).toHaveLength(1);
  });

  it("returns the first row under different arguments, and does not conflict", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    const first = await runToolCall(ledger, port, executionFor());

    // A different body would produce a different receipt, and therefore
    // different payload bytes under the same key. Stage 1 refused an argument
    // digest, so this is undetectable from here; returning the recorded row is
    // the fail-safe semantics, and never a second real effect.
    const wider = countingPort(completedOutcome({ ...COMPLETED, argumentBytes: 9_001 }));
    const replayed = await runToolCall(
      ledger,
      wider,
      executionFor({ arguments: { path: "/etc/shadow" } }),
    );

    expect(replayed.replayed).toBe(true);
    expect(replayed.argumentBytes).toBe(128);
    expect(replayed.eventId).toBe(first.eventId);
    expect(wider.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(1);
  });
});

describe("throw means the request never became an operation", () => {
  it("refuses a tool name that is not a bounded identifier, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    await expect(
      runToolCall(ledger, port, executionFor({ toolName: "rm -rf /" })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("refuses an account id that is not a bounded identifier, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    await expect(
      runToolCall(ledger, port, executionFor({ accountId: "acct primary" })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
  });

  it("refuses an identity outside the worker grammar, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    // Correction 4's case. Without this precheck the refusal would be built
    // from the raw identity and would throw inside the recorder -- after the
    // port had already been touched, which the invariant forbids.
    await expect(
      runToolCall(ledger, port, executionFor({ identity: "not-an-identity" })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("refuses a negative operationIndex, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    // `toolCallTransitionId(-1, 0)` is "tool.-1.0", which satisfies the
    // contract's transition-id grammar and would otherwise be recorded.
    await expect(
      runToolCall(ledger, port, executionFor({ operationIndex: -1 })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
  });

  it("refuses a non-integer callIndex, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    await expect(
      runToolCall(ledger, port, executionFor({ callIndex: 1.5 })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
  });

  it("refuses a scope opened for another operation, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome(), {
      scopeId: toolOperationScopeId(TASK, 1, 7),
    });

    await expect(runToolCall(ledger, port, executionFor())).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
  });

  it("refuses a task the ledger has never seen, before any call", async () => {
    const ledger = fakeLedger({ taskId: OTHER_TASK });
    const port = countingPort(completedOutcome());

    await expect(runToolCall(ledger, port, executionFor())).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
  });

  // The three below close the gap the post-audit drilled: each was a value the
  // recorder refuses inside `ControlPlaneEvent.parse`, which is *after* the
  // port has already run — a real effect with no row, the one outcome the
  // headline invariant forbids. Each asserts zero port calls and zero rows,
  // which is what distinguishes a check that ran before the port from the
  // `ZodError` that used to arrive after it.

  it("refuses a causedBy that is not an event id, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    await expect(
      runToolCall(ledger, port, executionFor({ causedBy: "not-a-uuid" })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("admits an absent causedBy, which is the normal case", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    // An omitted field and an explicit null are the same answer, exactly as the
    // recorder reads them. Without this the refusal above could be passing for
    // the wrong reason — by refusing every call that names no cause.
    const omitted = await runToolCall(ledger, port, executionFor());
    expect(omitted.replayed).toBe(false);
    expect(port.calls()).toBe(1);

    const other = fakeLedger();
    const otherPort = countingPort(completedOutcome());
    const withNull = await runToolCall(other, otherPort, executionFor({ causedBy: null }));
    expect(withNull.replayed).toBe(false);
    expect(otherPort.calls()).toBe(1);
  });

  it("refuses an invocation attempt of zero, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome(), {
      scopeId: toolOperationScopeId(TASK, 0, 0),
    });

    // Precheck 8 compares the attempt against the task's latest and so admits
    // 0: it is not greater than 1. The event contract's `attempt` is
    // `int().positive()`, and it is that schema the check now uses.
    await expect(
      runToolCall(ledger, port, executionFor({ invocation: invocationFor(TASK, 0) })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("refuses a fractional invocation attempt, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome(), {
      scopeId: toolOperationScopeId(TASK, 0.5, 0),
    });

    // A fraction also reaches `toolOperationScopeId` and yields
    // "tool/<task>/0.5/0" -- a scope id no resumed attempt could rebuild.
    await expect(
      runToolCall(ledger, port, executionFor({ invocation: invocationFor(TASK, 0.5) })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("refuses an invocation attempt above the contract's ceiling, before any call", async () => {
    const ledger = fakeLedger({ latestAttempt: 100_000 });
    const port = countingPort(completedOutcome(), {
      scopeId: toolOperationScopeId(TASK, 10_001, 0),
    });

    await expect(
      runToolCall(ledger, port, executionFor({ invocation: invocationFor(TASK, 10_001) })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("refuses an invocation submittedAt that is not a timestamp, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    // `submittedAt` becomes the row's `occurredAt` and `recordedAt`.
    await expect(
      runToolCall(
        ledger,
        port,
        executionFor({ invocation: invocationFor(TASK, 1, "yesterday") }),
      ),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("refuses an attempt the task has not reached, before any call", async () => {
    const ledger = fakeLedger({ latestAttempt: 1 });
    const port = countingPort(completedOutcome(), {
      scopeId: toolOperationScopeId(TASK, 2, 0),
    });

    await expect(
      runToolCall(ledger, port, executionFor({ invocation: invocationFor(TASK, 2) })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });
});

describe("return means there is always a row", () => {
  it("records a refused call and carries its reason and field path back", async () => {
    const ledger = fakeLedger();
    const port = countingPort({
      ok: false,
      receipt: REFUSED,
      refusal: "TOOL_NOT_ALLOWED",
      at: "request.toolName",
    });

    const result = await runToolCall(ledger, port, executionFor());

    expect(port.calls()).toBe(1);
    expect(ledger.rows).toHaveLength(1);
    expect(result.replayed).toBe(false);
    expect(result.outcome).toBe("REFUSED");
    expect(result.refusal).toBe("TOOL_NOT_ALLOWED");
    expect(result.at).toBe("request.toolName");
    expect(result.content).toEqual([]);
  });

  it("carries a refusal through a replay with its reason but without its field path", async () => {
    const ledger = fakeLedger();
    const port = countingPort({
      ok: false,
      receipt: REFUSED,
      refusal: "TOOL_NOT_ALLOWED",
      at: "request.toolName",
    });

    await runToolCall(ledger, port, executionFor());
    const replayed = await runToolCall(ledger, port, executionFor());

    expect(replayed.replayed).toBe(true);
    expect(replayed.refusal).toBe("TOOL_NOT_ALLOWED");
    // `at` is not among the nine durable keys, so a replay cannot rebuild it.
    expect(replayed.at).toBeNull();
    expect(port.calls()).toBe(1);
  });
});

describe("the seam is a grammar, and the row is nine scalars", () => {
  it("keeps a real receipt's sessionId and identity out of the durable payload", async () => {
    const ledger = fakeLedger();
    // A real `ToolCallReceipt` is structurally assignable to `ToolCallFacts`
    // and still carries these two at runtime. The recorder writes its payload
    // field by field for exactly this reason; this proves the spread never
    // crept back in.
    const realShaped = {
      ...COMPLETED,
      sessionId: "tool/session/should-never-be-durable",
      identity: IDENTITY,
    } as ToolCallFacts;
    const port = countingPort(completedOutcome(realShaped));

    await runToolCall(ledger, port, executionFor());

    const row = ledger.rows[0];
    if (row === undefined) throw new Error("no row appended");
    const payload = row["payload"] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(PAYLOAD_KEYS);
    expect(payload["sessionId"]).toBeUndefined();
    expect(payload["identity"]).toBeUndefined();
    expect(row["emittedBy"]).toBe(IDENTITY);
  });

  it("never lets content reach an appended payload", async () => {
    const ledger = fakeLedger();
    const sentinel = "SENTINEL-CONTENT-MUST-NOT-BE-DURABLE";
    const port = countingPort({ ok: true, receipt: COMPLETED, content: [sentinel] });

    const result = await runToolCall(ledger, port, executionFor());

    expect(result.content).toEqual([sentinel]);
    const serialized = JSON.stringify(ledger.rows);
    expect(serialized).not.toContain(sentinel);
    // Non-vacuous: the row that does not carry the content does carry its size.
    expect(serialized).toContain("argumentBytes");
  });
});

describe("the scope id is disjoint from an execution session", () => {
  it("leads with the literal tool segment and carries four segments", () => {
    const scopeId = toolOperationScopeId(TASK, 1, 0);

    expect(scopeId).toBe("tool/" + TASK + "/1/0");
    const segments = scopeId.split("/");
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe("tool");
    // An `executionSessionId` is `taskId + "/" + attempt + "/" + accountId`:
    // three segments whose first is a task Uuid, which can never be "tool".
    expect(segments[0]).not.toBe(TASK);
  });
});

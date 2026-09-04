import { canonicalJsonStringify } from "@acp/ledger";
import { describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import type { LedgerPort } from "../../src/core/step-executor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import { deriveEventCoordinate } from "../../src/core/coordinates/index.js";
import { deriveInvocation } from "../../src/submission/index.js";
import {
  TOOL_CALL_BOUND_MS,
  TOOL_CLAIM_MARGIN_MS,
  TOOL_CLAIM_TTL_MS,
  TOOL_POSTCONDITION_UNKNOWN,
  ToolClaimHeldError,
  runToolCall,
  toolOperationScopeId,
} from "../../src/tool-call/index.js";
import type {
  ToolCallExecution,
  ToolCallPort,
  ToolCallPortOutcome,
  ToolClaimPort,
  ToolClaimRecord,
  ToolClaimVerdict,
} from "../../src/tool-call/index.js";
import type { ToolCallFacts } from "../../src/tool-receipt/index.js";

/**
 * An in-memory claim port with the store's own semantics.
 *
 * The real store is drilled in `@acp/ledger`; what these cases need is the
 * *operation's* behaviour around it — which claim it takes, when it refuses, and
 * that it never reaches the port without one. The clock is a value the test
 * moves, which is how an expiry boundary is crossed without sleeping.
 */
function claimPortOf(options: { now?: () => string; seed?: Map<string, ToolClaimRecord> } = {}): ToolClaimPort & {
  readonly rows: Map<string, ToolClaimRecord>;
  readonly calls: string[];
} {
  const rows = options.seed ?? new Map<string, ToolClaimRecord>();
  const calls: string[] = [];
  const now = options.now ?? ((): string => "2026-09-04T05:00:00.000Z");
  return {
    rows,
    calls,
    now,
    transact(coordinateKey: string, decide: (current: ToolClaimRecord | null) => ToolClaimVerdict) {
      const current = rows.get(coordinateKey) ?? null;
      const verdict = decide(current);
      calls.push(verdict.verb);
      if (verdict.verb === "TAKE") {
        // Also the store's: a settled coordinate is spent and never reclaimed.
        if (current !== null && current.state === "SETTLED") {
          throw new Error("a settled coordinate is spent and cannot be reclaimed");
        }
        const row = verdict.row as unknown as Record<string, unknown>;
        rows.set(coordinateKey, {
          coordinateKey,
          state: "CLAIMED",
          holder: String(row["holder"]),
          expiresAt: String(row["expiresAt"]),
          taskId: String(row["taskId"]),
          attempt: Number(row["attempt"]),
          transitionId: String(row["transitionId"]),
          submittedAt: String(row["submittedAt"]),
          accountId: String(row["accountId"]),
          serverId: String(row["serverId"]),
          toolName: String(row["toolName"]),
          argumentBytes: Number(row["argumentBytes"]),
        });
        return { verb: "TAKE", row: rows.get(coordinateKey) ?? null };
      }
      if (current === null) return { verb: verdict.verb, row: null };
      if (verdict.verb === "MARK_IN_FLIGHT") {
        rows.set(coordinateKey, { ...current, state: "IN_FLIGHT" });
        return { verb: "MARK_IN_FLIGHT", row: rows.get(coordinateKey) ?? null };
      }
      if (verdict.verb === "SETTLE") {
        // The real store refuses a second settle. Mirrored, because the poison
        // path deliberately settles a coordinate another recoverer may have
        // settled first, and a fake that accepted it would hide the throw the
        // operation has to survive.
        if (current.state === "SETTLED") throw new Error("this coordinate is already settled");
        rows.set(coordinateKey, { ...current, state: "SETTLED" });
        return { verb: "SETTLE", row: rows.get(coordinateKey) ?? null };
      }
      return { verb: "REFUSE", reason: verdict.reason, row: current };
    },
  };
}

/**
 * A claim row as the store would have written it, for the recovery drills.
 *
 * Seeding rather than driving: the cases below are about what a caller does on
 * finding a coordinate someone else left behind, and the someone else is by
 * definition a process this test cannot run.
 */
function seededClaim(overrides: Partial<ToolClaimRecord> = {}): Map<string, ToolClaimRecord> {
  const key = claimKeyFor();
  return new Map([
    [
      key,
      {
        coordinateKey: key,
        state: "IN_FLIGHT",
        holder: OTHER_IDENTITY,
        expiresAt: "2026-09-04T04:00:00.000Z",
        taskId: TASK,
        attempt: 1,
        transitionId: "tool.0.0",
        submittedAt: SUBMITTED_AT,
        accountId: ACCOUNT,
        serverId: "fs-local",
        toolName: "read_file",
        argumentBytes: 21,
        ...overrides,
      },
    ],
  ]);
}

/**
 * The coordinate every execution in this file lands on.
 *
 * Derived exactly as the operation derives it, rather than written out: a
 * hand-copied key would keep passing after the derivation changed, which is the
 * one way these drills could go quietly vacuous.
 */
function claimKeyFor(taskId = TASK, attempt = 1): string {
  return deriveEventCoordinate(invocationFor(taskId, attempt), "tool.0.0", 0).idempotencyKey;
}

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
/** A second worker, so "signed by the holder" cannot pass by coincidence. */
const OTHER_IDENTITY = "claude/sonnet/implementer/07";
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

    const first = await runToolCall(ledger, port, claimPortOf(), executionFor());
    const second = await runToolCall(ledger, port, claimPortOf(), executionFor());

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

    const first = await runToolCall(ledger, port, claimPortOf(), executionFor());
    // Same coordinate, different instant. The idempotency key is built from
    // (taskId, attempt, transitionId) alone, so this is the same key over
    // different canonical bytes -- the case a second append would throw on.
    const replayed = await runToolCall(
      ledger,
      port,
      claimPortOf(),
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
    const first = await runToolCall(ledger, port, claimPortOf(), executionFor());

    // A different body would produce a different receipt, and therefore
    // different payload bytes under the same key. Stage 1 refused an argument
    // digest, so this is undetectable from here; returning the recorded row is
    // the fail-safe semantics, and never a second real effect.
    const wider = countingPort(completedOutcome({ ...COMPLETED, argumentBytes: 9_001 }));
    const replayed = await runToolCall(
      ledger,
      wider,
      claimPortOf(),
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
      runToolCall(ledger, port, claimPortOf(), executionFor({ toolName: "rm -rf /" })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("refuses an account id that is not a bounded identifier, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    await expect(
      runToolCall(ledger, port, claimPortOf(), executionFor({ accountId: "acct primary" })),
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
      runToolCall(ledger, port, claimPortOf(), executionFor({ identity: "not-an-identity" })),
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
      runToolCall(ledger, port, claimPortOf(), executionFor({ operationIndex: -1 })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
  });

  it("refuses a non-integer callIndex, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    await expect(
      runToolCall(ledger, port, claimPortOf(), executionFor({ callIndex: 1.5 })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
  });

  it("refuses a scope opened for another operation, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome(), {
      scopeId: toolOperationScopeId(TASK, 1, 7),
    });

    await expect(runToolCall(ledger, port, claimPortOf(), executionFor())).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
  });

  it("refuses a task the ledger has never seen, before any call", async () => {
    const ledger = fakeLedger({ taskId: OTHER_TASK });
    const port = countingPort(completedOutcome());

    await expect(runToolCall(ledger, port, claimPortOf(), executionFor())).rejects.toThrow(SupervisorError);
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
      runToolCall(ledger, port, claimPortOf(), executionFor({ causedBy: "not-a-uuid" })),
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
    const omitted = await runToolCall(ledger, port, claimPortOf(), executionFor());
    expect(omitted.replayed).toBe(false);
    expect(port.calls()).toBe(1);

    const other = fakeLedger();
    const otherPort = countingPort(completedOutcome());
    const withNull = await runToolCall(other, otherPort, claimPortOf(), executionFor({ causedBy: null }));
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
      runToolCall(ledger, port, claimPortOf(), executionFor({ invocation: invocationFor(TASK, 0) })),
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
      runToolCall(ledger, port, claimPortOf(), executionFor({ invocation: invocationFor(TASK, 0.5) })),
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
      runToolCall(ledger, port, claimPortOf(), executionFor({ invocation: invocationFor(TASK, 10_001) })),
    ).rejects.toThrow(SupervisorError);
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("refuses an invocation submittedAt that is not a timestamp, before any call", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());

    // `submittedAt` becomes the row's `occurredAt` and `recordedAt`.
    await expect(
      runToolCall(ledger, port, claimPortOf(), executionFor({ invocation: invocationFor(TASK, 1, "yesterday") }),
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
      runToolCall(ledger, port, claimPortOf(), executionFor({ invocation: invocationFor(TASK, 2) })),
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

    const result = await runToolCall(ledger, port, claimPortOf(), executionFor());

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

    await runToolCall(ledger, port, claimPortOf(), executionFor());
    const replayed = await runToolCall(ledger, port, claimPortOf(), executionFor());

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

    await runToolCall(ledger, port, claimPortOf(), executionFor());

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

    const result = await runToolCall(ledger, port, claimPortOf(), executionFor());

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


/**
 * The cross-process arbitration of the effect (V2 X1b).
 *
 * Stage 3B proved the *receipt* was spent once. These cases are about the
 * *effect*, which is the half the ledger cannot arbitrate: two processes that
 * both read "no receipt" both ran a real tool, and the second append was
 * absorbed as an exact replay — one row for two effects.
 *
 * What is drilled here is the operation's behaviour around the claim, not the
 * store: which verdict it asks for, when it refuses, that it never reaches the
 * port without a claim, and that a coordinate it cannot resolve is closed
 * rather than re-run. The store's own arbitration is drilled in `@acp/ledger`,
 * against SQLite and across real processes.
 *
 * Every instant is a value, so an expiry boundary is crossed without sleeping.
 */
describe("the coordinate is arbitrated before the effect", () => {
  it("takes the claim, opens the window, and settles only after the receipt", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    const claims = claimPortOf();

    const result = await runToolCall(ledger, port, claims, executionFor());

    expect(result.replayed).toBe(false);
    expect(port.calls()).toBe(1);
    // The order is the contract, and it is asserted as a sequence rather than
    // as a set: TAKE before the window, the window before the effect, and the
    // settle last, after the row is durable.
    expect(claims.calls).toEqual(["TAKE", "MARK_IN_FLIGHT", "SETTLE"]);
    expect(claims.rows.get(claimKeyFor())?.state).toBe("SETTLED");
    expect(ledger.rows).toHaveLength(1);
  });

  it("refuses a live holder before the port is touched, and records nothing", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    // Unexpired, so the holder is alive by the only test this plane has.
    const claims = claimPortOf({
      seed: seededClaim({ state: "CLAIMED", expiresAt: "2026-09-04T06:00:00.000Z" }),
    });

    await expect(runToolCall(ledger, port, claims, executionFor())).rejects.toThrow(ToolClaimHeldError);

    // The module's headline invariant, now across processes: a loser never
    // became an operation. No child, no row — and the counter is what tells
    // "refused before the effect" apart from "refused after it".
    expect(port.calls()).toBe(0);
    expect(ledger.rows).toHaveLength(0);
  });

  it("names the refusal on the error, so a door classifies by fact and not by message", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    const claims = claimPortOf({
      seed: seededClaim({ state: "CLAIMED", expiresAt: "2026-09-04T06:00:00.000Z" }),
    });

    const error = await runToolCall(ledger, port, claims, executionFor()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ToolClaimHeldError);
    expect(error).toBeInstanceOf(SupervisorError);
    expect((error as ToolClaimHeldError).refusal).toBe("CLAIM_HELD");
    // Nothing about the winner reaches the sentence a door may surface.
    expect((error as Error).message).not.toContain(OTHER_IDENTITY);
    expect((error as Error).message).not.toContain(claimKeyFor());
  });

  it("reclaims an expired CLAIMED coordinate and walks it normally", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    // Expired, and the dead holder never opened the window: no effect was
    // attempted, so this is an ordinary reclaim rather than a recovery.
    const claims = claimPortOf({
      seed: seededClaim({ state: "CLAIMED", expiresAt: "2026-09-04T04:00:00.000Z" }),
    });

    const result = await runToolCall(ledger, port, claims, executionFor());

    expect(result.replayed).toBe(false);
    expect(result.outcome).toBe("COMPLETED");
    expect(port.calls()).toBe(1);
    expect(claims.calls).toEqual(["TAKE", "MARK_IN_FLIGHT", "SETTLE"]);
  });

  it("never re-runs an expired IN_FLIGHT coordinate; it settles it POSTCONDITION_UNKNOWN", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    const claims = claimPortOf({ seed: seededClaim() });

    const result = await runToolCall(ledger, port, claims, executionFor());

    // The dangerous case: the tool may have answered and the receipt may not
    // have landed. Nobody may re-run it, and nobody may pretend it completed.
    expect(port.calls()).toBe(0);
    expect(result.outcome).toBe("REFUSED");
    expect(result.refusal).toBe(TOOL_POSTCONDITION_UNKNOWN);
    expect(result.content).toEqual([]);
    expect(ledger.rows).toHaveLength(1);
    // The receipt is promoted first and the claim spent second. Spending it
    // first would put a window between "the store says spent" and "the ledger
    // says why" in which an append failure loses the evidence permanently.
    expect(claims.calls).toEqual(["REFUSE", "SETTLE"]);
    expect(claims.rows.get(claimKeyFor())?.state).toBe("SETTLED");
  });

  it("signs the poison as the original holder, not as the recoverer", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    const claims = claimPortOf({ seed: seededClaim() });

    await runToolCall(ledger, port, claims, executionFor());

    const [row] = ledger.rows;
    // `emittedBy` is a durable field. A recoverer that signed with its own
    // identity would build different canonical bytes under the same key, and
    // the second recoverer's append would take an idempotency conflict rather
    // than the exact replay this design depends on.
    expect(row?.["emittedBy"]).toBe(OTHER_IDENTITY);
    expect(row?.["emittedBy"]).not.toBe(IDENTITY);
    expect(row?.["causationId"]).toBeNull();
  });

  it("builds byte-identical poison receipts from two unlike recoverers", async () => {
    // Two independent recoverers meeting the same abandoned coordinate: they
    // differ in identity, in submission instant, in digest and in causation —
    // every input a naive rebuild would have taken from itself.
    const first = fakeLedger();
    const second = fakeLedger();
    const claimOf = (): ReturnType<typeof claimPortOf> => claimPortOf({ seed: seededClaim() });

    await runToolCall(first, countingPort(completedOutcome()), claimOf(), executionFor());
    await runToolCall(
      second,
      countingPort(completedOutcome()),
      claimOf(),
      executionFor({
        identity: "claude/fable/implementer/09",
        invocation: deriveInvocation(TASK, 1, "2026-09-04T09:30:00.000Z", "b".repeat(64)),
        causedBy: "9c1f5a4e-3d2b-4c6a-8f7e-1a2b3c4d5e6f",
      }),
    );

    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
    // Byte equality, not field equality: the claim is that a second append into
    // one ledger would be an exact replay, and that is a statement about bytes.
    expect(canonicalJsonStringify(second.rows[0]!)).toBe(canonicalJsonStringify(first.rows[0]!));
  });

  it("replays a spent coordinate without contending for the claim at all", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    const claims = claimPortOf();

    await runToolCall(ledger, port, claims, executionFor());
    const before = [...claims.calls];
    const replayed = await runToolCall(ledger, port, claims, executionFor());

    expect(replayed.replayed).toBe(true);
    // The receipt read precedes the claim, and that ordering is what makes a
    // crash between the append and the settle benign: the claim still says
    // IN_FLIGHT, but the receipt exists, so a later caller replays here and
    // never reaches the arbitration. Asserted as "no further verdicts".
    expect(claims.calls).toEqual(before);
    expect(port.calls()).toBe(1);
  });

  it("leaves the claim IN_FLIGHT when the port throws, so expiry classifies it", async () => {
    const ledger = fakeLedger();
    const claims = claimPortOf();
    const port: ToolCallPort = {
      scopeId: toolOperationScopeId(TASK, 1, 0),
      callTool: () => Promise.reject(new Error("the child died mid-call")),
    };

    await expect(runToolCall(ledger, port, claims, executionFor())).rejects.toThrow("the child died mid-call");

    // The load-bearing half of the `finally`. Settling here would spend a
    // coordinate on the one path where the effect may have run and left no
    // row — an unaudited effect, which is what this plane exists to refuse.
    expect(ledger.rows).toHaveLength(0);
    expect(claims.calls).toEqual(["TAKE", "MARK_IN_FLIGHT"]);
    expect(claims.rows.get(claimKeyFor())?.state).toBe("IN_FLIGHT");
  });

  it("leaves the claim IN_FLIGHT when the append throws, for the same reason", async () => {
    const claims = claimPortOf();
    const port = countingPort(completedOutcome());
    const ledger = fakeLedger();
    const broken: FakeLedger = {
      ...ledger,
      append: () => {
        throw new Error("the ledger is unavailable");
      },
    };

    await expect(runToolCall(broken, port, claims, executionFor())).rejects.toThrow("the ledger is unavailable");

    // The tool ran and no row exists. Exactly the window the poison covers, and
    // it is reached only by leaving the claim where it is.
    expect(port.calls()).toBe(1);
    expect(claims.rows.get(claimKeyFor())?.state).toBe("IN_FLIGHT");
  });

  it("survives a settle another recoverer already took", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    // Two recoverers may reach a poisoned coordinate together. That is the
    // intended shape, not a race to be excluded: both rebuild the same bytes,
    // so one appends and the other replays. The loser of the *settle* then
    // meets a store that refuses a second settle — and that throw must not
    // escape, because the receipt is the record and who settled the claim is
    // not. Driven by a port whose SETTLE always refuses.
    const underlying = claimPortOf({ seed: seededClaim() });
    const contended: ToolClaimPort = {
      now: underlying.now,
      transact: (key, decide) => {
        const verdict = decide(underlying.rows.get(key) ?? null);
        if (verdict.verb === "SETTLE") throw new Error("this coordinate is already settled");
        return underlying.transact(key, () => verdict);
      },
    };

    const result = await runToolCall(ledger, port, contended, executionFor());

    expect(result.refusal).toBe(TOOL_POSTCONDITION_UNKNOWN);
    expect(ledger.rows).toHaveLength(1);
    expect(port.calls()).toBe(0);
  });

  it("derives the claim's life from the tool's bound and the append margin", () => {
    // Derived rather than guessed, and restated rather than imported because
    // this stratum cannot reach `@acp/tools`. If the tool edge's bound moves,
    // this is the assertion that has to move with it.
    expect(TOOL_CLAIM_TTL_MS).toBe(TOOL_CALL_BOUND_MS + TOOL_CLAIM_MARGIN_MS);
    expect(TOOL_CLAIM_TTL_MS).toBeGreaterThan(TOOL_CALL_BOUND_MS);
  });

  it("puts a byte count on the claim, and never the bytes it counts", async () => {
    const ledger = fakeLedger();
    const port = countingPort(completedOutcome());
    const claims = claimPortOf();
    const sentinel = "correct-horse-battery-staple";

    await runToolCall(ledger, port, claims, executionFor({ arguments: { path: sentinel } }));

    const claim = claims.rows.get(claimKeyFor());
    expect(claim?.argumentBytes).toBeGreaterThan(0);
    // Non-vacuous: the sentinel is in the arguments that produced the count.
    expect(JSON.stringify(claim)).not.toContain(sentinel);
  });
});

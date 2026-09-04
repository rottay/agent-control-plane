import type { ResolvedRoute } from "@acp/contracts";
import { openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import { deterministicUuid } from "../../src/core/coordinates/index.js";
import { LIFECYCLE_PLAN } from "../../src/core/lifecycle/index.js";
import { appendPlanStep } from "../../src/core/step-executor/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import { recordToolCall, toolCallTransitionId } from "../../src/tool-receipt/index.js";
import type { ToolCallFacts } from "../../src/tool-receipt/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";

/**
 * Evidence for the durable tool-call receipt (V2-B4b stage 2).
 *
 * Two claims, and the second is the reason the module exists. The first is the
 * house determinism law the usage recorder already carries: the event reaches
 * the ledger without a clock, replays to one row, and refuses to invent the
 * task it belongs to. The second is redaction *at the producer* — the payload
 * is nine safe scalars, and nothing a caller hands over outside that set can
 * reach a durable row, including the members a real `ToolCallReceipt` carries
 * at runtime but `ToolCallFacts` does not name.
 */

const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const AT = "2026-08-30T15:00:00.000Z";
const ACCOUNT = "acct-primary";

/** The nine recordable facts of one completed call. */
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

const scenarios: string[] = [];
const ledgers: Ledger[] = [];

function scenario(id: string): ScenarioRoot {
  scenarios.push(id);
  return resolveScenarioRoot(id);
}

function invocationFor(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("tool-receipt/" + taskId),
    submittedAt: AT,
    submissionDigest: "d".repeat(64),
  };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const id of scenarios.splice(0)) removeScenarioRoot(id);
});

/** A ledger holding one discovered task, which is what the module requires. */
function openWithTask(
  id: string,
  taskId: string,
): { ledger: Ledger; invocation: DurableInvocation } {
  const root = scenario(id);
  const ledger = openLedger(scenarioLedgerPath(root));
  ledgers.push(ledger);
  const invocation = invocationFor(taskId);
  const context: BeatContext = {
    ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
    invocation,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    route: TEST_ROUTE,
    initiativeId: INITIATIVE_ID,
  };
  const step = LIFECYCLE_PLAN[0];
  if (step === undefined) throw new Error("no plan step");
  appendPlanStep(context, step);
  return { ledger, invocation };
}

describe("tool-call receipts reach the ledger", () => {
  it("records a completed call as a same-state passthrough (A1)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-basic",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b01",
    );
    const before = ledger.getTask(invocation.taskId)?.currentState;

    const result = recordToolCall(ledger, {
      invocation,
      accountId: ACCOUNT,
      facts: COMPLETED,
      transitionId: toolCallTransitionId(0, 0),
      emittedBy: EMITTED_BY,
    });

    expect(result.inserted).toBe(true);
    expect(result.event.type).toBe("TOOL_CALL_RECORDED");
    // A passthrough: recording that a tool ran does not move the machine.
    expect(result.event.fromState).toBe(before);
    expect(result.event.toState).toBe(before);
    expect(ledger.getTask(invocation.taskId)?.currentState).toBe(before);
  });

  it("writes exactly the nine safe scalars, verbatim (A1b)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-payload",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b02",
    );
    const result = recordToolCall(ledger, {
      invocation,
      accountId: ACCOUNT,
      facts: COMPLETED,
      transitionId: toolCallTransitionId(0, 0),
      emittedBy: EMITTED_BY,
    });
    expect(result.event.payload).toEqual({
      accountId: ACCOUNT,
      serverId: "fs-local",
      toolName: "read_file",
      transport: "STDIO",
      outcome: "COMPLETED",
      refusal: null,
      argumentBytes: 128,
      resultBytes: 4_096,
      contentBlocks: 2,
    });
    expect(Object.keys(result.event.payload).sort()).toEqual(PAYLOAD_KEYS);
  });

  it("drops what the facts type does not name, even when the value carries it (A1c)", () => {
    // The seam assertion, and the most valuable test in the stage.
    //
    // `@acp/tools`' `ToolCallReceipt` is structurally assignable to
    // `ToolCallFacts`, which is what lets the composing packet write
    // `facts: receipt` with no field-by-field copying. The consequence is that
    // a real receipt still carries `sessionId` and `identity` **at runtime**
    // even though the interface does not name them. So the recorder builds the
    // payload field by field rather than spreading, and this is what makes that
    // a fact about the code rather than a convention in a comment: a spread
    // would put both in a durable row and pass every other test in this file.
    const { ledger, invocation } = openWithTask(
      "tool-seam",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b03",
    );
    const wider = {
      ...COMPLETED,
      sessionId: "session-8f21",
      identity: EMITTED_BY,
    };
    const facts: ToolCallFacts = wider;

    const result = recordToolCall(ledger, {
      invocation,
      accountId: ACCOUNT,
      facts,
      transitionId: toolCallTransitionId(1, 0),
      emittedBy: EMITTED_BY,
    });

    const keys = Object.keys(result.event.payload);
    expect(keys.sort()).toEqual(PAYLOAD_KEYS);
    expect(keys).not.toContain("sessionId");
    expect(keys).not.toContain("identity");
    // And not merely absent from the keys: absent from the durable bytes.
    const stored = ledger.getEventByIdempotencyKey(result.event.idempotencyKey);
    expect(stored).not.toBeNull();
    expect(stored?.canonicalJson).not.toContain("session-8f21");
    expect(stored?.canonicalJson).not.toContain("sessionId");
  });

  it("records a refused call with its reason (A2)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-refused",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b04",
    );
    const result = recordToolCall(ledger, {
      invocation,
      accountId: ACCOUNT,
      facts: {
        ...COMPLETED,
        outcome: "REFUSED",
        refusal: "NOT_ALLOWLISTED",
        resultBytes: 0,
        contentBlocks: 0,
      },
      transitionId: toolCallTransitionId(0, 1),
      emittedBy: EMITTED_BY,
    });
    expect(result.event.payload["outcome"]).toBe("REFUSED");
    expect(result.event.payload["refusal"]).toBe("NOT_ALLOWLISTED");
  });

  it("is deterministic: the same call appends once (A3)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-replay",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b05",
    );
    const observation = {
      invocation,
      accountId: ACCOUNT,
      facts: COMPLETED,
      transitionId: toolCallTransitionId(2, 4),
      emittedBy: EMITTED_BY,
    };
    const first = recordToolCall(ledger, observation);
    const second = recordToolCall(ledger, observation);

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(ledger.status().eventCount).toBe(2); // the discovery plus one receipt
  });

  it("distinguishes two calls by their transition ids (A4)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-two",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b06",
    );
    for (const callIndex of [0, 1]) {
      recordToolCall(ledger, {
        invocation,
        accountId: ACCOUNT,
        facts: COMPLETED,
        transitionId: toolCallTransitionId(0, callIndex),
        emittedBy: EMITTED_BY,
      });
    }
    expect(ledger.status().eventCount).toBe(3);
  });
});

describe("the causal thread and the clock", () => {
  it("rides the walk's correlation, and carries no cause by default (A5)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-thread",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b07",
    );
    const result = recordToolCall(ledger, {
      invocation,
      accountId: ACCOUNT,
      facts: COMPLETED,
      transitionId: toolCallTransitionId(0, 0),
      emittedBy: EMITTED_BY,
    });
    // A call rides an attempt rather than starting one.
    expect(result.event.correlationId).toBe(invocation.invocationId);
    expect(result.event.causationId).toBeNull();
  });

  it("carries a cause when the caller genuinely has one (A5)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-caused",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b08",
    );
    const cause = "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c99";
    const result = recordToolCall(ledger, {
      invocation,
      accountId: ACCOUNT,
      facts: COMPLETED,
      transitionId: toolCallTransitionId(0, 0),
      emittedBy: EMITTED_BY,
      causedBy: cause,
    });
    expect(result.event.causationId).toBe(cause);
  });

  it("reads no clock: both timestamps are the submission's (A6)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-clockless",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b09",
    );
    const result = recordToolCall(ledger, {
      invocation,
      accountId: ACCOUNT,
      facts: COMPLETED,
      transitionId: toolCallTransitionId(0, 0),
      emittedBy: EMITTED_BY,
    });
    expect(result.event.occurredAt).toBe(invocation.submittedAt);
    expect(result.event.recordedAt).toBe(invocation.submittedAt);
  });
});

describe("the grammar holds on the durable row, not only on the input", () => {
  it("leaves no space in any string value of the stored payload (A7)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-grammar",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b0a",
    );
    const result = recordToolCall(ledger, {
      invocation,
      accountId: ACCOUNT,
      facts: { ...COMPLETED, outcome: "REFUSED", refusal: "SERVER_UNAVAILABLE" },
      transitionId: toolCallTransitionId(0, 0),
      emittedBy: EMITTED_BY,
    });

    const stored = ledger.getEventByIdempotencyKey(result.event.idempotencyKey);
    expect(stored).not.toBeNull();
    const payload = (JSON.parse(stored?.canonicalJson ?? "{}") as { payload: Record<string, unknown> })
      .payload;
    // Read back off the ledger rather than off the input: this is the grammar
    // observed where an auditor would observe it. A value that could hold a
    // sentence would hold a space; none of these can.
    const strings = Object.values(payload).filter(
      (value): value is string => typeof value === "string",
    );
    expect(strings).toHaveLength(6);
    for (const value of strings) {
      expect(value).not.toContain(" ");
    }
  });

  it("derives a transition id the contract's grammar admits (A8)", () => {
    expect(toolCallTransitionId(3, 7)).toBe("tool.3.7");
    expect(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(toolCallTransitionId(3, 7))).toBe(true);
    expect(toolCallTransitionId(3, 7).length).toBeLessThanOrEqual(120);
  });
});

describe("the module refuses rather than appending", () => {
  it("refuses a call for a task the ledger has never seen (N1)", () => {
    const root = scenario("tool-unknown-task");
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);

    expect(() =>
      recordToolCall(ledger, {
        invocation: invocationFor("9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b0b"),
        accountId: ACCOUNT,
        facts: COMPLETED,
        transitionId: toolCallTransitionId(0, 0),
        emittedBy: EMITTED_BY,
      }),
    ).toThrow(SupervisorError);

    // Nothing was appended, which a throw-only assertion would not catch.
    expect(ledger.status().eventCount).toBe(0);
  });

  it("refuses a vocabulary field that is not a vocabulary word (N2)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-vocabulary",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b0c",
    );
    const cases: readonly Partial<ToolCallFacts>[] = [
      { transport: "stdio" },
      { outcome: "COMPLETED WITH CONTENT" },
      { outcome: "REFUSED", refusal: "R".repeat(41) },
    ];
    for (const override of cases) {
      expect(() =>
        recordToolCall(ledger, {
          invocation,
          accountId: ACCOUNT,
          facts: { ...COMPLETED, ...override },
          transitionId: toolCallTransitionId(0, 0),
          emittedBy: EMITTED_BY,
        }),
      ).toThrow(SupervisorError);
    }
    expect(ledger.status().eventCount).toBe(1);
  });

  it("refuses an identifier that is not a bounded identifier (N3)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-identifier",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b0d",
    );
    const bad = ["", "read file", "x".repeat(121)];
    for (const value of bad) {
      // The account travels beside the facts, so it is exercised the same way.
      expect(() =>
        recordToolCall(ledger, {
          invocation,
          accountId: value,
          facts: COMPLETED,
          transitionId: toolCallTransitionId(0, 0),
          emittedBy: EMITTED_BY,
        }),
      ).toThrow(SupervisorError);
      for (const field of ["serverId", "toolName"] as const) {
        expect(() =>
          recordToolCall(ledger, {
            invocation,
            accountId: ACCOUNT,
            facts: { ...COMPLETED, [field]: value },
            transitionId: toolCallTransitionId(0, 0),
            emittedBy: EMITTED_BY,
          }),
        ).toThrow(SupervisorError);
      }
    }
    expect(ledger.status().eventCount).toBe(1);
  });

  it("refuses a count that is not a non-negative integer (N4)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-counts",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b0e",
    );
    for (const field of ["argumentBytes", "resultBytes", "contentBlocks"] as const) {
      for (const value of [-1, 1.5]) {
        expect(() =>
          recordToolCall(ledger, {
            invocation,
            accountId: ACCOUNT,
            facts: { ...COMPLETED, [field]: value },
            transitionId: toolCallTransitionId(0, 0),
            emittedBy: EMITTED_BY,
          }),
        ).toThrow(SupervisorError);
      }
    }
    expect(ledger.status().eventCount).toBe(1);
  });

  it("refuses an outcome and a refusal that disagree, both ways (N5)", () => {
    const { ledger, invocation } = openWithTask(
      "tool-coherence",
      "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b0f",
    );
    // A refusal with no reason, and a completion carrying one. Both are rows an
    // auditor would have to guess at, so neither is written.
    const cases: readonly Partial<ToolCallFacts>[] = [
      { outcome: "REFUSED", refusal: null },
      { outcome: "COMPLETED", refusal: "NOT_ALLOWLISTED" },
    ];
    for (const override of cases) {
      expect(() =>
        recordToolCall(ledger, {
          invocation,
          accountId: ACCOUNT,
          facts: { ...COMPLETED, ...override },
          transitionId: toolCallTransitionId(0, 0),
          emittedBy: EMITTED_BY,
        }),
      ).toThrow(SupervisorError);
    }
    expect(ledger.status().eventCount).toBe(1);
  });
});

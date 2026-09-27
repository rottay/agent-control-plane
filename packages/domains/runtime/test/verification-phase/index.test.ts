import type { ResolvedRoute } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import { deriveEventCoordinate } from "../../src/core/coordinates/index.js";
import { LIFECYCLE_PLAN, READ_ONLY_PLAN, planStep } from "../../src/core/lifecycle/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import { SupervisorError, VerificationPhaseError } from "../../src/errors/index.js";
import { classifyFailure } from "../../src/failure/index.js";
import {
  AUDITED_VERDICT_KEY,
  VERIFIED_RECEIPT_KEY,
  consumerReference,
  consumerStepKind,
  produceBeforeStep,
} from "../../src/verification-phase/index.js";
import type { AuditOutcome, RecordedReceipt, RecordedVerdict, VerificationPorts, VerifyOutcome } from "../../src/verification-phase/index.js";

/**
 * The verification phase, over fake ports and a fake ledger (P-16/D1, ADR 0124;
 * decision 238). The walk through the real door is the step executor's suite
 * (`P-16/D1: steps 6 and 7 …`) and the daemon's recorded drills; here each branch of
 * the two functions is driven alone: reuse, the resume rulings (ND-4), the refusals by
 * name, the replay's own bytes, and V1 untouched.
 */

const TASK = "d1d1d1d1-0000-4000-8000-00000000f000";
const RECEIPT = "a".repeat(64);
const LATER = "b".repeat(64);
const AUDIT_ID = "d1d1d1d1-0000-4000-8000-00000000a0d1";

const ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

const V1: DurableInvocation = {
  taskId: TASK,
  attempt: 3,
  invocationId: "d1d1d1d1-0000-4000-8000-00000000b001",
  submittedAt: "2026-09-26T12:00:00.000Z",
  submissionDigest: "d".repeat(64),
};

const V2: DurableInvocation = {
  ...V1,
  revision: {
    revisionId: "d1d1d1d1-0000-4000-8000-00000000c001",
    revisionNumber: 2,
    attemptNumber: 1,
    envelopeSha256: "e".repeat(64),
    envelopeArtifactReferenceId: "ref-envelope",
  },
};

const VERIFIED = planStep(6);
const AUDITED = planStep(7);

interface Fakes {
  verify: number;
  audit: number;
  pass: string | null;
  latestReceipt: RecordedReceipt | null;
  verifyOutcome: VerifyOutcome;
  accept: string | null;
  latestVerdict: RecordedVerdict | null;
  auditOutcome: AuditOutcome;
  /** What the fake ledger holds, by idempotency key: canonical JSON. */
  readonly recorded: Map<string, string>;
  readonly coordinates: unknown[];
}

function fakes(): Fakes {
  return {
    verify: 0,
    audit: 0,
    pass: null,
    latestReceipt: null,
    verifyOutcome: { ok: true, runStatus: "PASS", receiptSha256: RECEIPT },
    accept: null,
    latestVerdict: null,
    auditOutcome: { ok: true, verdict: "ACCEPT", auditId: AUDIT_ID },
    recorded: new Map(),
    coordinates: [],
  };
}

function portsOver(state: Fakes): VerificationPorts {
  return {
    verifier: {
      recordedPass: (coordinate) => {
        state.coordinates.push(coordinate);
        return state.pass;
      },
      latest: () => state.latestReceipt,
      verify: () => {
        state.verify += 1;
        return Promise.resolve(state.verifyOutcome);
      },
    },
    auditor: {
      recordedAccept: () => state.accept,
      latest: () => state.latestVerdict,
      audit: () => {
        state.audit += 1;
        return Promise.resolve(state.auditOutcome);
      },
    },
  };
}

function contextOver(state: Fakes, invocation: DurableInvocation, withPorts = true): BeatContext {
  return {
    ledger: {
      append: () => {
        throw new Error("the phase appends nothing of its own");
      },
      getTask: () => null,
      getEventBySequence: () => null,
      getEventByIdempotencyKey: (key) => {
        const json = state.recorded.get(key);
        return json === undefined ? null : { canonicalJson: json };
      },
    },
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
    invocation,
    emittedBy: "claude/opus/implementer/01",
    plan: LIFECYCLE_PLAN,
    initiativeId: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01",
    route: ROUTE,
    ...(withPorts ? { verification: portsOver(state) } : {}),
  };
}

/** Record a beat of `step` in the fake ledger, carrying `payload`. */
function record(state: Fakes, step: typeof VERIFIED, payload: Record<string, unknown>): void {
  const key = deriveEventCoordinate(V2, step.transitionId, step.index).idempotencyKey;
  state.recorded.set(key, JSON.stringify({ transitionId: step.transitionId, payload }));
}

async function rejection(action: Promise<unknown>): Promise<unknown> {
  return action.then(() => null, (error: unknown) => error);
}

describe("which beats consume", () => {
  it("names steps 6 and 7 of every plan, and no other step", () => {
    for (const plan of [LIFECYCLE_PLAN, READ_ONLY_PLAN]) {
      expect(plan.map((step) => consumerStepKind(step))).toEqual(
        plan.map((step) => (step.index === 6 ? "VERIFIED" : step.index === 7 ? "AUDITED" : null)),
      );
    }
    expect([VERIFIED_RECEIPT_KEY, AUDITED_VERDICT_KEY]).toEqual(["verifiedReceipt", "auditedVerdict"]);
  });

  it("V1 is untouched: no port is asked, and no reference is carried (ND-3)", async () => {
    const state = fakes();
    for (const step of [VERIFIED, AUDITED]) {
      await produceBeforeStep(contextOver(state, V1), step);
      expect(consumerReference(contextOver(state, V1), step)).toBeNull();
      expect(consumerReference(contextOver(state, V1, false), step)).toBeNull();
    }
    expect([state.verify, state.audit, state.coordinates]).toEqual([0, 0, []]);
  });
});

describe("step 6: a PASS receipt, produced once", () => {
  it("runs the verifier once over the V2 coordinate, and names the PASS receipt it recorded", async () => {
    const state = fakes();
    await produceBeforeStep(contextOver(state, V2), VERIFIED);
    expect(state.verify).toBe(1);
    expect(state.coordinates[0]).toEqual({ taskId: TASK, revisionNumber: 2, attemptNumber: 1, attempt: 3 });
    state.pass = RECEIPT;
    expect(consumerReference(contextOver(state, V2), VERIFIED)).toEqual({ key: "verifiedReceipt", value: { receiptSha256: RECEIPT } });
  });

  it("P2: reuses a recorded PASS, so a resumed walk never runs the checks again", async () => {
    const state = fakes();
    state.pass = RECEIPT;
    await produceBeforeStep(contextOver(state, V2), VERIFIED);
    expect(state.verify).toBe(0);
  });

  it("N1/N2: a FAIL receipt or a refusal throws VERIFICATION_FAILED with the word, and settles", async () => {
    const state = fakes();
    state.verifyOutcome = { ok: true, runStatus: "FAIL", receiptSha256: RECEIPT };
    const failed = await rejection(produceBeforeStep(contextOver(state, V2), VERIFIED));
    expect(failed).toBeInstanceOf(VerificationPhaseError);
    expect([(failed as VerificationPhaseError).reason, (failed as VerificationPhaseError).word]).toEqual(["VERIFICATION_FAILED", "RECEIPT_FAIL"]);
    expect(classifyFailure(failed)).toEqual({ settle: true, reason: "VERIFICATION_FAILED" });

    state.verifyOutcome = { ok: false, refusal: "RUNNER_CHECKS_UNDECLARED", at: "envelope.validation.commands" };
    const refused = await rejection(produceBeforeStep(contextOver(state, V2), VERIFIED));
    expect((refused as VerificationPhaseError).word).toBe("RUNNER_CHECKS_UNDECLARED");
  });

  it("ND-4: no PASS and a latest FAIL settles without a new run (no retry until green)", async () => {
    const state = fakes();
    state.latestReceipt = { receiptSha256: RECEIPT, runStatus: "FAIL" };
    const failed = await rejection(produceBeforeStep(contextOver(state, V2), VERIFIED));
    expect((failed as VerificationPhaseError).reason).toBe("VERIFICATION_FAILED");
    expect(state.verify).toBe(0);
  });

  it("N8: with no ports the phase does nothing and the reference refuses, before any append", async () => {
    const state = fakes();
    await produceBeforeStep(contextOver(state, V2, false), VERIFIED);
    const refused = (() => {
      try {
        consumerReference(contextOver(state, V2, false), VERIFIED);
      } catch (error: unknown) {
        return error;
      }
      return null;
    })();
    expect(refused).toBeInstanceOf(SupervisorError);
    expect(classifyFailure(refused)).toEqual({ settle: false, refusal: "CONTINUITY" });
  });

  it("B2/replay: a recorded step 6 is rebuilt from its own reference, not from a later PASS", async () => {
    const state = fakes();
    record(state, VERIFIED, { verifiedReceipt: { receiptSha256: RECEIPT } });
    state.pass = LATER;
    await produceBeforeStep(contextOver(state, V2), VERIFIED);
    expect(state.verify).toBe(0);
    expect(consumerReference(contextOver(state, V2), VERIFIED)).toEqual({ key: "verifiedReceipt", value: { receiptSha256: RECEIPT } });
  });
});

describe("step 7: an ACCEPT verdict on the receipt step 6 consumed", () => {
  it("audits the receipt step 6 names, read back from the ledger, and names the ACCEPT", async () => {
    const state = fakes();
    record(state, VERIFIED, { verifiedReceipt: { receiptSha256: RECEIPT } });
    // A later PASS exists: step 7 still audits the receipt step 6 consumed (ND-2).
    state.pass = LATER;
    let audited: string | null = null;
    const ports = portsOver(state);
    const context = {
      ...contextOver(state, V2),
      verification: {
        ...ports,
        auditor: {
          ...ports.auditor,
          audit: (coordinate: Parameters<typeof ports.auditor.audit>[0], receiptSha256: string) => {
            audited = receiptSha256;
            return ports.auditor.audit(coordinate, receiptSha256);
          },
        },
      },
    };
    await produceBeforeStep(context, AUDITED);
    expect(audited).toBe(RECEIPT);
    state.accept = AUDIT_ID;
    expect(consumerReference(contextOver(state, V2), AUDITED)).toEqual({
      key: "auditedVerdict",
      value: { auditId: AUDIT_ID, receiptSha256: RECEIPT },
    });
  });

  it("reuses a recorded ACCEPT, and a latest non-ACCEPT settles AUDIT_NOT_ACCEPTED without a new audit (ND-4)", async () => {
    const state = fakes();
    record(state, VERIFIED, { verifiedReceipt: { receiptSha256: RECEIPT } });
    state.accept = AUDIT_ID;
    await produceBeforeStep(contextOver(state, V2), AUDITED);
    expect(state.audit).toBe(0);
    state.accept = null;
    state.latestVerdict = { auditId: AUDIT_ID, verdict: "REJECT" };
    const failed = await rejection(produceBeforeStep(contextOver(state, V2), AUDITED));
    expect([(failed as VerificationPhaseError).reason, (failed as VerificationPhaseError).word]).toEqual(["AUDIT_NOT_ACCEPTED", "REJECT"]);
    expect(state.audit).toBe(0);
  });

  it("N3/N14: a REJECT, an ACCEPT_WITH_CORRECTIONS or a refusal throws AUDIT_NOT_ACCEPTED, and settles", async () => {
    for (const outcome of [
      { ok: true, verdict: "REJECT", auditId: AUDIT_ID },
      { ok: true, verdict: "ACCEPT_WITH_CORRECTIONS", auditId: AUDIT_ID },
      { ok: false, refusal: "AUDITOR_RECEIPT_UNREADABLE", at: "receipt" },
    ] as const) {
      const state = fakes();
      record(state, VERIFIED, { verifiedReceipt: { receiptSha256: RECEIPT } });
      state.auditOutcome = outcome;
      const failed = await rejection(produceBeforeStep(contextOver(state, V2), AUDITED));
      expect(classifyFailure(failed)).toEqual({ settle: true, reason: "AUDIT_NOT_ACCEPTED" });
      expect((failed as VerificationPhaseError).word).toBe(outcome.ok ? outcome.verdict : outcome.refusal);
    }
  });

  it("refuses to audit when step 6 is not recorded with the receipt it consumed", async () => {
    const state = fakes();
    expect(await rejection(produceBeforeStep(contextOver(state, V2), AUDITED))).toBeInstanceOf(SupervisorError);
    record(state, VERIFIED, { beat: "PLAIN" });
    expect(await rejection(produceBeforeStep(contextOver(state, V2), AUDITED))).toBeInstanceOf(SupervisorError);
    expect(state.audit).toBe(0);
  });
});

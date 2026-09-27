import { deriveEventCoordinate } from "../core/coordinates/index.js";
import type { PlanStep } from "../core/lifecycle/index.js";
import type { BeatContext } from "../core/step-executor/index.js";
import { SupervisorError, VerificationPhaseError } from "../errors/index.js";

import type { VerificationCoordinate, VerificationPorts } from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and are
 * re-exported here unchanged (owner law §7).
 */
export type {
  AuditOutcome,
  AuditorPort,
  RecordedReceipt,
  RecordedVerdict,
  VerificationCoordinate,
  VerificationPorts,
  VerifierPort,
  VerifyOutcome,
} from "./types/index.js";

/**
 * The verification phase of a recorded walk — P-16/D1, ADR 0124 (decision 238; map-v1
 * D-1 (b)).
 *
 * The plan table is unchanged: step 6 (`verified`, `VERIFICATION_COMPLETED`,
 * `RUNNING -> VERIFYING`) and step 7 (`audited`, `AUDIT_COMPLETED`,
 * `VERIFYING -> AUDITING`) keep their indices, transition ids, event types and states.
 * What changes, on a revision-bearing (V2) invocation only, is what each of the two
 * beats stands on:
 *
 * - **Before** the append, `produceBeforeStep` asks the injected ports for the
 *   producer's row: a `PASS` receipt of the coordinate (step 6), then an `ACCEPT`
 *   verdict on the receipt step 6 named (step 7). A row already recorded is reused —
 *   a resumed walk does not run the checks or the audit again — and otherwise the
 *   port runs once and records it (the runner's receipt-form `VERIFICATION_COMPLETED`,
 *   the auditor's verdict-form `AUDIT_COMPLETED`, both same-state).
 * - **In** the append, `consumerReference` names that row under one closed key the
 *   ledger's door and fold hold to the rows they admitted: `verifiedReceipt:
 *   {receiptSha256}` and `auditedVerdict: {auditId, receiptSha256}` (ND-2).
 *
 * **The reference is read back, never remembered.** Step 6 names the coordinate's
 * largest-run `PASS` receipt; step 7 names the receipt **step 6's recorded event
 * carries**, read back from the ledger, and the largest-run `ACCEPT` verdict on it. A
 * beat already recorded is rebuilt from its own recorded reference, so a replay
 * rebuilds the same bytes whatever was recorded after it.
 *
 * **A failure is named, and settles.** A runner refusal or a `FAIL` receipt throws
 * `VerificationPhaseError("VERIFICATION_FAILED", word)`; an auditor refusal or a
 * verdict other than `ACCEPT` throws `VerificationPhaseError("AUDIT_NOT_ACCEPTED",
 * word)`; `classifyFailure` settles both. On a resume, a coordinate with no `PASS` and
 * a latest `FAIL` settles without a new run, and so does a latest non-`ACCEPT` verdict
 * with no `ACCEPT` (ND-4: no retry-until-green).
 *
 * **V1 is untouched** (ND-3): an invocation with no revision has no coordinate a
 * receipt could name, so both functions answer nothing and the beats stay PLAIN,
 * byte for byte. A V2 walk with no ports is refused by the step executor before the
 * append (the `checkpoints`-absent mould), never settled.
 *
 * No Git, no spawn and no ledger write of its own: every write is the ports'.
 */

/** The payload key step 6's consumer beat names its `PASS` receipt under. */
export const VERIFIED_RECEIPT_KEY = "verifiedReceipt";

/** The payload key step 7's consumer beat names its `ACCEPT` verdict under. */
export const AUDITED_VERDICT_KEY = "auditedVerdict";

/** Which consumer beat a plan step is, or null: the two state-changing gate steps only. */
export function consumerStepKind(step: PlanStep): "VERIFIED" | "AUDITED" | null {
  if (step.fromState === step.toState) return null;
  if (step.eventType === "VERIFICATION_COMPLETED") return "VERIFIED";
  if (step.eventType === "AUDIT_COMPLETED") return "AUDITED";
  return null;
}

/** The coordinate of a V2 invocation, or null for V1. */
function coordinateOf(context: BeatContext): VerificationCoordinate | null {
  const revision = context.invocation.revision;
  if (revision === undefined) return null;
  return {
    taskId: context.invocation.taskId,
    revisionNumber: revision.revisionNumber,
    attemptNumber: revision.attemptNumber,
    attempt: context.invocation.attempt,
  };
}

/** The ports of a V2 walk, or the refusal that it has none. */
function portsOf(context: BeatContext, step: PlanStep): VerificationPorts {
  const ports = context.verification;
  if (ports === undefined) {
    throw new SupervisorError(
      "refusing to append " +
        step.transitionId +
        ": this revision-bearing walk has no verification ports, so the beat would name a" +
        " verification or an audit nobody recorded",
    );
  }
  return ports;
}

/** The payload member one recorded event carries under `key`, or undefined. */
function recordedMember(context: BeatContext, step: PlanStep, key: string): unknown {
  const recorded = context.ledger.getEventByIdempotencyKey(
    deriveEventCoordinate(context.invocation, step.transitionId, step.index).idempotencyKey,
  );
  if (recorded === null) return undefined;
  const parsed: unknown = JSON.parse(recorded.canonicalJson);
  if (typeof parsed !== "object" || parsed === null) return null;
  const payload = (parsed as { readonly payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return null;
  return Object.hasOwn(payload, key) ? (payload as Record<string, unknown>)[key] : null;
}

/** The step-6 plan step of this walk's plan. Every plan carries it (the shared prefix). */
function verifiedStep(context: BeatContext): PlanStep {
  const step = context.plan.find((candidate) => consumerStepKind(candidate) === "VERIFIED");
  if (step === undefined) {
    throw new SupervisorError("refusing to audit: this walk's plan has no verified step to read the receipt from");
  }
  return step;
}

/**
 * The receipt step 6's recorded event names, read back from the ledger. Refused when
 * step 6 is absent or names none: step 7 never re-derives it.
 */
function receiptStepSixNamed(context: BeatContext): string {
  const member = recordedMember(context, verifiedStep(context), VERIFIED_RECEIPT_KEY);
  const sha =
    typeof member === "object" && member !== null ? (member as { readonly receiptSha256?: unknown }).receiptSha256 : undefined;
  if (typeof sha !== "string") {
    throw new SupervisorError(
      "refusing to audit: step 6 is not recorded with the receipt it consumed, so there is no receipt to audit",
    );
  }
  return sha;
}

/**
 * Produce the row the next consumer beat will name, or settle why it cannot exist.
 *
 * Awaited by the SQLite supervisor before the synchronous append of a PLAIN step. It
 * does nothing for a V1 invocation, for any step other than 6 and 7, for a V2 walk
 * with no ports (the append refuses it), and for a beat already recorded (the append
 * replays it).
 */
export async function produceBeforeStep(context: BeatContext, step: PlanStep): Promise<void> {
  const kind = consumerStepKind(step);
  const coordinate = coordinateOf(context);
  if (kind === null || coordinate === null) return;
  const ports = context.verification;
  if (ports === undefined) return;
  const key = deriveEventCoordinate(context.invocation, step.transitionId, step.index).idempotencyKey;
  if (context.ledger.getEventByIdempotencyKey(key) !== null) return;

  if (kind === "VERIFIED") {
    if (ports.verifier.recordedPass(coordinate) !== null) return;
    const latest = ports.verifier.latest(coordinate);
    if (latest !== null && latest.runStatus === "FAIL") throw new VerificationPhaseError("VERIFICATION_FAILED", "RECEIPT_FAIL");
    const outcome = await ports.verifier.verify(coordinate);
    if (!outcome.ok) throw new VerificationPhaseError("VERIFICATION_FAILED", outcome.refusal);
    if (outcome.runStatus !== "PASS") throw new VerificationPhaseError("VERIFICATION_FAILED", "RECEIPT_FAIL");
    return;
  }

  const receiptSha256 = receiptStepSixNamed(context);
  if (ports.auditor.recordedAccept(coordinate, receiptSha256) !== null) return;
  const latest = ports.auditor.latest(coordinate, receiptSha256);
  if (latest !== null && latest.verdict !== "ACCEPT") throw new VerificationPhaseError("AUDIT_NOT_ACCEPTED", latest.verdict);
  const outcome = await ports.auditor.audit(coordinate, receiptSha256);
  if (!outcome.ok) throw new VerificationPhaseError("AUDIT_NOT_ACCEPTED", outcome.refusal);
  if (outcome.verdict !== "ACCEPT") throw new VerificationPhaseError("AUDIT_NOT_ACCEPTED", outcome.verdict);
}

/**
 * The one key and value a consumer beat carries, or null for a beat that carries none.
 *
 * Synchronous, for the append: read through the same ports, or from the beat's own
 * recorded event on a replay. A V2 consumer step with no ports, or whose row does not
 * stand, is refused here, before anything is appended.
 */
export function consumerReference(
  context: BeatContext,
  step: PlanStep,
): { readonly key: string; readonly value: Readonly<Record<string, string>> } | null {
  const kind = consumerStepKind(step);
  const coordinate = coordinateOf(context);
  if (kind === null || coordinate === null) return null;
  const ports = portsOf(context, step);
  const key = kind === "VERIFIED" ? VERIFIED_RECEIPT_KEY : AUDITED_VERDICT_KEY;

  // A beat already recorded is rebuilt from its own reference: the replay's bytes.
  const recorded = recordedMember(context, step, key);
  if (typeof recorded === "object" && recorded !== null) {
    const value: Record<string, string> = {};
    for (const [name, member] of Object.entries(recorded)) {
      if (typeof member === "string") value[name] = member;
    }
    return { key, value };
  }

  if (kind === "VERIFIED") {
    const receiptSha256 = ports.verifier.recordedPass(coordinate);
    if (receiptSha256 === null) throw new VerificationPhaseError("VERIFICATION_FAILED", "RECEIPT_ABSENT");
    return { key, value: { receiptSha256 } };
  }
  const receiptSha256 = receiptStepSixNamed(context);
  const auditId = ports.auditor.recordedAccept(coordinate, receiptSha256);
  if (auditId === null) throw new VerificationPhaseError("AUDIT_NOT_ACCEPTED", "VERDICT_ABSENT");
  return { key, value: { auditId, receiptSha256 } };
}

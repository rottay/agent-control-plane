import { CONTRACT_VERSION, ControlPlaneEvent } from "@acp/contracts";
import type { ControlPlaneEvent as ControlPlaneEventType } from "@acp/contracts";

import type { DurableInvocation } from "../contracts/index.js";
import { deriveEventCoordinate } from "../core/coordinates/index.js";
import type { LedgerPort } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";

/**
 * The durable tool-call receipt (V2-B4b stage 2).
 *
 * A tool call is a thing a run did, and a control plane that cannot say which
 * tools ran cannot audit what a worker was actually able to touch. This module
 * is what puts that fact in the ledger. Like `../usage`, it records a fact a
 * caller observed: it calls no tool, measures nothing itself, and has no
 * opinion about whether the counts it is handed are right.
 *
 * **What it deliberately is not.** It is not a second home for the tool
 * vocabulary. `@acp/tools` owns `TOOL_TRANSPORT_KINDS`, `TOOL_REFUSALS` and the
 * byte ceilings, and this stratum may not name that package — the runtime's
 * import allowlist is the closed set `{@acp/accounts, @acp/contracts,
 * @acp/ledger}`, which refuses the edge with no new law needed. So the seam is
 * a **grammar, not a registry**: `ToolCallFacts` below restates the receipt's
 * recordable half over primitives, and bounds the vocabulary-shaped fields by
 * *shape* rather than by membership. Membership is checked where the value is
 * produced, by a type that makes a non-member unrepresentable.
 *
 * That is not a weakening. `@acp/tools`' `ToolCallReceipt` is structurally
 * assignable to `ToolCallFacts` field for field, so the composing caller writes
 * `facts: receipt` on one line with no field-by-field copying — which is where
 * drift would otherwise enter.
 *
 * **The redaction claim, made at the producer.** The payload is nine scalars
 * and nothing else, built field by field from named members. Every one of them
 * is either a count or a string under a grammar that cannot express prose:
 *
 * | Field | Bound | Why it cannot carry content |
 * |---|---|---|
 * | `accountId`, `serverId`, `toolName` | {@link IDENTIFIER} | no space, quote, brace, slash or newline |
 * | `transport`, `outcome`, `refusal` | {@link VOCABULARY_WORD} | screaming-snake only, or null for `refusal` |
 * | `argumentBytes`, `resultBytes`, `contentBlocks` | non-negative integers | a count of a secret is not a secret |
 *
 * No free text, no session id, no identity, no timestamp, no duration, no
 * digest, no arguments, no results and no content. A tenth key of any of those
 * shapes reopens the redaction argument and is a stop, not an edit.
 *
 * **Deliberately no ceiling on the byte counts.** `USAGE_TOKENS_MAX` exists
 * because the rollup fold silently drops an over-ceiling row and counts it
 * `skippedMalformed`, so appending one would be durably recorded and
 * permanently invisible. No fold reads tool receipts. An over-large
 * `resultBytes` is a wrong number a reader can see, not a quiet
 * disappearance — so the refusal has no subject here. Stated so a later reader
 * does not read the absence as an oversight.
 */

/**
 * The grammar for a configured identifier.
 *
 * `accountId`, `serverId` and `toolName` are all config-owned names, and
 * `toolName` in particular comes from the caller's **allowlist** rather than
 * from whatever a server advertised. The bound admits exactly the shape a name
 * has and nothing a payload fragment has.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

/**
 * The grammar for a vocabulary word.
 *
 * Screaming-snake, so `LOOPBACK`, `STDIO`, `COMPLETED`, `REFUSED` and every
 * refusal name fit, and a tool argument does not. Bounded by shape rather than
 * by membership on purpose: the membership lives in `@acp/tools`, and
 * restating it here would be the second registry.
 */
const VOCABULARY_WORD = /^[A-Z][A-Z0-9_]{0,39}$/;

/**
 * The durable name one tool call is recorded under.
 *
 * `"tool." + operationIndex + "." + callIndex`, mirroring `usageTransitionId`.
 * Two indices, both non-negative integers, so the result always satisfies the
 * contract's transition-id grammar (`/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`, at most
 * 120 characters) with room to spare.
 *
 * **Both indices are the caller's, and the caller owes their replay
 * stability.** `operationIndex` is the operation's own position in the plan;
 * `callIndex` is the call's position within that operation. A resumed attempt
 * that re-executes must rebuild exactly the same pair, which is what makes the
 * second append an exact replay rather than a second row. A counter in mutable
 * state or a clock would satisfy the type and break the property, so the
 * composing packet owes a derivation, not a counter.
 */
export function toolCallTransitionId(operationIndex: number, callIndex: number): string {
  return "tool." + String(operationIndex) + "." + String(callIndex);
}

/**
 * The receipt's recordable half, restated structurally.
 *
 * **Not** `@acp/tools`' `ToolCallReceipt`, and deliberately wider in its member
 * types: `transport` is a `string`, not `ToolTransportKind`; `outcome` is a
 * `string`, not `"COMPLETED" | "REFUSED"`; `refusal` is `string | null`, not
 * `ToolRefusal | null`. Widening is what lets the narrow type flow in without
 * this stratum naming the package that owns it.
 *
 * `sessionId` and `identity` are absent by decision, not by omission. A receipt
 * carrying an identity would make itself a second identity authority, and the
 * session id is a coordinate of a live process rather than a durable fact; the
 * emitter travels in {@link ToolCallObservation.emittedBy}, where every other
 * beat puts it. Because the assignment above is structural, a real receipt
 * still carries both **at runtime** even though this type does not name them —
 * which is exactly why {@link recordToolCall} builds its payload field by field
 * and never spreads.
 */
export interface ToolCallFacts {
  readonly serverId: string;
  readonly toolName: string;
  /** A transport vocabulary word. The union itself stays in `@acp/tools`. */
  readonly transport: string;
  /** `"COMPLETED"` or `"REFUSED"`, bounded here by shape. */
  readonly outcome: string;
  /** A refusal vocabulary word, or null when the call completed. */
  readonly refusal: string | null;
  readonly argumentBytes: number;
  readonly resultBytes: number;
  readonly contentBlocks: number;
}

export interface ToolCallObservation {
  readonly invocation: DurableInvocation;
  /** The account the call was made under. */
  readonly accountId: string;
  readonly facts: ToolCallFacts;
  /**
   * A durable name for this call, unique within the task's attempt.
   *
   * The caller's, as it is for a usage observation and for the same reason:
   * only the caller knows whether two receipts are one call seen twice or two
   * different calls. {@link toolCallTransitionId} is the shape it should take.
   */
  readonly transitionId: string;
  readonly emittedBy: string;
  /**
   * The event that prompted this call, when one genuinely did.
   *
   * Optional and normally absent. A tool call is something a step did rather
   * than something a single prior event caused, and inventing a cause to fill
   * the field would be exactly the fabricated causality the consumer refuses to
   * draw.
   */
  readonly causedBy?: string | null;
}

export interface ToolCallRecordResult {
  /** false means this exact call was already recorded. */
  readonly inserted: boolean;
  readonly event: ControlPlaneEventType;
}

function requireIdentifier(name: string, value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new SupervisorError(
      "refusing to record a tool call whose " +
        name +
        " is not a bounded identifier; the receipt's coordinates are" +
        " configured names, and anything that is not one is content",
    );
  }
}

function requireVocabularyWord(name: string, value: string): void {
  if (!VOCABULARY_WORD.test(value)) {
    throw new SupervisorError(
      "refusing to record a tool call whose " +
        name +
        " is not a vocabulary word; the field carries a closed name from the" +
        " producing edge, never free text",
    );
  }
}

function requireCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new SupervisorError(
      "refusing to record a tool call whose " +
        name +
        " is not a non-negative integer count",
    );
  }
}

/**
 * Append one tool-call receipt.
 *
 * A same-state passthrough: recording that a tool ran does not move the task's
 * lifecycle, so `fromState` and `toState` are both the state the ledger
 * currently holds — read from the ledger rather than claimed by the caller, for
 * the same reason every other beat reads it there.
 *
 * Clockless and replay-idempotent: coordinates come from the durable
 * invocation, nothing reads a clock or a random source, and recording the same
 * observation twice appends once because the second append is an exact replay
 * under the same key.
 *
 * **The module never opens a task.** A tool call recorded against a task with
 * no discovery has no initiative and no lifecycle to attribute it to, and
 * nothing later could repair the attribution — so an unknown task is refused at
 * the door, with the reason, rather than left to the ledger's contiguity guard
 * one layer from the cause.
 */
export function recordToolCall(
  ledger: LedgerPort,
  observation: ToolCallObservation,
): ToolCallRecordResult {
  const { invocation, accountId, facts, transitionId, emittedBy } = observation;

  requireIdentifier("accountId", accountId);
  requireIdentifier("serverId", facts.serverId);
  requireIdentifier("toolName", facts.toolName);
  requireVocabularyWord("transport", facts.transport);
  requireVocabularyWord("outcome", facts.outcome);
  if (facts.refusal !== null) requireVocabularyWord("refusal", facts.refusal);
  requireCount("argumentBytes", facts.argumentBytes);
  requireCount("resultBytes", facts.resultBytes);
  requireCount("contentBlocks", facts.contentBlocks);

  // Coherence. A refused call with no reason, or a completed call carrying one,
  // is a nonsense row an auditor would have to guess at — and guessing at a
  // durable row is the failure this plane exists to avoid.
  if (facts.outcome === "REFUSED" && facts.refusal === null) {
    throw new SupervisorError(
      "refusing to record a refused tool call with no refusal; a refusal" +
        " without a reason is a row an auditor cannot read",
    );
  }
  if (facts.outcome !== "REFUSED" && facts.refusal !== null) {
    throw new SupervisorError(
      "refusing to record a tool call that carries a refusal but did not" +
        " refuse; the outcome and the reason must agree",
    );
  }

  // The task must already exist. This module records against history; it never
  // begins one.
  const task = ledger.getTask(invocation.taskId);
  if (task === null) {
    throw new SupervisorError(
      "refusing to record a tool call for a task the ledger has never seen;" +
        " a receipt may never open a task, because a call recorded against a" +
        " task with no discovery has no initiative and no lifecycle to" +
        " attribute it to",
    );
  }

  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  const event = ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: "TOOL_CALL_RECORDED",
    fromState: task.currentState,
    toState: task.currentState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    // A tool call rides an attempt rather than starting one, so it belongs to
    // that run's thread and says so. Causation is the caller's to supply when a
    // specific event genuinely prompted the call.
    correlationId: invocation.invocationId,
    causationId: observation.causedBy ?? null,
    // Field by field from named members, never `{...facts}`. This is
    // load bearing rather than stylistic: a real `ToolCallReceipt` is
    // structurally assignable to `ToolCallFacts` and still carries `sessionId`
    // and `identity` at runtime, so a spread would leak both into a durable
    // row. Nine keys, written out, is what makes the redaction claim
    // unfalsifiable instead of conventional.
    payload: {
      accountId,
      serverId: facts.serverId,
      toolName: facts.toolName,
      transport: facts.transport,
      outcome: facts.outcome,
      refusal: facts.refusal,
      argumentBytes: facts.argumentBytes,
      resultBytes: facts.resultBytes,
      contentBlocks: facts.contentBlocks,
    },
  });

  const result = ledger.append(event);
  return { inserted: result.inserted, event: result.record.event };
}

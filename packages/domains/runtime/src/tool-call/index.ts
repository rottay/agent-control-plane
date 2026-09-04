import { BOUNDED_IDENTIFIER, ControlPlaneEvent, parseWorkerIdentity } from "@acp/contracts";

import type { DurableInvocation } from "../contracts/index.js";
import { deriveEventCoordinate } from "../core/coordinates/index.js";
import type { LedgerPort } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";
import { recordToolCall, toolCallTransitionId } from "../tool-receipt/index.js";
import type { ToolCallFacts } from "../tool-receipt/index.js";

/**
 * The explicit tool-call operation (V2-B4b stage 3B).
 *
 * Stage 2 gave the plane a way to *record* that a tool ran. Nothing joined the
 * three halves: a scope that can call, the receipt that comes back, and the
 * ledger row that makes it durable. `recordToolCall` had no callers at all.
 * This module is that join, and it is the operation only — there is no door
 * here. No route, no CLI verb, no process start, no `@acp/tools` import: an
 * entrypoint composes those on top, and until one does, nothing in this
 * repository calls a tool.
 *
 * **The ordering invariant, which is the whole contract of this module.**
 *
 * > **Throw = the request never became an operation: no row, no spawn.
 * > Return = it became an operation, and there is always a row.**
 *
 * Nine checks run before {@link ToolCallPort.callTool} is reachable, and every
 * one of them raises {@link SupervisorError} — no new refusal vocabulary is
 * invented here, and no enum member is earned. After the port is touched,
 * **every** outcome it returns is recorded, the refusals as much as the
 * successes: a refused call that left no row would be exactly the unaudited
 * effect this plane exists to refuse.
 *
 * **The rule the check list is derived from.** Every caller-supplied value that
 * the recorder will hand to `ControlPlaneEvent.parse` is bounded *here*, before
 * the port, because the recorder's own refusal arrives too late to be one: it
 * throws after the call already happened, leaving a real effect with no row.
 * That is why `causedBy`, `invocation.attempt` and `invocation.submittedAt` are
 * checked below and not only the seven the packet started with — the attempt
 * bound against `latestAttempt` admits `0`, a negative and a fraction, and the
 * other two were unbounded entirely.
 *
 * Those three are checked against **the contract's own field schemas**, reached
 * through `ControlPlaneEvent.shape`, rather than against a restatement of them.
 * A local copy of a grammar the recorder judges by is the exact drift stage 3A
 * removed; taking the schema object itself means the precheck cannot disagree
 * with the parse it is standing in front of, by construction rather than by
 * maintenance.
 *
 * **What the invariant assumes of the port.** It assumes a conforming one: an
 * outcome whose `receipt` satisfies the recorder's shape — vocabulary words for
 * `transport` and `outcome`, non-negative integer counts, a refusal that agrees
 * with the outcome. A port that answers outside that shape, or answers
 * `ok: false` with a `COMPLETED` receipt, still throws after the call, and no
 * check on this side of the seam can prevent it: the values do not exist until
 * the port has already run. Bounding that is the port's own obligation, and the
 * door that constructs one owes it.
 *
 * The identity check is one of the nine, and it is not decorative. The tool
 * port refuses an out-of-grammar identity with its own refusal and builds the
 * receipt from the caller's **raw** identity; that receipt then reaches
 * `ControlPlaneEvent.parse`, where `WorkerIdentityString` throws — after the
 * port was already touched. The refusal would be unrecordable, which is the one
 * outcome the invariant above forbids. Stage 3A bounds `descriptor.serverId`
 * and `entry.name` at *admission*; it does not bound the request. So the
 * request is bounded here, at this module's own door, before a port exists.
 *
 * Likewise the index bounds. `toolCallTransitionId(-1, 0)` yields `"tool.-1.0"`,
 * which satisfies the contract's transition-id grammar and would otherwise be
 * recorded — a durable coordinate nobody could rebuild.
 *
 * **Replay: a coordinate is spent once.** The idempotency key is read before
 * anything else can happen, and a hit returns the recorded row without ever
 * constructing the port, calling it, spawning a child or appending an event.
 * This is load-bearing rather than an optimisation, and its limit belongs in
 * writing: the key is built from `(taskId, attempt, transitionId)` alone, so a
 * second request under the same coordinate carrying different arguments or a
 * different `submittedAt` produces different canonical bytes and the ledger's
 * append would throw a conflict. Returning the recorded row is the only
 * implementable semantics — stage 1 deliberately refused an argument digest, so
 * a body mismatch is undetectable from here — and it is the fail-safe one:
 * never a second real effect. A caller who wants a different call owes a
 * different coordinate.
 *
 * **What the result cannot carry, and why.** No `sequence`: {@link LedgerPort}
 * narrows `append` to `{inserted, record: {event}}` and the event contract has
 * no such field, so neither path can yield one; widening the port to obtain it
 * would touch every fake in six suites. A door that holds the real ledger
 * projects `sequence` itself. And `at` is `null` on a replay: it is not among
 * the nine durable payload keys and cannot be reconstructed from a row.
 *
 * **Structural seam, no package edge.** {@link ToolCallPort} is structural
 * exactly as `EffectPort` is. Nothing here names `@acp/tools`, and the runtime's
 * import allowlist stays the closed set `{@acp/accounts, @acp/contracts,
 * @acp/ledger}` — the edge is refused by a law that already exists rather than
 * by a new one. `@acp/tools`' own scope satisfies this port structurally.
 *
 * **Clockless.** Every coordinate is caller-supplied and durable. Nothing here
 * reads a clock, a UUID source, a mutable counter or a ledger row count, which
 * is what makes a resumed attempt rebuild the same key rather than mint a
 * second one.
 */

/**
 * The ceiling on both indices.
 *
 * A bound rather than a taste: the pair becomes a durable transition id, and an
 * index that cannot be written down in a few characters is not a position in a
 * plan. The value matches the wire contract the door will carry.
 */
const INDEX_CEILING = 1_000_000;

/**
 * The scope one tool operation runs under.
 *
 * `"tool/" + taskId + "/" + attempt + "/" + operationIndex`, and the leading
 * literal is what makes it disjoint from `executionSessionId`
 * (`taskId + "/" + attempt + "/" + accountId`) by two independent arguments:
 * the first segment here is the literal `"tool"` and there it is a task Uuid,
 * which can never be `"tool"`; and the segment counts are four and three. Either
 * alone suffices, which is why both are stated — a scope id collision would
 * silently route a tool call into an execution session's connection.
 *
 * None of `taskId`, `String(attempt)` or `String(operationIndex)` can contain a
 * `/`, so the split is unambiguous.
 */
export function toolOperationScopeId(
  taskId: string,
  attempt: number,
  operationIndex: number,
): string {
  return "tool/" + taskId + "/" + String(attempt) + "/" + String(operationIndex);
}

/**
 * What a scope answers with, as a discriminated union.
 *
 * Discriminated deliberately, and not an object with optional `refusal` and
 * `content` members: the optional form collapses `ok` to `boolean`, and a
 * caller could then read `content` off a refusal or forget `at` on one without
 * the compiler saying anything. Here a refusal *must* carry both its reason and
 * the field it is about, and a success cannot carry either.
 */
export type ToolCallPortOutcome =
  | { readonly ok: true; readonly receipt: ToolCallFacts; readonly content: readonly string[] }
  | {
      readonly ok: false;
      readonly receipt: ToolCallFacts;
      readonly refusal: string;
      readonly at: string;
    };

/**
 * The calling surface one open tool operation exposes.
 *
 * Structural, as `EffectPort` is. `scopeId` is checked against the coordinate
 * the caller claims before anything is called, so a scope opened for one
 * operation cannot serve another's request.
 */
export interface ToolCallPort {
  readonly scopeId: string;
  readonly callTool: (request: {
    readonly sessionId: string;
    readonly serverId: string;
    readonly toolName: string;
    readonly identity: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }) => Promise<ToolCallPortOutcome>;
}

/**
 * One explicit tool call, as the caller states it.
 *
 * Both indices are the caller's and the caller owes their replay stability —
 * `operationIndex` is the operation's position in the plan, `callIndex` the
 * call's position within the operation. A counter in mutable state would
 * satisfy the type and break the property.
 */
export interface ToolCallExecution {
  readonly invocation: DurableInvocation;
  readonly operationIndex: number;
  readonly callIndex: number;
  readonly accountId: string;
  /** The caller's identity, and the event's `emittedBy`. One authority, not two. */
  readonly identity: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly causedBy?: string | null;
}

/**
 * What one operation returns to whoever composed it.
 *
 * `content` reaches the caller and nothing else: it is absent from the durable
 * payload by construction, and a replay returns `[]` because it was never
 * durable in the first place. That is a property of what was stored, not a
 * policy this function applies.
 */
export interface ToolCallOperationResult {
  readonly replayed: boolean;
  /** `"COMPLETED"` or `"REFUSED"`, bounded by shape as the receipt's is. */
  readonly outcome: string;
  readonly refusal: string | null;
  /** The refused field's path. Always null on a replay — it was never durable. */
  readonly at: string | null;
  readonly serverId: string;
  readonly toolName: string;
  readonly transport: string;
  readonly accountId: string;
  readonly argumentBytes: number;
  readonly resultBytes: number;
  readonly contentBlocks: number;
  /** Empty on a replay and on a refusal. Never durable, never logged. */
  readonly content: readonly string[];
  readonly eventId: string;
  readonly transitionId: string;
}

function requireBoundedIdentifier(name: string, value: string): void {
  if (typeof value !== "string" || !BOUNDED_IDENTIFIER.test(value)) {
    throw new SupervisorError(
      "refusing to open a tool call whose " +
        name +
        " is not a bounded identifier; the request's names are configured" +
        " names, and a value that is not one is content wearing a name's field",
    );
  }
}

/**
 * The identity must parse before the port is touched.
 *
 * `parseWorkerIdentity` throws a `ZodError`, which is not this plane's refusal
 * shape, so it is caught and restated. The check itself is the point: without
 * it a raw identity reaches the recorder only *after* a real call happened.
 */
function requireIdentity(value: string): void {
  try {
    parseWorkerIdentity(value);
  } catch {
    throw new SupervisorError(
      "refusing to open a tool call for an identity outside the worker" +
        " grammar; the identity becomes the event's emitter, and a row that" +
        " cannot name its emitter is a row the recorder would refuse after" +
        " the call already happened",
    );
  }
}

function requireIndex(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > INDEX_CEILING) {
    throw new SupervisorError(
      "refusing to open a tool call whose " +
        name +
        " is not an integer between 0 and " +
        String(INDEX_CEILING) +
        "; the pair becomes a durable transition id, and a coordinate nobody" +
        " can rebuild is a row nobody can replay",
    );
  }
}

/**
 * The invocation's own recordable fields, judged by the contract's schemas.
 *
 * `attempt` and `submittedAt` ride every event this operation appends —
 * `submittedAt` becomes both `occurredAt` and `recordedAt` — and both arrive
 * from the caller. Precheck 8 compares the attempt against the task's latest,
 * which says nothing about `0`, a negative or a fraction; a fractional attempt
 * would also reach `toolOperationScopeId` and produce a scope id nobody can
 * rebuild. So the bound is the event contract's own, taken from the schema
 * rather than restated beside it.
 */
function requireRecordableInvocation(invocation: DurableInvocation): void {
  if (!ControlPlaneEvent.shape.attempt.safeParse(invocation.attempt).success) {
    throw new SupervisorError(
      "refusing to open a tool call whose invocation attempt is not an" +
        " attempt the event contract can record; it must be a whole number" +
        " from 1 upward, and a value the recorder would refuse after the call" +
        " is a real effect with no row",
    );
  }
  if (!ControlPlaneEvent.shape.occurredAt.safeParse(invocation.submittedAt).success) {
    throw new SupervisorError(
      "refusing to open a tool call whose invocation submittedAt is not a" +
        " contract timestamp; it becomes the row's occurredAt and recordedAt," +
        " and an instant the recorder would refuse after the call is a real" +
        " effect with no row",
    );
  }
}

/**
 * The causal link, judged by the contract's schema.
 *
 * Absent is the normal case and stays free: `undefined` and `null` are the same
 * answer here, exactly as {@link recordToolCall} reads them. A present value
 * must be an event id the contract would accept, because it lands in
 * `causationId` and is refused there otherwise — after the call.
 *
 * That the named predecessor actually *exists* is deliberately not checked:
 * `LedgerPort` offers no lookup by event id, and widening it is a stop. The
 * consumer's own rule — refuse to draw an edge it cannot resolve — still
 * applies, and the door that composes this operation is where a presence check
 * belongs.
 */
function requireRecordableCause(causedBy: string | null | undefined): void {
  if (!ControlPlaneEvent.shape.causationId.safeParse(causedBy ?? null).success) {
    throw new SupervisorError(
      "refusing to open a tool call whose causedBy is neither absent nor an" +
        " event id the contract can record; a causal link the recorder would" +
        " refuse after the call is a real effect with no row",
    );
  }
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new SupervisorError(
      "refusing to replay a tool call whose recorded row has no readable " +
        key +
        "; the row under this coordinate is not a tool-call receipt",
    );
  }
  return value;
}

function readCount(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SupervisorError(
      "refusing to replay a tool call whose recorded row has no readable " +
        key +
        "; the row under this coordinate is not a tool-call receipt",
    );
  }
  return value;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SupervisorError(
      "refusing to replay a tool call whose recorded " +
        what +
        " is not an object; the row under this coordinate is not a tool-call receipt",
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Project a recorded row back into a result.
 *
 * Read narrowly, field by field, in the register `assertCausalPredecessor` uses
 * for the same job: a row under this coordinate that is not a tool-call receipt
 * is refused rather than coerced, because returning a half-read row would claim
 * a call happened whose shape nobody verified. The refusal reason and the
 * account come from the **row**, not from the request — the durable fact is the
 * authority on what was recorded, and a request that disagrees with it is
 * exactly the case where trusting the request would be wrong.
 */
function replayRecordedRow(canonicalJson: string): ToolCallOperationResult {
  const parsed: unknown = JSON.parse(canonicalJson);
  const event = asRecord(parsed, "event");
  const payload = asRecord(event["payload"], "payload");
  const refusal = payload["refusal"];
  if (refusal !== null && typeof refusal !== "string") {
    throw new SupervisorError(
      "refusing to replay a tool call whose recorded refusal is neither a" +
        " word nor null; the row under this coordinate is not a tool-call receipt",
    );
  }

  return Object.freeze({
    replayed: true,
    outcome: readString(payload, "outcome"),
    refusal,
    // Never durable, and therefore never reconstructable. Stated, not guessed.
    at: null,
    serverId: readString(payload, "serverId"),
    toolName: readString(payload, "toolName"),
    transport: readString(payload, "transport"),
    accountId: readString(payload, "accountId"),
    argumentBytes: readCount(payload, "argumentBytes"),
    resultBytes: readCount(payload, "resultBytes"),
    contentBlocks: readCount(payload, "contentBlocks"),
    content: Object.freeze([]) as readonly string[],
    eventId: readString(event, "eventId"),
    transitionId: readString(event, "transitionId"),
  });
}

/**
 * Run one explicit tool call, and record whatever it did.
 *
 * The nine prechecks of the module header run first and in this order; only
 * after all of them may `scope.callTool` be reached, and after it every outcome
 * is recorded. A throw from here means no row was appended and no child was
 * spawned; a return means the row exists.
 */
export async function runToolCall(
  ledger: LedgerPort,
  scope: ToolCallPort,
  execution: ToolCallExecution,
): Promise<ToolCallOperationResult> {
  const { invocation, operationIndex, callIndex, accountId, identity } = execution;

  // 1. The configured names, under the one grammar the recorder judges by.
  requireBoundedIdentifier("accountId", accountId);
  requireBoundedIdentifier("serverId", execution.serverId);
  requireBoundedIdentifier("toolName", execution.toolName);

  // 2. The identity, before the port exists rather than after it was touched.
  requireIdentity(identity);

  // 3. The indices, because they become a durable coordinate.
  requireIndex("operationIndex", operationIndex);
  requireIndex("callIndex", callIndex);

  // 4. The invocation's own recordable fields. Both ride the appended event,
  //    and the recorder's refusal on either would arrive after the call.
  requireRecordableInvocation(invocation);

  // 5. The causal link, for the same reason.
  requireRecordableCause(execution.causedBy);

  // 6. The scope must be this operation's, not another's.
  const expectedScopeId = toolOperationScopeId(
    invocation.taskId,
    invocation.attempt,
    operationIndex,
  );
  if (scope.scopeId !== expectedScopeId) {
    throw new SupervisorError(
      "refusing to run a tool call through a scope opened for " +
        scope.scopeId +
        "; this operation's scope is " +
        expectedScopeId +
        ", and a scope that serves another operation's request is a call" +
        " attributed to work it did not belong to",
    );
  }

  // 7. The task must exist. This module records against history, never opens it.
  const task = ledger.getTask(invocation.taskId);
  if (task === null) {
    throw new SupervisorError(
      "refusing to run a tool call for a task the ledger has never seen;" +
        " a call recorded against a task with no discovery has no lifecycle" +
        " to attribute it to",
    );
  }

  // 8. The attempt must be one the task actually reached.
  if (invocation.attempt > task.latestAttempt) {
    throw new SupervisorError(
      "refusing to run a tool call for attempt " +
        String(invocation.attempt) +
        " when the task's latest attempt is " +
        String(task.latestAttempt) +
        "; a call cannot belong to an attempt that has not begun",
    );
  }

  // 9. The replay read. A coordinate is spent once: on a hit the port is never
  //    constructed, never called, and nothing is appended.
  const transitionId = toolCallTransitionId(operationIndex, callIndex);
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  const recorded = ledger.getEventByIdempotencyKey(coordinate.idempotencyKey);
  if (recorded !== null) return replayRecordedRow(recorded.canonicalJson);

  const outcome = await scope.callTool({
    sessionId: expectedScopeId,
    serverId: execution.serverId,
    toolName: execution.toolName,
    identity,
    arguments: execution.arguments,
  });

  // Every outcome is recorded, refusals included. `facts` flows in whole
  // because `ToolCallFacts` is structural; `recordToolCall` still writes its
  // payload field by field, which is what keeps a real receipt's `sessionId`
  // and `identity` out of the durable row.
  const facts = outcome.receipt;
  const result = recordToolCall(ledger, {
    invocation,
    accountId,
    facts,
    transitionId,
    emittedBy: identity,
    causedBy: execution.causedBy ?? null,
  });

  return Object.freeze({
    replayed: false,
    outcome: facts.outcome,
    refusal: facts.refusal,
    at: outcome.ok ? null : outcome.at,
    serverId: facts.serverId,
    toolName: facts.toolName,
    transport: facts.transport,
    accountId,
    argumentBytes: facts.argumentBytes,
    resultBytes: facts.resultBytes,
    contentBlocks: facts.contentBlocks,
    content: outcome.ok ? outcome.content : Object.freeze([]),
    eventId: result.event.eventId,
    transitionId,
  });
}

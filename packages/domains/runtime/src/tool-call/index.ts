import { BOUNDED_IDENTIFIER, ControlPlaneEvent, parseWorkerIdentity, utf8ByteLength } from "@acp/contracts";

import type { DurableInvocation } from "../contracts/index.js";
import { deriveEventCoordinate, deterministicUuid } from "../core/coordinates/index.js";
import { deriveInvocation } from "../submission/index.js";
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
/**
 * How long a claim on a coordinate is good for — V2 X1b.
 *
 * Derived, not guessed. A tool call is hard-bounded by the tool edge's own
 * `TOOL_CALL_TIMEOUT_MS` (30_000 at the time of writing), so a claimant that is
 * still alive cannot still be running after that bound plus the time it takes to
 * append a receipt. The margin is that append plus a generous allowance for a
 * loaded machine.
 *
 * **Restated rather than imported, and that is a fence fact.**
 * `RUNTIME_ALLOWED_PACKAGES` is the closed set `{@acp/accounts, @acp/contracts,
 * @acp/ledger}`, so this stratum cannot reach `@acp/tools`. Two numbers in two
 * homes is the cost; the alternative is a dependency edge added for one integer,
 * which is the trade this repository has refused before. If the tool edge's
 * bound moves, this must move with it — which is why the derivation is written
 * out rather than the sum being written down.
 */
export const TOOL_CALL_BOUND_MS = 30_000;
export const TOOL_CLAIM_MARGIN_MS = 30_000;
export const TOOL_CLAIM_TTL_MS = TOOL_CALL_BOUND_MS + TOOL_CLAIM_MARGIN_MS;

/** The word a poisoned coordinate settles under. Shape-bounded, not enumerated. */
export const TOOL_POSTCONDITION_UNKNOWN = "POSTCONDITION_UNKNOWN" as const;

/** The word a cross-process loser is refused with. */
export const TOOL_CLAIM_HELD = "CLAIM_HELD" as const;

/**
 * A live claimant holds this coordinate, so this caller never became one.
 *
 * A named class rather than a message a door matches on. Both doors must tell a
 * lost race apart from a defect — one is the arbitration working and answers
 * `409`, the other is ours and answers `500` — and a substring test over an
 * error message is a coupling that survives exactly until someone improves the
 * sentence. It extends {@link SupervisorError} because it *is* one: the request
 * never became an operation, no row exists, and no child was spawned.
 *
 * Its own module rather than `errors/index.ts`, as `ExecutionEffectError` is:
 * the failure belongs to this operation, and the constant it names is here.
 */
export class ToolClaimHeldError extends SupervisorError {
  readonly refusal = TOOL_CLAIM_HELD;

  constructor() {
    super(
      "another process holds this tool coordinate; the winner will record the" +
        " receipt, so this caller must read it rather than run the tool again" +
        " (" +
        TOOL_CLAIM_HELD +
        ")",
    );
    this.name = "ToolClaimHeldError";
  }
}

/**
 * The claim seam — V2 X1b.
 *
 * Structural, like `LedgerPort` beside it: the runtime declares the shape it
 * needs and `@acp/ledger`'s `ToolClaimStore` satisfies it, so this stratum owes
 * nothing to that module's exact types and a test can supply a fake without one.
 *
 * `now` lives on the port rather than in `ToolCallExecution` because a clock is
 * a capability, not a coordinate: putting it here keeps `runToolCall` at three
 * parameters and keeps every instant injected, which is what lets an expiry
 * boundary be drilled without sleeping.
 */
export interface ToolClaimRecord {
  readonly coordinateKey: string;
  readonly state: string;
  readonly expiresAt: string | null;
  /**
   * The identity that took the coordinate.
   *
   * Load-bearing, and not merely informational. `emittedBy` is a **durable
   * field of the receipt**, so a recoverer that signed a poison with its own
   * identity would build different canonical bytes under the same idempotency
   * key — and the second recoverer's append would take an idempotency conflict
   * rather than the exact replay this design depends on. The original holder is
   * on the claim precisely so the receipt can be rebuilt from the claim.
   *
   * `string | null` because the store types it so: a row exists in states where
   * no holder is set. An `IN_FLIGHT` row cannot be one of them, and the poison
   * path refuses rather than substituting itself if it ever is.
   */
  readonly holder: string | null;
  readonly taskId: string;
  readonly attempt: number;
  readonly transitionId: string;
  readonly submittedAt: string;
  readonly accountId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly argumentBytes: number;
}

export type ToolClaimVerdict =
  | { readonly verb: "TAKE"; readonly row: Record<string, unknown> }
  | { readonly verb: "MARK_IN_FLIGHT"; readonly at: string }
  | { readonly verb: "SETTLE"; readonly at: string }
  | { readonly verb: "REFUSE"; readonly reason: string };

export interface ToolClaimPort {
  readonly transact: (
    coordinateKey: string,
    decide: (current: ToolClaimRecord | null) => ToolClaimVerdict,
  ) => { readonly verb: string; readonly reason?: string; readonly row?: ToolClaimRecord | null };
  /** Injected, so expiry is decided with a clock a test can move. */
  readonly now: () => string;
}

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
/**
 * The recovery record, written at claim time by whoever takes the coordinate.
 *
 * Everything a poison receipt needs, so a recoverer rebuilds identical bytes
 * from the claim rather than from itself — the idempotency key is built from the
 * coordinate alone, but the event body carries the submission instant, the
 * account, the server, the tool and the byte count.
 */
function claimRowFor(
  execution: ToolCallExecution,
  coordinate: { readonly idempotencyKey: string },
  claimedAt: string,
  expiresAt: string,
  argumentBytes: number,
): Record<string, unknown> {
  return {
    // Keyed by the **coordinate**, not by the task. `claim_id` carries a
    // repository-wide partial UNIQUE index, and two different coordinates of one
    // attempt can be claimed inside the same millisecond -- a task-keyed
    // derivation would then mint one id twice and the second claim would die on
    // a constraint that has nothing to say about the race it is reporting.
    claimId: deterministicUuid("tool-claim/" + coordinate.idempotencyKey + "/" + claimedAt),
    holder: execution.identity,
    claimedAt,
    expiresAt,
    taskId: execution.invocation.taskId,
    attempt: execution.invocation.attempt,
    transitionId: toolCallTransitionId(execution.operationIndex, execution.callIndex),
    submittedAt: execution.invocation.submittedAt,
    accountId: execution.accountId,
    serverId: execution.serverId,
    toolName: execution.toolName,
    argumentBytes,
  };
}

/**
 * Promote a poisoned claim into a receipt, from the claim's own bytes.
 *
 * The coordinate is spent either way: the tool may have run and the plane cannot
 * tell, so it settles fail-closed under `POSTCONDITION_UNKNOWN` and is never
 * re-run. Two independent recoverers build the same event from the same claim,
 * so the second appends an exact replay rather than taking a conflict.
 */
function recordPoison(
  ledger: LedgerPort,
  claim: ToolClaimRecord,
  ownDigest: string,
): ToolCallOperationResult {
  // **Why the recoverer's own digest is safe here**, which is the one line a
  // reader will want. `invocationId` is `deterministicUuid("invocation/" +
  // taskId + "/" + attempt)` — taskId and attempt only, both stored on the
  // claim. `occurredAt` and `recordedAt` come from `submittedAt`, also stored.
  // `submissionDigest` reaches **no field of the event**, so two recoverers with
  // different digests build byte-identical rows from the same claim, and the
  // second append is an exact replay rather than a conflict. Measured, not
  // assumed: the event's fields are enumerated in `recordToolCall`.
  const invocation: DurableInvocation = deriveInvocation(
    claim.taskId,
    claim.attempt,
    claim.submittedAt,
    ownDigest,
  );
  // Signed by the **original holder**, never by whoever is recovering. Both
  // `emittedBy` and the causation id are durable fields of the receipt, so a
  // recoverer that supplied its own would build different bytes under one key
  // and the second recoverer would take an idempotency conflict instead of the
  // exact replay F8 depends on.
  //
  // The causation is pinned to `null` rather than stored on the claim, and that
  // is a decision rather than an omission: causation records what *this* caller
  // was caused by, and a poison is not caused by the recoverer's request. It is
  // the plane closing a coordinate whose original cause it cannot know from
  // here. `null` is both honest and identical for every recoverer.
  if (claim.holder === null) {
    throw new SupervisorError(
      "the poisoned coordinate carries no holder; the receipt cannot be signed as the original" +
        " claimant would have signed it, and the coordinate must not be re-run",
    );
  }
  const facts: ToolCallFacts = {
    serverId: claim.serverId,
    toolName: claim.toolName,
    // The transport is genuinely unknown: nothing in this process opened one.
    // `UNRESOLVED` is the word the tool edge already spells for exactly that,
    // and it reaches the row through the recorder's shape bound, not through a
    // vocabulary this stratum names.
    transport: "UNRESOLVED",
    outcome: "REFUSED",
    refusal: TOOL_POSTCONDITION_UNKNOWN,
    argumentBytes: claim.argumentBytes,
    resultBytes: 0,
    contentBlocks: 0,
  };
  const result = recordToolCall(ledger, {
    invocation,
    accountId: claim.accountId,
    facts,
    transitionId: claim.transitionId,
    emittedBy: claim.holder,
    causedBy: null,
  });
  return Object.freeze({
    replayed: false,
    outcome: facts.outcome,
    refusal: facts.refusal,
    at: null,
    serverId: facts.serverId,
    toolName: facts.toolName,
    transport: facts.transport,
    accountId: claim.accountId,
    argumentBytes: facts.argumentBytes,
    resultBytes: facts.resultBytes,
    contentBlocks: facts.contentBlocks,
    content: Object.freeze([]),
    eventId: result.event.eventId,
    transitionId: claim.transitionId,
  });
}

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
  claims: ToolClaimPort,
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

  // 10. The claim (V2 X1b). Step 9 read the receipt; this step decides whether
  //     this process may produce one. The order is the contract: reading the
  //     receipt first is what makes a crash between the append and the settle
  //     benign — the claim still says IN_FLIGHT, but the receipt exists, so a
  //     later caller replays above and never reaches here.
  //
  //     The transaction **commits before the port is called**. No SQLite write
  //     lock is held across an external process — L-X1-6 asserts it.
  const claimKey = coordinate.idempotencyKey;
  const argumentBytes = utf8ByteLength(JSON.stringify(execution.arguments));
  const claimedAt = claims.now();
  const expiresAt = new Date(Date.parse(claimedAt) + TOOL_CLAIM_TTL_MS).toISOString();

  const verdict = claims.transact(claimKey, (current) => {
    if (current === null) {
      return { verb: "TAKE", row: claimRowFor(execution, coordinate, claimedAt, expiresAt, argumentBytes) };
    }
    // Expiry is judged here, by the caller, because the store holds no clock.
    const expired = current.expiresAt !== null && Date.parse(current.expiresAt) <= Date.parse(claimedAt);
    if (current.state === "CLAIMED" && expired) {
      // No effect was attempted by the dead holder, so this is an ordinary
      // reclaim and the walk proceeds normally.
      return { verb: "TAKE", row: claimRowFor(execution, coordinate, claimedAt, expiresAt, argumentBytes) };
    }
    if (current.state === "IN_FLIGHT" && expired) {
      // The dangerous case: the tool may have answered and the receipt may not
      // have landed. Nobody may re-run it, and nobody may pretend it completed.
      // The coordinate is **not** spent inside this transaction: the receipt is
      // appended first, below, and the settle follows it. Spending it here would
      // put a window between "the store says spent" and "the ledger says why" in
      // which an append failure loses the evidence permanently.
      return { verb: "REFUSE", reason: TOOL_POSTCONDITION_UNKNOWN };
    }
    return { verb: "REFUSE", reason: TOOL_CLAIM_HELD };
  });

  if (verdict.reason === TOOL_POSTCONDITION_UNKNOWN) {
    // 11. The poison, promoted into the ledger and only then spent.
    //
    //     Rebuilt from the **claim the store handed back** and never from this
    //     process: the idempotency key is built from the coordinate alone, but
    //     the event body carries the submission instant, the account, the
    //     server, the tool and the byte count — so a recoverer that substituted
    //     its own values would build one key from different bytes and the second
    //     append would conflict rather than replay.
    //
    //     Two recoverers may reach this together. That is the intended shape,
    //     not a race to be excluded: both rebuild the same bytes, so the first
    //     appends and the second replays exactly (F8). What must never happen is
    //     a re-run of the tool, and neither of them can, because the coordinate
    //     never returns to `CLAIMED`.
    const claim = verdict.row ?? null;
    if (claim === null) {
      throw new SupervisorError(
        "the claim store reported a poisoned coordinate without returning the" +
          " claim; the receipt cannot be rebuilt and the coordinate must not be re-run",
      );
    }
    const poisoned = recordPoison(ledger, claim, invocation.submissionDigest);
    // Bookkeeping, after the evidence. A throw here means another recoverer
    // settled it first, which is the same answer arrived at twice.
    try {
      claims.transact(claimKey, () => ({ verb: "SETTLE", at: claims.now() }));
    } catch {
      /* the receipt is the record; who settled the claim is not */
    }
    return poisoned;
  }

  if (verdict.verb !== "TAKE") {
    // A loser never became an operation: no row, no spawn. The module's own
    // headline invariant, applied across processes rather than within one.
    throw new ToolClaimHeldError();
  }

  // The window opens here and only here.
  claims.transact(claimKey, () => ({ verb: "MARK_IN_FLIGHT", at: claims.now() }));

  // Hoisted so the `finally` below can settle the claim without the result
  // falling out of scope. The settle is bookkeeping; the receipt is the record.
  let recordedResult: ReturnType<typeof recordToolCall>;
  let recordedFacts: ToolCallFacts;
  // Read by the `finally` below, which the two above cannot be: they are
  // definitely assigned only where control reaches the end of the `try`.
  let receiptLanded = false;
  let refusedAt: string | null = null;
  let content: ToolCallOperationResult["content"] = Object.freeze([]);
  try {
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
    recordedFacts = facts;
    content = outcome.ok ? outcome.content : Object.freeze([]);
    recordedResult = recordToolCall(ledger, {
      invocation,
      accountId,
      facts,
      transitionId,
      emittedBy: identity,
      causedBy: execution.causedBy ?? null,
    });
    receiptLanded = true;
    refusedAt = outcome.ok ? null : outcome.at;
  } finally {
    // **Settled only against a receipt, and this is the load-bearing half of
    // the `finally`.** Settling unconditionally would spend the coordinate on
    // the one path where the effect may have run and left no row — the port
    // threw, or the append did — and a spent coordinate with no receipt is
    // exactly the unaudited effect this plane exists to refuse. Leaving the
    // claim `IN_FLIGHT` instead hands that case to expiry, which classifies it
    // `POSTCONDITION_UNKNOWN` and writes the receipt saying so.
    //
    // On the ordinary path the receipt is already durable, so a throw here is
    // harmless and F4 covers the crash that skips it — the next caller reads
    // the receipt at step 9 and replays.
    if (receiptLanded) {
      try {
        claims.transact(claimKey, () => ({ verb: "SETTLE", at: claims.now() }));
      } catch {
        /* the receipt is the record; the claim expiring is not a loss */
      }
    }
  }
  // Definitely assigned: the `try` above assigns both before it completes, and
  // the `finally` neither assigns nor swallows, so the only way past this point
  // is through a recorded receipt.
  const result = recordedResult;
  const facts = recordedFacts;

  return Object.freeze({
    replayed: false,
    outcome: facts.outcome,
    refusal: facts.refusal,
    at: refusedAt,
    serverId: facts.serverId,
    toolName: facts.toolName,
    transport: facts.transport,
    accountId,
    argumentBytes: facts.argumentBytes,
    resultBytes: facts.resultBytes,
    contentBlocks: facts.contentBlocks,
    content,
    eventId: result.event.eventId,
    transitionId,
  });
}

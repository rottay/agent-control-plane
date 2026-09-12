/**
 * ControlPlaneEvent — `@acp/contracts` (P8-T G6).
 *
 * The append-only ledger record and its idempotency coordinates.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import { attachGuards, serializedByteLength } from "../credential-guards/index.js";
import { TaskState } from "../lifecycle/index.js";
import { ContractVersion, Timestamp, Uuid } from "../primitives/index.js";
import { WorkerIdentityString } from "../worker-identity/index.js";

/** Serialized byte budget for a single ControlPlaneEvent payload. */
export const EVENT_PAYLOAD_MAX_BYTES = 8_192;

export const CONTROL_PLANE_EVENT_TYPES = [
  "TASK_DISCOVERED",
  "TASK_CLASSIFIED",
  "TASK_READY",
  "SLOT_RESERVED",
  "RUN_STARTED",
  "ATOMIC_STEP_COMPLETED",
  "CHECKPOINT_WRITTEN",
  "VERIFICATION_COMPLETED",
  "AUDIT_COMPLETED",
  "COMMIT_AUTHORIZED",
  "COMMIT_RECORDED",
  "LEASE_ACQUIRED",
  "LEASE_REVOKED",
  "WRITE_SET_VIOLATION_DETECTED",
  "QUOTA_WARNING",
  // Usage attribution. Both are task facts, so they belong to the task stream
  // and are same-state passthroughs: recording what a task spent, or what was
  // reserved for it, moves no lifecycle state. The payload is
  // `{accountId, tokens}` on the WorkerSlot bounds for both — the reservation
  // variant mirrors the usage shape rather than inventing a second one. In P7I
  // only tests append these; the runtime's own emission is a later packet.
  "TOKEN_USAGE_RECORDED",
  "TOKEN_RESERVATION_RECORDED",
  "ACCOUNT_SWITCH_STARTED",
  "ACCOUNT_SWITCH_COMPLETED",
  "AUTH_REQUIRED_RAISED",
  "TASK_STATE_CHANGED",
  "TASK_FAILED",
  "TASK_CANCELLED",
  // The durable tool-call receipt (V2-B4b stage 2). A task fact and a
  // same-state passthrough, exactly as the two usage types above are: a tool
  // call is something a run did, not a lifecycle move. The payload is the nine
  // safe scalars `{accountId, serverId, toolName, transport, outcome, refusal,
  // argumentBytes, resultBytes, contentBlocks}` — identifiers, screaming-snake
  // vocabulary words and counts, with no free text, no arguments, no results
  // and no session id anywhere in it.
  //
  // That shape is the **producer's** law, not this contract's: `payload` here
  // is `z.record(…, z.unknown())` for every type, so what keeps a tenth key
  // out is `@acp/runtime`'s recorder, which builds the payload field by field
  // from named members and refuses anything outside the grammar. What this
  // contract does enforce for it is what it enforces for every event — the
  // credential and transcript guards, and the payload byte budget.
  "TOOL_CALL_RECORDED",
  // The attempt's own opening (P-18/protocolo B). A task fact and a same-state
  // passthrough, exactly as the two usage types and the tool-call receipt above
  // are: opening an attempt records an identity, it does not move a lifecycle
  // state. It is the first member of this vocabulary that exists because a
  // *projection* needs a birth event — `task_attempt_read_model`'s row cannot
  // be folded from the presence of payload keys the way the revision record is,
  // because the attempt carries facts (`invocationId`, `legacyAttemptNumber`)
  // that only the arrival which opens it may state.
  //
  // The payload is the full coordinate plus the revision record plus the two
  // identity facts: `{revisionId, revisionNumber, attemptNumber,
  // envelopeSha256, restoredFromRevisionId?, invocationId,
  // legacyAttemptNumber}`. Carrying the revision keys is not redundancy — it is
  // what satisfies `fk_task_attempt_read_model__task_revision_read_model` by
  // construction, because the revision row is folded from this same event in
  // this same transaction rather than assumed to be already there.
  //
  // That shape is the **producer's** law and the ledger door's, not this
  // contract's: `payload` here is `z.record(…, z.unknown())` for every type, so
  // what keeps a stray key out is `@acp/runtime`'s builder — which is escalón G
  // and does not exist yet. What this contract does enforce for it is what it
  // enforces for every event: the key rule above (a complete V2 coordinate in
  // the payload requires the V2 key), the credential and transcript guards, and
  // the payload byte budget.
  "TASK_ATTEMPT_OPENED",
] as const;

export const ControlPlaneEventType = z.enum(CONTROL_PLANE_EVENT_TYPES);
export type ControlPlaneEventType = z.infer<typeof ControlPlaneEventType>;

/**
 * The idempotency coordinates of a ledger append.
 *
 * (taskId, attempt, transitionId) is the natural key. The derived
 * idempotencyKey is what the ledger enforces uniqueness on, so a replayed
 * durable step appends nothing rather than duplicating state.
 */
export const IdempotencyCoordinates = z.strictObject({
  taskId: Uuid,
  attempt: z.number().int().positive().max(10_000),
  transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});
export type IdempotencyCoordinates = z.infer<typeof IdempotencyCoordinates>;

export function buildIdempotencyKey(coordinates: IdempotencyCoordinates): string {
  return (
    coordinates.taskId + "/" + String(coordinates.attempt) + "/" + coordinates.transitionId
  );
}

/**
 * The namespace every V2 idempotency key begins with (streams §1.1).
 *
 * Migration 11 reserved this namespace in `@acp/ledger` and refused to open the
 * door if a historical key already sat inside it, leaving composition "to the
 * producer". The constant travelled with the reservation because that is where
 * the reservation ran — but a namespace is **grammar of the key**, and the key
 * is this contract's. So it moves here, and the ledger imports it (decision 42,
 * revising P-05/B's placement; Q2(b)). The direction is the only one the
 * dependency graph allows: `@acp/ledger` already imports `@acp/contracts`, and
 * this package may reach no `node:` builtin, so the constant could not have
 * gone the other way without a cycle.
 *
 * `ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1` is the standing precedent for the
 * shape: a preimage's version prefix declared here and computed in the ledger.
 *
 * The trailing separator is part of the constant, so the literal `"v2/"` lives
 * in exactly one `src` file of the monorepo and a caller composing a key cannot
 * get the join wrong by restating it (test N-A-3).
 */
export const V2_IDEMPOTENCY_NAMESPACE = "v2/";

/**
 * The streams a V2 key may name.
 *
 * streams §1.1's preimage puts a `stream` segment between the namespace and the
 * task id, which only means something if the vocabulary is closed: an open
 * string would let one producer write `control_plane_events` and another
 * `control-plane-events` for the same fact, and the uniqueness the key exists
 * to give would be gone. This escalón admits exactly one member — the stream
 * the ledger already names in `causation_stream` and in
 * `ck_projection_watermark__source_stream` — and a later escalón that needs
 * another adds it here rather than passing a bare string through.
 */
export const V2_IDEMPOTENCY_STREAMS = ["control_plane_events"] as const;

/**
 * The V2 idempotency coordinates: the full revision-aware coordinate of an
 * append (streams §1.1 `:134-140`).
 *
 * The V1 coordinate `(taskId, attempt, transitionId)` cannot distinguish a
 * retry of revision 2 from a retry of revision 1, because `attempt` is flat.
 * This one carries the revision, so `attemptNumber` may restart at 1 in each
 * new revision without colliding with anything.
 */
export const V2IdempotencyCoordinates = z.strictObject({
  stream: z.enum(V2_IDEMPOTENCY_STREAMS),
  taskId: Uuid,
  revisionNumber: z.number().int().positive().max(10_000),
  attemptNumber: z.number().int().positive().max(10_000),
  transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});
export type V2IdempotencyCoordinates = z.infer<typeof V2IdempotencyCoordinates>;

/**
 * Compose the V2 idempotency key, the one way it is ever composed.
 *
 * The preimage is streams §1.1's, in its order and with its separator:
 * `"v2" · stream · task_id · revision_number · attempt_number · transition_id`.
 * Every segment is a uuid, a closed vocabulary word, a decimal integer or an
 * identifier whose grammar excludes `/`, so the join is unambiguous and the key
 * can be read back apart. Nothing in the tree parses it — the ledger uniques on
 * it and compares it whole — but a key that could be composed two ways would
 * still be two keys for one fact.
 *
 * At the maximum `transitionId` the result is 193 characters, inside the
 * schema's 300 bound and inside the ledger's printable-key guard.
 */
export function buildV2IdempotencyKey(coordinates: V2IdempotencyCoordinates): string {
  return (
    V2_IDEMPOTENCY_NAMESPACE +
    coordinates.stream +
    "/" +
    coordinates.taskId +
    "/" +
    String(coordinates.revisionNumber) +
    "/" +
    String(coordinates.attemptNumber) +
    "/" +
    coordinates.transitionId
  );
}

/**
 * The V2 coordinate an event's payload carries, or `null` for a V1 event.
 *
 * Complete or absent, and nothing between: both keys must be present as safe
 * integers of at least one. A half pair — or a `null`, or a string `"2"` —
 * reads as **no coordinate** here, which makes the V1 key the one this schema
 * requires; the ledger's own door then refuses the malformed payload by name
 * before it can reach a column, and the stream trigger holds the same line
 * underneath. Three refusals rather than one, because the failure this shape
 * must never produce is a V2 event quietly recorded as legacy.
 *
 * This reads the payload it is given rather than trusting a caller's claim,
 * for the same reason the key is recomputed rather than accepted.
 */
function v2CoordinateInPayload(
  payload: Record<string, unknown>,
): { readonly revisionNumber: number; readonly attemptNumber: number } | null {
  const read = (key: string): number | null => {
    const value = payload[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
  };
  const revisionNumber = read("revisionNumber");
  const attemptNumber = read("attemptNumber");
  if (revisionNumber === null || attemptNumber === null) return null;
  return { revisionNumber, attemptNumber };
}

export const ControlPlaneEvent = z
  .strictObject({
    contractVersion: ContractVersion,
    eventId: Uuid,

    taskId: Uuid,
    attempt: z.number().int().positive().max(10_000),
    transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    /**
     * The key the ledger uniques on, and exactly one of two forms.
     *
     * Which form is not the producer's choice: it is decided by what the
     * payload carries. An event whose payload holds a complete V2 coordinate
     * must key with `buildV2IdempotencyKey`; one that does not must key with
     * `buildIdempotencyKey`. Nothing else passes — see the refinement below.
     */
    idempotencyKey: z.string().min(1).max(300),

    type: ControlPlaneEventType,
    fromState: TaskState.nullable(),
    toState: TaskState,

    emittedBy: WorkerIdentityString,
    occurredAt: Timestamp,
    recordedAt: Timestamp,

    /**
     * The causal thread. Definitional, and deliberately not enforced here.
     *
     * `correlationId` groups every event of one run: the producers set it to
     * the invocation's own id, so "this attempt" is selectable without
     * reconstructing it from coordinates.
     *
     * `causationId` names the event this one followed from. Within a walk that
     * is the plan's previous step in the same attempt; across tasks it is the
     * event that genuinely prompted the work, and null everywhere nothing
     * caused anything -- nothing causes a task's discovery.
     *
     * **The ledger does not verify either.** Integrity here means the hash
     * chain: `previousSha256`, `eventSha256`, the idempotency key. A row whose
     * causation names a missing event, or an event in another task, is a valid
     * row. Causation is therefore advisory, and its trustworthiness comes from
     * two guards outside this contract: the producer refuses to append a link
     * whose predecessor is not durably present, and the consumer refuses to
     * draw an edge it cannot resolve. Reading these fields as verified facts
     * about the world would be reading more than the contract promises.
     */
    correlationId: Uuid.nullable(),
    causationId: Uuid.nullable(),

    /** Bounded structured payload. Never a provider transcript. */
    payload: z.record(z.string().max(80), z.unknown()),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    // The door, and it is strict in both directions (C-1, adjudicated).
    //
    // Until P-18/protocolo A this refinement demanded the V1 form
    // unconditionally, which made the `v2/` namespace migration 11 reserved
    // physically unreachable: no producer could emit a V2 key, because the
    // contract refused it before the ledger ever saw it. Opening the door by
    // merely *permitting* the V2 form would have been the wrong repair. Two
    // admissible keys for one fact is two keys for one fact — the same
    // coordinate and transition could enter twice, once under each form, and
    // streams §1.1's "no … otro namespace de idempotencia para los mismos
    // hechos" would have become advice rather than a rule.
    //
    // So the payload decides and the producer obeys: a complete V2 coordinate
    // requires the V2 key, and its absence requires the V1 key. A producer
    // that hits a conflict cannot switch namespaces to make it go away,
    // because the namespace is not a thing it chooses (negative N-P18-20).
    const coordinate = v2CoordinateInPayload(value.payload);
    const expected =
      coordinate === null
        ? buildIdempotencyKey({
            taskId: value.taskId,
            attempt: value.attempt,
            transitionId: value.transitionId,
          })
        : buildV2IdempotencyKey({
            stream: "control_plane_events",
            taskId: value.taskId,
            revisionNumber: coordinate.revisionNumber,
            attemptNumber: coordinate.attemptNumber,
            transitionId: value.transitionId,
          });
    if (value.idempotencyKey !== expected) {
      ctx.addIssue({
        code: "custom",
        message:
          coordinate === null
            ? "idempotencyKey must be exactly taskId/attempt/transitionId"
            : "idempotencyKey must be the V2 key of the coordinate this payload carries",
        path: ["idempotencyKey"],
      });
    }

    if (value.fromState === value.toState && value.type === "TASK_STATE_CHANGED") {
      ctx.addIssue({
        code: "custom",
        message: "a state change event must actually change state",
        path: ["toState"],
      });
    }

    const size = serializedByteLength(value.payload);
    if (size > EVENT_PAYLOAD_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message:
          "event payload is " +
          String(size) +
          " bytes which exceeds the " +
          String(EVENT_PAYLOAD_MAX_BYTES) +
          " byte budget",
        path: ["payload"],
      });
    }
  });
export type ControlPlaneEvent = z.infer<typeof ControlPlaneEvent>;

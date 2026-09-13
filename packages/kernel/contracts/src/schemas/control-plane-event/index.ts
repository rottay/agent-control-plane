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
  // The three of P-18/protocolo C (execution §6, §6.1 and §7; ADR 0076). All
  // three are same-state passthroughs on the `execution` channel, exactly as
  // `TASK_ATTEMPT_OPENED` is: intending an effect, intending a delivery and
  // recording how a delivery went are things a run *did*, not moves through a
  // lifecycle.
  //
  // **Three, and the third is the one that is easy to leave out.** Without an
  // event that records a dispatch's resolution, `dispatch_state` could never
  // leave `INTENDED` and `effect_read_model.outcome_status` could never be
  // written at all — which would make `OUTCOME_UNKNOWN` a column no producer
  // can reach, and execution §6 `:252`'s whole rule unenforceable. The five
  // states of §7 stay closed at five: `RECONCILING` is `outbox_message`'s word
  // (coordination §2), not a sixth state here, and an overdue `INFLIGHT`
  // remains `INFLIGHT` and is *found* by an index rather than moved by a clock.
  //
  // The payload grammar is the **producer's** law and the ledger door's, not
  // this contract's — `payload` is `z.record(…, z.unknown())` for every type.
  // What this contract enforces for them is what it enforces for every event:
  // the key rule above, the credential and transcript guards, and the byte
  // budget. What the ledger enforces is the rest, and it recomputes every
  // digest whose preimage the event itself carries rather than believing it.
  "EFFECT_INTENDED",
  "DISPATCH_INTENDED",
  "DISPATCH_OUTCOME_RECORDED",
  // The two of P-18/protocolo D (execution §8; ADR 0077). Same-state
  // passthroughs on `execution`, for the reason the three above are: sending a
  // prompt and receiving its answer are things a run *did*.
  //
  // **Two, and not one.** The answer has a primary key of its own, its own
  // `recorded_at` and its own `sequence` (§8 `:406-412`), and §8 `:418` speaks
  // of an answer that arrives **late** — after a handoff, on a delivery that has
  // already been abandoned. A fact that happens at another instant cannot ride
  // the event of the prompt it answers.
  //
  // Neither carries a byte of the prompt or of the answer: digests and counts
  // only (§8 `:433`). The transcript guard below already refuses the keys a
  // conversation would travel under; the ledger door additionally refuses any
  // key its own payload grammar does not declare.
  "PROMPT_OCCURRENCE_RECORDED",
  "RESPONSE_OCCURRENCE_RECORDED",
  // The three of P-18/protocolo F (coordination §6.2 `:301-312`; ADR 0078).
  // Same-state passthroughs on `execution`, for the reason C's three are:
  // intending a command, intending one delivery of it and observing how that
  // delivery went are things the plane *did*, and none of them is a task moving
  // through its lifecycle.
  //
  // **The names are the specification's, not this escalón's.** §6.2 fixes all
  // three and fixes what each payload carries: the intention names its saga,
  // command, phase, kind, target, deadline and the nullable fence pair; the
  // attempt names its command and its own delivery attempt; the observation
  // names both, an outbox state, a nullable failure code and a nullable opaque
  // response handle. Every payload is versioned `outboxContractVersion = 1`.
  //
  // What these rows are **not** is a row of `outbox.sqlite`. Datos §11 `:548-550`
  // puts the command's intention inside the ledger's own transaction and says
  // the separate outbox is a cache: losing it rebuilds from these three events,
  // and never turns an uncertain delivery into `PENDING`.
  //
  // The payload grammar is the ledger door's, not this contract's, on C's terms.
  "OUTBOX_COMMAND_INTENDED",
  "OUTBOX_DELIVERY_INTENDED",
  "OUTBOX_DELIVERY_OBSERVED",
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
 * The version prefix of the effect identity preimage (P-18/protocolo C).
 *
 * ## The formula, stated once
 *
 *     preimage  = EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1 + canonicalJson([
 *                   taskId, revisionNumber, attemptNumber, segmentNumber,
 *                   operationOrdinal,
 *                 ])
 *     effect_id = SHA256(preimage)
 *
 * Execution §6 `:238` says `effect_id` "conserva la fórmula existente" over that
 * quintuple. **There is no existing formula.** The nearest things in the tree
 * are `operationId` — a deterministic uuid over a name — and `operationDigest`,
 * a sha-256 hex over slash-joined coordinates, and both are V1 shapes that know
 * nothing of a revision or a segment. Two writers reading that sentence would
 * have produced two identities, so this escalón writes one down rather than
 * inheriting a sentence (ADR 0076, correction C-4).
 *
 * The five members are exactly execution §6's quintuple, in its order. The
 * clock is **not** in it, and neither is anything resolved at dispatch time:
 * datos §6.3 puts `intended_at` outside on purpose, because replay and handoff
 * have to reproduce the same bytes, and an identity that moved with the wall
 * clock would make every retry a new effect.
 *
 * ## Why the prefix, and why here
 *
 * `ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1` is the precedent for both halves. The
 * prefix carries its own trailing LF and there is **no separator** between it
 * and the JSON: one LF, and it belongs to the prefix. And the rule lives in this
 * package while the function lives in `@acp/ledger`, because this package may
 * import `zod` and nothing else — a `node:crypto` here would make the contract
 * surface unloadable in a browser page, and a second canonicalizer would be a
 * second authority on a question `canonicalJsonStringify` already answers.
 *
 * A key's grammar is the contract's (decision 42, reiterated by decision 44),
 * which is why this sits beside `V2_IDEMPOTENCY_NAMESPACE` rather than in the
 * ledger that computes it.
 *
 * `v1` is frozen. A change to the encoding is a **new** prefix with a new name;
 * this constant is never edited and no history is ever rehashed, because a
 * digest whose preimage can be redefined identifies nothing.
 */
export const EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1 = "acp/execution-effect/v1\n";

/**
 * The version prefix of the effect idempotency-key preimage (P-18/protocolo C).
 *
 * ## The formula, stated once
 *
 *     preimage = EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1 + canonicalJson([
 *                  effectKind, taskId, revisionNumber, attemptNumber,
 *                  segmentNumber, operationOrdinal, envelopeSha256,
 *                ])
 *     key      = SHA256(preimage)
 *
 * Execution §6 `:250` gives the members and this fixes their encoding: the kind
 * of business operation, the same quintuple `effect_id` uses, and the envelope
 * digest of the revision the work was asked for under. **Two different keys over
 * overlapping material, on purpose.** `effect_id` names *which* logical step
 * this is inside a run; the idempotency key is what a destination is asked not
 * to do twice, so it additionally binds the kind of operation and the exact
 * revision of the work — a re-issued envelope is a different request even at the
 * same coordinate.
 *
 * The initial segment is fixed once, when the effect is created. Replay and
 * handoff conserve the original bytes: execution §6.1 `:329` is explicit that a
 * later authorized dispatch "conserva el efecto inicial y registra el segmento
 * efectivo aparte", which is what `dispatch_attempt_read_model.route_segment_id`
 * is for. Recomputing this key with the current segment would hand a destination
 * a second key for one operation, which is the single failure the column exists
 * to prevent.
 *
 * Prefix discipline, placement and the frozen `v1` are
 * `EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1`'s, for its reasons.
 */
export const EXECUTION_EFFECT_IDEMPOTENCY_PREIMAGE_PREFIX_V1 =
  "acp/execution-effect-idempotency/v1\n";

/**
 * The version prefix of the outbox command identity preimage (P-18/protocolo F).
 *
 * ## The formula, stated once
 *
 *     preimage   = OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1 + canonicalJson([
 *                    sagaId, phase, targetKind, targetId,
 *                  ])
 *     command_id = SHA256(preimage)
 *
 * Coordination §6 `:221` and datos §11 `:563-565` say `command_id` is
 * "determinista por `(saga_id, phase, target_kind, target_id)`" and give no
 * encoding. That is exactly C-4's situation for `effect_id` — a sentence, and no
 * formula — so this escalón writes one down rather than letting two producers
 * read the sentence two ways (ADR 0078).
 *
 * Decision 44 left the key's grammar to "the producer in P-18/F", with the note
 * that if it turned out to be grammar it would land in this package. It is
 * grammar: the ledger's door recomputes it and refuses a command whose id does
 * not match, so a producer and the door must agree on the bytes. The
 * computation is `@acp/ledger`'s, for `EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1`'s
 * reason — this package may reach no `node:` builtin.
 *
 * The four members are §6's four, in its order. The kind of command is **not**
 * in it: a saga that revokes a lease and releases a reservation names two
 * different targets, and one target at one phase is one command whatever it is
 * asked to do. The clock is not in it either, because retrying a command must
 * conserve its identity (coordination §7 `:360-361`).
 *
 * Prefix discipline, placement and the frozen `v1` are
 * `EXECUTION_EFFECT_ID_PREIMAGE_PREFIX_V1`'s, for its reasons.
 */
export const OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1 = "acp/outbox-command/v1\n";

/**
 * Why one delivery of one outbox command did not end `DELIVERED`
 * (P-18/protocolo F, decision 45's `last_failure_code`).
 *
 * Six words, closed. Contracts §16 fixes the seven-field failure record and
 * gives no row to the outbox; this is the `code` that record carries for
 * `origin ∈ {DURABILITY, EXECUTION}` in `phase ∈ {DISPATCH, RECOVERY}`, and the
 * exhaustive §16 map is a later packet's (ADR 0078). The words name a fact about
 * the destination or about the delivery, never a policy and never a provider's
 * prose:
 *
 * - `TARGET_REFUSED` — the destination answered with a typed refusal;
 * - `TARGET_STALE_TOKEN` — the destination's token had moved past the one the
 *   command was issued under;
 * - `TARGET_INCARNATION_MISMATCH` — the destination file is another incarnation
 *   than the one the command names;
 * - `TARGET_UNAVAILABLE` — the destination could not be reached;
 * - `DEADLINE_EXCEEDED` — the command's deadline passed first;
 * - `NOT_DISPATCHED_PROVEN` — reconciliation proved nothing was sent, which is
 *   the one fact coordination §2 `:51-54` accepts for `FAILED_RETRYABLE` or
 *   `ABANDONED` out of an uncertain delivery.
 *
 * **Imposed when written, not stored as a CHECK.** Decision 45 keeps
 * `outbox_message.last_failure_code` a free `TEXT`; the ledger's door refuses a
 * word outside this set, and the cache can only ever be rebuilt from what the
 * door admitted. It lives here beside the three event types because it is the
 * vocabulary of their payload.
 */
export const OUTBOX_FAILURE_CODES = [
  "TARGET_REFUSED",
  "TARGET_STALE_TOKEN",
  "TARGET_INCARNATION_MISMATCH",
  "TARGET_UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "NOT_DISPATCHED_PROVEN",
] as const;

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

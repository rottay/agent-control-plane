import { CONTRACT_VERSION, buildIdempotencyKey } from "@acp/contracts";
import type {
  ControlPlaneEvent,
  ControlPlaneEventType,
  ResolvedRoute,
  TaskState,
} from "@acp/contracts";
import { describe, expect, it } from "vitest";

import {
  LANGFUSE_TRACE_NAME,
  TELEMETRY_ATTRIBUTE_KEYS,
  TELEMETRY_REFUSAL_REASONS,
  TELEMETRY_SPAN_KIND,
  emitTelemetry,
  telemetrySpanName,
  toLangfuseTrace,
} from "../../src/index.js";

/**
 * Evidence for neutral telemetry, the redaction gate, and the optional
 * Langfuse boundary.
 *
 * Nothing here opens a ledger, and nothing here exports anything. The whole
 * surface is a pure function of contract values, which is the property being
 * held as much as the mapping itself: telemetry that needed a database to be
 * checked, or a vendor to be exercised, would not be the read-model projection
 * law 9 asks for.
 */

const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER_TASK = "22222222-2222-4222-8222-222222222222";
const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const OCCURRED = "2026-08-30T12:00:00.000Z";
const RECORDED = "2026-08-30T12:00:01.000Z";
const EMITTER = "claude/opus/implementer/01";

/**
 * One admitted route, in the shape the INTENT beat writes it.
 *
 * Nested under one key, which is the whole point: the walk has never written a
 * model, a provider, a transport or a policy version flat, so a projection
 * reading flat keys emitted none of them.
 */
const ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-route",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "2026-08-30.1",
  resolvedAt: "2026-08-30T11:59:00.000Z",
};

interface EventInput {
  readonly taskId?: string;
  readonly type: ControlPlaneEventType;
  readonly transitionId: string;
  readonly payload?: Record<string, unknown>;
  readonly fromState?: TaskState | null;
  readonly toState?: TaskState;
}

function event(input: EventInput): ControlPlaneEvent {
  const taskId = input.taskId ?? TASK;
  const attempt = 1;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: "00000000-0000-4000-8000-0000000000" + input.transitionId.slice(-2).padStart(2, "0"),
    taskId,
    attempt,
    transitionId: input.transitionId,
    idempotencyKey: buildIdempotencyKey({ taskId, attempt, transitionId: input.transitionId }),
    type: input.type,
    fromState: input.fromState === undefined ? "RUNNING" : input.fromState,
    toState: input.toState ?? "RUNNING",
    emittedBy: EMITTER,
    occurredAt: OCCURRED,
    recordedAt: RECORDED,
    correlationId: null,
    causationId: null,
    payload: input.payload ?? {},
  };
}

// ---------------------------------------------------------------------------
// The neutral mapping
// ---------------------------------------------------------------------------

describe("the ledger's events become OTel-shaped values", () => {
  it("maps one event onto conventional attribute names, and nothing else", () => {
    const batch = emitTelemetry([
      event({
        type: "TOKEN_USAGE_RECORDED",
        transitionId: "usage.01",
        payload: { accountId: "acct-a", tokens: 1_234 },
      }),
    ]);

    expect(batch.refusedCount).toBe(0);
    const [first] = batch.events;
    if (first === undefined) throw new Error("expected one event");

    expect(first.name).toBe("acp.token_usage_recorded");
    expect(first.startTime).toBe(OCCURRED);
    expect(first.endTime).toBe(RECORDED);
    expect(first.status).toBe("OK");

    // The whole attribute surface, by equality rather than by sampling: an
    // attribute this module started emitting without anyone deciding to would
    // fail here rather than quietly reach an exporter.
    expect(first.attributes).toEqual({
      "acp.task.id": TASK,
      "acp.task.attempt": 1,
      // The event's own id, in full. The span id is its first eight bytes, so
      // the ledger row is not recoverable from the span context alone.
      "acp.event.id": "00000000-0000-4000-8000-000000000001",
      "acp.event.type": "TOKEN_USAGE_RECORDED",
      "acp.event.transition_id": "usage.01",
      "acp.task.state.from": "RUNNING",
      "acp.task.state.to": "RUNNING",
      "acp.worker.identity": EMITTER,
      "acp.account.id": "acct-a",
      // Not `gen_ai.usage.output_tokens`: that key names output tokens, and
      // only one of three adapters supplies those. The count is the one the
      // adapter reported, and this key says exactly that much.
      "acp.usage.tokens": 1_234,
      "openinference.span.kind": TELEMETRY_SPAN_KIND,
    });
  });

  it("reads the route where the walk writes it, nested, and promotes five fields", () => {
    const batch = emitTelemetry([
      event({
        type: "RUN_STARTED",
        transitionId: "run.01",
        fromState: "RESERVED",
        payload: {
          submissionDigest: "d".repeat(64),
          beat: "INTENT",
          route: { ...ROUTE },
        },
      }),
    ]);

    expect(batch.refusedCount).toBe(0);
    const [first] = batch.events;
    if (first === undefined) throw new Error("expected one event");

    // The whole surface again, so what is ABSENT is asserted too: nothing flat
    // survives from the payload, `resolvedAt` is not promoted, and there is no
    // `gen_ai.response.model` -- the provider's own resolution never reaches
    // the ledger, so the key has no source and is absent by construction.
    expect(first.attributes).toEqual({
      "acp.task.id": TASK,
      "acp.task.attempt": 1,
      "acp.event.id": "00000000-0000-4000-8000-000000000001",
      "acp.event.type": "RUN_STARTED",
      "acp.event.transition_id": "run.01",
      "acp.task.state.from": "RESERVED",
      "acp.task.state.to": "RUNNING",
      "acp.worker.identity": EMITTER,
      "acp.account.id": ROUTE.accountId,
      "acp.route.provider": ROUTE.provider,
      "acp.route.transport_kind": ROUTE.transportKind,
      "acp.route.capability_policy_version": ROUTE.capabilityPolicyVersion,
      "gen_ai.request.model": ROUTE.model,
      "openinference.span.kind": TELEMETRY_SPAN_KIND,
    });
    expect(JSON.stringify(first.attributes)).not.toContain(ROUTE.resolvedAt);
    expect(JSON.stringify(first.attributes)).not.toContain("submissionDigest");
  });

  it("promotes the usage count for one event type, and a reservation for none", () => {
    const [usage] = emitTelemetry([
      event({
        type: "TOKEN_USAGE_RECORDED",
        transitionId: "usage.01",
        payload: { accountId: "acct-a", tokens: 500 },
      }),
    ]).events;
    const [reservation] = emitTelemetry([
      event({
        type: "TOKEN_RESERVATION_RECORDED",
        transitionId: "reservation.01",
        payload: { accountId: "acct-a", tokens: 500 },
      }),
    ]).events;
    if (usage === undefined || reservation === undefined) throw new Error("expected two events");

    // Held tokens are not spent tokens. A reservation reported under a usage
    // key would be spend a reader would add to a bill, and there is no
    // reservation attribute to move it to either: no production emitter writes
    // a reservation, and minting a key for a fact nobody records is the
    // fabrication this projection refuses.
    expect(usage.attributes[TELEMETRY_ATTRIBUTE_KEYS.tokens]).toBe(500);
    expect(Object.hasOwn(reservation.attributes, TELEMETRY_ATTRIBUTE_KEYS.tokens)).toBe(false);
    expect(JSON.stringify(reservation.attributes)).not.toContain("500");
  });

  it("gives the pressure recorder's provider its own name, not the route's", () => {
    const [first] = emitTelemetry([
      event({
        type: "QUOTA_WARNING",
        transitionId: "pressure.01",
        payload: { accountId: "acct-a", provider: "codex", pressure: "QUOTA_WARNING" },
      }),
    ]).events;
    if (first === undefined) throw new Error("expected one event");

    // The value is the provider that REPORTED the pressure, as the adapter
    // classified it. `acp.route.provider` would assert a route this event does
    // not carry, and the `pressure` key itself is not promoted at all.
    expect(first.attributes[TELEMETRY_ATTRIBUTE_KEYS.pressureProvider]).toBe("codex");
    expect(Object.hasOwn(first.attributes, TELEMETRY_ATTRIBUTE_KEYS.routeProvider)).toBe(false);
    expect(JSON.stringify(first.attributes)).not.toContain("acp.pressure.kind");
  });

  it("projects nothing from a malformed route, and refuses nothing for it", () => {
    const batch = emitTelemetry([
      event({
        type: "RUN_STARTED",
        transitionId: "run.01",
        payload: { submissionDigest: "d".repeat(64), route: { provider: "claude", model: "" } },
      }),
    ]);

    // A bad route is not a redaction failure. Refusing here would mis-signal
    // the refusal count, and promoting the fields that happened to parse would
    // put a partial row where a reader expects a route.
    expect(batch.refusedCount).toBe(0);
    const [first] = batch.events;
    if (first === undefined) throw new Error("expected one event");
    for (const key of [
      TELEMETRY_ATTRIBUTE_KEYS.model,
      TELEMETRY_ATTRIBUTE_KEYS.routeProvider,
      TELEMETRY_ATTRIBUTE_KEYS.transportKind,
      TELEMETRY_ATTRIBUTE_KEYS.policyVersion,
    ]) {
      expect(Object.hasOwn(first.attributes, key)).toBe(false);
    }
    // The event's own attributes still emit: a route it could not read is not
    // a reason to lose the coordinates it could.
    expect(first.attributes[TELEMETRY_ATTRIBUTE_KEYS.taskId]).toBe(TASK);
    expect(first.attributes[TELEMETRY_ATTRIBUTE_KEYS.eventType]).toBe("RUN_STARTED");
  });

  it("promotes only the allowlisted payload keys, never the payload itself", () => {
    const batch = emitTelemetry([
      event({
        type: "TASK_DISCOVERED",
        transitionId: "discovery.01",
        payload: {
          initiativeId: INITIATIVE,
          // Not on the allowlist. A projection that mirrored whatever a
          // payload carried would export tomorrow's new field without anyone
          // deciding to.
          scratchNote: "an internal note nobody chose to export",
          planIndex: 0,
        },
      }),
    ]);

    const [first] = batch.events;
    if (first === undefined) throw new Error("expected one event");
    expect(first.attributes[TELEMETRY_ATTRIBUTE_KEYS.initiativeId]).toBe(INITIATIVE);
    expect(JSON.stringify(first)).not.toContain("scratchNote");
    expect(JSON.stringify(first)).not.toContain("an internal note");
    expect(Object.hasOwn(first.attributes, "planIndex")).toBe(false);
  });

  it("omits a state it does not have rather than spelling null", () => {
    const batch = emitTelemetry([
      event({ type: "TASK_DISCOVERED", transitionId: "discovery.01", fromState: null, toState: "DISCOVERED" }),
    ]);
    const [first] = batch.events;
    if (first === undefined) throw new Error("expected one event");

    // An absent attribute is how OTel says "not applicable"; the string
    // "null" would be a value a reader has to know to disbelieve.
    expect(Object.hasOwn(first.attributes, TELEMETRY_ATTRIBUTE_KEYS.fromState)).toBe(false);
    expect(JSON.stringify(first.attributes)).not.toContain("null");
  });

  it("reports failure-class events as ERROR and the rest as OK", () => {
    const batch = emitTelemetry([
      event({ type: "TASK_FAILED", transitionId: "fail.01" }),
      event({ type: "CHECKPOINT_WRITTEN", transitionId: "checkpoint.01" }),
    ]);
    expect(batch.events.map((telemetry) => telemetry.status)).toEqual(["ERROR", "OK"]);
  });

  it("classifies a revocation by its cause, not by its type", () => {
    // The status table, row by row. A `LEASE_REVOKED` used to be an ERROR on
    // EVERY revocation, and a clean walk ends by releasing its lease -- so the
    // projection reported every successful run as a fault. The three causes
    // that really are faults are named; the two lawful ones are not; and a
    // cause in neither set is unclassified rather than guessed, because
    // `cause` is a string and not an enum.
    const revocation = (cause: string | undefined): ControlPlaneEvent =>
      event({
        type: "LEASE_REVOKED",
        transitionId: "lease.01",
        payload:
          cause === undefined
            ? { leaseId: "lease-a", holder: EMITTER }
            : { leaseId: "lease-a", holder: EMITTER, cause },
      });

    const statuses = (causes: readonly (string | undefined)[]): readonly string[] =>
      emitTelemetry(causes.map(revocation)).events.map((telemetry) => telemetry.status);

    expect(statuses(["RELEASED", "ACCOUNT_SWITCH"])).toEqual(["OK", "OK"]);
    expect(statuses(["WRITE_SET_VIOLATION_DETECTED", "HOLDER_DEAD", "EXPIRED"])).toEqual([
      "ERROR",
      "ERROR",
      "ERROR",
    ]);
    expect(statuses([undefined, "SOMETHING_NOBODY_HAS_WRITTEN_YET"])).toEqual(["UNSET", "UNSET"]);
  });

  it("classifies quarantine on the state, and a cancellation as an outcome", () => {
    const batch = emitTelemetry([
      // What the dead `TASK_QUARANTINED` literal meant. It was never a member
      // of the frozen vocabulary, so no event could ever have selected it;
      // quarantine is reached as a state change, and is classified as one.
      event({
        type: "TASK_STATE_CHANGED",
        transitionId: "quarantine.01",
        toState: "SUSPECT_WORKTREE",
      }),
      event({ type: "TASK_STATE_CHANGED", transitionId: "state.01", toState: "READY_TO_COMMIT" }),
      // A cancellation is an outcome and a warning is a warning. OTel's ERROR
      // is not "not-success".
      event({ type: "TASK_CANCELLED", transitionId: "cancel.01" }),
      event({ type: "QUOTA_WARNING", transitionId: "quota.01" }),
      // Produced in production, and absent from the old error list, so the one
      // event meaning "a walk wrote outside its declared set" reported OK.
      event({ type: "WRITE_SET_VIOLATION_DETECTED", transitionId: "violation.01" }),
      event({ type: "AUTH_REQUIRED_RAISED", transitionId: "auth.01" }),
    ]);
    expect(batch.events.map((telemetry) => telemetry.status)).toEqual([
      "ERROR",
      "OK",
      "OK",
      "OK",
      "ERROR",
      "ERROR",
    ]);
  });

  it("names a tool-call receipt a TOOL span, and everything else an AGENT span", () => {
    // The OpenInference half of the contract. `TOOL_CALL_RECORDED` is the one
    // event the convention has a word for, and stamping it AGENT made the
    // projection false for exactly the event the convention names.
    const [tool] = emitTelemetry([
      event({ type: "TOOL_CALL_RECORDED", transitionId: "tool.01" }),
    ]).events;
    if (tool === undefined) throw new Error("expected one event");
    expect(tool.attributes[TELEMETRY_ATTRIBUTE_KEYS.spanKind]).toBe("TOOL");

    for (const type of [
      "RUN_STARTED",
      "TASK_FAILED",
      "TOKEN_USAGE_RECORDED",
      "LEASE_REVOKED",
      "CHECKPOINT_WRITTEN",
    ] as const) {
      const [other] = emitTelemetry([event({ type, transitionId: "kind.01" })]).events;
      if (other === undefined) throw new Error("expected one event");
      expect(other.attributes[TELEMETRY_ATTRIBUTE_KEYS.spanKind]).toBe(TELEMETRY_SPAN_KIND);
    }
  });

  it("is deterministic: two runs over the same events are byte-identical", () => {
    const events = [
      event({ type: "RUN_STARTED", transitionId: "run.01" }),
      event({
        type: "TOKEN_USAGE_RECORDED",
        transitionId: "usage.01",
        payload: { tokens: 7, accountId: "acct-a", model: "opus" },
      }),
    ];
    // Serialized, so attribute *order* is compared too: a fold whose key order
    // depended on payload insertion order would pass a deep-equal and fail
    // this.
    expect(JSON.stringify(emitTelemetry(events))).toBe(JSON.stringify(emitTelemetry(events)));
  });

  it("names spans from the event type, never from free text", () => {
    expect(telemetrySpanName("TASK_DISCOVERED")).toBe("acp.task_discovered");
    expect(emitTelemetry([]).events).toEqual([]);
    expect(emitTelemetry([]).refusedCount).toBe(0);
  });
});
// ---------------------------------------------------------------------------
// The trace tree (V2-B5/R10)
// ---------------------------------------------------------------------------

/**
 * Collision-free fixtures, and why the file needs a second builder.
 *
 * `event()` above mints every id as `"00000000-0000-4000-8000-0000000000" +
 * two digits`, so every fixture in this file shares its first eight bytes.
 * Under an eight-byte fold they are indistinguishable, and a tree suite built
 * on that helper would assert nothing: every span would carry the same id and
 * every parent lookup would resolve to whichever event was indexed last.
 *
 * So the ids below differ in their FIRST byte, which is the half the span id
 * is taken from, and `causal()` takes the three causal columns as arguments
 * rather than writing nulls into all of them.
 */
const CORRELATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CORRELATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const EVENT_1 = "11111111-2222-4333-8444-555555555551";
const EVENT_2 = "21111111-2222-4333-8444-555555555552";
const EVENT_3 = "31111111-2222-4333-8444-555555555553";
const EVENT_4 = "41111111-2222-4333-8444-555555555554";
const EVENT_5 = "51111111-2222-4333-8444-555555555555";
const ABSENT_EVENT = "e1111111-2222-4333-8444-55555555550e";

/** The nil UUID. `z.uuid()` admits it; every derived id carries a version. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * An id whose first eight bytes are zero without being the nil UUID.
 *
 * Measured against `zod@4.1.13`: `z.uuid()` REFUSES this one, because hex
 * index 12 is the version nibble and only the nil UUID may leave it zero. So
 * the case is reachable only from a value that never passed
 * `ControlPlaneEvent.parse` -- a hand-built or foreign record, exactly like
 * the malformed route two sections above. The guard is implemented anyway,
 * because the TypeScript value space this module is total over admits it.
 */
const ZERO_HEAD_EVENT = "00000000-0000-0000-8444-555555555559";

interface CausalInput {
  readonly eventId: string;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly transitionId: string;
  readonly type?: ControlPlaneEventType;
  readonly taskId?: string;
  readonly payload?: Record<string, unknown>;
}

function causal(input: CausalInput): ControlPlaneEvent {
  const taskId = input.taskId ?? TASK;
  const attempt = 1;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: input.eventId,
    taskId,
    attempt,
    transitionId: input.transitionId,
    idempotencyKey: buildIdempotencyKey({ taskId, attempt, transitionId: input.transitionId }),
    type: input.type ?? "ATOMIC_STEP_COMPLETED",
    fromState: "RUNNING",
    toState: "RUNNING",
    emittedBy: EMITTER,
    occurredAt: OCCURRED,
    recordedAt: RECORDED,
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: input.payload ?? {},
  };
}

/** The fold, restated in the test so the assertion computes rather than recalls. */
function uuidHex(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}

/** A resolvable three-step chain in one correlation, in causal order. */
function chain(): readonly ControlPlaneEvent[] {
  return [
    causal({ eventId: EVENT_1, correlationId: CORRELATION_A, causationId: null, transitionId: "one.01" }),
    causal({ eventId: EVENT_2, correlationId: CORRELATION_A, causationId: EVENT_1, transitionId: "two.01" }),
    causal({ eventId: EVENT_3, correlationId: CORRELATION_A, causationId: EVENT_2, transitionId: "three.01" }),
  ];
}

describe("a span is parented only where the ledger resolves it", () => {
  it("U1: derives a span context from the correlation and the event id", () => {
    const [first] = emitTelemetry([
      causal({ eventId: EVENT_1, correlationId: CORRELATION_A, causationId: null, transitionId: "one.01" }),
    ]).events;
    if (first === undefined) throw new Error("expected one event");

    const context = first.spanContext;
    if (context === null) throw new Error("expected a span context");
    // Shape before value: a 32-hex trace and a 16-hex span, both lower-cased,
    // are what the OTel data model calls a span context. Anything else is not
    // one, however plausible it reads.
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("U2: the fold is the normalized hex, and its head — computed, not recalled", () => {
    const [first] = emitTelemetry([
      causal({ eventId: EVENT_2, correlationId: CORRELATION_B, causationId: null, transitionId: "two.01" }),
    ]).events;
    if (first === undefined) throw new Error("expected one event");

    // Computed from the fixture ids rather than pasted as literals: a pasted
    // vector proves the run agreed with a transcription, not with the rule.
    expect(first.spanContext).toEqual({
      traceId: uuidHex(CORRELATION_B),
      spanId: uuidHex(EVENT_2).slice(0, 16),
      parentSpanId: null,
    });
  });

  it("U3: a correlation-less event gets no context, and is not a refusal", () => {
    const batch = emitTelemetry([
      causal({ eventId: EVENT_1, correlationId: null, causationId: null, transitionId: "one.01" }),
      // The same case carrying a causation, so the counter is pinned here too:
      // an event with no trace has no parent to resolve, and that is exactly
      // an unresolved causation rather than a second silent drop.
      causal({ eventId: EVENT_2, correlationId: null, causationId: EVENT_1, transitionId: "two.01" }),
    ]);

    // A span this projection cannot place is not a record it must withhold.
    // Refusing here would mis-signal the refusal count, which is the module's
    // own settled allocation for the malformed route.
    expect(batch.events.map((telemetry) => telemetry.spanContext)).toEqual([null, null]);
    expect(batch.refusedCount).toBe(0);
    expect(batch.unresolvedCausationCount).toBe(1);
  });

  it("U4: a nil correlation is a degeneration, not a trace of zeroes", () => {
    const batch = emitTelemetry([
      causal({ eventId: EVENT_1, correlationId: NIL_UUID, causationId: null, transitionId: "one.01" }),
    ]);

    // `z.uuid()` admits the nil UUID, so this guard is required rather than
    // decorative. A trace id of thirty-two zeroes is not a trace: OTel names
    // the all-zero id invalid, and emitting it would put every degenerate
    // event of every chain in one enormous fictional trace.
    expect(batch.events[0]?.spanContext).toBe(null);
    expect(batch.refusedCount).toBe(0);
  });

  it("U5: an event id whose head folds to zero yields no span, and no refusal", () => {
    const batch = emitTelemetry([
      causal({
        eventId: ZERO_HEAD_EVENT,
        correlationId: CORRELATION_A,
        causationId: null,
        transitionId: "one.01",
      }),
    ]);

    // The correlation is usable and the event id is not. All or nothing: a
    // span id without a trace id is not a span, and a trace id without a span
    // id is not one either, so the whole context is absent rather than half
    // present.
    expect(batch.events[0]?.spanContext).toBe(null);
    expect(batch.refusedCount).toBe(0);
  });

  it("U6: an uncaused event is a root of its trace, and stays one", () => {
    const [first] = emitTelemetry([
      causal({ eventId: EVENT_1, correlationId: CORRELATION_A, causationId: null, transitionId: "one.01" }),
    ]).events;
    if (first === undefined) throw new Error("expected one event");

    // A trace is honestly a forest. No synthetic root is minted to make the
    // shape look like a tree, because a span that names no ledger row is a
    // fact this projection would be inventing.
    expect(first.spanContext?.parentSpanId).toBe(null);
    expect(first.spanContext?.traceId).toBe(uuidHex(CORRELATION_A));
  });

  it("U7: a causation naming an event outside the batch is counted, not drawn", () => {
    const batch = emitTelemetry([
      causal({
        eventId: EVENT_1,
        correlationId: CORRELATION_A,
        causationId: ABSENT_EVENT,
        transitionId: "one.01",
      }),
    ]);

    // The contract's own sentence: the consumer refuses to draw an edge it
    // cannot resolve. Parentage is batch-scoped, and a cause outside the page
    // is a fact this projection cannot substantiate.
    expect(batch.events[0]?.spanContext?.parentSpanId).toBe(null);
    expect(batch.unresolvedCausationCount).toBe(1);
    expect(batch.refusedCount).toBe(0);
  });

  it("U8: a cause in a different correlation is not a parent edge", () => {
    const batch = emitTelemetry([
      causal({ eventId: EVENT_1, correlationId: CORRELATION_B, causationId: null, transitionId: "one.01" }),
      causal({
        eventId: EVENT_2,
        correlationId: CORRELATION_A,
        causationId: EVENT_1,
        transitionId: "two.01",
      }),
    ]);

    // Cross-trace causation is not a weak parent edge, it is a corrupt one:
    // in OTel a parent must be in the same trace. The relation is refused and
    // counted, and the raw id still travels as an attribute.
    const [, child] = batch.events;
    if (child === undefined) throw new Error("expected two events");
    expect(child.spanContext?.parentSpanId).toBe(null);
    expect(child.attributes[TELEMETRY_ATTRIBUTE_KEYS.causationId]).toBe(EVENT_1);
    expect(batch.unresolvedCausationCount).toBe(1);

    // The structural half, over the whole batch: no emitted parent may name a
    // span in another trace.
    const spansByTrace = new Map<string, Set<string>>();
    for (const emitted of batch.events) {
      const context = emitted.spanContext;
      if (context === null) continue;
      const seen = spansByTrace.get(context.traceId) ?? new Set<string>();
      seen.add(context.spanId);
      spansByTrace.set(context.traceId, seen);
    }
    for (const emitted of batch.events) {
      const context = emitted.spanContext;
      if (context === null) continue;
      if (context.parentSpanId === null) continue;
      expect(spansByTrace.get(context.traceId)?.has(context.parentSpanId)).toBe(true);
    }
  });

  it("U9: siblings need no rule — one cause, three children, three distinct spans", () => {
    const batch = emitTelemetry([
      causal({ eventId: EVENT_1, correlationId: CORRELATION_A, causationId: null, transitionId: "one.01" }),
      causal({ eventId: EVENT_2, correlationId: CORRELATION_A, causationId: EVENT_1, transitionId: "two.01" }),
      causal({ eventId: EVENT_3, correlationId: CORRELATION_A, causationId: EVENT_1, transitionId: "three.01" }),
      causal({ eventId: EVENT_4, correlationId: CORRELATION_A, causationId: EVENT_1, transitionId: "four.01" }),
    ]);

    // Exactly what `executeSwitchPlan` writes: every event of one plan takes
    // the same `causedBy`. Ordinary OTel, and no sibling rule is needed to
    // express it.
    const children = batch.events.slice(1);
    expect(children.map((child) => child.spanContext?.parentSpanId)).toEqual([
      uuidHex(EVENT_1).slice(0, 16),
      uuidHex(EVENT_1).slice(0, 16),
      uuidHex(EVENT_1).slice(0, 16),
    ]);
    expect(new Set(children.map((child) => child.spanContext?.spanId)).size).toBe(3);
    expect(batch.unresolvedCausationCount).toBe(0);
  });

  it("U10: a refused cause has no span, so nothing may name it as a parent", () => {
    const secret = "sk-p87-do-not-emit-0123456789";
    const batch = emitTelemetry([
      causal({
        eventId: EVENT_1,
        correlationId: CORRELATION_A,
        causationId: null,
        transitionId: "one.01",
        payload: { apiKey: secret },
      }),
      causal({
        eventId: EVENT_2,
        correlationId: CORRELATION_A,
        causationId: EVENT_1,
        transitionId: "two.01",
      }),
    ]);

    // The half a one-pass fold gets wrong. The cause is present among the
    // INPUTS and absent from what the batch EMITTED, so an index built while
    // shaping would resolve a parent that names a span which does not exist --
    // and would leak a structural trace of a record the gate exists to
    // withhold.
    expect(batch.refusedCount).toBe(1);
    expect(batch.events.length).toBe(1);
    expect(batch.events[0]?.spanContext?.parentSpanId).toBe(null);
    expect(batch.unresolvedCausationCount).toBe(1);

    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain(uuidHex(EVENT_1).slice(0, 16));
    expect(serialized).not.toContain(secret);
  });

  it("U11: the two id attributes, and the correlation attribute that is absent", () => {
    const [child] = emitTelemetry([
      causal({
        eventId: EVENT_2,
        correlationId: CORRELATION_A,
        causationId: EVENT_1,
        transitionId: "two.01",
        type: "TASK_DISCOVERED",
      }),
    ]).events;
    if (child === undefined) throw new Error("expected one event");

    // The whole surface by equality, so a third id attribute added without
    // anyone deciding to fails here. `acp.event.id` exists because a span id
    // is 64 of the event id's 128 bits, so the ledger row is not recoverable
    // from the span alone; `acp.event.causation_id` exists because the parent
    // relation is DROPPED whenever the four clauses refuse it, which for a
    // real account switch is always.
    expect(child.attributes).toEqual({
      "acp.task.id": TASK,
      "acp.task.attempt": 1,
      "acp.event.id": EVENT_2,
      "acp.event.causation_id": EVENT_1,
      "acp.event.type": "TASK_DISCOVERED",
      "acp.event.transition_id": "two.01",
      "acp.task.state.from": "RUNNING",
      "acp.task.state.to": "RUNNING",
      "acp.worker.identity": EMITTER,
      "openinference.span.kind": TELEMETRY_SPAN_KIND,
    });

    // No `acp.event.correlation_id`, on any event. The trace id IS the
    // correlation, losslessly and invertibly, so a third attribute would be a
    // second spelling of a fact the output already carries.
    const uncaused = emitTelemetry([
      causal({ eventId: EVENT_1, correlationId: CORRELATION_A, causationId: null, transitionId: "one.01" }),
    ]).events[0];
    if (uncaused === undefined) throw new Error("expected one event");
    expect(Object.hasOwn(uncaused.attributes, "acp.event.causation_id")).toBe(false);
    expect(uncaused.attributes["acp.event.id"]).toBe(EVENT_1);
    expect(JSON.stringify(emitTelemetry(chain()))).not.toContain("acp.event.correlation_id");
  });

  it("U12: the counter is zero for a resolved chain and exact for a mixed one", () => {
    // A read model that silently discarded every cross-task edge would look
    // identical to one whose chains had no cross-task edges. The counter is
    // what stands between those two.
    expect(emitTelemetry(chain()).unresolvedCausationCount).toBe(0);

    const mixed = emitTelemetry([
      ...chain(),
      causal({
        eventId: EVENT_4,
        correlationId: CORRELATION_A,
        causationId: ABSENT_EVENT,
        transitionId: "four.01",
      }),
      causal({
        eventId: EVENT_5,
        correlationId: CORRELATION_A,
        causationId: NIL_UUID,
        transitionId: "five.01",
      }),
    ]);
    expect(mixed.unresolvedCausationCount).toBe(2);
    expect(mixed.refusedCount).toBe(0);
  });

  it("U13: two runs, and a structurally cloned input, serialize identically", () => {
    const events = chain();
    expect(JSON.stringify(emitTelemetry(events))).toBe(JSON.stringify(emitTelemetry(events)));
    // A clone shares no object identity with the original, so a fold that had
    // quietly keyed on reference rather than on value would part company here.
    const cloned = structuredClone(events) as ControlPlaneEvent[];
    expect(JSON.stringify(emitTelemetry(cloned))).toBe(JSON.stringify(emitTelemetry(events)));
    // The determinism claim is only worth making about a projection that
    // actually carries the tree: two runs of a fold that emits no span context
    // agree with each other perfectly and prove nothing about this packet.
    expect(JSON.stringify(emitTelemetry(events))).toContain("spanContext");
    expect(JSON.stringify(emitTelemetry(events))).toContain("parentSpanId");
  });

  it("U14: reversing the batch changes no span context — parent is not predecessor", () => {
    const forward = emitTelemetry(chain()).events;
    const reversed = emitTelemetry([...chain()].reverse()).events;

    const byEventId = (events: readonly typeof forward[number][]): Record<string, unknown> => {
      const table: Record<string, unknown> = {};
      for (const emitted of events) {
        table[String(emitted.attributes["acp.event.id"])] = emitted.spanContext;
      }
      return table;
    };

    // The table must be a real one first. Keyed on an attribute that did not
    // exist, and valued on a field that did not either, the comparison below
    // would be `{} === {}` -- a test that cannot fail is not evidence.
    const table = byEventId(forward);
    expect(Object.keys(table).sort()).toEqual([EVENT_1, EVENT_2, EVENT_3].sort());
    expect(Object.values(table).every((context) => context !== null && context !== undefined)).toBe(true);

    // On a plan-only fixture the cause IS the previous element, so a wholly
    // wrong `parentSpanId = previousElement` implementation would satisfy a
    // forward-order assertion. Reversed, the previous element is the
    // SUCCESSOR, and the two agree only if the fold reads `causationId`.
    expect(byEventId(reversed)).toEqual(table);
  });

  it("U15: an event that causes itself is not its own parent", () => {
    const batch = emitTelemetry([
      causal({
        eventId: EVENT_1,
        correlationId: CORRELATION_A,
        causationId: EVENT_1,
        transitionId: "one.01",
      }),
    ]);

    // Unreachable from every production writer -- `core/events` threads the
    // previous plan step, `switch-landing` the started event, `switch-executor`
    // a foreign decision, and the rest write null -- but representable in the
    // contract, and a self-parent is an invalid edge rather than a weak one.
    // Closed inside the resolution rather than as a fifth clause.
    expect(batch.events[0]?.spanContext?.parentSpanId).toBe(null);
    expect(batch.unresolvedCausationCount).toBe(1);
  });

  it("the neutralization probe: with no causation, nothing is parented", () => {
    // The suite's own falsifier. If a parent survives the removal of every
    // causation, the implementation is deriving parentage from something else
    // -- order, position, correlation -- and every assertion above is
    // measuring the wrong thing.
    const parented = emitTelemetry(chain()).events.filter(
      (emitted) => emitted.spanContext?.parentSpanId != null,
    );
    expect(parented.length).toBe(2);

    const neutralized = chain().map((event) => ({ ...event, causationId: null }));
    for (const emitted of emitTelemetry(neutralized).events) {
      expect(emitted.spanContext?.parentSpanId).toBe(null);
    }
    expect(emitTelemetry(neutralized).unresolvedCausationCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The redaction gate
// ---------------------------------------------------------------------------

describe("the redaction gate refuses and counts, inside the emitter", () => {
  it("refuses a credential-shaped payload and emits nothing for it", () => {
    const batch = emitTelemetry([
      event({ type: "RUN_STARTED", transitionId: "run.01" }),
      event({
        type: "AUTH_REQUIRED_RAISED",
        transitionId: "auth.01",
        payload: { apiKey: "sk-p87-do-not-emit-0123456789" },
      }),
    ]);

    expect(batch.events.length).toBe(1);
    expect(batch.refusedCount).toBe(1);
    const [refusal] = batch.refused;
    if (refusal === undefined) throw new Error("expected a refusal");
    expect(refusal.reason).toBe("CREDENTIAL_SHAPED");
    expect({ taskId: refusal.taskId, attempt: refusal.attempt, transitionId: refusal.transitionId }).toEqual({
      taskId: TASK,
      attempt: 1,
      transitionId: "auth.01",
    });
  });

  it("carries coordinates and counts only — never the matched content", () => {
    const secret = "sk-p87-do-not-emit-0123456789";
    const batch = emitTelemetry([
      event({ type: "AUTH_REQUIRED_RAISED", transitionId: "auth.01", payload: { apiKey: secret } }),
    ]);

    // C1, asserted on the serialized diagnostics rather than field by field: a
    // redaction report that quoted what it caught would be the leak it exists
    // to prevent, and it would travel to exactly the vendor the gate keeps
    // clean.
    const serialized = JSON.stringify(batch.refused);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sk-");
    // The coordinate survives: a path names *where*, never *what*.
    const [refusal] = batch.refused;
    if (refusal === undefined) throw new Error("expected a refusal");
    expect(refusal.paths).toEqual(["apiKey"]);
  });

  it("refuses a transcript-shaped payload under its own classification", () => {
    const batch = emitTelemetry([
      event({
        type: "RUN_STARTED",
        transitionId: "run.01",
        payload: { messages: "a provider transcript smuggled as continuity" },
      }),
    ]);
    expect(batch.refusedCount).toBe(1);
    expect(batch.refused[0]?.reason).toBe("TRANSCRIPT_SHAPED");
    expect(batch.events).toEqual([]);
  });

  it("keeps its refusal vocabulary closed and sorted", () => {
    expect([...TELEMETRY_REFUSAL_REASONS]).toEqual([...TELEMETRY_REFUSAL_REASONS].sort());
    expect(new Set(TELEMETRY_REFUSAL_REASONS).size).toBe(TELEMETRY_REFUSAL_REASONS.length);
  });

  it("does not throw on a dirty record: it is a read model, not an authority", () => {
    // Refusing by throwing would make one bad payload destroy a whole page of
    // otherwise-clean telemetry, and would hand a read model a veto it has no
    // standing to hold.
    const batch = emitTelemetry([
      event({ type: "RUN_STARTED", transitionId: "run.01", payload: { token: "sk-aaaa-bbbb-cccc" } }),
      event({ taskId: OTHER_TASK, type: "CHECKPOINT_WRITTEN", transitionId: "checkpoint.01" }),
    ]);
    expect({ emitted: batch.events.length, refused: batch.refusedCount }).toEqual({
      emitted: 1,
      refused: 1,
    });
    expect(batch.events[0]?.attributes[TELEMETRY_ATTRIBUTE_KEYS.taskId]).toBe(OTHER_TASK);
  });
});

// ---------------------------------------------------------------------------
// The optional vendor boundary
// ---------------------------------------------------------------------------

describe("the Langfuse translator is a value, and can only see gated events", () => {
  it("translates a batch into a trace, one observation per event", () => {
    const batch = emitTelemetry([
      event({ type: "RUN_STARTED", transitionId: "run.01" }),
      event({ type: "TASK_FAILED", transitionId: "fail.01" }),
    ]);
    const trace = toLangfuseTrace(batch);

    expect(trace.name).toBe(LANGFUSE_TRACE_NAME);
    expect(trace.sessionId).toBe(TASK);
    expect(trace.observations.map((observation) => observation.name)).toEqual([
      "acp.run_started",
      "acp.task_failed",
    ]);
    // Langfuse's levels are not OTel's status codes; only ERROR maps.
    expect(trace.observations.map((observation) => observation.level)).toEqual(["DEFAULT", "ERROR"]);
    // Compared as values rather than with a `===` the type system already
    // knows the answer to: every ACP lifecycle event is a Langfuse span.
    expect(trace.observations.map((observation) => observation.type)).toEqual(["SPAN", "SPAN"]);
  });

  it("tells the vendor that something was withheld, without telling it what", () => {
    const secret = "sk-p87-do-not-emit-0123456789";
    const batch = emitTelemetry([
      event({ type: "RUN_STARTED", transitionId: "run.01" }),
      event({ type: "AUTH_REQUIRED_RAISED", transitionId: "auth.01", payload: { apiKey: secret } }),
    ]);
    const trace = toLangfuseTrace(batch);

    expect(trace.metadata).toEqual({
      "acp.telemetry.event_count": 1,
      "acp.telemetry.refused_count": 1,
    });
    // The diagnostics do not travel to the vendor at all — not the paths, not
    // the reason, and certainly not the content.
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("CREDENTIAL_SHAPED");
  });

  it("the planted-dirty drill: a credential-shaped record cannot reach a trace", () => {
    // C2, end to end. The dirty record is planted in the middle of a clean
    // page, and the only route from a `ControlPlaneEvent` to a trace runs
    // through the gate — `TelemetryEvent` is branded and `emitTelemetry` is
    // its sole producer, so there is no second path a caller could take.
    const secret = "sk-p87-planted-dirty-9876543210";
    const events = [
      event({ type: "RUN_STARTED", transitionId: "run.01" }),
      event({
        type: "ATOMIC_STEP_COMPLETED",
        transitionId: "step.01",
        payload: { authorization: "Bearer " + secret },
      }),
      event({ type: "CHECKPOINT_WRITTEN", transitionId: "checkpoint.01" }),
    ];

    const trace = toLangfuseTrace(emitTelemetry(events));

    expect(trace.observations.length).toBe(2);
    expect(trace.observations.map((observation) => observation.name)).toEqual([
      "acp.run_started",
      "acp.checkpoint_written",
    ]);
    expect(JSON.stringify(trace)).not.toContain(secret);
    expect(JSON.stringify(trace)).not.toContain("Bearer");
    expect(trace.metadata["acp.telemetry.refused_count"]).toBe(1);
  });

  it("an empty batch translates to an empty trace with no session", () => {
    const trace = toLangfuseTrace(emitTelemetry([]));
    expect({ session: trace.sessionId, observations: trace.observations.length }).toEqual({
      session: null,
      observations: 0,
    });
  });
});

describe("removal is by construction, not by configuration", () => {
  it("imports no vendor SDK anywhere in the package", () => {
    // The removal bullet's observability leg: disabling the exporter is not a
    // flag that could be set wrong, it is the absence of a dependency. The
    // architecture fence asserts the package's import allowlist; this test
    // states the consequence the law actually cares about — that the neutral
    // surface is complete on its own.
    const batch = emitTelemetry([event({ type: "RUN_STARTED", transitionId: "run.01" })]);
    expect(batch.events.length).toBe(1);
    // The neutral event is fully formed without the translator ever running:
    // nothing in `emitTelemetry`'s output depends on Langfuse existing.
    expect(batch.events[0]?.attributes[TELEMETRY_ATTRIBUTE_KEYS.spanKind]).toBe(TELEMETRY_SPAN_KIND);
  });
});

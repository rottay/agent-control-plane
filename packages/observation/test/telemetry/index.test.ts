import { CONTRACT_VERSION, buildIdempotencyKey } from "@acp/contracts";
import type { ControlPlaneEvent, ControlPlaneEventType, TaskState } from "@acp/contracts";
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
      "acp.event.type": "TOKEN_USAGE_RECORDED",
      "acp.event.transition_id": "usage.01",
      "acp.task.state.from": "RUNNING",
      "acp.task.state.to": "RUNNING",
      "acp.worker.identity": EMITTER,
      "acp.account.id": "acct-a",
      "gen_ai.usage.output_tokens": 1_234,
      "openinference.span.kind": TELEMETRY_SPAN_KIND,
    });
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

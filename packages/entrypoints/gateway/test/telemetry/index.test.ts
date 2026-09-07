import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLedger } from "@acp/ledger";
import type { LedgerEventRecord } from "@acp/ledger";
import { TELEMETRY_SPAN_KIND, computeBaseline, computeTokenRollups, emitTelemetry } from "@acp/observation";
import type { BuildEventInput, SwitchExecutionInput } from "@acp/runtime";
import {
  LIFECYCLE_PLAN,
  acquireLease,
  buildEvent,
  checkWriteSetConformance,
  deriveEventCoordinate,
  deterministicUuid,
  executeSwitchPlan,
  recordProviderPressure,
  recordTokenObservation,
  revokeLease,
} from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The emitter-to-projection agreement, driven causally.
 *
 * `emitTelemetry` has zero production callers and, under this packet, keeps
 * none: the sink is owed to R11 and to the owner's dependency answer. So the
 * honesty of the projection cannot come from "it has a caller". It comes from
 * causality instead, and that is what this file is: the REAL production
 * emitters are driven, their events are appended to a REAL disposable ledger,
 * the events are read back OUT of that ledger, and only then are they
 * projected. Nothing here asserts against a builder's return value, because a
 * builder's return value is not what a consumer would ever see.
 *
 * **It runs against `dist/`, deliberately.** The gateway vitest project aliases
 * three kernel and persistence packages to source and no more, so
 * `@acp/observation` and `@acp/runtime` resolve through their manifests to the
 * built output. A run of this file without a preceding `tsc --build` proves
 * nothing in either direction — the red half would be recorded against a stale
 * build and the green half could pass on a stale build of an unfinished fix.
 *
 * **Why the gateway hosts it.** The gateway is the only package whose manifest
 * already names both `@acp/observation` and `@acp/runtime`, so the agreement
 * between those two can be driven end to end with zero manifest, lockfile or
 * dependency-graph change. It tests an agreement between two packages the
 * gateway already depends on, not a gateway module, which is why it is
 * registered in `TEST_ONLY_DOMAINS.gateway` beside `parity` rather than
 * mirroring a source directory that does not exist.
 *
 * **The arbiter is not reachable from here and is not imported.** The lease and
 * conformance planes live behind `@acp/daemon`, which is not in the gateway's
 * manifest. Their events are constructed from `@acp/runtime`'s own
 * `acquireLease`, `revokeLease` and `checkWriteSetConformance` and appended by
 * this file on the task's own thread, mirroring the arbiter's passthrough
 * (`daemon/src/arbiter/index.ts:284-302`) by reading it: same-state, because a
 * lease is not a lifecycle transition; coordinates from
 * `deriveEventCoordinate`; the invocation's id as the correlation; no
 * causation; the payload passed through untouched.
 */

/**
 * The two contract types, reached through packages this one does depend on.
 *
 * This package may not name the contracts package — not in live code, not in
 * its manifest, not in its tsconfig, and the fence enforces all three over
 * `src` and `test` alike. So the event type is taken from the shape the ledger
 * hands back, and the route type from the input the event builder demands.
 * Derived rather than restated: a field added upstream arrives here on its own,
 * and no second declaration can drift from the first.
 */
type ControlPlaneEvent = LedgerEventRecord["event"];
type ResolvedRoute = BuildEventInput["route"];

// ---------------------------------------------------------------------------
// A disposable ledger, and the fixtures the walk runs on
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-telemetry-drill-"));
  temporaryDirectories.push(directory);
  return join(directory, "control-plane.sqlite");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/** One admitted route. It satisfies the contract's own CLI refinement. */
const ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-drill-a",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "2026-08-30.1",
  resolvedAt: "2026-09-06T09:00:00.000Z",
};

const TASK_ID = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f01";
const INITIATIVE_ID = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f02";
const EMITTED_BY = "claude/opus/implementer/01";

const INVOCATION = {
  taskId: TASK_ID,
  attempt: 1,
  invocationId: deterministicUuid("inv/telemetry-drill"),
  submittedAt: "2026-09-06T09:00:00.000Z",
  submissionDigest: "c".repeat(64),
};

/** The absolute worktree path every lease fixture plants. */
const WORKTREE = "/private/tmp/acp-telemetry-drill/worktree-a";
const LEASE_HOLDER = "claude/opus/implementer/01";
const LEASE_ID = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f03";

/**
 * The path the conformance gate finds outside the declared set.
 *
 * Repo-relative, because the contract admits nothing else there — the absolute
 * path this control is really about rides `worktreePath` on the lease events,
 * where `AbsolutePath` is exactly what the schema asks for.
 */
const VIOLATING_PATH = "packages/entrypoints/daemon/src/index.ts";

const LEASE = {
  leaseId: LEASE_ID,
  worktreePath: WORKTREE,
  holder: LEASE_HOLDER,
  acquiredAt: "2026-09-06T09:00:00.000Z",
  expiresAt: "2026-09-06T10:00:00.000Z",
};

type Ledger = ReturnType<typeof openLedger>;

/** Walk the real plan, step by step, through the real event builder. */
function walk(ledger: Ledger, upToIndex: number): void {
  for (const step of LIFECYCLE_PLAN) {
    if (step.index > upToIndex) break;
    ledger.append(
      buildEvent({
        invocation: INVOCATION,
        step,
        emittedBy: EMITTED_BY,
        initiativeId: INITIATIVE_ID,
        plan: LIFECYCLE_PLAN,
        route: ROUTE,
      }),
    );
  }
}

/**
 * The arbiter's passthrough, mirrored by reading it rather than importing it.
 *
 * A lease event rides the task's thread and leaves the state exactly where it
 * found it, which is what makes it a passthrough rather than a transition.
 */
function appendEnforcementEvent(
  ledger: Ledger,
  transitionId: string,
  type: ControlPlaneEvent["type"],
  payload: Readonly<Record<string, string>>,
): void {
  const coordinate = deriveEventCoordinate(INVOCATION, transitionId, 0);
  const current = ledger.getTask(INVOCATION.taskId);
  if (current === null) throw new Error("the task must exist before a lease event rides its thread");
  ledger.append({
    contractVersion: contractVersionOf(ledger),
    eventId: coordinate.eventId,
    taskId: INVOCATION.taskId,
    attempt: INVOCATION.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type,
    fromState: current.currentState,
    toState: current.currentState,
    emittedBy: LEASE_HOLDER,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: INVOCATION.invocationId,
    causationId: null,
    payload,
  });
}

/**
 * The contract version the walk itself wrote, read back off its own first event.
 *
 * A restated literal here would be a second declaration of a fact the ledger
 * already holds, and the two could disagree after a version bump.
 */
function contractVersionOf(ledger: Ledger): string {
  const [first] = ledger.listEvents({ taskId: TASK_ID, limit: 1 }).events;
  if (first === undefined) throw new Error("the walk must have appended before a lease event rides it");
  return first.event.contractVersion;
}

/** Every event of the task, read back out of the ledger in ledger order. */
function readBack(path: string): readonly ControlPlaneEvent[] {
  const ledger = openLedger(path, { readOnly: true });
  try {
    return ledger.listEvents({ taskId: TASK_ID, limit: 1_000 }).events.map((record) => record.event);
  } finally {
    ledger.close();
  }
}

function only(events: readonly ControlPlaneEvent[], type: string): ControlPlaneEvent {
  const found = events.find((event) => event.type === type);
  if (found === undefined) throw new Error("no " + type + " in the chain the ledger returned");
  return found;
}

// ---------------------------------------------------------------------------
// C1, C2 — the route the walk writes reaches telemetry
// ---------------------------------------------------------------------------

describe("the route the walk writes reaches the projection", () => {
  it("C1: carries every identifying route field, with the route's own values", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);
    ledger.close();

    const events = readBack(path);
    const batch = emitTelemetry([only(events, "RUN_STARTED")]);
    expect(batch.refusedCount).toBe(0);

    const [first] = batch.events;
    if (first === undefined) throw new Error("expected one telemetry event");

    // The five D1 names, each read from the nested route the INTENT beat is
    // the sole writer of. Before this packet all five were absent from every
    // production chain: the projection read nine FLAT keys and the walk has
    // never written any of them flat.
    expect({
      model: first.attributes["gen_ai.request.model"],
      provider: first.attributes["acp.route.provider"],
      transport: first.attributes["acp.route.transport_kind"],
      policy: first.attributes["acp.route.capability_policy_version"],
      account: first.attributes["acp.account.id"],
    }).toEqual({
      model: ROUTE.model,
      provider: ROUTE.provider,
      transport: ROUTE.transportKind,
      policy: ROUTE.capabilityPolicyVersion,
      account: ROUTE.accountId,
    });

    // `resolvedAt` is not promoted: an instant the route was chosen at is not
    // an identifying field, and a projection that promoted every member would
    // be a payload mirror with extra steps.
    expect(JSON.stringify(first.attributes)).not.toContain(ROUTE.resolvedAt);
  });

  it("C2: the flat read is genuinely dead, asserted on the whole surface", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);
    ledger.close();

    const runStarted = only(readBack(path), "RUN_STARTED");
    const [first] = emitTelemetry([runStarted]).events;
    if (first === undefined) throw new Error("expected one telemetry event");

    // By equality rather than by sampling, so the defect is behavioural rather
    // than a reading of the source: the payload the walk wrote carries the
    // route nested, and nothing flat that the old allowlist named.
    expect(first.attributes).toEqual({
      "acp.task.id": TASK_ID,
      "acp.task.attempt": 1,
      // The event's own id, and the id of the plan step that caused it. The
      // span context carries only the first eight bytes of each, so the
      // ledger rows they name stay recoverable from the attributes.
      "acp.event.id": runStarted.eventId,
      "acp.event.causation_id": runStarted.causationId,
      "acp.event.type": "RUN_STARTED",
      "acp.event.transition_id": "run.started",
      "acp.task.state.from": "RESERVED",
      "acp.task.state.to": "RUNNING",
      "acp.worker.identity": EMITTED_BY,
      "acp.account.id": ROUTE.accountId,
      "acp.route.provider": ROUTE.provider,
      "acp.route.transport_kind": ROUTE.transportKind,
      "acp.route.capability_policy_version": ROUTE.capabilityPolicyVersion,
      "gen_ai.request.model": ROUTE.model,
      "openinference.span.kind": TELEMETRY_SPAN_KIND,
    });
    expect(Object.hasOwn(runStarted.payload, "model")).toBe(false);
    expect(Object.hasOwn(runStarted.payload, "provider")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C3, C4 — one spend quantity, two folds; and a reservation is not usage
// ---------------------------------------------------------------------------

describe("the token count agrees with the recorder that wrote it", () => {
  it("C3: the attribute and the rollup report the same number", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);
    recordTokenObservation(ledger, {
      invocation: INVOCATION,
      kind: "USAGE",
      accountId: ROUTE.accountId,
      tokens: 4_321,
      transitionId: "usage.drill.01",
      emittedBy: EMITTED_BY,
    });
    ledger.close();

    const events = readBack(path);
    const usage = only(events, "TOKEN_USAGE_RECORDED");
    const [first] = emitTelemetry([usage]).events;
    if (first === undefined) throw new Error("expected one telemetry event");

    const rollups = computeTokenRollups({ events, initiativeByTask: new Map() });
    const rollup = rollups.byTask.find((row) => row.taskId === TASK_ID);
    if (rollup === undefined) throw new Error("expected a rollup for the task");

    // One quantity, two folds. A projection that read a key nobody writes
    // would disagree with the fold that reads the key the recorder does write.
    expect({
      attribute: first.attributes["acp.usage.tokens"],
      rollup: rollup.tokensUsed,
    }).toEqual({ attribute: 4_321, rollup: 4_321 });
  });

  it("C4: a reservation is not reported under the usage key", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);
    recordTokenObservation(ledger, {
      invocation: INVOCATION,
      kind: "RESERVATION",
      accountId: ROUTE.accountId,
      tokens: 9_999,
      transitionId: "reservation.drill.01",
      emittedBy: EMITTED_BY,
    });
    ledger.close();

    const reservation = only(readBack(path), "TOKEN_RESERVATION_RECORDED");
    const [first] = emitTelemetry([reservation]).events;
    if (first === undefined) throw new Error("expected one telemetry event");

    // Held tokens are not spent tokens. The usage key names spend, so a
    // reservation carrying `tokens` projects no usage attribute at all rather
    // than a number a reader would add to a bill.
    expect(Object.hasOwn(first.attributes, "acp.usage.tokens")).toBe(false);
    expect(JSON.stringify(first.attributes)).not.toContain("9999");
  });
});

// ---------------------------------------------------------------------------
// C5, C6, C7 — the negative controls
// ---------------------------------------------------------------------------

describe("the allowlist is not a payload mirror", () => {
  it("C5: no worktree path, and no violating path, ever leaves", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);

    // Real enforcement decisions, from the runtime's own exports. Each carries
    // a real absolute worktree path in its payload, and the guards admit all
    // of them: a filesystem path is neither credential- nor transcript-shaped,
    // so the allowlist is the only thing keeping it out of telemetry.
    const granted = acquireLease({ leases: [], now: "2026-09-06T09:00:00.000Z", candidate: LEASE });
    if (!granted.ok) throw new Error("the lease fixture must be grantable");
    for (const event of granted.events) {
      appendEnforcementEvent(ledger, "lease.acquired.01", event.type, event.payload);
    }

    const violated = checkWriteSetConformance({
      declaredWriteSet: ["packages/domains/observation/src/telemetry/index.ts"],
      lease: LEASE,
      observation: {
        head: "a".repeat(40),
        trackedChanges: [],
        untrackedPaths: [VIOLATING_PATH],
      },
    });
    if (!violated.ok) throw new Error("the conformance fixture must return a verdict");
    let index = 0;
    for (const event of violated.events) {
      index += 1;
      appendEnforcementEvent(ledger, "conformance.0" + String(index), event.type, event.payload);
    }
    ledger.close();

    const events = readBack(path);
    const batch = emitTelemetry(events);

    // The guards admit these records, so a refusal here would be the wrong
    // signal entirely: the control is that they emit, and that the paths they
    // carry do not.
    expect(batch.refusedCount).toBe(0);
    expect(batch.events.length).toBe(events.length);
    expect(events.some((event) => event.type === "LEASE_ACQUIRED")).toBe(true);
    expect(events.some((event) => event.type === "WRITE_SET_VIOLATION_DETECTED")).toBe(true);

    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain(WORKTREE);
    expect(serialized).not.toContain("/private/tmp/acp-telemetry-drill");
    expect(serialized).not.toContain("firstPathOutsideSet");
    expect(serialized).not.toContain(VIOLATING_PATH);
    // The payloads really did carry them, so the control is over a live risk.
    expect(JSON.stringify(events)).toContain(WORKTREE);
  });

  it("C6: a field production never writes stays absent, not stringified", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 7);
    ledger.close();

    const events = readBack(path);
    const batch = emitTelemetry([only(events, "AUDIT_COMPLETED"), only(events, "TASK_CLASSIFIED")]);
    for (const emitted of batch.events) {
      expect(Object.hasOwn(emitted.attributes, "acp.audit.verdict")).toBe(false);
    }
    // Asserted over the ATTRIBUTES rather than over the whole event: a root
    // of a trace carries `parentSpanId: null` as a structural member, and
    // that null is the honest absence of a parent rather than a value spelled
    // into an attribute. The claim this test makes has always been about the
    // attribute surface.
    const serialized = JSON.stringify(batch.events.map((emitted) => emitted.attributes));
    expect(serialized).not.toContain("acp.audit.verdict");
    expect(serialized).not.toContain("unknown");
    expect(serialized).not.toContain("null");
  });

  it("C7: a malformed route projects nothing, and refuses nothing", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);
    ledger.close();

    // A route-shaped payload the contract will not admit: no transport kind,
    // no account, no policy version, and an empty model. It is built from the
    // event the ledger returned, so everything except the route is real.
    const runStarted = only(readBack(path), "RUN_STARTED");
    const malformed: ControlPlaneEvent = {
      ...runStarted,
      payload: { ...runStarted.payload, route: { provider: "claude", model: "" } },
    };

    const batch = emitTelemetry([malformed]);
    // A bad route is not a redaction failure. The event still emits, with its
    // own event-level attributes, and the refusal count stays honest.
    expect(batch.refusedCount).toBe(0);
    const [first] = batch.events;
    if (first === undefined) throw new Error("expected one telemetry event");
    for (const key of [
      "gen_ai.request.model",
      "acp.route.provider",
      "acp.route.transport_kind",
      "acp.route.capability_policy_version",
    ]) {
      expect(Object.hasOwn(first.attributes, key)).toBe(false);
    }
    expect(first.attributes["acp.task.id"]).toBe(TASK_ID);
    expect(first.attributes["acp.event.type"]).toBe("RUN_STARTED");
  });
});

// ---------------------------------------------------------------------------
// C8, C9 — isolation, of a dirty record and of a failure
// ---------------------------------------------------------------------------

describe("one bad record isolates, and a failure never becomes a veto", () => {
  it("C8: a planted credential is refused and counted; its neighbours emit", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);
    ledger.close();

    const secret = "sk-drill-do-not-emit-0123456789";
    const events = readBack(path);
    const runStarted = only(events, "RUN_STARTED");
    const dirty: ControlPlaneEvent = {
      ...runStarted,
      payload: { ...runStarted.payload, apiKey: secret },
    };
    const chain = [events[0], dirty, events[1]].filter(
      (event): event is ControlPlaneEvent => event !== undefined,
    );

    const batch = emitTelemetry(chain);
    expect({ emitted: batch.events.length, refused: batch.refusedCount }).toEqual({
      emitted: 2,
      refused: 1,
    });
    const [refusal] = batch.refused;
    if (refusal === undefined) throw new Error("expected one refusal");
    expect(refusal.reason).toBe("CREDENTIAL_SHAPED");
    expect(refusal.paths).toEqual(["apiKey"]);
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sk-");
  });

  it("C9: a clean walk's revocation is OK; the violation's is ERROR", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);

    const granted = acquireLease({ leases: [], now: "2026-09-06T09:00:00.000Z", candidate: LEASE });
    if (!granted.ok) throw new Error("the lease fixture must be grantable");
    for (const event of granted.events) {
      appendEnforcementEvent(ledger, "lease.acquired.01", event.type, event.payload);
    }

    // The end of every clean walk: `hold.release("RELEASED")`. Before this
    // packet this row alone made every successful run report a fault.
    const released = revokeLease({
      leases: [LEASE],
      now: "2026-09-06T09:30:00.000Z",
      leaseId: LEASE_ID,
      cause: "RELEASED",
    });
    if (!released.ok) throw new Error("the revocation fixture must be grantable");
    for (const event of released.events) {
      appendEnforcementEvent(ledger, "lease.released.01", event.type, event.payload);
    }

    const violated = checkWriteSetConformance({
      declaredWriteSet: ["packages/domains/observation/src/telemetry/index.ts"],
      lease: LEASE,
      observation: {
        head: "a".repeat(40),
        trackedChanges: [],
        untrackedPaths: [VIOLATING_PATH],
      },
    });
    if (!violated.ok) throw new Error("the conformance fixture must return a verdict");
    let index = 0;
    for (const event of violated.events) {
      index += 1;
      appendEnforcementEvent(ledger, "conformance.0" + String(index), event.type, event.payload);
    }
    ledger.close();

    const events = readBack(path);
    // A read model with a veto is not a read model. Every event of a mixed
    // chain projects, and the fold never throws.
    const batch = emitTelemetry(events);
    expect(batch.refusedCount).toBe(0);
    expect(batch.events.length).toBe(events.length);

    const statusOf = (predicate: (event: ControlPlaneEvent) => boolean): string => {
      const position = events.findIndex(predicate);
      if (position < 0) throw new Error("no such event in the chain");
      const emitted = batch.events[position];
      if (emitted === undefined) throw new Error("no telemetry event at that position");
      return emitted.status;
    };

    expect({
      released: statusOf(
        (event) => event.type === "LEASE_REVOKED" && event.payload["cause"] === "RELEASED",
      ),
      violation: statusOf(
        (event) =>
          event.type === "LEASE_REVOKED" && event.payload["cause"] === "WRITE_SET_VIOLATION_DETECTED",
      ),
      detected: statusOf((event) => event.type === "WRITE_SET_VIOLATION_DETECTED"),
      acquired: statusOf((event) => event.type === "LEASE_ACQUIRED"),
    }).toEqual({ released: "OK", violation: "ERROR", detected: "ERROR", acquired: "OK" });
  });
});

// ---------------------------------------------------------------------------
// C11 — determinism survives the nested read
// ---------------------------------------------------------------------------

describe("the projection stays a pure function of the chain", () => {
  it("C11: two runs over one chain are byte-identical, attribute order included", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 5);
    recordProviderPressure(ledger, {
      invocation: INVOCATION,
      accountId: ROUTE.accountId,
      provider: ROUTE.provider,
      pressure: "QUOTA_WARNING",
      transitionId: "pressure.drill.01",
      emittedBy: EMITTED_BY,
    });
    ledger.close();

    const events = readBack(path);
    // Serialized rather than deep-equalled, so attribute ORDER is compared: a
    // fold whose key order depended on payload insertion order would pass a
    // deep equality and fail this.
    expect(JSON.stringify(emitTelemetry(events))).toBe(JSON.stringify(emitTelemetry(events)));

    // The pressure recorder's provider is the adapter's own classification of
    // who spoke, not a route. It travels under its own name, and the route's
    // provider is not asserted on an event that carries no route.
    const pressure = only(events, "QUOTA_WARNING");
    const [emitted] = emitTelemetry([pressure]).events;
    if (emitted === undefined) throw new Error("expected one telemetry event");
    expect(emitted.attributes["acp.pressure.provider"]).toBe(ROUTE.provider);
    expect(Object.hasOwn(emitted.attributes, "acp.route.provider")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C12 - C21: the trace tree, driven from the real emitters (V2-B5/R10)
// ---------------------------------------------------------------------------

/**
 * The fold, restated here so an assertion computes rather than recalls.
 *
 * A pasted vector would prove the run agreed with a transcription. This agrees
 * with the rule, over ids the real emitters derived.
 */
function uuidHex(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}

/** The span context of one emitted event, by the event id it carries. */
type SpanContext = ReturnType<typeof emitTelemetry>["events"][number]["spanContext"];

function contextByEventId(events: readonly ControlPlaneEvent[]): Map<string, SpanContext> {
  const table = new Map<string, SpanContext>();
  const batch = emitTelemetry(events);
  for (const emitted of batch.events) {
    table.set(String(emitted.attributes["acp.event.id"]), emitted.spanContext);
  }
  return table;
}

/** A second task in the same ledger, so a cross-task cause is a REAL row. */
const FOREIGN_TASK_ID = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f04";

const FOREIGN_INVOCATION = {
  taskId: FOREIGN_TASK_ID,
  attempt: 1,
  invocationId: deterministicUuid("inv/telemetry-drill-foreign"),
  submittedAt: "2026-09-06T08:00:00.000Z",
  submissionDigest: "d".repeat(64),
};

/** Attempt two of the same task. A different invocation, so a different trace. */
const SECOND_ATTEMPT = {
  taskId: TASK_ID,
  attempt: 2,
  invocationId: deterministicUuid("inv/telemetry-drill-attempt-2"),
  submittedAt: "2026-09-06T11:00:00.000Z",
  submissionDigest: "e".repeat(64),
};

/** Walk a plan prefix for any invocation, through the real event builder. */
function walkFor(ledger: Ledger, invocation: typeof INVOCATION, upToIndex: number): void {
  for (const step of LIFECYCLE_PLAN) {
    if (step.index > upToIndex) break;
    ledger.append(
      buildEvent({
        invocation,
        step,
        emittedBy: EMITTED_BY,
        initiativeId: INITIATIVE_ID,
        plan: LIFECYCLE_PLAN,
        route: ROUTE,
      }),
    );
  }
}

/** Every event of one task, off the handle that is already open. */
function eventsOf(ledger: Ledger, taskId: string): readonly ControlPlaneEvent[] {
  return ledger.listEvents({ taskId, limit: 1_000 }).events.map((record) => record.event);
}

/** Every event of one task, read back out of a CLOSED ledger in ledger order. */
function readBackTask(path: string, taskId: string): readonly ControlPlaneEvent[] {
  const ledger = openLedger(path, { readOnly: true });
  try {
    return ledger.listEvents({ taskId, limit: 1_000 }).events.map((record) => record.event);
  } finally {
    ledger.close();
  }
}

/**
 * A switch plan the executor admits: three decisions, no claimed step.
 *
 * The type is derived from the executor's own input rather than restated, for
 * the reason the two contract types above are: this package may not name the
 * contracts package, and a second declaration could drift from the first.
 */
const SWITCH_PLAN: SwitchExecutionInput["plan"] = {
  kind: "DRAIN",
  accountStatus: "DRAINING",
  taskState: null,
  steps: [],
  selectedAccountId: null,
  events: [
    { type: "QUOTA_WARNING", payload: { accountId: ROUTE.accountId, provider: ROUTE.provider } },
    { type: "AUTH_REQUIRED_RAISED", payload: { accountId: ROUTE.accountId } },
    { type: "ACCOUNT_SWITCH_STARTED", payload: { toAccountId: "acct-drill-b" } },
  ],
};

describe("the tree the ledger resolves, driven causally", () => {
  it("C12: one walk is one trace, and each step parents the one before it", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 10);
    ledger.close();

    const events = readBack(path);
    const batch = emitTelemetry(events);
    expect(batch.refusedCount).toBe(0);
    expect(batch.events.length).toBe(events.length);

    // One trace for the whole attempt, and it IS the invocation the walk ran
    // under -- not a value this projection minted for itself.
    const traces = new Set(batch.events.map((emitted) => emitted.spanContext?.traceId));
    expect([...traces]).toEqual([uuidHex(INVOCATION.invocationId)]);

    // Step i's parent is step i-1's span, over the whole plan. The walk
    // derives its causation from the plan's previous step, so this is the
    // agreement between what the builder wrote and what the projection reads.
    for (const [index, emitted] of batch.events.entries()) {
      const previous = batch.events[index - 1];
      expect(emitted.spanContext?.parentSpanId).toBe(
        index === 0 ? null : (previous?.spanContext?.spanId ?? null),
      );
    }
    expect(batch.unresolvedCausationCount).toBe(0);
  });

  it("C13: an interleaved lease event does not become anybody's parent", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);

    // A real lease decision, appended BETWEEN two causally adjacent plan
    // steps. Ledger order is now not plan order, so "the previous element"
    // and "the cause" part company for the first time.
    const granted = acquireLease({ leases: [], now: "2026-09-06T09:00:00.000Z", candidate: LEASE });
    if (!granted.ok) throw new Error("the lease fixture must be grantable");
    for (const event of granted.events) {
      appendEnforcementEvent(ledger, "lease.acquired.01", event.type, event.payload);
    }
    walkFor(ledger, INVOCATION, 6);
    ledger.close();

    const events = readBack(path);
    const contexts = contextByEventId(events);
    const spanOf = (transitionId: string): string => {
      const found = events.find((event) => event.transitionId === transitionId);
      if (found === undefined) throw new Error("no " + transitionId + " in the chain");
      const context = contexts.get(found.eventId);
      if (context === null || context === undefined) throw new Error("no span context for " + transitionId);
      return context.spanId;
    };

    // The lease event really did land between them.
    const order = events.map((event) => event.transitionId);
    expect(order.indexOf("lease.acquired.01")).toBeGreaterThan(order.indexOf("run.started"));
    expect(order.indexOf("lease.acquired.01")).toBeLessThan(order.indexOf("verified"));

    // And the plan step after it still parents to the plan step before it.
    const verified = events.find((event) => event.transitionId === "verified");
    if (verified === undefined) throw new Error("no verified step in the chain");
    expect(contexts.get(verified.eventId)?.parentSpanId).toBe(spanOf("run.outcome"));

    // The lease event carries no causation at all, so it is a root of the
    // trace it rides -- not a link in the plan's chain.
    const lease = events.find((event) => event.transitionId === "lease.acquired.01");
    if (lease === undefined) throw new Error("no lease event in the chain");
    expect(lease.causationId).toBe(null);
    expect(contexts.get(lease.eventId)?.parentSpanId).toBe(null);
  });

  it("C14: reversing a real chain changes no span context", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 10);
    ledger.close();

    const events = readBack(path);
    const forward = contextByEventId(events);
    // The table must be a real one first. Keyed on an attribute that did not
    // exist and valued on a field that did not either, the comparison below
    // would be `{} === {}`, and a test that cannot fail is not evidence.
    expect(forward.size).toBe(events.length);
    expect([...forward.keys()].sort()).toEqual(events.map((event) => event.eventId).sort());
    expect([...forward.values()].every((context) => context !== null)).toBe(true);

    // Ledger order is plan order, so a `parentSpanId = previousElement` fold
    // passes C12. Reversed, the previous element is the successor.
    expect(Object.fromEntries(contextByEventId([...events].reverse()))).toEqual(
      Object.fromEntries(forward),
    );
  });

  it("C15: the roots of a real chain are exactly the events nothing caused", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 10);

    const granted = acquireLease({ leases: [], now: "2026-09-06T09:00:00.000Z", candidate: LEASE });
    if (!granted.ok) throw new Error("the lease fixture must be grantable");
    for (const event of granted.events) {
      appendEnforcementEvent(ledger, "lease.acquired.01", event.type, event.payload);
    }
    const released = revokeLease({
      leases: [LEASE],
      now: "2026-09-06T09:30:00.000Z",
      leaseId: LEASE_ID,
      cause: "RELEASED",
    });
    if (!released.ok) throw new Error("the revocation fixture must be grantable");
    for (const event of released.events) {
      appendEnforcementEvent(ledger, "lease.released.01", event.type, event.payload);
    }
    const violated = checkWriteSetConformance({
      declaredWriteSet: ["packages/domains/observation/src/telemetry/index.ts"],
      lease: LEASE,
      observation: { head: "a".repeat(40), trackedChanges: [], untrackedPaths: [VIOLATING_PATH] },
    });
    if (!violated.ok) throw new Error("the conformance fixture must return a verdict");
    let index = 0;
    for (const event of violated.events) {
      index += 1;
      appendEnforcementEvent(ledger, "conformance.0" + String(index), event.type, event.payload);
    }
    recordProviderPressure(ledger, {
      invocation: INVOCATION,
      accountId: ROUTE.accountId,
      provider: ROUTE.provider,
      pressure: "QUOTA_WARNING",
      transitionId: "pressure.drill.01",
      emittedBy: EMITTED_BY,
    });
    ledger.close();

    const events = readBack(path);
    const batch = emitTelemetry(events);

    // A trace is a forest and this one has several roots. The count is
    // asserted EXACTLY, so a later move to a synthetic root is a named change
    // rather than a drift nobody notices.
    const roots = batch.events.filter((emitted) => emitted.spanContext?.parentSpanId === null);
    const uncaused = events.filter((event) => event.causationId === null);
    expect(roots.length).toBe(uncaused.length);
    expect(roots.length).toBe(6);
    expect(roots.map((root) => String(root.attributes["acp.event.type"])).sort()).toEqual([
      "LEASE_ACQUIRED",
      // Two revocations: the clean release, and the one the conformance
      // verdict carries beside its violation.
      "LEASE_REVOKED",
      "LEASE_REVOKED",
      "QUOTA_WARNING",
      "TASK_DISCOVERED",
      "WRITE_SET_VIOLATION_DETECTED",
    ]);
    // Several roots, one trace. That is the correct output, not a degradation.
    expect(new Set(batch.events.map((emitted) => emitted.spanContext?.traceId)).size).toBe(1);
  });

  it("C16: one plan's events are siblings under one parent, with distinct spans", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);
    const runStarted = only(eventsOf(ledger, TASK_ID), "RUN_STARTED");

    // The cause is a REAL row of the SAME invocation, so the four clauses all
    // hold and the edge is drawn.
    executeSwitchPlan({
      ledger,
      invocation: INVOCATION,
      plan: SWITCH_PLAN,
      emittedBy: EMITTED_BY,
      lease: null,
      taskState: "RUNNING",
      causedBy: runStarted.eventId,
    });
    ledger.close();

    const events = readBack(path);
    const contexts = contextByEventId(events);
    const switched = events.filter((event) => event.transitionId.startsWith("switch."));
    expect(switched.length).toBe(3);

    const expected = uuidHex(runStarted.eventId).slice(0, 16);
    for (const event of switched) {
      expect(contexts.get(event.eventId)?.parentSpanId).toBe(expected);
    }
    // Three children of one parent, each its own span. Siblings need no rule.
    expect(new Set(switched.map((event) => contexts.get(event.eventId)?.spanId)).size).toBe(3);
    expect(emitTelemetry(events).unresolvedCausationCount).toBe(0);
  });

  it("C17: a cross-task cause is preserved as an attribute and refused as a parent", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 4);
    // A second task's own walk, in the same ledger. This is the real shape:
    // `switch-executor` threads `authorization.decidedFromEventId`, which the
    // elector recorded against whichever task reported the pressure.
    walkFor(ledger, FOREIGN_INVOCATION, 4);
    const foreign = eventsOf(ledger, FOREIGN_TASK_ID);
    const foreignCause = foreign[foreign.length - 1];
    if (foreignCause === undefined) throw new Error("the foreign task must have events");

    executeSwitchPlan({
      ledger,
      invocation: INVOCATION,
      plan: SWITCH_PLAN,
      emittedBy: EMITTED_BY,
      lease: null,
      taskState: "RUNNING",
      causedBy: foreignCause.eventId,
    });
    ledger.close();

    // Both tasks projected together, which is the strongest form of the
    // question: the cause is genuinely IN the batch, and still may not be a
    // parent, because it is in another trace.
    const events = [...readBackTask(path, TASK_ID), ...readBackTask(path, FOREIGN_TASK_ID)];
    const batch = emitTelemetry(events);
    const switched = events.filter((event) => event.transitionId.startsWith("switch."));
    expect(switched.length).toBe(3);
    expect(foreignCause.taskId).not.toBe(TASK_ID);
    expect(foreignCause.correlationId).not.toBe(INVOCATION.invocationId);

    const contexts = contextByEventId(events);
    const attributesByEventId = new Map(
      batch.events.map((emitted) => [String(emitted.attributes["acp.event.id"]), emitted.attributes]),
    );
    for (const event of switched) {
      expect(contexts.get(event.eventId)?.parentSpanId).toBe(null);
      // The relation is refused; the fact is not. The raw id travels verbatim.
      expect(attributesByEventId.get(event.eventId)?.["acp.event.causation_id"]).toBe(
        foreignCause.eventId,
      );
    }
    expect(batch.unresolvedCausationCount).toBe(switched.length);

    // The structural half: no emitted parent anywhere in this batch names a
    // span belonging to a different trace. In OTel a cross-trace parent is not
    // a weak edge, it is a corrupt one.
    const spansByTrace = new Map<string, Set<string>>();
    for (const emitted of batch.events) {
      const context = emitted.spanContext;
      if (context === null) continue;
      const seen = spansByTrace.get(context.traceId) ?? new Set<string>();
      seen.add(context.spanId);
      spansByTrace.set(context.traceId, seen);
    }
    expect(spansByTrace.size).toBe(2);
    for (const emitted of batch.events) {
      const context = emitted.spanContext;
      if (context === null) continue;
      if (context.parentSpanId === null) continue;
      expect(spansByTrace.get(context.traceId)?.has(context.parentSpanId)).toBe(true);
    }
  });

  it("C18: two attempts of one task are two disjoint traces", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 10);

    // Attempt 2 cannot re-walk the plan: the ledger holds the task at
    // CHECKPOINTED and refuses an event declaring `fromState: null`. So the
    // second attempt is built from the recorders that DO ride a finished
    // task's thread, which is how a second attempt reaches a ledger anyway.
    recordProviderPressure(ledger, {
      invocation: SECOND_ATTEMPT,
      accountId: ROUTE.accountId,
      provider: ROUTE.provider,
      pressure: "QUOTA_WARNING",
      transitionId: "pressure.attempt2.01",
      emittedBy: EMITTED_BY,
    });
    const pressure = eventsOf(ledger, TASK_ID).find(
      (event) => event.transitionId === "pressure.attempt2.01",
    );
    if (pressure === undefined) throw new Error("the attempt-2 pressure event must exist");
    // A real edge INSIDE trace two, so the containment half below is asserted
    // of both traces rather than only of the walked one.
    recordTokenObservation(ledger, {
      invocation: SECOND_ATTEMPT,
      kind: "USAGE",
      accountId: ROUTE.accountId,
      tokens: 3_333,
      transitionId: "usage.attempt2.01",
      emittedBy: EMITTED_BY,
      causedBy: pressure.eventId,
    });
    ledger.close();

    const events = readBack(path);
    const batch = emitTelemetry(events);
    const spansByAttempt = new Map<number, Set<string>>([
      [1, new Set<string>()],
      [2, new Set<string>()],
    ]);
    const parentsByTrace = new Map<string, Set<string>>();
    for (const [index, emitted] of batch.events.entries()) {
      const context = emitted.spanContext;
      if (context === null) throw new Error("every event of a real chain must carry a span context");
      const source = events[index];
      if (source === undefined) throw new Error("expected a source event");
      spansByAttempt.get(source.attempt)?.add(context.spanId);
      if (context.parentSpanId !== null) {
        const seen = parentsByTrace.get(context.traceId) ?? new Set<string>();
        seen.add(context.parentSpanId);
        parentsByTrace.set(context.traceId, seen);
      }
    }

    const first = spansByAttempt.get(1) ?? new Set<string>();
    const second = spansByAttempt.get(2) ?? new Set<string>();
    // Uniqueness is claimed per (taskId, attempt) within one ledger and no
    // further. This is that claim as a set operation rather than a sample:
    // the two attempts share the task and share not one span id.
    expect({ first: first.size, second: second.size }).toEqual({ first: 11, second: 2 });
    expect([...first].filter((spanId) => second.has(spanId))).toEqual([]);

    const traceOne = uuidHex(INVOCATION.invocationId);
    const traceTwo = uuidHex(SECOND_ATTEMPT.invocationId);
    expect(new Set(batch.events.map((emitted) => emitted.spanContext?.traceId))).toEqual(
      new Set([traceOne, traceTwo]),
    );

    // Both traces carry real edges, and no parent in either reaches into the
    // other. Without the second half the first would pass vacuously on a
    // projection that emitted no parents at all.
    expect([...parentsByTrace.keys()].sort()).toEqual([traceOne, traceTwo].sort());
    for (const [traceId, parents] of parentsByTrace) {
      const own = traceId === traceOne ? first : second;
      const foreign = traceId === traceOne ? second : first;
      for (const parent of parents) {
        expect(own.has(parent)).toBe(true);
        expect(foreign.has(parent)).toBe(false);
      }
    }
  });

  it("C19: a causation reaching back into attempt 1 is counted, not drawn", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 10);
    const firstAttempt = only(eventsOf(ledger, TASK_ID), "RUN_STARTED");

    // A real recorder, on attempt 2, naming an attempt-1 event as its cause.
    recordTokenObservation(ledger, {
      invocation: SECOND_ATTEMPT,
      kind: "USAGE",
      accountId: ROUTE.accountId,
      tokens: 2_222,
      transitionId: "usage.attempt2.01",
      emittedBy: EMITTED_BY,
      causedBy: firstAttempt.eventId,
    });
    ledger.close();

    const events = readBack(path);
    const usage = events.find((event) => event.transitionId === "usage.attempt2.01");
    if (usage === undefined) throw new Error("no attempt-2 usage event in the chain");
    expect(usage.causationId).toBe(firstAttempt.eventId);

    const batch = emitTelemetry(events);
    const contexts = contextByEventId(events);
    // The cause is in the batch and in the ledger, and it is in another trace.
    expect(contexts.get(usage.eventId)?.parentSpanId).toBe(null);
    expect(batch.unresolvedCausationCount).toBe(1);
  });

  it("C20: a refused record's span id appears nowhere in the batch", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 10);
    ledger.close();

    const secret = "sk-drill-do-not-emit-0123456789";
    const events = readBack(path);
    // The dirty record is a REAL link in the chain: the step after it names it
    // as its cause, so refusing it is exactly the case where a one-pass fold
    // would publish a parent naming a span that does not exist.
    const dirtyIndex = 4;
    const dirtySource = events[dirtyIndex];
    const childSource = events[dirtyIndex + 1];
    if (dirtySource === undefined || childSource === undefined) throw new Error("expected a walked chain");
    expect(childSource.causationId).toBe(dirtySource.eventId);

    const chain = events.map((event, index) =>
      index === dirtyIndex ? { ...event, payload: { ...event.payload, apiKey: secret } } : event,
    );
    const batch = emitTelemetry(chain);
    expect(batch.refusedCount).toBe(1);
    expect(batch.events.length).toBe(events.length - 1);

    const orphanSpan = uuidHex(dirtySource.eventId).slice(0, 16);
    for (const emitted of batch.events) {
      expect(emitted.spanContext?.parentSpanId).not.toBe(orphanSpan);
      expect(emitted.spanContext?.spanId).not.toBe(orphanSpan);
    }
    expect(batch.unresolvedCausationCount).toBe(1);

    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sk-");
    // A withheld record must leave no structural handle either. A span id
    // naming a row the gate refused is exactly such a handle.
    expect(serialized).not.toContain(orphanSpan);
  });

  it("C21: the tree is a pure function of the chain, attribute order included", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 10);
    executeSwitchPlan({
      ledger,
      invocation: INVOCATION,
      plan: SWITCH_PLAN,
      emittedBy: EMITTED_BY,
      lease: null,
      taskState: "CHECKPOINTED",
      causedBy: null,
    });
    ledger.close();

    const events = readBack(path);
    // Serialized rather than deep-equalled, so the span context's own key
    // order is compared alongside the attributes'.
    expect(JSON.stringify(emitTelemetry(events))).toBe(JSON.stringify(emitTelemetry(events)));
    expect(JSON.stringify(emitTelemetry(events))).toContain("spanContext");
  });
});

// ---------------------------------------------------------------------------
// C22, C23 — the baseline measures the walk that actually runs (R9b)
//
// The two checks above prove the *projection* reads what the walk writes. These
// two prove the same thing of the *baseline*, which is the other read model
// over the same chain and the one ADR 0048 left owing. They are here for the
// reason C1-C21 are here: `@acp/observation` declares only `@acp/contracts` and
// `@acp/ledger`, so its own suite cannot reach the walk, and the gateway is the
// only package whose manifest already names both sides of the agreement.
// ---------------------------------------------------------------------------

describe("the baseline measures the walk that actually runs", () => {
  it("C22: a real chain is measured rather than refused, and its tokens are the recorded ones", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 10);
    // Two spends and one hold, written by the recorder the daemon calls, on the
    // account the route elected -- the same door `recordUsage` goes through.
    recordTokenObservation(ledger, {
      invocation: INVOCATION,
      kind: "USAGE",
      accountId: ROUTE.accountId,
      tokens: 4_321,
      transitionId: "usage.baseline.01",
      emittedBy: EMITTED_BY,
    });
    recordTokenObservation(ledger, {
      invocation: INVOCATION,
      kind: "USAGE",
      accountId: ROUTE.accountId,
      tokens: 1_234,
      transitionId: "usage.baseline.02",
      emittedBy: EMITTED_BY,
    });
    recordTokenObservation(ledger, {
      invocation: INVOCATION,
      kind: "RESERVATION",
      accountId: ROUTE.accountId,
      tokens: 9_999,
      transitionId: "reservation.baseline.01",
      emittedBy: EMITTED_BY,
    });
    ledger.close();

    const events = readBack(path);
    // The whole point: the walk's own chain, read back out of a real ledger,
    // is measurable. Before R9b this threw `MISSING_REASON` on event index 1.
    const baseline = computeBaseline(events);

    // The expectation is derived from the rows themselves, never restated. A
    // literal here would be a second declaration of the recorder's own numbers
    // and could agree with a fold that read nothing at all.
    const usageRows = events.filter((event) => event.type === "TOKEN_USAGE_RECORDED");
    const recorded = usageRows.reduce((sum, event) => sum + Number(event.payload["tokens"]), 0);
    expect(usageRows.length).toBeGreaterThan(1);
    expect(recorded).toBeGreaterThan(0);
    expect(baseline.tokens).toEqual({ events: usageRows.length, total: recorded });

    // A hold is not a spend. The reservation carries the same `tokens` key on a
    // neighbouring type, so a fold that read the key without reading the type
    // would report it and disagree with the recorder that wrote it.
    expect(baseline.tokens.total).not.toBe(recorded + 9_999);

    // And the chain really is the walk's, not a hand-built stand-in.
    expect(events.length).toBe(LIFECYCLE_PLAN.length + 3);
    expect(only(events, "COMMIT_RECORDED").taskId).toBe(TASK_ID);
  });

  it("C23: what the walk never writes is counted as unreported, not as zero", () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    walk(ledger, 10);
    ledger.close();

    const events = readBack(path);
    const baseline = computeBaseline(events);

    // The walk emits `TASK_CLASSIFIED` and `AUDIT_COMPLETED` as PLAIN beats, so
    // neither carries the field the baseline once demanded. Absence is now
    // tolerated -- but it is *stated*. A reader sees "one classification, no
    // reason reported", never a zero that could equally mean "none happened".
    expect(baseline.routing).toEqual({ total: 0, unreported: 1, byReason: [] });
    expect(baseline.acceptance.audits).toBe(0);
    expect(baseline.acceptance.unreported).toBe(1);
    expect(baseline.acceptance.byVerdict).toEqual([]);

    // The counts are of real events, not of an empty chain: the same walk that
    // reported nothing did reach a terminal outcome, and that is measured.
    expect(baseline.acceptance.terminalOutcomes).toEqual([
      { type: "COMMIT_RECORDED", count: 1 },
      { type: "TASK_CANCELLED", count: 0 },
      { type: "TASK_FAILED", count: 0 },
    ]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openLedger } from "@acp/ledger";
import type { LedgerEventRecord } from "@acp/ledger";
import { TELEMETRY_SPAN_KIND, computeTokenRollups, emitTelemetry } from "@acp/observation";
import type { BuildEventInput } from "@acp/runtime";
import {
  LIFECYCLE_PLAN,
  acquireLease,
  buildEvent,
  checkWriteSetConformance,
  deriveEventCoordinate,
  deterministicUuid,
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
    const serialized = JSON.stringify(batch.events);
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

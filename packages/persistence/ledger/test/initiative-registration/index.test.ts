import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "@acp/contracts";

import {
  INITIATIVE_OBJECTIVE_MEDIA_TYPE,
  INITIATIVE_REGISTRATION_REFUSALS,
  INITIATIVE_REGISTRATION_WRITE_REFUSALS,
  LedgerIntegrityError,
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  decideInitiativeRegistration,
  initiativeObjectiveIdempotencyKeys,
  initiativeRegistrationEvent,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  readInitiativeObjective,
  recordedInitiativeRegistrationOf,
  registerInitiative,
  type ArtifactPlane,
  type ArtifactPlaneTestFaults,
  type InitiativeRegistrationFields,
  type InitiativeRegistrationOutcome,
  type InitiativeRegistrationTestFaults,
  type Ledger,
  type RecordedInitiativeRegistration,
} from "../../src/index.js";
import { INITIATIVE_REGISTRATION_PAYLOAD_KEYS } from "../../src/types/index.js";

/**
 * Evidence for the initiative registration (P-14 escalón B, ADR 0086).
 *
 * The decision is pure and asserted over values; the orchestration is asserted
 * over a real ledger, a real blob lease store and a real private plane, because
 * what it promises is an order across three substrates that share no
 * transaction: decide, publish, append. The negatives are the brief's:
 *
 *   • N-P14B-1 — the same registration twice is one row, one reference, a replay;
 *   • N-P14B-2 — the same id with other content is `CONFLICT`, and nothing moves;
 *   • N-P14B-3/4 — a request outside `Initiative`, or a credential in the
 *     objective, publishes nothing; the objective is never in `event_json`;
 *   • N-P14B-5 — a restart keeps the ids, and two initiatives with one objective
 *     hold two references neither can read across;
 *   • N-P14B-13 — a crash between the publication and the append is completed by
 *     a retry that starts no second publication.
 *
 * A crash is a fault hook that throws, as in the plane's own suite: the call
 * ends where it stands and the handles are closed as a dead process's would be.
 */

const I1 = "11111111-1111-4111-8111-111111111111";
const I2 = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const AT = "2026-09-13T12:00:00.000Z";
const LATER = "2026-09-13T12:30:00.000Z";
const COORDINATOR = "kimi/k3/coordinator/01";
const OPERATOR = "claude/opus/implementer/01";
const DEAD_PID = 4242;
const LIVE_PID = 5151;
const INITIATIVE_A = "44444444-4444-4444-8444-444444444444";
const INITIATIVE_B = "55555555-5555-4555-8555-555555555555";
const OBJECTIVE = "Register an initiative by command and by API, and keep its objective off the stream.";
const SENTINEL = "sk-ant-api03-SENTINELSENTINELSENTINEL";

const temporaryDirectories: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function temporaryLedgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-initiative-registration-"));
  temporaryDirectories.push(directory);
  return join(directory, "control-plane.sqlite");
}

interface Substrates {
  readonly ledgerPath: string;
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  /** A dead process's handles are closed; nothing it held is released. */
  readonly die: () => void;
}

function substrates(ledgerPath = temporaryLedgerPath(), faults: ArtifactPlaneTestFaults = {}): Substrates {
  const ledger = openLedger(ledgerPath);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledgerPath), {
    incarnationId: I1,
    createdAt: CREATED_AT,
  });
  const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath, __testFaults: faults });
  let closed = false;
  const die = (): void => {
    if (closed) return;
    closed = true;
    leaseStore.close();
    ledger.close();
  };
  closers.push(die);
  return { ledgerPath, ledger, plane, die };
}

function fields(overrides: Partial<InitiativeRegistrationFields> = {}): InitiativeRegistrationFields {
  return {
    initiativeId: INITIATIVE_A,
    slug: "acp-p14",
    title: "The P-14 bootstrap",
    objective: OBJECTIVE,
    recordedBy: COORDINATOR,
    ...overrides,
  };
}

/** Fresh identities, as a door mints them for every attempt. */
function identities(): Parameters<typeof registerInitiative>[0]["identities"] {
  return {
    eventId: randomUUID(),
    commandId: randomUUID(),
    artifactPinId: randomUUID(),
    artifactReferenceId: randomUUID(),
    intentionEventId: randomUUID(),
    terminalEventId: randomUUID(),
  };
}

function register(
  on: Substrates,
  overrides: Partial<InitiativeRegistrationFields> = {},
  options: { readonly pid?: number; readonly at?: string; readonly faults?: InitiativeRegistrationTestFaults } = {},
): InitiativeRegistrationOutcome {
  return registerInitiative({
    ledger: on.ledger,
    plane: on.plane,
    request: fields(overrides),
    recordedAt: options.at ?? AT,
    holderPid: options.pid ?? LIVE_PID,
    identities: identities(),
    ...(options.faults === undefined ? {} : { __testFaults: options.faults }),
  });
}

function granted(outcome: InitiativeRegistrationOutcome): InitiativeRegistrationOutcome & { ok: true } {
  if (!outcome.ok) throw new Error("expected a registration, got " + outcome.reason + " at " + outcome.at);
  return outcome;
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    initiativeId: INITIATIVE_A,
    slug: "acp-p14",
    title: "The P-14 bootstrap",
    objective: OBJECTIVE,
    status: "ACTIVE",
    createdAt: AT,
    ...overrides,
  };
}

function recorded(overrides: Partial<RecordedInitiativeRegistration> = {}): RecordedInitiativeRegistration {
  return {
    initiativeId: INITIATIVE_A,
    sequence: 1,
    slug: "acp-p14",
    title: "The P-14 bootstrap",
    objectiveSha256: sha256(OBJECTIVE),
    objectiveArtifactReferenceId: "objective-reference",
    ...overrides,
  };
}

function eventJsonRows(ledgerPath: string): readonly string[] {
  const raw = new Database(ledgerPath, { readonly: true });
  try {
    return (raw.prepare("SELECT event_json FROM initiative_events ORDER BY sequence").all() as { readonly event_json: string }[]).map(
      (row) => row.event_json,
    );
  } finally {
    raw.close();
  }
}

function registryRowCount(ledgerPath: string): number {
  const raw = new Database(ledgerPath, { readonly: true });
  try {
    return (raw.prepare("SELECT COUNT(*) AS count FROM registry_events").get() as { readonly count: number }).count;
  } finally {
    raw.close();
  }
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

describe("the registration decision, over values", () => {
  it("grants a first registration and digests the objective's UTF-8 bytes", () => {
    const decision = decideInitiativeRegistration({ candidate: candidate({ objective: "é" }), existing: null });
    expect(decision.ok && !decision.replay).toBe(true);
    if (!decision.ok || decision.replay) return;
    expect(decision.objectiveSha256).toBe(sha256("é"));
    expect(Buffer.from(decision.objectiveBytes).toString("utf8")).toBe("é");
    expect(decision.initiative.initiativeId).toBe(INITIATIVE_A);
  });

  it("N-P14B-3: refuses a request outside Initiative by the field that failed", () => {
    const refusals = [
      [{ slug: "ACP-P14" }, "candidate.slug"],
      [{ objective: "" }, "candidate.objective"],
      [{ objective: "o".repeat(4_001) }, "candidate.objective"],
      [{ title: "" }, "candidate.title"],
      [{ initiativeId: "not-a-uuid" }, "candidate.initiativeId"],
      [{ status: "PAUSED" }, "candidate.status"],
    ] as const;
    for (const [overrides, at] of refusals) {
      expect(decideInitiativeRegistration({ candidate: candidate(overrides), existing: null }), at).toEqual({
        ok: false,
        reason: "REQUEST_INVALID",
        at,
      });
    }
    const stray = decideInitiativeRegistration({ candidate: candidate({ objectiveSha256: "a".repeat(64) }), existing: null });
    expect(stray.ok).toBe(false);
  });

  it("N-P14B-4: refuses a credential in the objective at the objective, before anything else is looked at", () => {
    expect(
      decideInitiativeRegistration({ candidate: candidate({ objective: "deploy with " + SENTINEL }), existing: recorded() }),
    ).toEqual({ ok: false, reason: "REQUEST_INVALID", at: "candidate.objective" });
  });

  it("N-P14B-2: the same content is a replay, and each difference is a conflict at its own field", () => {
    const existing = recorded();
    expect(decideInitiativeRegistration({ candidate: candidate(), existing })).toEqual({ ok: true, replay: true, existing });
    expect(decideInitiativeRegistration({ candidate: candidate({ slug: "acp-p15" }), existing })).toEqual({
      ok: false,
      reason: "CONFLICT",
      at: "candidate.slug",
    });
    expect(decideInitiativeRegistration({ candidate: candidate({ title: "Another title" }), existing })).toEqual({
      ok: false,
      reason: "CONFLICT",
      at: "candidate.title",
    });
    expect(decideInitiativeRegistration({ candidate: candidate({ objective: OBJECTIVE + "!" }), existing })).toEqual({
      ok: false,
      reason: "CONFLICT",
      at: "candidate.objective",
    });
  });

  it("answers a registration older than the closed payload as a conflict, never as a replay", () => {
    const legacy = recorded({ slug: null, title: null, objectiveSha256: null, objectiveArtifactReferenceId: null });
    expect(decideInitiativeRegistration({ candidate: candidate(), existing: legacy })).toEqual({
      ok: false,
      reason: "CONFLICT",
      at: "candidate.slug",
    });
    expect(
      decideInitiativeRegistration({ candidate: candidate(), existing: recorded({ initiativeId: INITIATIVE_B }) }),
    ).toEqual({ ok: false, reason: "REQUEST_INVALID", at: "existing.initiativeId" });
  });

  it("keeps both vocabularies closed and sorted", () => {
    expect([...INITIATIVE_REGISTRATION_REFUSALS]).toEqual([...INITIATIVE_REGISTRATION_REFUSALS].sort());
    expect([...INITIATIVE_REGISTRATION_WRITE_REFUSALS]).toEqual(["CONFLICT", "CONTENT_REJECTED", "REQUEST_INVALID", "WRITE_CONFLICT"]);
  });

  it("builds the event with the closed payload and the fixed transition, and never the objective", () => {
    const decision = decideInitiativeRegistration({ candidate: candidate(), existing: null });
    if (!decision.ok || decision.replay) throw new Error("expected a grant");
    const event = initiativeRegistrationEvent({
      initiative: decision.initiative,
      objectiveSha256: decision.objectiveSha256,
      objectiveArtifactReferenceId: "objective-reference",
      eventId: I2,
      recordedBy: COORDINATOR,
    });
    expect(Object.keys(event["payload"] as Record<string, unknown>)).toEqual([...INITIATIVE_REGISTRATION_PAYLOAD_KEYS]);
    expect(event).toMatchObject({
      transitionId: "register",
      idempotencyKey: INITIATIVE_A + "/1/register",
      type: "INITIATIVE_REGISTERED",
      fromStatus: null,
      toStatus: "ACTIVE",
      emittedBy: COORDINATOR,
      occurredAt: AT,
      recordedAt: AT,
    });
    expect(JSON.stringify(event)).not.toContain(OBJECTIVE);
  });
});

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

describe("a registration decides, publishes the objective, then appends", () => {
  it("N-P14B-4: records the digest and the reference, and the objective only in the plane", () => {
    const on = substrates();
    const outcome = granted(register(on));
    expect(outcome).toMatchObject({
      replayed: false,
      sequence: 1,
      registration: {
        initiativeId: INITIATIVE_A,
        slug: "acp-p14",
        title: "The P-14 bootstrap",
        objectiveSha256: sha256(OBJECTIVE),
        status: "ACTIVE",
        eventCount: 1,
        createdAt: AT,
        updatedAt: AT,
      },
    });

    const rows = eventJsonRows(on.ledgerPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(sha256(OBJECTIVE));
    expect(rows[0]).not.toContain(OBJECTIVE);
    expect(rows[0]).not.toContain('"objective"');

    const record = on.ledger.listInitiativeEvents({ initiativeId: INITIATIVE_A }).events[0];
    if (record === undefined) throw new Error("expected the registration");
    const payload = recordedInitiativeRegistrationOf(record);
    const reference = on.ledger.getArtifactReference(payload?.objectiveArtifactReferenceId ?? "");
    expect(reference).toMatchObject({
      artifactClass: "PLAN_DOCUMENT",
      classification: "INTERNAL",
      scopeKind: "INITIATIVE",
      scopeId: INITIATIVE_A,
      accessPolicyId: "SCOPE_EQUALITY_V1",
      retentionClass: "PERMANENT",
      expiresAt: null,
      contentSha256: sha256(OBJECTIVE),
    });
    expect(on.ledger.getArtifactBlob(sha256(OBJECTIVE), 1)?.mediaType).toBe(INITIATIVE_OBJECTIVE_MEDIA_TYPE);
    expect(readInitiativeObjective(on.ledger, record.event)).toBe(OBJECTIVE);
  });

  it("N-P14B-1: the same registration again is a replay — one row, one publication, nothing appended", () => {
    const on = substrates();
    const first = granted(register(on));
    const artifactEvents = on.ledger.listArtifactEvents(sha256(OBJECTIVE)).length;
    const second = granted(register(on, {}, { at: LATER, pid: DEAD_PID }));
    expect(second.replayed).toBe(true);
    expect(second.sequence).toBe(first.sequence);
    expect(second.registration).toEqual(first.registration);
    expect(on.ledger.listInitiatives()).toHaveLength(1);
    expect(on.ledger.status().initiativeEventCount).toBe(1);
    expect(on.ledger.listArtifactEvents(sha256(OBJECTIVE))).toHaveLength(artifactEvents);
    // Intention and success, and nothing else, for the one publication.
    expect(on.ledger.listArtifactEvents(sha256(OBJECTIVE)).map((record) => record.event.artifactEventKind)).toEqual([
      "PUBLICATION_INTENDED",
      "PUBLICATION_SUCCEEDED",
    ]);
  });

  it("N-P14B-2: the same id with another title or objective is a conflict, and nothing is published or appended", () => {
    const on = substrates();
    granted(register(on));
    const head = on.ledger.status();
    const registryRows = registryRowCount(on.ledgerPath);
    expect(register(on, { title: "Another title" })).toEqual({ ok: false, reason: "CONFLICT", at: "candidate.title" });
    const other = OBJECTIVE + " And more.";
    expect(register(on, { objective: other })).toEqual({ ok: false, reason: "CONFLICT", at: "candidate.objective" });
    expect(on.ledger.listArtifactEvents(sha256(other))).toEqual([]);
    expect(on.ledger.status().initiativeEventCount).toBe(head.initiativeEventCount);
    expect(registryRowCount(on.ledgerPath)).toBe(registryRows);
  });

  it("N-P14B-3/4: a refused request publishes nothing, leases nothing and appends nothing", () => {
    const on = substrates();
    const planted = "deploy with " + SENTINEL;
    expect(register(on, { objective: planted })).toEqual({ ok: false, reason: "REQUEST_INVALID", at: "candidate.objective" });
    expect(register(on, { slug: "Not A Slug" })).toEqual({ ok: false, reason: "REQUEST_INVALID", at: "candidate.slug" });
    expect(register(on, { recordedBy: "not an identity" })).toEqual({ ok: false, reason: "REQUEST_INVALID", at: "recordedBy" });
    expect(on.ledger.listArtifactEvents(sha256(planted))).toEqual([]);
    expect(on.ledger.status().initiativeEventCount).toBe(0);
    expect(registryRowCount(on.ledgerPath)).toBe(0);
    expect(readdirSync(artifactPlaneRootFor(on.ledgerPath))).toEqual([]);
  });

  it("N-P14B-5: a restart keeps the ids, and two initiatives with one objective cannot read each other's", () => {
    const ledgerPath = temporaryLedgerPath();
    const before = substrates(ledgerPath);
    const a = granted(register(before));
    before.die();

    const after = substrates(ledgerPath);
    const again = granted(register(after, {}, { at: LATER }));
    expect(again.replayed).toBe(true);
    expect(again.registration.objectiveSha256).toBe(a.registration.objectiveSha256);
    expect(after.ledger.getInitiative(INITIATIVE_A)?.objectiveSha256).toBe(sha256(OBJECTIVE));

    const b = granted(register(after, { initiativeId: INITIATIVE_B, slug: "acp-p14-b" }, { at: LATER }));
    expect(b.replayed).toBe(false);
    expect(b.registration.objectiveSha256).toBe(a.registration.objectiveSha256);

    const referenceOf = (initiativeId: string): string => {
      const record = after.ledger.listInitiativeEvents({ initiativeId, type: "INITIATIVE_REGISTERED" }).events[0];
      if (record === undefined) throw new Error("expected a registration");
      return recordedInitiativeRegistrationOf(record)?.objectiveArtifactReferenceId ?? "";
    };
    const referenceA = referenceOf(INITIATIVE_A);
    const referenceB = referenceOf(INITIATIVE_B);
    expect(referenceA).not.toBe(referenceB);
    expect(after.ledger.getArtifactReference(referenceB)?.scopeId).toBe(INITIATIVE_B);
    // One blob, two references, and scope equality between them.
    expect(after.plane.read({ artifactReferenceId: referenceA, scopeKind: "INITIATIVE", scopeId: INITIATIVE_B })).toEqual({
      verb: "REFUSE",
      refusal: "REFERENCE_NOT_READABLE",
    });
    expect(after.plane.read({ artifactReferenceId: referenceB, scopeKind: "INITIATIVE", scopeId: INITIATIVE_A })).toEqual({
      verb: "REFUSE",
      refusal: "REFERENCE_NOT_READABLE",
    });
    const recordB = after.ledger.listInitiativeEvents({ initiativeId: INITIATIVE_B }).events[0];
    if (recordB === undefined) throw new Error("expected b");
    expect(readInitiativeObjective(after.ledger, recordB.event)).toBe(OBJECTIVE);
  });
});

describe("a crash between the steps is completed by a retry, never restarted", () => {
  it("N-P14B-13: published and not appended — a retry with fresh ids appends, with no second intention", () => {
    const ledgerPath = temporaryLedgerPath();
    const dying = substrates(ledgerPath);
    expect(() =>
      register(dying, {}, {
        pid: DEAD_PID,
        faults: {
          afterObjectivePublished: () => {
            throw new Error("the process died after the publication");
          },
        },
      }),
    ).toThrow("died after the publication");
    const published = dying.ledger.listArtifactEvents(sha256(OBJECTIVE));
    expect(published.map((record) => record.event.artifactEventKind)).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_SUCCEEDED"]);
    // The gap, named: a reference that names no initiative yet.
    expect(dying.ledger.getInitiative(INITIATIVE_A)).toBeNull();
    dying.die();

    const restarted = substrates(ledgerPath);
    const outcome = granted(register(restarted, {}, { at: LATER }));
    expect(outcome.replayed).toBe(false);
    const events = restarted.ledger.listArtifactEvents(sha256(OBJECTIVE));
    expect(events.map((record) => record.eventId)).toEqual(published.map((record) => record.eventId));
    const keys = initiativeObjectiveIdempotencyKeys(INITIATIVE_A, sha256(OBJECTIVE));
    expect(events.map((record) => record.idempotencyKey)).toEqual([keys.intended, keys.succeeded]);
    const record = restarted.ledger.listInitiativeEvents({ initiativeId: INITIATIVE_A }).events[0];
    if (record === undefined) throw new Error("expected the registration");
    const intended = published[0]?.event;
    const reference =
      intended?.artifactEventKind === "PUBLICATION_INTENDED" ? intended.payload.intendedReference?.artifactReferenceId : undefined;
    expect(recordedInitiativeRegistrationOf(record)?.objectiveArtifactReferenceId).toBe(reference);
  });

  it("V3 §3.b: a holding a dead process left inside the publication is not displaced — QUIESCENCE_UNPROVEN", () => {
    const ledgerPath = temporaryLedgerPath();
    const dying = substrates(ledgerPath, {
      afterIntentionRecorded: () => {
        throw new Error("the process died holding the blob");
      },
    });
    expect(() => register(dying, {}, { pid: DEAD_PID })).toThrow("died holding the blob");
    dying.die();

    const restarted = substrates(ledgerPath);
    expect(register(restarted, {}, { at: LATER, pid: LIVE_PID })).toEqual({
      ok: false,
      reason: "CONTENT_REJECTED",
      at: "QUIESCENCE_UNPROVEN",
    });
    expect(restarted.ledger.getInitiative(INITIATIVE_A)).toBeNull();
    expect(restarted.ledger.listArtifactEvents(sha256(OBJECTIVE)).map((record) => record.event.artifactEventKind)).toEqual([
      "PUBLICATION_INTENDED",
    ]);
  });

  it("V3 §3.a: a publication that ended abandoned is refused by name, and the pair is not registered", () => {
    const ledgerPath = temporaryLedgerPath();
    const dying = substrates(ledgerPath, {
      afterIntentionRecorded: () => {
        throw new Error("the process died holding the blob");
      },
    });
    expect(() => register(dying, {}, { pid: DEAD_PID })).toThrow("died holding the blob");
    dying.die();

    // A reconciler, attesting the dead process's quiescence, finds no bytes and
    // abandons the publication.
    const reconciling = substrates(ledgerPath);
    const reconciled = reconciling.plane.reconcile({
      contentSha256: sha256(OBJECTIVE),
      holding: { holder: OPERATOR, holderPid: LIVE_PID, acquiredAt: LATER, expiresAt: LATER },
      quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID },
      terminal: { eventId: randomUUID(), idempotencyKey: "reconciliation/" + randomUUID(), occurredAt: LATER, recordedAt: LATER },
      recordedBy: OPERATOR,
    });
    expect(reconciled.verb).toBe("ABANDONED");

    expect(register(reconciling, {}, { at: LATER })).toEqual({
      ok: false,
      reason: "CONTENT_REJECTED",
      at: "PUBLICATION_ALREADY_ABANDONED",
    });
    expect(reconciling.ledger.getInitiative(INITIATIVE_A)).toBeNull();
  });

  it("V3 §3.d: an append that loses the race re-reads and answers the winner — replay or conflict", () => {
    const on = substrates();
    // The winner lands between this call's publication and its append.
    const replay = granted(
      register(on, {}, {
        faults: {
          afterObjectivePublished: () => {
            granted(register(on));
          },
        },
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(on.ledger.status().initiativeEventCount).toBe(1);

    const other = substrates();
    expect(
      register(other, {}, {
        faults: {
          afterObjectivePublished: () => {
            granted(register(other, { title: "The winner's title" }));
          },
        },
      }),
    ).toEqual({ ok: false, reason: "CONFLICT", at: "candidate.title" });
    expect(other.ledger.getInitiative(INITIATIVE_A)?.title).toBe("The winner's title");
  });
});

// ---------------------------------------------------------------------------
// The objective, read back
// ---------------------------------------------------------------------------

describe("the objective is read back by reference, or the read fails closed", () => {
  it("answers null for a registration that never published one, and opens nothing for it", () => {
    const ledgerPath = temporaryLedgerPath();
    const ledger = openLedger(ledgerPath);
    closers.push(() => {
      ledger.close();
    });
    ledger.appendInitiativeEvent({
      contractVersion: CONTRACT_VERSION,
      eventId: randomUUID(),
      initiativeId: INITIATIVE_A,
      transitionId: "initiative.registered",
      idempotencyKey: INITIATIVE_A + "/1/initiative.registered",
      type: "INITIATIVE_REGISTERED",
      fromStatus: null,
      toStatus: "ACTIVE",
      emittedBy: COORDINATOR,
      occurredAt: AT,
      recordedAt: AT,
      payload: { slug: "acp-p8", title: "The P8 initiative", objective: "Land the execution boundary" },
    });
    const record = ledger.listInitiativeEvents({}).events[0];
    if (record === undefined) throw new Error("expected the registration");
    expect(readInitiativeObjective(ledger, record.event)).toBeNull();
    expect(existsSync(artifactPlaneRootFor(ledgerPath))).toBe(false);
  });

  it("reads through a read-only handle, and creates no coordination file", () => {
    const on = substrates();
    granted(register(on));
    on.die();
    unlinkSync(artifactBlobLeaseStorePath(on.ledgerPath));
    for (const suffix of ["-wal", "-shm"]) {
      const path = artifactBlobLeaseStorePath(on.ledgerPath) + suffix;
      if (existsSync(path)) unlinkSync(path);
    }
    const reader = openLedger(on.ledgerPath, { readOnly: true });
    closers.push(() => {
      reader.close();
    });
    const record = reader.listInitiativeEvents({}).events[0];
    if (record === undefined) throw new Error("expected the registration");
    expect(readInitiativeObjective(reader, record.event)).toBe(OBJECTIVE);
    expect(existsSync(artifactBlobLeaseStorePath(on.ledgerPath))).toBe(false);
  });

  it("fails closed with an integrity error when the root or the bytes are gone, and never answers null", () => {
    const on = substrates();
    granted(register(on));
    const record = on.ledger.listInitiativeEvents({}).events[0];
    if (record === undefined) throw new Error("expected the registration");
    const digest = sha256(OBJECTIVE);
    unlinkSync(join(artifactPlaneRootFor(on.ledgerPath), digest.slice(0, 2), digest));
    expect(caught(() => readInitiativeObjective(on.ledger, record.event))).toBeInstanceOf(LedgerIntegrityError);
    rmSync(artifactPlaneRootFor(on.ledgerPath), { recursive: true, force: true });
    expect(caught(() => readInitiativeObjective(on.ledger, record.event))).toBeInstanceOf(LedgerIntegrityError);
    // And the reader did not recreate the root it found absent.
    expect(existsSync(artifactPlaneRootFor(on.ledgerPath))).toBe(false);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  ROADMAP_WRITE_SET_PREIMAGE_PREFIX_V1,
  buildInitiativeIdempotencyKey,
} from "@acp/contracts";

import {
  LedgerInitiativeBatchConflictError,
  LedgerRoadmapVersionRefusedError,
  LedgerValidationError,
  artifactBlobLeaseStorePath,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  recordRoadmapRevision,
  roadmapStepDigests,
  type ArtifactPlane,
  type Ledger,
  type RoadmapRevisionOutcome,
} from "../../src/index.js";
import { readRoadmapStepManifest, roadmapStepManifestDocument } from "../../src/roadmap-steps/index.js";

/**
 * Evidence for a roadmap's steps (P-26 cut B, ADR 0111).
 *
 * The digests and the rank are asserted over values and against an independent
 * computation; the producer and the batch door over a real ledger, a real blob
 * lease store and a real private plane, because what they promise is an order
 * across substrates that share no transaction: decide, publish the manifest,
 * append the batch — and a door that re-derives every step from the manifest it
 * reads back.
 */

const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const OTHER_INITIATIVE = "55555555-5555-4555-8555-555555555555";
const AT = "2026-09-24T12:00:00.000Z";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const COORDINATOR = "kimi/k3/coordinator/01";
const PID = 5151;

const directories: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      /* already closed */
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function step(stepId: string, dependsOn: readonly string[] = [], overrides: Record<string, unknown> = {}) {
  return {
    stepId,
    title: "Step " + stepId,
    objective: "The objective of " + stepId + ", which stays private.",
    acceptance: "The acceptance of " + stepId + ", which stays private.",
    expectedWriteSet: ["packages/" + stepId + "/b.ts", "packages/" + stepId + "/a.ts"],
    dependsOn: [...dependsOn],
    ...overrides,
  };
}

/** A→B, A→C: the map's S1 manifest. */
function threeSteps() {
  return { manifestContractVersion: 1 as const, steps: [step("A"), step("B", ["A"]), step("C", ["A"])] };
}

interface Substrates {
  readonly path: string;
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
}

function substrates(): Substrates {
  const directory = mkdtempSync(join(tmpdir(), "acp-roadmap-steps-"));
  directories.push(directory);
  const path = join(directory, "control-plane.sqlite");
  const ledger = openLedger(path);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(path), {
    incarnationId: randomUUID(),
    createdAt: CREATED_AT,
  });
  const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: path });
  closers.push(() => {
    leaseStore.close();
    ledger.close();
  });
  for (const initiativeId of [INITIATIVE, OTHER_INITIATIVE]) {
    ledger.appendInitiativeEvent({
      contractVersion: CONTRACT_VERSION,
      eventId: randomUUID(),
      initiativeId,
      transitionId: "initiative.registered",
      idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId, transitionId: "initiative.registered" }),
      type: "INITIATIVE_REGISTERED",
      fromStatus: null,
      toStatus: "ACTIVE",
      emittedBy: COORDINATOR,
      occurredAt: AT,
      recordedAt: AT,
      payload: {},
    });
  }
  return { path, ledger, plane };
}

function revise(
  on: Substrates,
  request: {
    readonly content?: string;
    readonly expectedHeadDigest?: string | null;
    readonly kind?: "EDIT" | "ROLLBACK";
    readonly restoresVersionId?: string | null;
    readonly steps?: unknown;
  } = {},
  initiativeId = INITIATIVE,
): RoadmapRevisionOutcome {
  const stepCount =
    typeof request.steps === "object" && request.steps !== null && Array.isArray((request.steps as { steps?: unknown }).steps)
      ? ((request.steps as { steps: unknown[] }).steps.length)
      : 0;
  return recordRoadmapRevision({
    reader: on.ledger,
    writable: on.ledger,
    plane: on.plane,
    initiativeId,
    request: {
      content: request.content ?? "# Roadmap\n",
      expectedHeadDigest: request.expectedHeadDigest ?? null,
      kind: request.kind ?? "EDIT",
      restoresVersionId: request.restoresVersionId ?? null,
      recordedBy: COORDINATOR,
      ...(request.steps === undefined ? {} : { steps: request.steps }),
    },
    recordedAt: AT,
    roadmapVersionId: randomUUID(),
    eventId: randomUUID(),
    holderPid: PID,
    stepIdentities: {
      stepEventIds: Array.from({ length: stepCount }, () => randomUUID()),
      commandId: randomUUID(),
      artifactPinId: randomUUID(),
      artifactReferenceId: randomUUID(),
      intentionEventId: randomUUID(),
      terminalEventId: randomUUID(),
    },
  });
}

function granted(outcome: RoadmapRevisionOutcome): RoadmapRevisionOutcome & { ok: true } {
  if (!outcome.ok) throw new Error("expected a grant, got " + outcome.reason + " at " + outcome.at);
  return outcome;
}

function rows<T>(path: string, sql: string): T[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare(sql).all() as T[];
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

/** The stored events of the version at `version`, as the batch door received them. */
function storedBatch(ledger: Ledger, version: number): Record<string, unknown>[] {
  const prefix = "roadmap.v" + String(version);
  return ledger
    .listInitiativeEvents({ initiativeId: INITIATIVE })
    .events.filter((record) => record.event.transitionId === prefix || record.event.transitionId.startsWith(prefix + ".step."))
    .map((record) => ({ ...record.event }) as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// The one derivation
// ---------------------------------------------------------------------------

describe("roadmapStepDigests: one derivation of each step's digests and rank", () => {
  it("digests each text's UTF-8 bytes, and the write set sorted under the contract's prefix", () => {
    const derived = roadmapStepDigests(threeSteps());
    if (!derived.ok) throw new Error("expected an acyclic manifest");
    const b = derived.steps[1];
    // Computed here the other way: node:crypto over the bytes, JSON.stringify for
    // an array of strings, which is its canonical form.
    expect(b?.objectiveSha256).toBe(sha256("The objective of B, which stays private."));
    expect(b?.acceptanceSha256).toBe(sha256("The acceptance of B, which stays private."));
    expect(b?.expectedWriteSetSha256).toBe(
      sha256(ROADMAP_WRITE_SET_PREIMAGE_PREFIX_V1 + JSON.stringify(["packages/B/a.ts", "packages/B/b.ts"])),
    );
    expect(derived.steps.map((entry) => [entry.stepId, entry.stepIndex, entry.dependencyRank])).toEqual([
      ["A", 0, 0],
      ["B", 1, 1],
      ["C", 2, 1],
    ]);
  });

  it("ranks by the longest path, across a forward reference, and order is not identity", () => {
    const chain = { manifestContractVersion: 1 as const, steps: [step("C", ["B"]), step("A"), step("B", ["A"]), step("D", ["A", "C"])] };
    const derived = roadmapStepDigests(chain);
    if (!derived.ok) throw new Error("expected an acyclic manifest");
    expect(derived.steps.map((entry) => entry.dependencyRank)).toEqual([2, 0, 1, 3]);
    const reversed = roadmapStepDigests({
      manifestContractVersion: 1,
      steps: [step("A", [], { expectedWriteSet: ["packages/A/a.ts", "packages/A/b.ts"] })],
    });
    const forward = roadmapStepDigests({ manifestContractVersion: 1, steps: [step("A")] });
    if (!reversed.ok || !forward.ok) throw new Error("expected acyclic manifests");
    expect(reversed.steps[0]?.expectedWriteSetSha256).toBe(forward.steps[0]?.expectedWriteSetSha256);
  });

  it("refuses a cycle at its first step in manifest order, by id and never by content", () => {
    const cyclic = { manifestContractVersion: 1 as const, steps: [step("A"), step("B", ["C"]), step("C", ["D"]), step("D", ["B"])] };
    expect(roadmapStepDigests(cyclic)).toEqual({ ok: false, reason: "STEP_DEPENDENCY_CYCLE", at: "B" });
  });

  it("digests the manifest's canonical bytes, whatever order its keys were written in", () => {
    const shuffled = {
      steps: threeSteps().steps.map((entry) => Object.fromEntries(Object.entries(entry).reverse()) as typeof entry),
      manifestContractVersion: 1 as const,
    };
    expect(roadmapStepManifestDocument(shuffled).sha256).toBe(roadmapStepManifestDocument(threeSteps()).sha256);
    expect(roadmapStepManifestDocument(threeSteps()).sha256).toBe(sha256(roadmapStepManifestDocument(threeSteps()).json));
  });
});

// ---------------------------------------------------------------------------
// The producer, through the batch door
// ---------------------------------------------------------------------------

describe("recordRoadmapRevision: one producer, steps optional", () => {
  it("records a version and its three steps in one contiguous batch, re-derived at the door", () => {
    const on = substrates();
    const outcome = granted(revise(on, { steps: threeSteps() }));
    expect(outcome.version.stepCount).toBe(3);
    const document = roadmapStepManifestDocument(threeSteps());
    expect(outcome.version.stepManifestSha256).toBe(document.sha256);

    const events = on.ledger.listInitiativeEvents({ initiativeId: INITIATIVE }).events.slice(1);
    expect(events.map((record) => [record.event.type, record.event.transitionId])).toEqual([
      ["ROADMAP_VERSION_RECORDED", "roadmap.v1"],
      ["ROADMAP_STEP_DECLARED", "roadmap.v1.step.0"],
      ["ROADMAP_STEP_DECLARED", "roadmap.v1.step.1"],
      ["ROADMAP_STEP_DECLARED", "roadmap.v1.step.2"],
    ]);
    const sequences = events.map((record) => record.sequence);
    expect(sequences).toEqual([sequences[0], (sequences[0] ?? 0) + 1, (sequences[0] ?? 0) + 2, (sequences[0] ?? 0) + 3]);

    const steps = on.ledger.listRoadmapSteps(outcome.version.roadmapVersionId);
    expect(steps.map((entry) => [entry.stepId, entry.stepIndex, entry.dependencyRank, entry.state, entry.routingAssignmentVersion])).toEqual([
      ["A", 0, 0, "DECLARED", null],
      ["B", 1, 1, "DECLARED", null],
      ["C", 2, 1, "DECLARED", null],
    ]);
    expect(
      on.ledger.listRoadmapStepDependencies(outcome.version.roadmapVersionId).map((entry) => [entry.stepId, entry.dependsOnStepId]),
    ).toEqual([
      ["B", "A"],
      ["C", "A"],
    ]);

    // The manifest is a PLAN_DOCUMENT of this initiative, and reads back whole.
    const reference = rows<{ artifact_class: string; scope_kind: string; scope_id: string; content_sha256: string }>(
      on.path,
      "SELECT artifact_class, scope_kind, scope_id, content_sha256 FROM artifact_reference_read_model",
    ).find((row) => row.content_sha256 === document.sha256);
    expect(reference).toEqual({ artifact_class: "PLAN_DOCUMENT", scope_kind: "INITIATIVE", scope_id: INITIATIVE, content_sha256: document.sha256 });
    const read = readRoadmapStepManifest(on.ledger, {
      artifactReferenceId: outcome.version.stepManifestArtifactReferenceId ?? "",
      initiativeId: INITIATIVE,
    });
    expect(read.ok && read.contentSha256).toBe(document.sha256);
    expect(on.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("keeps every step's objective, acceptance and paths off the stream; only titles travel", () => {
    const on = substrates();
    granted(revise(on, { steps: threeSteps() }));
    const bodies = rows<{ event_json: string }>(on.path, "SELECT event_json FROM initiative_events").map((row) => row.event_json).join("\n");
    for (const entry of threeSteps().steps) {
      expect(bodies).not.toContain(entry.objective);
      expect(bodies).not.toContain(entry.acceptance);
      for (const path of entry.expectedWriteSet) expect(bodies).not.toContain(path);
      expect(bodies).toContain(entry.title);
    }
  });

  it("records a version with no steps through the single door, with its count 0 and no manifest", () => {
    const on = substrates();
    const outcome = granted(revise(on));
    expect([outcome.version.stepCount, outcome.version.stepManifestArtifactReferenceId, outcome.version.stepManifestSha256]).toEqual([0, null, null]);
    expect(on.ledger.listRoadmapSteps(outcome.version.roadmapVersionId)).toEqual([]);
  });

  it("refuses a cycle before anything is published or appended", () => {
    const on = substrates();
    const before = on.ledger.status().initiativeEventCount;
    const cyclic = { manifestContractVersion: 1, steps: [step("A", ["B"]), step("B", ["A"])] };
    expect(revise(on, { steps: cyclic })).toEqual({ ok: false, reason: "STEP_DEPENDENCY_CYCLE", at: "A" });
    expect(on.ledger.status().initiativeEventCount).toBe(before);
    expect(on.ledger.listArtifactEvents(roadmapStepManifestDocument(cyclic as never).sha256)).toEqual([]);
  });

  it("rolls back to a version with its steps re-declared, or refuses a rollback whose steps differ", () => {
    const on = substrates();
    const first = granted(revise(on, { content: "# one\n", steps: threeSteps() }));
    const second = granted(revise(on, { content: "# two\n", expectedHeadDigest: first.version.contentDigest }));
    const refused = revise(on, {
      content: "# one\n",
      expectedHeadDigest: second.version.contentDigest,
      kind: "ROLLBACK",
      restoresVersionId: first.version.roadmapVersionId,
    });
    expect(refused).toEqual({ ok: false, reason: "ROLLBACK_STEPS_MISMATCH", at: "candidate.stepManifestSha256" });
    const rolled = granted(
      revise(on, {
        content: "# one\n",
        expectedHeadDigest: second.version.contentDigest,
        kind: "ROLLBACK",
        restoresVersionId: first.version.roadmapVersionId,
        steps: threeSteps(),
      }),
    );
    expect(rolled.version.stepManifestSha256).toBe(first.version.stepManifestSha256);
    const restored = on.ledger.listRoadmapSteps(rolled.version.roadmapVersionId);
    const original = on.ledger.listRoadmapSteps(first.version.roadmapVersionId);
    const shape = (entry: (typeof restored)[number]) => [entry.stepId, entry.stepIndex, entry.title, entry.objectiveSha256, entry.acceptanceSha256, entry.expectedWriteSetSha256, entry.dependencyRank];
    expect(restored.map(shape)).toEqual(original.map(shape));
  });
});

// ---------------------------------------------------------------------------
// The batch door
// ---------------------------------------------------------------------------

describe("appendInitiativeBatch: all or none, replayed whole, re-derived", () => {
  it("answers an exact whole-batch replay with the stored records and writes nothing", () => {
    const on = substrates();
    const outcome = granted(revise(on, { steps: threeSteps() }));
    const batch = storedBatch(on.ledger, outcome.version.version);
    const count = on.ledger.status().initiativeEventCount;
    const replay = on.ledger.appendInitiativeBatch(batch);
    expect(replay.insertedCount).toBe(0);
    expect(replay.records.map((record) => record.eventId)).toEqual(batch.map((event) => event["eventId"]));
    expect(on.ledger.status().initiativeEventCount).toBe(count);
  });

  it("refuses a partial replay and a byte-different replay as one batch conflict", () => {
    const on = substrates();
    const outcome = granted(revise(on, { steps: threeSteps() }));
    const batch = storedBatch(on.ledger, outcome.version.version);
    const last = batch[3] ?? {};
    const partial = [...batch.slice(0, 3), { ...last, eventId: randomUUID(), transitionId: "roadmap.v1.step.x", idempotencyKey: INITIATIVE + "/1/roadmap.v1.step.x" }];
    const partialError = caught(() => on.ledger.appendInitiativeBatch(partial));
    expect(partialError).toBeInstanceOf(LedgerInitiativeBatchConflictError);
    expect((partialError as LedgerInitiativeBatchConflictError).code).toBe("LEDGER_INITIATIVE_BATCH_CONFLICT");
    expect((partialError as LedgerInitiativeBatchConflictError).recordedKeys).toBe(3);

    const different = batch.map((event, index) =>
      index === 2 ? { ...event, payload: { ...(event["payload"] as object), title: "Another title" } } : event,
    );
    const differentError = caught(() => on.ledger.appendInitiativeBatch(different));
    expect(differentError).toBeInstanceOf(LedgerInitiativeBatchConflictError);
    expect((differentError as LedgerInitiativeBatchConflictError).recordedKeys).toBe(4);
  });

  it("refuses a batch whose shape is not one version and its steps in index order", () => {
    const on = substrates();
    const outcome = granted(revise(on, { steps: threeSteps() }));
    const batch = storedBatch(on.ledger, outcome.version.version).map((event) => ({
      ...event,
      eventId: randomUUID(),
    }));
    const swapped = [batch[0], batch[2], batch[1], batch[3]];
    expect(caught(() => on.ledger.appendInitiativeBatch(swapped))).toBeInstanceOf(LedgerValidationError);
    expect(caught(() => on.ledger.appendInitiativeBatch(batch.slice(1)))).toBeInstanceOf(LedgerValidationError);
    expect(caught(() => on.ledger.appendInitiativeBatch(batch.slice(0, 1)))).toBeInstanceOf(LedgerValidationError);
    expect(caught(() => on.ledger.appendInitiativeBatch(batch.slice(0, 3)))).toBeInstanceOf(LedgerValidationError);
  });

  /** Version 2 of the initiative, built by hand as a raw producer would, over v1's manifest. */
  function rawSecondBatch(on: Substrates, first: RoadmapRevisionOutcome & { ok: true }, tamper: (events: Record<string, unknown>[]) => void) {
    const versionId = randomUUID();
    const derived = roadmapStepDigests(threeSteps());
    if (!derived.ok) throw new Error("expected an acyclic manifest");
    const envelope = (transitionId: string, type: string, payload: unknown): Record<string, unknown> => ({
      contractVersion: CONTRACT_VERSION,
      eventId: randomUUID(),
      initiativeId: INITIATIVE,
      transitionId,
      idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId: INITIATIVE, transitionId }),
      type,
      fromStatus: "ACTIVE",
      toStatus: "ACTIVE",
      emittedBy: COORDINATOR,
      occurredAt: AT,
      recordedAt: AT,
      payload,
    });
    const events = [
      envelope("roadmap.v2", "ROADMAP_VERSION_RECORDED", {
        ...first.version,
        roadmapVersionId: versionId,
        version: 2,
        parentVersionId: first.version.roadmapVersionId,
        expectedHeadDigest: first.version.contentDigest,
      }),
      ...derived.steps.map((entry, index) =>
        envelope("roadmap.v2.step." + String(index), "ROADMAP_STEP_DECLARED", { roadmapVersionId: versionId, ...entry }),
      ),
    ];
    tamper(events);
    return events;
  }

  it("grants a raw batch that re-derives, and refuses each tampered digest and rank by name", () => {
    const on = substrates();
    const first = granted(revise(on, { steps: threeSteps() }));
    expect(on.ledger.appendInitiativeBatch(rawSecondBatch(on, first, () => undefined)).insertedCount).toBe(4);

    for (const field of ["objectiveSha256", "acceptanceSha256", "expectedWriteSetSha256", "dependencyRank", "title"]) {
      const fresh = substrates();
      const base = granted(revise(fresh, { steps: threeSteps() }));
      const events = rawSecondBatch(fresh, base, (batch) => {
        const target = batch[2] as { payload: Record<string, unknown> };
        target.payload = { ...target.payload, [field]: field === "dependencyRank" ? 5 : field === "title" ? "Z" : "f".repeat(64) };
      });
      const error = caught(() => fresh.ledger.appendInitiativeBatch(events));
      expect(error, field).toBeInstanceOf(LedgerRoadmapVersionRefusedError);
      expect({ field, reason: (error as LedgerRoadmapVersionRefusedError).reason, at: (error as LedgerRoadmapVersionRefusedError).at }).toEqual({
        field,
        reason: "STEP_DIGEST_MISMATCH",
        at: "steps[1]." + field,
      });
    }
  });

  it("refuses a manifest reference that is unknown, scoped elsewhere or of another digest", () => {
    const on = substrates();
    const first = granted(revise(on, { steps: threeSteps() }));
    const unknown = rawSecondBatch(on, first, (batch) => {
      const version = batch[0] as { payload: Record<string, unknown> };
      version.payload = { ...version.payload, stepManifestArtifactReferenceId: "ref-that-was-never-published" };
    });
    expect(caught(() => on.ledger.appendInitiativeBatch(unknown))).toBeInstanceOf(LedgerValidationError);

    // The same manifest published under the other initiative's scope.
    const foreign = granted(revise(on, { steps: threeSteps() }, OTHER_INITIATIVE));
    const scoped = rawSecondBatch(on, first, (batch) => {
      const version = batch[0] as { payload: Record<string, unknown> };
      version.payload = { ...version.payload, stepManifestArtifactReferenceId: foreign.version.stepManifestArtifactReferenceId };
    });
    expect(caught(() => on.ledger.appendInitiativeBatch(scoped))).toBeInstanceOf(LedgerValidationError);

    const digest = rawSecondBatch(on, first, (batch) => {
      const version = batch[0] as { payload: Record<string, unknown> };
      version.payload = { ...version.payload, stepManifestSha256: "e".repeat(64) };
    });
    const error = caught(() => on.ledger.appendInitiativeBatch(digest));
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect(String(error)).toContain("payload.stepManifestSha256");
    expect(on.ledger.listRoadmapVersions(INITIATIVE)).toHaveLength(1);
  });

  it("the single door writes no step and no version that counts steps (L-P26B-1)", () => {
    const on = substrates();
    const first = granted(revise(on, { steps: threeSteps() }));
    const batch = rawSecondBatch(on, first, () => undefined);
    const versionError = caught(() => on.ledger.appendInitiativeEvent(batch[0]));
    expect(versionError).toBeInstanceOf(LedgerValidationError);
    expect(String(versionError)).toContain("payload.stepCount");
    const stepError = caught(() => on.ledger.appendInitiativeEvent(batch[1]));
    expect(stepError).toBeInstanceOf(LedgerValidationError);
    expect(String(stepError)).toContain("appendInitiativeBatch");
    expect(on.ledger.listRoadmapVersions(INITIATIVE)).toHaveLength(1);
  });

  it("refuses new work stamped 2.9.0 at the batch door, and a payload whose version is not its event's", () => {
    const on = substrates();
    const first = granted(revise(on, { steps: threeSteps() }));
    const stale = rawSecondBatch(on, first, (batch) => {
      for (const event of batch) event["contractVersion"] = "2.9.0";
    });
    const staleError = caught(() => on.ledger.appendInitiativeBatch(stale));
    expect(staleError).toBeInstanceOf(LedgerValidationError);
    expect(String(staleError)).toContain(CONTRACT_VERSION);
    expect(String(staleError)).toContain("2.9.0");
    const mixed = rawSecondBatch(on, first, (batch) => {
      const version = batch[0] as { payload: Record<string, unknown> };
      version.payload = { ...version.payload, contractVersion: "2.9.0" };
    });
    const mixedError = caught(() => on.ledger.appendInitiativeBatch(mixed));
    expect(mixedError).toBeInstanceOf(LedgerRoadmapVersionRefusedError);
    expect((mixedError as LedgerRoadmapVersionRefusedError).at).toBe("candidate.contractVersion");
  });

  it("rebuilds the steps and their dependencies to identical rows, twice", () => {
    const on = substrates();
    const outcome = granted(revise(on, { steps: threeSteps() }));
    const steps = on.ledger.listRoadmapSteps(outcome.version.roadmapVersionId);
    const dependencies = on.ledger.listRoadmapStepDependencies(outcome.version.roadmapVersionId);
    on.ledger.rebuildReadModel();
    expect(on.ledger.listRoadmapSteps(outcome.version.roadmapVersionId)).toEqual(steps);
    on.ledger.rebuildReadModel();
    expect(on.ledger.listRoadmapSteps(outcome.version.roadmapVersionId)).toEqual(steps);
    expect(on.ledger.listRoadmapStepDependencies(outcome.version.roadmapVersionId)).toEqual(dependencies);
    expect(on.ledger.verifyIntegrity().ok).toBe(true);
  });
});

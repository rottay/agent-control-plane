import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_VERSION, buildInitiativeIdempotencyKey } from "@acp/contracts";
import {
  artifactBlobLeaseStorePath,
  canonicalJsonStringify,
  envelopeSha256,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  recordRoadmapRevision,
} from "@acp/ledger";
import type { ArtifactPlane, ArtifactPlaneTestFaults, Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import {
  TASK_ENVELOPE_MEDIA_TYPE,
  TASK_INTAKE_CODES,
  TASK_INTAKE_REFUSALS,
  TASK_INTAKE_WRITE_REFUSALS,
  assignmentRefusalClass,
  intakeTask,
  taskEnvelopeIdempotencyKeys,
} from "../../src/intake/index.js";
import type { TaskIntakeFields, TaskIntakeOutcome, TaskIntakeTestFaults } from "../../src/intake/index.js";

/**
 * The instruction content for a fixture whose prose is `text` (P-06/B, ADR 0094).
 *
 * One text block, the envelope's whole instruction: from 2.11.0 `content` states it
 * once (P-16/A1, ADR 0120). `contentSha256` is a placeholder:
 * escalón B admits and publishes, and escalón C is where a digest is checked
 * against the bytes it describes.
 */
function fixtureContent(text: string): Record<string, unknown> {
  return {
    contentContractVersion: 1,
    blocks: [
      {
        kind: "text",
        blockId: "b1",
        mediaType: "text/plain; charset=utf-8",
        byteLength: new TextEncoder().encode(text).byteLength,
        contentSha256: "0".repeat(64),
        artifactRefId: null,
        text,
        toolCallId: null,
        effectId: null,
      },
    ],
  };
}


/**
 * Evidence for the task intake (P-14 escalón C, ADR 0087).
 *
 * The orchestration is asserted over a real ledger, a real blob lease store and a
 * real private plane, because what it promises is an order across substrates
 * that share no transaction: decide, publish, append. The registry it resolves
 * against is seeded through the ledger's own doors — an initiative, a roadmap
 * version, a model version and a GLOBAL assignment — so every refusal here is
 * the one a real ledger would produce. The negatives are the preaudit's
 * N-P14C-*; the two-door equivalence lives in the gateway's and the CLI's suites.
 *
 * A crash is a fault hook that throws: the call ends where it stands and the
 * handles are closed as a dead process's would be.
 */

const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const OTHER_INITIATIVE = "55555555-5555-4555-8555-555555555555";
const VERSION_ID = "66666666-6666-4666-8666-666666666601";
const OTHER_VERSION_ID = "66666666-6666-4666-8666-666666666602";
const TASK_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TASK_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const CREATED_AT = "2026-09-01T00:00:00.000Z";
const REGISTRY_AT = "2026-09-03T12:00:00.000Z";
const AT = "2026-09-13T12:00:00.000Z";
const LATER = "2026-09-13T12:30:00.000Z";
const COORDINATOR = "kimi/k3/coordinator/01";
const OPERATOR = "claude/opus/implementer/01";
const MODEL_ONE = "claude-opus-5@2026-06-01";
const MODEL_TWO = "claude-sonnet-5@2026-06-01";
const LIVE_PID = 5151;
const DEAD_PID = 4242;
const OBJECTIVE = "Enter one task by command and by API, and keep its envelope off the stream.";
const SENTINEL = "sk-ant-api03-SENTINELSENTINELSENTINEL";
const INTAKE_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/intake/index.ts");
const INTAKE_TYPE_LEAF = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/intake/types/index.ts");

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

function sha256(bytes: string): string {
  return createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex");
}

function temporaryLedgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-task-intake-"));
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
    incarnationId: "11111111-1111-4111-8111-111111111111",
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

// ---------------------------------------------------------------------------
// The world an intake is decided against, seeded through the ledger's doors
// ---------------------------------------------------------------------------

function registerInitiative(ledger: Ledger, initiativeId: string): void {
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
    occurredAt: CREATED_AT,
    recordedAt: CREATED_AT,
    payload: {},
  });
}

function recordRoadmapVersion(ledger: Ledger, initiativeId: string, roadmapVersionId: string): void {
  const transitionId = "roadmap." + roadmapVersionId;
  ledger.appendInitiativeEvent({
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    initiativeId,
    transitionId,
    idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId, transitionId }),
    type: "ROADMAP_VERSION_RECORDED",
    fromStatus: "ACTIVE",
    toStatus: "ACTIVE",
    emittedBy: COORDINATOR,
    occurredAt: CREATED_AT,
    recordedAt: CREATED_AT,
    payload: {
      contractVersion: CONTRACT_VERSION,
      roadmapVersionId,
      initiativeId,
      version: 1,
      contentDigest: "a".repeat(64),
      parentVersionId: null,
      expectedHeadDigest: null,
      kind: "EDIT",
      restoresVersionId: null,
      recordedBy: COORDINATOR,
      recordedAt: CREATED_AT,
      stepCount: 0,
      stepManifestArtifactReferenceId: null,
      stepManifestSha256: null,
    },
  });
}

function registryDocument(input: {
  readonly documentKind: string;
  readonly documentId: string;
  readonly documentVersion?: number;
  readonly payload: Record<string, unknown>;
}): Record<string, unknown> {
  const documentVersion = input.documentVersion ?? 1;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    idempotencyKey: input.documentId + "/" + String(documentVersion),
    documentKind: input.documentKind,
    documentId: input.documentId,
    documentVersion,
    parentDocumentVersion: documentVersion === 1 ? null : documentVersion - 1,
    // The payload's own digest, which the registry door verifies (P-15/R, ADR 0104).
    contentDigest: sha256(canonicalJsonStringify(input.payload)),
    recordedBy: COORDINATOR,
    effectiveFrom: REGISTRY_AT,
    occurredAt: REGISTRY_AT,
    recordedAt: REGISTRY_AT,
    payload: input.payload,
  };
}

function modelVersion(
  ledger: Ledger,
  modelVersionId: string,
  overrides: Record<string, unknown> = {},
  documentVersion = 1,
): void {
  ledger.appendRegistryEvent(
    registryDocument({
      documentKind: "MODEL_VERSION",
      documentId: modelVersionId,
      documentVersion,
      payload: {
        provider: "claude",
        model: "claude-opus-5",
        release: "2026-06-01",
        status: "ACTIVE",
        contextTokens: 200000,
        policyVersion: "2026.09.0",
        deprecatedAt: null,
        eligibleRoles: ["coordinator", "implementer", "reviewer", "consultant", "verifier"],
        transports: ["CLI_SUBSCRIPTION"],
        ...overrides,
      },
    }),
  );
}

function assignGlobal(ledger: Ledger, role = "implementer", slot = 0, modelVersionId = MODEL_ONE): void {
  ledger.appendRegistryEvent(
    registryDocument({
      documentKind: "ROUTING_ASSIGNMENT_GLOBAL",
      documentId: "routing:GLOBAL:" + role + ":" + String(slot),
      payload: { role, slot, provider: "claude", modelVersionId, fallbacks: [] },
    }),
  );
}

/** The steps the fixture's version declares, through the producer and the batch door (P-27 cut A). */
const DECLARED_STEPS = ["step.one", "step.two"] as const;

/**
 * Record a roadmap version that declares `stepIds`, through the ledger's one producer:
 * the manifest published to the private plane, the version and its steps appended
 * all or none. Since P-27 cut A an intake's step must be one its version declares.
 */
function recordRoadmapVersionWithSteps(
  on: Substrates,
  initiativeId: string,
  roadmapVersionId: string,
  stepIds: readonly string[],
): void {
  const outcome = recordRoadmapRevision({
    reader: on.ledger,
    writable: on.ledger,
    plane: on.plane,
    initiativeId,
    request: {
      content: "# Roadmap\n",
      expectedHeadDigest: null,
      kind: "EDIT",
      restoresVersionId: null,
      recordedBy: COORDINATOR,
      steps: {
        manifestContractVersion: 1,
        steps: stepIds.map((stepId) => ({
          stepId,
          title: "Step " + stepId,
          objective: "The objective of " + stepId + ".",
          acceptance: "The acceptance of " + stepId + ".",
          expectedWriteSet: ["docs/" + stepId + ".md"],
          dependsOn: [],
        })),
      },
    },
    recordedAt: CREATED_AT,
    roadmapVersionId,
    eventId: randomUUID(),
    holderPid: LIVE_PID,
    stepIdentities: {
      stepEventIds: stepIds.map(() => randomUUID()),
      commandId: randomUUID(),
      artifactPinId: randomUUID(),
      artifactReferenceId: randomUUID(),
      intentionEventId: randomUUID(),
      terminalEventId: randomUUID(),
    },
  });
  if (!outcome.ok) throw new Error("the fixture's roadmap version was refused: " + outcome.reason + " at " + outcome.at);
}

/**
 * An initiative with one roadmap version declaring two steps, another initiative with
 * a version declaring none, one ACTIVE model version and the implementer's slot 0.
 */
function seedWorld(on: Substrates): void {
  registerInitiative(on.ledger, INITIATIVE);
  recordRoadmapVersionWithSteps(on, INITIATIVE, VERSION_ID, DECLARED_STEPS);
  registerInitiative(on.ledger, OTHER_INITIATIVE);
  recordRoadmapVersion(on.ledger, OTHER_INITIATIVE, OTHER_VERSION_ID);
  modelVersion(on.ledger, MODEL_ONE);
  assignGlobal(on.ledger);
}

function world(ledgerPath = temporaryLedgerPath(), faults?: ArtifactPlaneTestFaults): Substrates {
  // The world is seeded through a plane with no fault, because the version's manifest
  // is itself a publication; the faults arm the handles the test drives.
  if (faults !== undefined) {
    const seeding = substrates(ledgerPath);
    seedWorld(seeding);
    seeding.die();
    return substrates(ledgerPath, faults);
  }
  const on = substrates(ledgerPath);
  seedWorld(on);
  return on;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: TASK_A,
    initiativeId: INITIATIVE,
    title: "Enter a task",
    content: fixtureContent(OBJECTIVE),
    classification: "MECHANICAL",
    issuedBy: COORDINATOR,
    issuedAt: CREATED_AT,
    authority: [],
    readSet: ["docs/intake.md"],
    writeSet: ["docs/intake.md"],
    conflictKeys: ["docs"],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "" },
    validation: { commands: [], independentVerifierRequired: false },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 100 },
    visualEvidenceRequired: false,
    commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
    checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 1 },
    ...overrides,
  };
}

function fields(overrides: Partial<TaskIntakeFields> = {}): TaskIntakeFields {
  return {
    envelope: envelope(),
    clientScope: OPERATOR,
    clientRequestKey: "intake-0001",
    roadmapVersionId: VERSION_ID,
    stepId: "step.one",
    role: "implementer",
    slot: 0,
    transportKind: "CLI_SUBSCRIPTION",
    recordedBy: OPERATOR,
    ...overrides,
  };
}

function intake(
  on: Substrates,
  overrides: Partial<TaskIntakeFields> = {},
  options: { readonly pid?: number; readonly at?: string; readonly faults?: TaskIntakeTestFaults } = {},
): TaskIntakeOutcome {
  return intakeTask({
    ledger: on.ledger,
    plane: on.plane,
    request: fields(overrides),
    recordedAt: options.at ?? AT,
    holderPid: options.pid ?? LIVE_PID,
    identities: {
      eventId: randomUUID(),
      revisionId: randomUUID(),
      commandId: randomUUID(),
      artifactPinId: randomUUID(),
      artifactReferenceId: randomUUID(),
      intentionEventId: randomUUID(),
      terminalEventId: randomUUID(),
    },
    ...(options.faults === undefined ? {} : { __testFaults: options.faults }),
  });
}

function entered(outcome: TaskIntakeOutcome): TaskIntakeOutcome & { ok: true } {
  if (!outcome.ok) throw new Error("expected an intake, got " + outcome.reason + " " + outcome.code + " at " + outcome.at);
  return outcome;
}

function refusal(reason: string, code: string, at: string, proposal: string | null = null): TaskIntakeOutcome {
  return { ok: false, reason, code, at, proposal } as TaskIntakeOutcome;
}

/** The three heads a refused intake must leave where they were (E11). */
function heads(ledger: Ledger): readonly number[] {
  const status = ledger.status();
  const registry = status.projections
    .find((projection) => projection.name === "model_version_read_model")
    ?.watermarks.find((watermark) => watermark.sourceStream === "registry_events");
  return [status.headSequence, status.initiativeHeadSequence, registry?.appliedThroughSequence ?? -1];
}

/** A source with its block and line comments removed, so a law reads code and not prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function envelopeBytes(overrides: Record<string, unknown> = {}): string {
  return canonicalJsonStringify(envelope(overrides));
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe("the intake's vocabulary is closed and sorted", () => {
  it("names contracts §5's three classes, and the write door's two more", () => {
    expect([...TASK_INTAKE_REFUSALS]).toEqual(["AUTHORITY_REFUSED", "CONFLICT", "REQUEST_INVALID"]);
    expect([...TASK_INTAKE_WRITE_REFUSALS]).toEqual([
      "AUTHORITY_REFUSED",
      "CONFLICT",
      "CONTENT_REJECTED",
      "REQUEST_INVALID",
      "WRITE_CONFLICT",
    ]);
    expect([...TASK_INTAKE_CODES]).toEqual([...TASK_INTAKE_CODES].sort());
  });

  it("M-7: maps the resolver's two unreadable questions to the request, and the other seven to authority", () => {
    expect(assignmentRefusalClass("ASSIGNMENT_REQUEST_INVALID")).toBe("REQUEST_INVALID");
    expect(assignmentRefusalClass("ASSIGNMENT_READING_INVALID")).toBe("REQUEST_INVALID");
    for (const reason of [
      "ASSIGNMENT_ABSENT",
      "MODEL_VERSION_UNKNOWN",
      "MODEL_VERSION_RETIRED",
      "MODEL_VERSION_DEPRECATED",
      "ROLE_NOT_ELIGIBLE",
      "TRANSPORT_NOT_ADMITTED",
      "ASSIGNMENT_PROVIDER_MISMATCH",
    ] as const) {
      expect(assignmentRefusalClass(reason), reason).toBe("AUTHORITY_REFUSED");
    }
  });
});

// ---------------------------------------------------------------------------
// The intake
// ---------------------------------------------------------------------------

describe("a task enters once, with its revision and its envelope by reference", () => {
  it("records DISCOVERED, revision 1, the key, the resolution and the envelope in the private plane", () => {
    const on = world();
    const before = on.ledger.getGlobalRoutingAssignment({ role: "implementer", slot: 0 });
    const outcome = entered(intake(on));

    expect(outcome.replayed).toBe(false);
    expect(outcome.task.taskId).toBe(TASK_A);
    expect(outcome.task.state).toBe("DISCOVERED");
    expect(outcome.task.revisionNumber).toBe(1);
    expect(outcome.task.envelopeSha256).toBe(envelopeSha256(envelope()));
    expect(outcome.task.resolution).toEqual({
      assignmentId: before.assignment?.assignmentId,
      assignmentVersion: 1,
      slot: 0,
      modelVersionId: MODEL_ONE,
      provider: "claude",
      model: "claude-opus-5",
      release: "2026-06-01",
      transportKind: "CLI_SUBSCRIPTION",
      watermarks: before.watermarks,
    });

    const task = on.ledger.getTask(TASK_A);
    expect(task).toMatchObject({
      initiativeId: INITIATIVE,
      currentState: "DISCOVERED",
      eventCount: 1,
      stepId: "step.one",
      role: "implementer",
      commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
      latestRevisionNumber: 1,
      latestAttemptNumber: 1,
      envelopeSha256: outcome.task.envelopeSha256,
    });
    expect(on.ledger.getTaskSubmission(OPERATOR, "intake-0001")).toEqual({
      clientScope: OPERATOR,
      clientRequestKey: "intake-0001",
      taskId: TASK_A,
      revisionNumber: 1,
      envelopeSha256: outcome.task.envelopeSha256,
      sequence: outcome.sequence,
      createdAt: AT,
    });

    const record = on.ledger.getEventBySequence(outcome.sequence);
    expect(record?.event).toMatchObject({
      type: "TASK_DISCOVERED",
      transitionId: "intake",
      fromState: null,
      toState: "DISCOVERED",
      attempt: 1,
      idempotencyKey: "v2/control_plane_events/" + TASK_A + "/1/1/intake",
      emittedBy: OPERATOR,
      occurredAt: AT,
      correlationId: null,
      causationId: null,
    });

    // The reference: a TASK_ENVELOPE of this task, whose bytes are the envelope's
    // canonical JSON — and whose digest is not the envelope's identity digest.
    const reference = on.ledger.getArtifactReference(outcome.task.envelopeArtifactReferenceId);
    expect(reference).toMatchObject({
      artifactClass: "TASK_ENVELOPE",
      classification: "INTERNAL",
      scopeKind: "TASK",
      scopeId: TASK_A,
      producerIdentity: OPERATOR,
      retentionClass: "PERMANENT",
      contentSha256: sha256(envelopeBytes()),
    });
    expect(reference?.contentSha256).not.toBe(outcome.task.envelopeSha256);
    const read = on.plane.read({
      artifactReferenceId: outcome.task.envelopeArtifactReferenceId,
      scopeKind: "TASK",
      scopeId: TASK_A,
    });
    expect(read.verb).toBe("READ");
    if (read.verb !== "READ") throw new Error("expected the envelope");
    expect(read.content.toString("utf8")).toBe(envelopeBytes());
    const blob = on.ledger.getArtifactBlob(sha256(envelopeBytes()), 1);
    expect(blob?.mediaType).toBe(TASK_ENVELOPE_MEDIA_TYPE);
    expect(on.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("N-P14C-2: the same key and the same request twice is one task, one revision, one reference — a replay", () => {
    const on = world();
    const first = entered(intake(on));
    const heldBefore = heads(on.ledger);
    const second = entered(intake(on, {}, { at: LATER }));

    expect(second.replayed).toBe(true);
    expect(second).toEqual({ ...first, replayed: true });
    expect(heads(on.ledger)).toEqual(heldBefore);
    expect(on.ledger.getTask(TASK_A)?.eventCount).toBe(1);
    expect(on.ledger.listArtifactEvents(sha256(envelopeBytes())).map((event) => event.event.artifactEventKind)).toEqual([
      "PUBLICATION_INTENDED",
      "PUBLICATION_SUCCEEDED",
    ]);
  });

  it("N-P14C-1: the same key with another envelope is CONFLICT, and nothing is published or appended", () => {
    const on = world();
    entered(intake(on));
    const held = heads(on.ledger);
    const other = envelope({ title: "Another title" });
    expect(intake(on, { envelope: other })).toEqual(refusal("CONFLICT", "CLIENT_KEY_CONFLICT", "envelope"));
    expect(heads(on.ledger)).toEqual(held);
    expect(on.ledger.listArtifactEvents(sha256(canonicalJsonStringify(other)))).toEqual([]);
    expect(on.ledger.getTaskSubmission(OPERATOR, "intake-0001")?.envelopeSha256).toBe(envelopeSha256(envelope()));
  });

  it("N-P14C-3: the same key and envelope with another step, link, role, slot or transport is CONFLICT at the field", () => {
    const on = world();
    entered(intake(on));
    const held = heads(on.ledger);
    expect(intake(on, { stepId: "step.two" })).toEqual(refusal("CONFLICT", "CLIENT_KEY_CONFLICT", "stepId"));
    expect(intake(on, { roadmapVersionId: null, stepId: null })).toEqual(
      refusal("CONFLICT", "CLIENT_KEY_CONFLICT", "roadmapVersionId"),
    );
    expect(intake(on, { role: "reviewer" })).toEqual(refusal("CONFLICT", "CLIENT_KEY_CONFLICT", "role"));
    expect(intake(on, { slot: 1 })).toEqual(refusal("CONFLICT", "CLIENT_KEY_CONFLICT", "slot"));
    expect(intake(on, { transportKind: "API_KEY" })).toEqual(refusal("CONFLICT", "CLIENT_KEY_CONFLICT", "transportKind"));
    expect(heads(on.ledger)).toEqual(held);
  });

  it("N-P14C-4: another key naming a task that already entered is CONFLICT on the task id, not a ledger throw", () => {
    const on = world();
    entered(intake(on));
    const held = heads(on.ledger);
    expect(intake(on, { clientRequestKey: "intake-0002" })).toEqual(
      refusal("CONFLICT", "TASK_ALREADY_RECORDED", "envelope.taskId"),
    );
    expect(heads(on.ledger)).toEqual(held);
    expect(on.ledger.getTaskSubmission(OPERATOR, "intake-0002")).toBeNull();
  });

  it("N-P14C-25: the digest recorded is the one computed from the parsed envelope, whatever the caller declares", () => {
    const on = world();
    const declared = { ...fields(), envelopeSha256: "f".repeat(64) } as TaskIntakeFields;
    const outcome = entered(
      intakeTask({
        ledger: on.ledger,
        plane: on.plane,
        request: declared,
        recordedAt: AT,
        holderPid: LIVE_PID,
        identities: {
          eventId: randomUUID(),
          revisionId: randomUUID(),
          commandId: randomUUID(),
          artifactPinId: randomUUID(),
          artifactReferenceId: randomUUID(),
          intentionEventId: randomUUID(),
          terminalEventId: randomUUID(),
        },
      }),
    );
    expect(outcome.task.envelopeSha256).toBe(envelopeSha256(envelope()));
    expect(on.ledger.getTaskSubmission(OPERATOR, "intake-0001")?.envelopeSha256).toBe(envelopeSha256(envelope()));
  });
});

// ---------------------------------------------------------------------------
// The preconditions
// ---------------------------------------------------------------------------

describe("the preconditions of the request link refuse with a class, a code and a field", () => {
  it("holds the request to its form before anything is read", () => {
    const on = world();
    const held = heads(on.ledger);
    expect(intake(on, { recordedBy: "nobody" })).toEqual(refusal("REQUEST_INVALID", "REQUEST_FIELD_INVALID", "recordedBy"));
    expect(intake(on, { clientScope: "has space" })).toEqual(
      refusal("REQUEST_INVALID", "REQUEST_FIELD_INVALID", "clientScope"),
    );
    expect(intake(on, { clientRequestKey: "" })).toEqual(
      refusal("REQUEST_INVALID", "REQUEST_FIELD_INVALID", "clientRequestKey"),
    );
    expect(intake(on, { slot: -1 })).toEqual(refusal("REQUEST_INVALID", "REQUEST_FIELD_INVALID", "slot"));
    expect(intake(on, { transportKind: "PIGEON" })).toEqual(
      refusal("REQUEST_INVALID", "REQUEST_FIELD_INVALID", "transportKind"),
    );
    expect(intake(on, { envelope: envelope({ taskId: "not-a-uuid" }) })).toEqual(
      refusal("REQUEST_INVALID", "ENVELOPE_INVALID", "envelope.taskId"),
    );
    expect(heads(on.ledger)).toEqual(held);
  });

  it("N-P14C-17: a credential in the instruction content is refused at its path before a byte is published", () => {
    // The instruction lives in `content` alone since P-16/A1 (ADR 0120), so that is
    // where the credential guards now find it.
    const on = world();
    const held = heads(on.ledger);
    const planted = envelope({ content: fixtureContent("deploy with " + SENTINEL) });
    expect(intake(on, { envelope: planted })).toEqual(
      refusal("REQUEST_INVALID", "ENVELOPE_INVALID", "envelope.content.blocks.0.text"),
    );
    expect(heads(on.ledger)).toEqual(held);
    expect(on.ledger.listArtifactEvents(sha256(canonicalJsonStringify(planted)))).toEqual([]);
  });

  it("P-16/A1: an envelope that still carries `objective` is ENVELOPE_INVALID at the envelope, and nothing is published or appended", () => {
    // Both spellings of the old legal shape: equal to the first text block, and not.
    for (const objective of [OBJECTIVE, "Something the content does not say."]) {
      const on = world();
      const held = heads(on.ledger);
      const stale = envelope({ objective });
      expect(intake(on, { envelope: stale }), objective).toEqual(refusal("REQUEST_INVALID", "ENVELOPE_INVALID", "envelope"));
      expect(heads(on.ledger)).toEqual(held);
      expect(on.ledger.listArtifactEvents(sha256(canonicalJsonStringify(stale)))).toEqual([]);
      expect(on.ledger.getTask(TASK_A)).toBeNull();
    }
  });

  it("P-16/A1 act 2: the stored envelope's version is the intake event's, and both are the version in force", () => {
    const on = world();
    const outcome = entered(intake(on));
    const record = on.ledger.getEventBySequence(outcome.sequence);
    const read = on.plane.read({
      artifactReferenceId: outcome.task.envelopeArtifactReferenceId,
      scopeKind: "TASK",
      scopeId: TASK_A,
    });
    if (read.verb !== "READ") throw new Error("expected the envelope");
    const stored = JSON.parse(read.content.toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain("objective");
    expect(stored["contractVersion"]).toBe(record?.event.contractVersion);
    expect(record?.event.contractVersion).toBe(CONTRACT_VERSION);
    expect(CONTRACT_VERSION).toBe("2.11.0");
  });

  it("N-P14C-5: an initiative with no row is REQUEST_INVALID, and nothing enters", () => {
    const on = world();
    const held = heads(on.ledger);
    const orphan = envelope({ initiativeId: "99999999-9999-4999-8999-999999999999" });
    expect(intake(on, { envelope: orphan, roadmapVersionId: null, stepId: null })).toEqual(
      refusal("REQUEST_INVALID", "INITIATIVE_UNKNOWN", "envelope.initiativeId"),
    );
    expect(heads(on.ledger)).toEqual(held);
    expect(on.ledger.getTask(TASK_A)).toBeNull();
  });

  it("N-P14C-5, control: the legacy task door still admits a uuid-only initiative, because this check is the intake's", () => {
    const on = world();
    const legacy = on.ledger.append({
      contractVersion: CONTRACT_VERSION,
      eventId: randomUUID(),
      taskId: TASK_B,
      attempt: 1,
      transitionId: "discovered",
      idempotencyKey: TASK_B + "/1/discovered",
      type: "TASK_DISCOVERED",
      fromState: null,
      toState: "DISCOVERED",
      emittedBy: OPERATOR,
      occurredAt: AT,
      recordedAt: AT,
      correlationId: null,
      causationId: null,
      payload: { initiativeId: "99999999-9999-4999-8999-999999999999" },
    });
    expect(legacy.inserted).toBe(true);
    expect(on.ledger.getTask(TASK_B)).toMatchObject({ stepId: null, role: null, commitPolicy: null });
  });

  it("N-P14C-6: a step travels with a version and a version with a step, and the version is the initiative's", () => {
    const on = world();
    const held = heads(on.ledger);
    expect(intake(on, { roadmapVersionId: null })).toEqual(
      refusal("REQUEST_INVALID", "ROADMAP_LINK_INCOMPLETE", "roadmapVersionId"),
    );
    expect(intake(on, { stepId: null })).toEqual(refusal("REQUEST_INVALID", "ROADMAP_LINK_INCOMPLETE", "stepId"));
    expect(intake(on, { roadmapVersionId: "77777777-7777-4777-8777-777777777777" })).toEqual(
      refusal("REQUEST_INVALID", "ROADMAP_VERSION_UNKNOWN", "roadmapVersionId"),
    );
    expect(intake(on, { roadmapVersionId: OTHER_VERSION_ID })).toEqual(
      refusal("REQUEST_INVALID", "ROADMAP_VERSION_UNKNOWN", "roadmapVersionId"),
    );
    expect(heads(on.ledger)).toEqual(held);
    // And with no link at all, the task enters with a null step: the one case the dictionary allows.
    const outside = entered(intake(on, { roadmapVersionId: null, stepId: null }));
    expect(on.ledger.getTask(outside.task.taskId)?.stepId).toBeNull();
  });

  it("P-27 cut A (decision 193): a step the version does not declare is ROADMAP_STEP_UNKNOWN, a version that declares none refuses every step", () => {
    const on = world();
    const held = heads(on.ledger);
    expect(intake(on, { stepId: "step.nine" })).toEqual(refusal("REQUEST_INVALID", "ROADMAP_STEP_UNKNOWN", "stepId"));
    // A second version of the initiative, declaring no step: zero declares none, and
    // every stepId is unknown there, never undeclared.
    const head = on.ledger.listRoadmapVersions(INITIATIVE).at(-1);
    const empty = recordRoadmapRevision({
      reader: on.ledger,
      writable: on.ledger,
      plane: on.plane,
      initiativeId: INITIATIVE,
      request: {
        content: "# Roadmap, again\n",
        expectedHeadDigest: head?.contentDigest ?? null,
        kind: "EDIT",
        restoresVersionId: null,
        recordedBy: COORDINATOR,
      },
      recordedAt: CREATED_AT,
      roadmapVersionId: randomUUID(),
      eventId: randomUUID(),
      holderPid: null,
      stepIdentities: null,
    });
    if (!empty.ok) throw new Error("the second version was refused: " + empty.reason);
    expect(empty.version.stepCount).toBe(0);
    const zeroHeld = heads(on.ledger);
    for (const stepId of DECLARED_STEPS) {
      expect(intake(on, { roadmapVersionId: empty.version.roadmapVersionId, stepId })).toEqual(
        refusal("REQUEST_INVALID", "ROADMAP_STEP_UNKNOWN", "stepId"),
      );
    }
    expect(heads(on.ledger)).toEqual(zeroHeld);
    expect(held[0]).toBe(zeroHeld[0]);
    // A declared step enters, and its exact replay is still a replay.
    const first = entered(intake(on, { stepId: "step.two" }));
    const again = entered(intake(on, { stepId: "step.two" }));
    expect(again.replayed).toBe(true);
    expect(again.task).toEqual(first.task);
  });

  it("P-27 cut A (decision 193, ND-P27-9): a version of the cohort before steps declares nothing, and says so by its own word, never as an unknown step", () => {
    const on = world();
    const held = heads(on.ledger);
    // A reader standing for a history recorded before P-26 cut B: the same rows, the
    // version's step count read back null. The gateway's suite reaches the same row
    // through a real rewind of the stream; this one isolates the decision.
    const preCohort = new Proxy(on.ledger, {
      get(target, property, receiver) {
        if (property === "listRoadmapVersions") {
          return (initiativeId: string) =>
            target.listRoadmapVersions(initiativeId).map((version) => ({ ...version, recordingContractVersion: "2.9.0", stepCount: null }));
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const undeclared = intakeTask({
      ledger: preCohort,
      plane: on.plane,
      request: fields(),
      recordedAt: AT,
      holderPid: LIVE_PID,
      identities: {
        eventId: randomUUID(),
        revisionId: randomUUID(),
        commandId: randomUUID(),
        artifactPinId: randomUUID(),
        artifactReferenceId: randomUUID(),
        intentionEventId: randomUUID(),
        terminalEventId: randomUUID(),
      },
    });
    expect(undeclared).toEqual(refusal("REQUEST_INVALID", "ROADMAP_STEPS_UNDECLARED", "stepId"));
    // Null and zero side by side: the same stepId on the real version, which declares it, enters.
    expect(heads(on.ledger)).toEqual(held);
    expect(entered(intake(on)).task.taskId).toBe(TASK_A);
  });

  it("N-P14C-10: a role the envelope does not admit is REQUEST_INVALID, before the registry is asked", () => {
    const on = world();
    const held = heads(on.ledger);
    expect(intake(on, { role: "reviewer" })).toEqual(refusal("REQUEST_INVALID", "ROLE_NOT_IN_ENVELOPE", "role"));
    expect(heads(on.ledger)).toEqual(held);
  });

  it("N-P14C-7: a role with no GLOBAL assignment is AUTHORITY_REFUSED, with no default and no policy fallback", () => {
    const on = world();
    const held = heads(on.ledger);
    const reviewing = envelope({ eligibility: { roles: ["reviewer"], providers: null, requiredCapabilities: [] } });
    expect(intake(on, { envelope: reviewing, role: "reviewer" })).toEqual(
      refusal("AUTHORITY_REFUSED", "ASSIGNMENT_ABSENT", "request.role"),
    );
    expect(intake(on, { slot: 3 })).toEqual(refusal("AUTHORITY_REFUSED", "ASSIGNMENT_ABSENT", "request.role"));
    expect(heads(on.ledger)).toEqual(held);

    const source = withoutComments(readFileSync(INTAKE_SOURCE, "utf8"));
    expect(source).not.toMatch(/resolveRoute|loadPolicyRegistry|DEFAULT_ROUTING_CONFIG|\/policy\//);
  });

  it("N-P14C-8: a retired model version is AUTHORITY_REFUSED and carries the proposal to migrate", () => {
    const on = world();
    modelVersion(on.ledger, MODEL_ONE, { status: "RETIRED", deprecatedAt: REGISTRY_AT }, 2);
    const held = heads(on.ledger);
    expect(intake(on)).toEqual(
      refusal("AUTHORITY_REFUSED", "MODEL_VERSION_RETIRED", "reading.modelVersion.status", "MIGRATE_TO_ACTIVE_MODEL_VERSION"),
    );
    expect(heads(on.ledger)).toEqual(held);
  });

  it("refuses a transport the model version does not admit, at the transport", () => {
    const on = world();
    expect(intake(on, { transportKind: "API_KEY" })).toEqual(
      refusal("AUTHORITY_REFUSED", "TRANSPORT_NOT_ADMITTED", "request.transportKind"),
    );
  });

  it("N-P14C-9: records the vector it read, not the registry the append found", () => {
    const on = world();
    const read = on.ledger.getGlobalRoutingAssignment({ role: "implementer", slot: 0 });
    const outcome = entered(
      intake(on, {}, {
        faults: {
          // The registry advances between the decision and the append.
          afterEnvelopePublished: () => {
            modelVersion(on.ledger, MODEL_TWO, { model: "claude-sonnet-5" });
          },
        },
      }),
    );
    const now = on.ledger.getGlobalRoutingAssignment({ role: "implementer", slot: 0 });
    expect(now.watermarks).not.toEqual(read.watermarks);
    expect(outcome.task.resolution.watermarks).toEqual(read.watermarks);

    const payload = on.ledger.getEventBySequence(outcome.sequence)?.event.payload;
    expect((payload?.["resolution"] as Record<string, unknown>)["watermarks"]).toEqual(read.watermarks);
    on.ledger.rebuildReadModel();
    expect(on.ledger.verifyIntegrity().problems).toEqual([]);
    expect(entered(intake(on, {}, { at: LATER })).task.resolution.watermarks).toEqual(read.watermarks);
  });

  it("N-P14C-24: no refusal appends to any stream, the registry's artifact plane included", () => {
    const on = world();
    const held = heads(on.ledger);
    for (const overrides of [
      { recordedBy: "nobody" },
      { roadmapVersionId: null },
      { role: "reviewer" },
      { slot: 9 },
      { envelope: envelope({ initiativeId: "99999999-9999-4999-8999-999999999999" }) },
    ] as Partial<TaskIntakeFields>[]) {
      expect(intake(on, overrides).ok, JSON.stringify(Object.keys(overrides))).toBe(false);
    }
    expect(heads(on.ledger)).toEqual(held);
    expect(on.ledger.status().eventCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Entering is not acquiring
// ---------------------------------------------------------------------------

describe("entering is not acquiring (E8)", () => {
  it("N-P14C-11: two tasks with overlapping write-sets and conflict keys both enter, and no lease is taken", () => {
    const on = world();
    entered(intake(on));
    entered(
      intake(on, {
        envelope: envelope({ taskId: TASK_B, title: "The same files, another task" }),
        clientRequestKey: "intake-0002",
      }),
    );
    expect(on.ledger.getTask(TASK_A)?.currentState).toBe("DISCOVERED");
    expect(on.ledger.getTask(TASK_B)?.currentState).toBe("DISCOVERED");
    // The only coordination file beside the ledger is the blob lease store the
    // plane holds its publications under; no worktree lease store exists.
    const files = readdirSync(dirname(on.ledgerPath)).filter((name) => name.endsWith(".sqlite"));
    expect(files.sort()).toEqual(["artifact-blob-leases.sqlite", "control-plane.sqlite"]);

    // Read over the concept — the module and its type leaf — not over one file:
    // the isolation law is a fact about the concept, not about one of its files
    // (owner law §7.1 and §7.2; C-3 / P-37 seam 1, adjudication v2). The type
    // separation moved declarations *within* the concept, so a pin that reads only
    // `index.ts` measures the wrong container. Module first, then leaf.
    const source =
      withoutComments(readFileSync(INTAKE_SOURCE, "utf8")) +
      "\n" +
      withoutComments(readFileSync(INTAKE_TYPE_LEAF, "utf8"));
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)].map((match) => match[1]);
    // The allowlist this law always carried, plus the sibling leaf — the one
    // addition a type seam can make. Nothing foreign is newly permitted.
    expect(imports).toEqual([
      "node:crypto",
      "@acp/accounts",
      "@acp/accounts",
      "@acp/contracts",
      "@acp/contracts",
      "@acp/ledger",
      "@acp/ledger",
      // the module's type-only import of its own leaf; this law's regex is anchored
      // at `^import`, so the matching `export type { … } from` re-export is not a
      // second entry here
      "./types/index.js",
      // and the leaf's own four, which are the same four packages plus this concept
      "@acp/accounts",
      "@acp/contracts",
      "@acp/ledger",
      "../index.js",
    ]);
    expect(source).not.toMatch(/conflict-graph|lease-store\/|openLeaseStore|scheduler|buildConflictGraph|acquireLease/);
  });
});

// ---------------------------------------------------------------------------
// The crash, the race and the restart
// ---------------------------------------------------------------------------

describe("a crash between the steps is completed by a retry, and a race is decided again", () => {
  it("N-P14C-13: published and not appended — a retry with fresh ids appends, with no second publication", () => {
    const ledgerPath = temporaryLedgerPath();
    const dying = world(ledgerPath);
    expect(() =>
      intake(dying, {}, {
        pid: DEAD_PID,
        faults: {
          afterEnvelopePublished: () => {
            throw new Error("the process died after the publication");
          },
        },
      }),
    ).toThrow("died after the publication");
    const published = dying.ledger.listArtifactEvents(sha256(envelopeBytes()));
    expect(published.map((record) => record.event.artifactEventKind)).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_SUCCEEDED"]);
    // The gap, named: a reference that names no task yet.
    expect(dying.ledger.getTask(TASK_A)).toBeNull();
    dying.die();

    const restarted = substrates(ledgerPath);
    const outcome = entered(intake(restarted, {}, { at: LATER }));
    expect(outcome.replayed).toBe(false);
    const events = restarted.ledger.listArtifactEvents(sha256(envelopeBytes()));
    expect(events.map((record) => record.eventId)).toEqual(published.map((record) => record.eventId));
    const keys = taskEnvelopeIdempotencyKeys(TASK_A, envelopeSha256(envelope()));
    expect(events.map((record) => record.idempotencyKey)).toEqual([keys.intended, keys.succeeded]);
    const intended = published[0]?.event;
    const reference =
      intended?.artifactEventKind === "PUBLICATION_INTENDED" ? intended.payload.intendedReference?.artifactReferenceId : undefined;
    expect(outcome.task.envelopeArtifactReferenceId).toBe(reference);
  });

  it("N-P14C-13: a publication that ended abandoned is refused by name, and the task does not enter", () => {
    const ledgerPath = temporaryLedgerPath();
    const dying = world(ledgerPath, {
      afterIntentionRecorded: () => {
        throw new Error("the process died holding the blob");
      },
    });
    expect(() => intake(dying, {}, { pid: DEAD_PID })).toThrow("died holding the blob");
    dying.die();

    const reconciling = substrates(ledgerPath);
    const reconciled = reconciling.plane.reconcile({
      contentSha256: sha256(envelopeBytes()),
      holding: { holder: COORDINATOR, holderPid: LIVE_PID, acquiredAt: LATER, expiresAt: LATER },
      quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID },
      terminal: { eventId: randomUUID(), idempotencyKey: "reconciliation/" + randomUUID(), occurredAt: LATER, recordedAt: LATER },
      recordedBy: COORDINATOR,
    });
    expect(reconciled.verb).toBe("ABANDONED");
    expect(intake(reconciling, {}, { at: LATER })).toEqual(
      refusal("CONTENT_REJECTED", "PUBLICATION_ALREADY_ABANDONED", "envelope"),
    );
    expect(reconciling.ledger.getTask(TASK_A)).toBeNull();
  });

  it("an append that loses the race re-reads the key and answers the winner — replay or conflict", () => {
    const same = world();
    const replay = entered(
      intake(same, {}, {
        faults: {
          afterEnvelopePublished: () => {
            entered(intake(same));
          },
        },
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(same.ledger.status().eventCount).toBe(1);

    const other = world();
    expect(
      intake(other, {}, {
        faults: {
          afterEnvelopePublished: () => {
            entered(intake(other, { envelope: envelope({ title: "The winner's title" }) }));
          },
        },
      }),
    ).toEqual(refusal("CONFLICT", "CLIENT_KEY_CONFLICT", "envelope"));
    expect(other.ledger.status().eventCount).toBe(1);
  });

  it("M-9: a winner that entered another task under the same key reaches the loser as the ledger's named refusal, decided as CONFLICT", () => {
    const on = world();
    expect(
      intake(on, {}, {
        faults: {
          afterEnvelopePublished: () => {
            entered(intake(on, { envelope: envelope({ taskId: TASK_B }) }));
          },
        },
      }),
    ).toEqual(refusal("CONFLICT", "CLIENT_KEY_CONFLICT", "envelope"));
    expect(on.ledger.status().eventCount).toBe(1);
    expect(on.ledger.getTask(TASK_A)).toBeNull();
    expect(on.ledger.getTaskSubmission(OPERATOR, "intake-0001")?.taskId).toBe(TASK_B);
    expect(on.ledger.verifyIntegrity().problems).toEqual([]);
  });

  it("N-P14C-12: a restart keeps the task, its revision and its key, and a rebuild reproduces them", () => {
    const ledgerPath = temporaryLedgerPath();
    const first = world(ledgerPath);
    const outcome = entered(intake(first));
    const submission = first.ledger.getTaskSubmission(OPERATOR, "intake-0001");
    const task = first.ledger.getTask(TASK_A);
    first.die();

    const reopened = substrates(ledgerPath);
    expect(reopened.ledger.getTaskSubmission(OPERATOR, "intake-0001")).toEqual(submission);
    expect(reopened.ledger.getTask(TASK_A)).toEqual(task);
    reopened.ledger.rebuildReadModel();
    expect(reopened.ledger.getTaskSubmission(OPERATOR, "intake-0001")).toEqual(submission);
    expect(reopened.ledger.getTask(TASK_A)).toEqual(task);
    expect(reopened.ledger.verifyIntegrity().problems).toEqual([]);
    expect(entered(intake(reopened, {}, { at: LATER }))).toEqual({ ...outcome, replayed: true });
    // The envelope is read under its own task's scope, and under no other.
    expect(
      reopened.plane.read({ artifactReferenceId: outcome.task.envelopeArtifactReferenceId, scopeKind: "TASK", scopeId: TASK_B }),
    ).toEqual({ verb: "REFUSE", refusal: "REFERENCE_NOT_READABLE" });
  });

  it("N-P14C-16: the stream and the answer carry the digest and the reference, never the envelope", () => {
    const on = world();
    const outcome = entered(intake(on));
    const record = on.ledger.getEventBySequence(outcome.sequence);
    const json = record?.canonicalJson ?? "";
    expect(json).not.toContain(OBJECTIVE);
    for (const key of ['"objective"', '"authority"', '"writeSet"', '"readSet"', '"envelope"']) {
      expect(json, key).not.toContain(key);
    }
    expect(JSON.stringify(outcome)).not.toContain(OBJECTIVE);
  });
});

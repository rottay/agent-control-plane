import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS, buildInitiativeIdempotencyKey } from "@acp/contracts";
import type { ResolvedRoute } from "@acp/contracts";
import {
  LedgerValidationError,
  artifactBlobLeaseStorePath,
  canonicalJsonStringify,
  envelopeSha256,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
} from "@acp/ledger";
import type { ArtifactPlane, Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { INTAKE_ATTEMPT_OPENING_STEP, buildEvent } from "../../src/core/events/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN, planStep } from "../../src/core/lifecycle/index.js";
import { appendPlanStep, assertInvocationContinuity, nextStep } from "../../src/core/step-executor/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import { SupervisorError } from "../../src/errors/index.js";
import { intakeTask } from "../../src/intake/index.js";
import { restateInvocation } from "../../src/lifecycle-operation/index.js";
import { RECORDED_TASK_REFUSALS, readRecordedTask } from "../../src/recorded-task/index.js";
import type { RecordedTaskLedgerPort, RecordedTaskOutcome, RecordedTaskPlanePort } from "../../src/recorded-task/index.js";
import { canonicalSubmissionDigest, deriveInvocation } from "../../src/submission/index.js";

/**
 * Evidence for the recorded-task reader and the intake → opening → discovery
 * continuity (P-15 escalón D1, ADR 0105; adjudication v2 C2).
 *
 * The task is entered through the real intake — a real ledger, blob lease store and
 * private plane, the registry seeded through its doors — so what the reader reads
 * is what a door wrote. Then the walk opens the intake's coordinate out of
 * `DISCOVERED`, at the intake's flat attempt, and discovers under the submission the
 * reader derived; recovery restates the same invocation. The negatives drive the
 * reader through doctored ports, one field at a time.
 */

const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const OTHER_INITIATIVE = "55555555-5555-4555-8555-555555555555";
const TASK = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const CREATED_AT = "2026-09-01T00:00:00.000Z";
const REGISTRY_AT = "2026-09-03T12:00:00.000Z";
const AT = "2026-09-13T12:00:00.000Z";
const COORDINATOR = "kimi/k3/coordinator/01";
const OPERATOR = "claude/opus/implementer/01";
const MODEL = "claude-opus-5@2026-06-01";
const OBJECTIVE = "Enter one task, then open its attempt and discover it under one submission.";

const ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "claude-opus-5",
  accountId: "acct-recorded",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-1",
  resolvedAt: AT,
};

const temporaryDirectories: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      /* closed by the test */
    }
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface World {
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
}

function world(): World {
  const directory = mkdtempSync(join(tmpdir(), "acp-recorded-task-"));
  temporaryDirectories.push(directory);
  const ledgerPath = join(directory, "control-plane.sqlite");
  const ledger = openLedger(ledgerPath);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledgerPath), {
    incarnationId: "11111111-1111-4111-8111-111111111111",
    createdAt: CREATED_AT,
  });
  const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath });
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
      occurredAt: CREATED_AT,
      recordedAt: CREATED_AT,
      payload: {},
    });
  }
  const document = (documentKind: string, documentId: string, payload: Record<string, unknown>): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    idempotencyKey: documentId + "/1",
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    contentDigest: sha256(canonicalJsonStringify(payload)),
    recordedBy: COORDINATOR,
    effectiveFrom: REGISTRY_AT,
    occurredAt: REGISTRY_AT,
    recordedAt: REGISTRY_AT,
    payload,
  });
  ledger.appendRegistryEvent(
    document("MODEL_VERSION", MODEL, {
      provider: "claude",
      model: "claude-opus-5",
      release: "2026-06-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["implementer"],
      transports: ["CLI_SUBSCRIPTION"],
    }),
  );
  ledger.appendRegistryEvent(
    document("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", {
      role: "implementer",
      slot: 0,
      provider: "claude",
      modelVersionId: MODEL,
      fallbacks: [],
    }),
  );
  return { ledger, plane };
}

function envelope(): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: TASK,
    initiativeId: INITIATIVE,
    title: "Enter a task",
    content: {
      contentContractVersion: 1,
      blocks: [
        {
          kind: "text",
          blockId: "b1",
          mediaType: "text/plain; charset=utf-8",
          byteLength: new TextEncoder().encode(OBJECTIVE).byteLength,
          contentSha256: "0".repeat(64),
          artifactRefId: null,
          text: OBJECTIVE,
          toolCallId: null,
          effectId: null,
        },
      ],
    },
    classification: "MECHANICAL",
    issuedBy: COORDINATOR,
    issuedAt: CREATED_AT,
    authority: [],
    readSet: ["docs/recorded.md"],
    writeSet: ["docs/recorded.md"],
    conflictKeys: ["docs"],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "" },
    validation: { commands: [], independentVerifierRequired: false },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 100 },
    visualEvidenceRequired: false,
    commitPolicy: "NO_COMMIT",
    checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 1 },
  };
}

/** A world with one task entered through the real intake. */
function intaken(): World {
  const on = world();
  const outcome = intakeTask({
    ledger: on.ledger,
    plane: on.plane,
    request: {
      envelope: envelope(),
      clientScope: OPERATOR,
      clientRequestKey: "recorded-0001",
      roadmapVersionId: null,
      stepId: null,
      role: "implementer",
      slot: 0,
      transportKind: "CLI_SUBSCRIPTION",
      recordedBy: OPERATOR,
    },
    recordedAt: AT,
    holderPid: 5151,
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
  if (!outcome.ok) throw new Error("expected an intake, got " + outcome.reason + " " + outcome.code);
  return on;
}

function read(on: World, route: ResolvedRoute = ROUTE): RecordedTaskOutcome {
  return readRecordedTask({ ledger: on.ledger, plane: on.plane, taskId: TASK, route });
}

function recorded(outcome: RecordedTaskOutcome): RecordedTaskOutcome & { ok: true } {
  if (!outcome.ok) throw new Error("expected a recorded task, got " + outcome.refusal + " at " + outcome.at);
  return outcome;
}

function walkContext(on: World, outcome: RecordedTaskOutcome & { ok: true }): BeatContext {
  return {
    ledger: on.ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE" as const) },
    invocation: outcome.task.invocation,
    emittedBy: OPERATOR,
    plan: LIFECYCLE_PLAN,
    route: ROUTE,
    initiativeId: outcome.task.initiativeId,
  };
}

function head(ledger: Ledger): readonly [number, string] {
  const status = ledger.status();
  return [status.headSequence, status.headEventSha256];
}

describe("a recorded task is read back whole (P-15/D1)", () => {
  it("reads the intake, the envelope by reference, the revision and the submission, minting nothing", () => {
    const on = intaken();
    const before = head(on.ledger);
    const outcome = recorded(read(on));
    const revision = on.ledger.getTaskRevision(TASK, 1);
    expect(outcome.task.revision).toEqual({
      revisionId: revision?.revisionId,
      revisionNumber: 1,
      attemptNumber: 1,
      envelopeSha256: revision?.envelopeSha256,
      envelopeArtifactReferenceId: revision?.envelopeArtifactReferenceId,
    });
    expect(outcome.task.envelope).toEqual(envelope());
    expect(envelopeSha256(outcome.task.envelope)).toBe(outcome.task.revision.envelopeSha256);
    expect(outcome.task.attempt).toBe(1);
    expect(outcome.task.submittedAt).toBe(AT);
    expect(outcome.task.initiativeId).toBe(INITIATIVE);
    expect(outcome.task.role).toBe("implementer");
    expect(outcome.task.resolution).toMatchObject({ modelVersionId: MODEL, provider: "claude", transportKind: "CLI_SUBSCRIPTION" });
    const digest = canonicalSubmissionDigest({ taskId: TASK, attempt: 1, submittedAt: AT, initiativeId: INITIATIVE, route: ROUTE });
    expect(outcome.task.submissionDigest).toBe(digest);
    expect(outcome.task.invocation).toEqual(deriveInvocation(TASK, 1, AT, digest, outcome.task.revision));
    // Read-only by shape: nothing moved.
    expect(head(on.ledger)).toEqual(before);
  });

  it("closes its vocabulary, sorted", () => {
    expect([...RECORDED_TASK_REFUSALS]).toEqual([...RECORDED_TASK_REFUSALS].sort());
  });

  it("closes its vocabulary at seven words, the two version words among them (P-16/A1)", () => {
    expect([...RECORDED_TASK_REFUSALS]).toEqual([
      "ENVELOPE_DIGEST_MISMATCH",
      "ENVELOPE_UNREADABLE",
      "ENVELOPE_VERSION_MISMATCH",
      "ENVELOPE_VERSION_SUPERSEDED",
      "INTAKE_UNREADABLE",
      "ROUTE_DISAGREES_WITH_INTAKE",
      "TASK_UNKNOWN",
    ]);
  });
});

describe("intake → opening → discovery is one attempt (C2; ADR 0080 §4/§5 as amended)", () => {
  it("opens the intake's coordinate out of DISCOVERED at its flat attempt, discovers, and recovery restates the same invocation", () => {
    const on = intaken();
    const outcome = recorded(read(on));
    const context = walkContext(on, outcome);

    assertInvocationContinuity(context);
    expect(nextStep(context, "DISCOVERED")).toBe(INTAKE_ATTEMPT_OPENING_STEP);
    const opening = appendPlanStep(context, INTAKE_ATTEMPT_OPENING_STEP);
    expect(opening.inserted).toBe(true);
    expect(opening.event).toMatchObject({ type: "TASK_ATTEMPT_OPENED", fromState: "DISCOVERED", toState: "DISCOVERED", attempt: 1 });
    expect(opening.event?.payload).toMatchObject({ revisionNumber: 1, attemptNumber: 1, legacyAttemptNumber: 1 });

    assertInvocationContinuity(context);
    expect(nextStep(context, "DISCOVERED")).toBe(planStep(0));
    for (let index = 0; index <= INTENT_STEP.index; index += 1) {
      assertInvocationContinuity(context);
      expect(appendPlanStep(context, planStep(index)).inserted).toBe(true);
    }

    // One attempt row, at the intake's flat attempt, bound to this invocation.
    expect(on.ledger.getTask(TASK)?.latestAttempt).toBe(1);
    expect(on.ledger.verifyIntegrity().problems).toEqual([]);

    const restated = restateInvocation(on.ledger, TASK, 1);
    expect(restated).toMatchObject({ ok: true });
    if (restated.ok) {
      expect(restated.context.invocation).toEqual(outcome.task.invocation);
      expect(restated.context.initiativeId).toBe(INITIATIVE);
      expect(restated.context.route).toEqual(ROUTE);
    }

    // A replay of the opening is the same row: the continuity rebuilds it byte for byte.
    expect(appendPlanStep(context, INTAKE_ATTEMPT_OPENING_STEP).inserted).toBe(false);
  });

  it("N-D8: an opening proposed at flat 2 on the intake's coordinate is refused by the producer and by the door, with zero delta", () => {
    const on = intaken();
    const outcome = recorded(read(on));
    const context = walkContext(on, outcome);
    const second = { ...context, invocation: deriveInvocation(TASK, 2, AT, outcome.task.submissionDigest, outcome.task.revision) };
    const before = head(on.ledger);
    expect(() => appendPlanStep(second, INTAKE_ATTEMPT_OPENING_STEP)).toThrow(SupervisorError);
    const event = buildEvent({
      invocation: second.invocation,
      step: INTAKE_ATTEMPT_OPENING_STEP,
      emittedBy: OPERATOR,
      initiativeId: INITIATIVE,
      plan: LIFECYCLE_PLAN,
      route: ROUTE,
    });
    let refused: unknown;
    try {
      on.ledger.append(event);
    } catch (error: unknown) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(LedgerValidationError);
    expect(String(refused)).toContain("which its own earlier events already carry");
    expect(head(on.ledger)).toEqual(before);
  });

  it("N-D9: a restart under another route derives another submission, and continuity refuses it, with zero delta", () => {
    const on = intaken();
    const context = walkContext(on, recorded(read(on)));
    appendPlanStep(context, INTAKE_ATTEMPT_OPENING_STEP);
    appendPlanStep(context, planStep(0));
    const before = head(on.ledger);
    const otherAccount = recorded(read(on, { ...ROUTE, accountId: "acct-other" }));
    expect(otherAccount.task.submissionDigest).not.toBe(context.invocation.submissionDigest);
    expect(() => {
      assertInvocationContinuity({ ...context, invocation: otherAccount.task.invocation });
    }).toThrow(SupervisorError);
    expect(head(on.ledger)).toEqual(before);
  });

  it("refuses to resume under an intake that records another request, for each fact the two share", () => {
    const on = intaken();
    const outcome = recorded(read(on));
    const context = walkContext(on, outcome);
    const { revision } = outcome.task;
    const variants: readonly (readonly [string, BeatContext])[] = [
      ["submittedAt", { ...context, invocation: deriveInvocation(TASK, 1, "2026-09-13T12:00:01.000Z", outcome.task.submissionDigest, revision) }],
      ["initiativeId", { ...context, initiativeId: OTHER_INITIATIVE }],
      ["revisionId", { ...context, invocation: deriveInvocation(TASK, 1, AT, outcome.task.submissionDigest, { ...revision, revisionId: randomUUID() }) }],
      ["envelopeSha256", { ...context, invocation: deriveInvocation(TASK, 1, AT, outcome.task.submissionDigest, { ...revision, envelopeSha256: "e".repeat(64) }) }],
      [
        "envelopeArtifactReferenceId",
        { ...context, invocation: deriveInvocation(TASK, 1, AT, outcome.task.submissionDigest, { ...revision, envelopeArtifactReferenceId: randomUUID() }) },
      ],
    ];
    for (const [fact, variant] of variants) {
      expect(() => {
        assertInvocationContinuity(variant);
      }, fact).toThrow(SupervisorError);
    }
    assertInvocationContinuity(context);
  });
});

describe("the reader refuses by name, and never reads a wrong task as a right one", () => {
  /** The real ledger, with the first event's JSON replaced. */
  function doctored(on: World, change: (event: Record<string, unknown>) => Record<string, unknown>): RecordedTaskLedgerPort {
    return {
      getTask: (taskId) => on.ledger.getTask(taskId),
      getEventBySequence: (sequence) => {
        const found = on.ledger.getEventBySequence(sequence);
        if (found === null) return null;
        return { canonicalJson: JSON.stringify(change(JSON.parse(found.canonicalJson) as Record<string, unknown>)) };
      },
    };
  }

  function withPayload(change: (payload: Record<string, unknown>) => void): (event: Record<string, unknown>) => Record<string, unknown> {
    return (event) => {
      const payload = { ...(event["payload"] as Record<string, unknown>) };
      change(payload);
      return { ...event, payload };
    };
  }

  it("N-D3: a task the ledger does not hold is TASK_UNKNOWN", () => {
    const on = intaken();
    expect(readRecordedTask({ ledger: on.ledger, plane: on.plane, taskId: randomUUID(), route: ROUTE })).toEqual({
      ok: false,
      refusal: "TASK_UNKNOWN",
      at: "task",
      word: null,
    });
  });

  it("N-D4: a first event that is not an intake is INTAKE_UNREADABLE", () => {
    const on = intaken();
    for (const change of [
      (event: Record<string, unknown>) => ({ ...event, transitionId: "discovered" }),
      (event: Record<string, unknown>) => ({ ...event, type: "TASK_ATTEMPT_OPENED" }),
      (event: Record<string, unknown>) => ({ ...event, fromState: "DISCOVERED" }),
    ]) {
      const outcome = readRecordedTask({ ledger: doctored(on, change), plane: on.plane, taskId: TASK, route: ROUTE });
      expect(outcome).toMatchObject({ ok: false, refusal: "INTAKE_UNREADABLE" });
    }
  });

  it("an intake instant outside the canonical form is INTAKE_UNREADABLE, never carried into the submission", () => {
    const on = intaken();
    for (const occurredAt of ["2026-09-13T14:00:00.000+02:00", "2026-09-13T12:00:00Z"]) {
      const ledger = doctored(on, (event) => ({ ...event, occurredAt, recordedAt: occurredAt }));
      expect({ occurredAt, outcome: readRecordedTask({ ledger, plane: on.plane, taskId: TASK, route: ROUTE }) }).toEqual({
        occurredAt,
        outcome: { ok: false, refusal: "INTAKE_UNREADABLE", at: "intake.occurredAt", word: null },
      });
    }
  });

  it("N-D18: each revision field absent, null, empty or of the wrong type is INTAKE_UNREADABLE naming it", () => {
    const on = intaken();
    const variants: readonly (readonly [string, unknown])[] = [
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
      ["number", 7],
    ];
    for (const field of ["revisionId", "envelopeSha256", "envelopeArtifactReferenceId"]) {
      for (const [name, value] of variants) {
        const ledger = doctored(
          on,
          withPayload((payload) => {
            if (value === undefined) Reflect.deleteProperty(payload, field);
            else payload[field] = value;
          }),
        );
        expect({ field, name, outcome: readRecordedTask({ ledger, plane: on.plane, taskId: TASK, route: ROUTE }) }).toEqual({
          field,
          name,
          outcome: { ok: false, refusal: "INTAKE_UNREADABLE", at: "intake.payload." + field, word: null },
        });
      }
    }
    const shortDigest = doctored(on, withPayload((payload) => (payload["envelopeSha256"] = "e".repeat(63))));
    expect(readRecordedTask({ ledger: shortDigest, plane: on.plane, taskId: TASK, route: ROUTE })).toMatchObject({
      refusal: "INTAKE_UNREADABLE",
      at: "intake.payload.envelopeSha256",
    });
  });

  it("N-D5: altered bytes, a reference the plane refuses, and bytes that are no envelope are refused, the plane's word carried", () => {
    const on = intaken();
    const bytes = (content: string): RecordedTaskPlanePort => ({
      read: (request) => {
        const real = on.plane.read(request);
        return real.verb === "READ" ? { ...real, content: Buffer.from(content, "utf8") } : real;
      },
    });
    const altered = canonicalJsonStringify({ ...envelope(), title: "Another task" });
    expect(readRecordedTask({ ledger: on.ledger, plane: bytes(altered), taskId: TASK, route: ROUTE })).toEqual({
      ok: false,
      refusal: "ENVELOPE_DIGEST_MISMATCH",
      at: "envelope",
      word: null,
    });
    expect(readRecordedTask({ ledger: on.ledger, plane: bytes("{ not json"), taskId: TASK, route: ROUTE })).toMatchObject({
      refusal: "ENVELOPE_UNREADABLE",
      at: "envelope",
    });
    expect(readRecordedTask({ ledger: on.ledger, plane: bytes("{}"), taskId: TASK, route: ROUTE })).toMatchObject({
      refusal: "ENVELOPE_UNREADABLE",
      at: "envelope",
    });
    const missing = doctored(on, withPayload((payload) => (payload["envelopeArtifactReferenceId"] = randomUUID())));
    const refused = readRecordedTask({ ledger: missing, plane: on.plane, taskId: TASK, route: ROUTE });
    expect(refused).toMatchObject({ ok: false, refusal: "ENVELOPE_UNREADABLE", at: "intake.payload.envelopeArtifactReferenceId" });
    expect(refused.ok ? null : refused.word).not.toBeNull();
  });

  it("N-D6: a route that disagrees with the intake's resolution, field by field, is ROUTE_DISAGREES_WITH_INTAKE", () => {
    const on = intaken();
    for (const [field, value] of [
      ["provider", "codex"],
      ["model", "claude-sonnet-5"],
      ["transportKind", "API_KEY"],
    ] as const) {
      expect(read(on, { ...ROUTE, [field]: value } as ResolvedRoute)).toEqual({
        ok: false,
        refusal: "ROUTE_DISAGREES_WITH_INTAKE",
        at: "route." + field,
        word: null,
      });
    }
    // The account is the caller's election: the intake records none.
    expect(read(on, { ...ROUTE, accountId: "acct-any" }).ok).toBe(true);
  });
});

describe("a stored envelope's version is read before its shape (P-16/A1, ADR 0120; D-B-1)", () => {
  /** The real ledger, with the intake event's `contractVersion` replaced. */
  function eventAt(on: World, contractVersion: string): RecordedTaskLedgerPort {
    return {
      getTask: (taskId) => on.ledger.getTask(taskId),
      getEventBySequence: (sequence) => {
        const found = on.ledger.getEventBySequence(sequence);
        if (found === null) return null;
        return { canonicalJson: JSON.stringify({ ...(JSON.parse(found.canonicalJson) as Record<string, unknown>), contractVersion }) };
      },
    };
  }

  /** The real plane, answering the given bytes for the reference the intake recorded. */
  function bytes(on: World, content: string): RecordedTaskPlanePort {
    return {
      read: (request) => {
        const real = on.plane.read(request);
        return real.verb === "READ" ? { ...real, content: Buffer.from(content, "utf8") } : real;
      },
    };
  }

  /** What a build of `version` stored: its version stamp, and the `objective` it still carried. */
  function storedUnder(version: string): string {
    const text = ((envelope()["content"] as Record<string, unknown>)["blocks"] as Record<string, unknown>[])[0]!["text"];
    return canonicalJsonStringify({ ...envelope(), contractVersion: version, objective: text });
  }

  const superseded = SUPPORTED_CONTRACT_VERSIONS.filter((version) => version !== CONTRACT_VERSION);

  it("P2: a task intaken under the version in force reads back ok, and the stored stamp is that version", () => {
    const on = intaken();
    expect(CONTRACT_VERSION).toBe("2.11.0");
    const outcome = recorded(read(on));
    expect(outcome.task.envelope.contractVersion).toBe(CONTRACT_VERSION);
  });

  it("N3: a task recorded under a supported, superseded version is ENVELOPE_VERSION_SUPERSEDED, for every such member", () => {
    const on = intaken();
    const before = head(on.ledger);
    expect(superseded).toHaveLength(SUPPORTED_CONTRACT_VERSIONS.length - 1);
    expect(superseded).toContain("2.10.0");
    expect(superseded).toContain("2.2.0");
    for (const version of superseded) {
      const outcome = readRecordedTask({ ledger: eventAt(on, version), plane: bytes(on, storedUnder(version)), taskId: TASK, route: ROUTE });
      expect({ version, outcome }).toEqual({
        version,
        outcome: { ok: false, refusal: "ENVELOPE_VERSION_SUPERSEDED", at: "envelope.contractVersion", word: null },
      });
    }
    expect(head(on.ledger)).toEqual(before);
  });

  it("N4: an envelope whose version is not its intake event's is ENVELOPE_VERSION_MISMATCH, in both directions, before SUPERSEDED", () => {
    const on = intaken();
    const before = head(on.ledger);
    // Envelope 2.10.0 under a 2.11.0 event.
    expect(readRecordedTask({ ledger: on.ledger, plane: bytes(on, storedUnder("2.10.0")), taskId: TASK, route: ROUTE })).toEqual({
      ok: false,
      refusal: "ENVELOPE_VERSION_MISMATCH",
      at: "envelope.contractVersion",
      word: null,
    });
    // Envelope 2.11.0 under a 2.10.0 event: never named SUPERSEDED.
    expect(readRecordedTask({ ledger: eventAt(on, "2.10.0"), plane: on.plane, taskId: TASK, route: ROUTE })).toEqual({
      ok: false,
      refusal: "ENVELOPE_VERSION_MISMATCH",
      at: "envelope.contractVersion",
      word: null,
    });
    expect(head(on.ledger)).toEqual(before);
  });

  it("N5: a version absent, null, empty, of the wrong type, malformed or never supported is ENVELOPE_UNREADABLE at the envelope, never SUPERSEDED", () => {
    const on = intaken();
    const before = head(on.ledger);
    const variants: readonly (readonly [string, unknown])[] = [
      ["absent", undefined],
      ["null", null],
      ["empty", ""],
      ["number", 2.1],
      ["short", "2.10"],
      ["padded", " 2.10.0"],
      ["future", "9.9.9"],
      ["never supported", "2.1.0"],
    ];
    for (const [name, value] of variants) {
      const stored = { ...envelope(), objective: "stale" } as Record<string, unknown>;
      if (value === undefined) Reflect.deleteProperty(stored, "contractVersion");
      else stored["contractVersion"] = value;
      for (const ledger of [on.ledger, eventAt(on, "2.10.0")]) {
        const outcome = readRecordedTask({ ledger, plane: bytes(on, canonicalJsonStringify(stored)), taskId: TASK, route: ROUTE });
        expect({ name, outcome }).toEqual({
          name,
          outcome: { ok: false, refusal: "ENVELOPE_UNREADABLE", at: "envelope", word: null },
        });
      }
    }
    for (const content of ["[]", "null", '"2.10.0"', "7"]) {
      expect(readRecordedTask({ ledger: on.ledger, plane: bytes(on, content), taskId: TASK, route: ROUTE }), content).toEqual({
        ok: false,
        refusal: "ENVELOPE_UNREADABLE",
        at: "envelope",
        word: null,
      });
    }
    expect(head(on.ledger)).toEqual(before);
  });

  it("N6: past the version, the shape and the digest still refuse as before", () => {
    const on = intaken();
    const current = (change: Record<string, unknown>): string => canonicalJsonStringify({ ...envelope(), ...change });
    for (const change of [{ taskId: "not-a-uuid" }, { objective: OBJECTIVE }, { title: "" }]) {
      expect(readRecordedTask({ ledger: on.ledger, plane: bytes(on, current(change)), taskId: TASK, route: ROUTE })).toEqual({
        ok: false,
        refusal: "ENVELOPE_UNREADABLE",
        at: "envelope",
        word: null,
      });
    }
    expect(readRecordedTask({ ledger: on.ledger, plane: bytes(on, current({ title: "Another task" })), taskId: TASK, route: ROUTE })).toEqual({
      ok: false,
      refusal: "ENVELOPE_DIGEST_MISMATCH",
      at: "envelope",
      word: null,
    });
  });
});

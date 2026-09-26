import { createHash } from "node:crypto";

import { resolveAssignment } from "@acp/accounts";
import type { AssignmentProposal, AssignmentReading, AssignmentRefusal } from "@acp/accounts";
import {
  CONTRACT_VERSION,
  TRANSPORT_KINDS,
  TaskEnvelope,
  WORKER_ROLES,
  WorkerIdentityString,
  buildV2IdempotencyKey,
} from "@acp/contracts";
import type { TransportKind, WorkerRole } from "@acp/contracts";
import {
  ARTIFACT_ACCESS_POLICY_IDS,
  LedgerCanonicalizationError,
  LedgerError,
  LedgerIntegrityError,
  TASK_CLIENT_KEY_PATTERN,
  TASK_INTAKE_TRANSITION_ID,
  canonicalJsonStringify,
  envelopeSha256,
  taskIntakePayloadOf,
} from "@acp/ledger";
import type {
  ArtifactEventIdentity,
  ArtifactEventRecord,
  ArtifactPublicationRequest,
  GlobalRoutingAssignmentReading,
  Ledger,
  TaskIntakeResolution,
} from "@acp/ledger";

import type {
  ParsedTaskIntake,
  RecordedTaskIntake,
  TaskIntakeCode,
  TaskIntakeFields,
  TaskIntakeInput,
  TaskIntakeOutcome,
  TaskIntakeRefusal,
  TaskIntakeRefused,
  TaskIntakeWriteRefusal,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf,
 * `./types/index.ts`, and are re-exported here unchanged so every importer
 * keeps reading them from this module (owner law §7, ADR 0088 errata,
 * decision 90; `outbox-store`'s and `projection`'s precedent).
 */
export type {
  TaskIntakeRefusal,
  TaskIntakeWriteRefusal,
  TaskIntakeCode,
  TaskIntakeFields,
  ParsedTaskIntake,
  TaskIntakeRefused,
  RecordedTaskIntake,
  TaskIntakeIdentities,
  TaskIntakeTestFaults,
  TaskIntakeInput,
  IntakeTask,
  TaskIntakeOutcome,
} from "./types/index.js";

/**
 * The task intake — P-14 escalón C, ADR 0087.
 *
 * ## What this is
 *
 * The one orchestration both doors call to enter a task: the gateway's
 * `POST tasks` and the CLI's `acp intake`. It decides, publishes the envelope to
 * the private plane, and appends one `TASK_DISCOVERED`, in that order and in no
 * other. The doors open the handles, mint the identities, read the clock and map
 * the outcome; nothing about **whether** a task may enter, or **what** its event
 * says, lives in either of them.
 *
 * It lives here and not beside the initiative registration in `@acp/ledger`, and
 * the reason is one import: the role resolves through `resolveAssignment`, which
 * is `@acp/accounts`', and the ledger may not import accounts. This package may
 * import both.
 *
 * It opens nothing and reads no clock: the writable ledger, the plane, the
 * instant, the pid and every identifier arrive with the input.
 *
 * ## Entering is not acquiring, and not executing (E8, Q3)
 *
 * Nothing here reads the conflict graph, takes a lease or wakes a scheduler. Two
 * tasks whose write-sets overlap both enter; the conflict is reported when one of
 * them is acquired, which is the scheduler's and not this escalón's. A task that
 * entered is `DISCOVERED`, with revision 1 and the resolution of its role, and
 * nothing runs it.
 *
 * ## The key, and what a second submission is (contracts §15)
 *
 * `(clientScope, clientRequestKey)` is the request link's idempotency key, and
 * its one home is `task_submission_read_model`. A second submission under a key
 * that already names a task is compared, as a precondition, against what that
 * key recorded: the envelope digest, the roadmap link, the role, the slot and the
 * transport. The same is a replay that publishes nothing and appends nothing and
 * answers the task that exists; a difference is `CONFLICT`, naming the field.
 * Never a silent new revision. The comparison precedes every other precondition,
 * so a replay answers what was recorded even if the registry has moved since.
 *
 * ## The producer proposes, the ledger verifies
 *
 * This module proposes revision 1 and its identity. The ledger verifies the
 * revision is written once, the envelope reference exists as a `TASK_ENVELOPE`,
 * the client key is unique and the task's lifecycle opens from nothing. What the
 * ledger cannot verify, this module does not take on trust: the envelope digest
 * is computed here, by `envelopeSha256`, from `TaskEnvelope.parse` — never
 * accepted from a caller.
 *
 * ## The envelope's publication, and the gaps it leaves (M-6)
 *
 * The bytes are `canonicalJsonStringify(TaskEnvelope.parse(value))` in UTF-8, so
 * there are two digests and they are different things: `envelope_sha256` is the
 * digest of the envelope's identity preimage — a versioned prefix and those
 * bytes — and the reference's `contentSha256` is the digest of the bytes alone.
 * `TASK_ENVELOPE`, `INTERNAL`, scoped to the task, `PERMANENT`, under the plane's
 * one access policy, as `application/json; charset=utf-8` in plaintext. The
 * intention and terminal keys are derived from the task and the envelope digest,
 * so one envelope of one task has **exactly one publication**, and a retry
 * reuses what the intention recorded. Two consequences, accepted by name:
 *
 * - a task whose envelope was published and whose intake never landed holds a
 *   reference that names no task until a retry completes the intake;
 * - a publication of that pair that ended `ABANDONED` is never retried by this
 *   door: the intake is refused `CONTENT_REJECTED` until another decision.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The decision's three refusal classes, sorted — contracts §5's for the request
 * link.
 *
 * - `AUTHORITY_REFUSED` — the role has no assignment in force that admits it,
 *   for this slot and this transport.
 * - `CONFLICT` — the key names another request, or the task already entered.
 * - `REQUEST_INVALID` — the request is malformed, or names what does not exist.
 */
export const TASK_INTAKE_REFUSALS = ["AUTHORITY_REFUSED", "CONFLICT", "REQUEST_INVALID"] as const;

/**
 * Every class the intake can refuse with: the decision's three, the plane's
 * `CONTENT_REJECTED` and the lost race's `WRITE_CONFLICT`. Sorted, so a door can
 * exhaust it.
 */
export const TASK_INTAKE_WRITE_REFUSALS = Object.freeze(
  [...TASK_INTAKE_REFUSALS, "CONTENT_REJECTED" as const, "WRITE_CONFLICT" as const].sort(),
);

/**
 * The intake's own refusal codes. A refusal of the role's resolution carries
 * `@acp/accounts`' word instead, and one of the plane carries the plane's.
 */
export const TASK_INTAKE_CODES = [
  "CLIENT_KEY_CONFLICT",
  "CONTENT_REFERENCE_UNKNOWN",
  "ENVELOPE_INVALID",
  "INITIATIVE_UNKNOWN",
  "REQUEST_FIELD_INVALID",
  "ROADMAP_LINK_INCOMPLETE",
  "ROADMAP_STEPS_UNDECLARED",
  "ROADMAP_STEP_UNKNOWN",
  "ROADMAP_VERSION_UNKNOWN",
  "ROLE_NOT_IN_ENVELOPE",
  "TASK_ALREADY_RECORDED",
  "WRITE_RACE_LOST",
] as const;

/** How the envelope's bytes are described to the plane. */
export const TASK_ENVELOPE_MEDIA_TYPE = "application/json; charset=utf-8";

/** The encryption profile of a plaintext envelope, as the plane records it. */
export const TASK_ENVELOPE_ENCRYPTION_PROFILE = "local-plaintext-v1";

/** The holding's informative window: five minutes from the recording instant. */
export const TASK_ENVELOPE_HOLDING_WINDOW_MS = 5 * 60 * 1000;

/** The revision and attempt coordinate an intake records: the first of each. */
const INTAKE_REVISION_NUMBER = 1;
const INTAKE_ATTEMPT_NUMBER = 1;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Execution §6.1's `LocalKey`, restated for the step: the ledger's fold holds it to the same. */
const STEP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The idempotency keys of the envelope's intention and terminal, derived from
 * the task and the envelope digest alone — the revision's identity, not the
 * bytes' digest.
 */
export function taskEnvelopeIdempotencyKeys(
  taskId: string,
  envelopeDigest: string,
): { readonly intended: string; readonly succeeded: string } {
  const prefix = taskId + "/envelope/" + envelopeDigest + "/";
  return { intended: prefix + "intended", succeeded: prefix + "succeeded" };
}

// ---------------------------------------------------------------------------
// The request, and its form
// ---------------------------------------------------------------------------

function refuse(
  reason: TaskIntakeWriteRefusal,
  code: string,
  at: string,
  proposal: AssignmentProposal | null = null,
): TaskIntakeRefused {
  return Object.freeze({ ok: false as const, reason, code, at, proposal });
}

/**
 * Hold one request to its form, and compute what the rest of the intake reads.
 *
 * Pure: no ledger, no clock, no plane. Every refusal is `REQUEST_INVALID`. The
 * roadmap link is a pair in both directions (N-P14-8): a step without a version
 * and a version without a step are both refused, at the half that is missing.
 * The envelope is parsed whole — its credential guards over the content
 * included — **before anything is published**, and its digest is this module's
 * computation, never the caller's.
 */
export function parseTaskIntake(
  request: TaskIntakeFields,
): { readonly ok: true; readonly parsed: ParsedTaskIntake } | TaskIntakeRefused {
  const invalid = (at: string, code: TaskIntakeCode = "REQUEST_FIELD_INVALID"): TaskIntakeRefused =>
    refuse("REQUEST_INVALID", code, at);

  if (!WorkerIdentityString.safeParse(request.recordedBy).success) return invalid("recordedBy");
  if (typeof request.clientScope !== "string" || !TASK_CLIENT_KEY_PATTERN.test(request.clientScope)) {
    return invalid("clientScope");
  }
  if (typeof request.clientRequestKey !== "string" || !TASK_CLIENT_KEY_PATTERN.test(request.clientRequestKey)) {
    return invalid("clientRequestKey");
  }
  if (!(WORKER_ROLES as readonly unknown[]).includes(request.role)) return invalid("role");
  if (!Number.isSafeInteger(request.slot) || request.slot < 0) return invalid("slot");
  if (!(TRANSPORT_KINDS as readonly unknown[]).includes(request.transportKind)) return invalid("transportKind");
  const { roadmapVersionId, stepId } = request;
  if (roadmapVersionId !== null && (typeof roadmapVersionId !== "string" || !UUID_PATTERN.test(roadmapVersionId))) {
    return invalid("roadmapVersionId");
  }
  if (stepId !== null && (typeof stepId !== "string" || !STEP_KEY_PATTERN.test(stepId))) return invalid("stepId");
  if (roadmapVersionId !== null && stepId === null) return invalid("stepId", "ROADMAP_LINK_INCOMPLETE");
  if (roadmapVersionId === null && stepId !== null) return invalid("roadmapVersionId", "ROADMAP_LINK_INCOMPLETE");

  const parsed = TaskEnvelope.safeParse(request.envelope);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = (issue?.path ?? []).map((segment) => String(segment)).join(".");
    return invalid(path === "" ? "envelope" : "envelope." + path, "ENVELOPE_INVALID");
  }
  const envelope = parsed.data;

  let identity: string;
  let json: string;
  try {
    identity = envelopeSha256(envelope);
    json = canonicalJsonStringify(envelope);
  } catch (error: unknown) {
    if (error instanceof LedgerCanonicalizationError) {
      return invalid(error.path === "<root>" ? "envelope" : "envelope." + error.path, "ENVELOPE_INVALID");
    }
    throw error;
  }
  const envelopeBytes = Buffer.from(json, "utf8");

  return {
    ok: true,
    parsed: Object.freeze({
      envelope,
      envelopeSha256: identity,
      envelopeBytes,
      contentSha256: createHash("sha256").update(envelopeBytes).digest("hex"),
      clientScope: request.clientScope,
      clientRequestKey: request.clientRequestKey,
      roadmapVersionId,
      stepId,
      role: request.role as WorkerRole,
      slot: request.slot,
      transportKind: request.transportKind as TransportKind,
      recordedBy: request.recordedBy,
    }),
  };
}

// ---------------------------------------------------------------------------
// The decision against what is recorded
// ---------------------------------------------------------------------------

/**
 * Compare a request against what its key already recorded (contracts §15).
 *
 * Pure. `null` when the two are the same request — a replay; otherwise
 * `CONFLICT`, naming the first field that differs, in the order a reader of a
 * conflict wants: the work, then where it sits, then who does it.
 */
export function compareTaskIntake(parsed: ParsedTaskIntake, recorded: RecordedTaskIntake): TaskIntakeRefused | null {
  const conflict = (at: string): TaskIntakeRefused => refuse("CONFLICT", "CLIENT_KEY_CONFLICT", at);
  if (recorded.submission.envelopeSha256 !== parsed.envelopeSha256) return conflict("envelope");
  if (recorded.payload.roadmapVersionId !== parsed.roadmapVersionId) return conflict("roadmapVersionId");
  if (recorded.payload.stepId !== parsed.stepId) return conflict("stepId");
  if (recorded.payload.role !== parsed.role) return conflict("role");
  if (recorded.payload.resolution.slot !== parsed.slot) return conflict("slot");
  if (recorded.payload.resolution.transportKind !== parsed.transportKind) return conflict("transportKind");
  return null;
}

/**
 * The class a refusal of the role's resolution is answered with (M-7).
 *
 * A question the resolver could not read is the request's; everything else it
 * refuses is a route that is not in force for this role, slot and transport —
 * authority, in contracts §5's words.
 */
export function assignmentRefusalClass(refusal: AssignmentRefusal): TaskIntakeRefusal {
  return refusal === "ASSIGNMENT_REQUEST_INVALID" || refusal === "ASSIGNMENT_READING_INVALID"
    ? "REQUEST_INVALID"
    : "AUTHORITY_REFUSED";
}

/**
 * The ledger's GLOBAL reading, described in `@acp/accounts`' structural terms. Read by
 * the READY adapter too (P-27 cut A), so the assignment a task entered under and the
 * one it still resolves to are read through one description.
 */
export function assignmentReadingOf(reading: GlobalRoutingAssignmentReading): AssignmentReading {
  const { assignment, modelVersion } = reading;
  return {
    assignment:
      assignment === null
        ? null
        : {
            assignmentId: assignment.assignmentId,
            version: assignment.version,
            role: assignment.role,
            slot: assignment.slot,
            provider: assignment.provider,
            modelVersionId: assignment.modelVersionId,
          },
    fallbacks: reading.fallbacks,
    modelVersion:
      modelVersion === null
        ? null
        : {
            modelVersionId: modelVersion.row.modelVersionId,
            provider: modelVersion.row.provider,
            model: modelVersion.row.model,
            release: modelVersion.row.release,
            status: modelVersion.row.status,
            eligibleRoles: modelVersion.eligibleRoles,
            transports: modelVersion.transports,
          },
    watermarks: reading.watermarks,
  };
}

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

/**
 * The `TASK_DISCOVERED` a granted intake records, as a value.
 *
 * The one construction of an event under `TASK_INTAKE_TRANSITION_ID` in
 * production source (L-P14C-1). `fromState` is `null`: an intake opens a task,
 * and the ledger refuses one for a task that exists. The coordinate is V2 —
 * revision 1, attempt 1 — because the revision record the payload carries
 * requires one, and no attempt is opened: the attempt table gains no row until an
 * attempt's own opening. Nothing caused it and no run correlates it.
 *
 * The payload is the closed `TASK_INTAKE_PAYLOAD_KEYS`, and the envelope is not
 * among them.
 */
export function taskIntakeEvent(input: {
  readonly parsed: ParsedTaskIntake;
  readonly resolution: TaskIntakeResolution;
  readonly envelopeArtifactReferenceId: string;
  readonly eventId: string;
  readonly revisionId: string;
  readonly recordedAt: string;
}): Record<string, unknown> {
  const { parsed, resolution } = input;
  const taskId = parsed.envelope.taskId;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: input.eventId,
    taskId,
    attempt: INTAKE_ATTEMPT_NUMBER,
    transitionId: TASK_INTAKE_TRANSITION_ID,
    idempotencyKey: buildV2IdempotencyKey({
      stream: "control_plane_events",
      taskId,
      revisionNumber: INTAKE_REVISION_NUMBER,
      attemptNumber: INTAKE_ATTEMPT_NUMBER,
      transitionId: TASK_INTAKE_TRANSITION_ID,
    }),
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: parsed.recordedBy,
    occurredAt: input.recordedAt,
    recordedAt: input.recordedAt,
    correlationId: null,
    causationId: null,
    payload: {
      revisionId: input.revisionId,
      revisionNumber: INTAKE_REVISION_NUMBER,
      attemptNumber: INTAKE_ATTEMPT_NUMBER,
      envelopeSha256: parsed.envelopeSha256,
      restoredFromRevisionId: null,
      envelopeArtifactReferenceId: input.envelopeArtifactReferenceId,
      initiativeId: parsed.envelope.initiativeId,
      clientScope: parsed.clientScope,
      clientRequestKey: parsed.clientRequestKey,
      roadmapVersionId: parsed.roadmapVersionId,
      stepId: parsed.stepId,
      role: parsed.role,
      commitPolicy: parsed.envelope.commitPolicy,
      resolution: {
        assignmentId: resolution.assignmentId,
        assignmentVersion: resolution.assignmentVersion,
        slot: resolution.slot,
        modelVersionId: resolution.modelVersionId,
        provider: resolution.provider,
        model: resolution.model,
        release: resolution.release,
        transportKind: resolution.transportKind,
        watermarks: resolution.watermarks.map((watermark) => ({
          projectionName: watermark.projectionName,
          sourceStream: watermark.sourceStream,
          appliedThroughSequence: watermark.appliedThroughSequence,
          eventCount: watermark.eventCount,
          sourceHeadSha256: watermark.sourceHeadSha256,
        })),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

/**
 * The ledger codes that mean another writer got there first. Matched by name: a
 * lost race is re-read and re-decided, and any other ledger fault keeps
 * throwing. `LEDGER_IDEMPOTENCY_CONFLICT` covers the client key's own refusal.
 */
const RACE_LOST_CODES: readonly string[] = Object.freeze([
  "LEDGER_IDEMPOTENCY_CONFLICT",
  "LEDGER_EVENT_ID_CONFLICT",
  "LEDGER_LIFECYCLE_CONFLICT",
]);

/** What one client key recorded, read back from the ledger, or null. */
function recordedIntake(ledger: Ledger, clientScope: string, clientRequestKey: string): RecordedTaskIntake | null {
  const submission = ledger.getTaskSubmission(clientScope, clientRequestKey);
  if (submission === null) return null;
  const record = ledger.getEventBySequence(submission.sequence);
  const payload = record === null ? null : taskIntakePayloadOf(record.event);
  if (payload === null) {
    throw new LedgerIntegrityError(["a client key names a task-stream position that holds no intake"]);
  }
  return { submission, payload };
}

/** The answer for a key that names a task: the rows that exist, never the request in hand. */
function answerOf(ledger: Ledger, recorded: RecordedTaskIntake, replayed: boolean): TaskIntakeOutcome {
  const task = ledger.getTask(recorded.submission.taskId);
  if (task === null) {
    throw new LedgerIntegrityError(["a client key names a task the task projection does not hold"]);
  }
  return Object.freeze({
    ok: true as const,
    replayed,
    sequence: recorded.submission.sequence,
    task: Object.freeze({
      taskId: recorded.submission.taskId,
      revisionNumber: recorded.submission.revisionNumber,
      revisionId: recorded.payload.revisionId,
      envelopeSha256: recorded.submission.envelopeSha256,
      envelopeArtifactReferenceId: recorded.payload.envelopeArtifactReferenceId,
      state: task.currentState,
      resolution: recorded.payload.resolution,
    }),
  });
}

/** Replay or conflict against a recorded key; `null` when the key names nothing yet. */
function againstRecorded(ledger: Ledger, parsed: ParsedTaskIntake): TaskIntakeOutcome | null {
  const recorded = recordedIntake(ledger, parsed.clientScope, parsed.clientRequestKey);
  if (recorded === null) return null;
  return compareTaskIntake(parsed, recorded) ?? answerOf(ledger, recorded, true);
}

function identityOf(record: ArtifactEventRecord): ArtifactEventIdentity {
  return {
    eventId: record.eventId,
    idempotencyKey: record.idempotencyKey,
    occurredAt: record.event.occurredAt,
    recordedAt: record.event.recordedAt,
  };
}

/**
 * The publication request for one envelope: fresh when no intention stands under
 * the derived key, and the recorded intention's own otherwise.
 */
function publicationRequestFor(
  input: TaskIntakeInput,
  parsed: ParsedTaskIntake,
): ArtifactPublicationRequest | TaskIntakeRefused {
  const { ledger, recordedAt, holderPid, identities } = input;
  const taskId = parsed.envelope.taskId;
  const keys = taskEnvelopeIdempotencyKeys(taskId, parsed.envelopeSha256);
  const events = ledger.listArtifactEvents(parsed.contentSha256);
  const intention = events.find((record) => record.idempotencyKey === keys.intended);
  const terminal = events.find((record) => record.idempotencyKey === keys.succeeded);
  const holding = {
    holder: parsed.recordedBy,
    holderPid,
    acquiredAt: recordedAt,
    expiresAt: new Date(Date.parse(recordedAt) + TASK_ENVELOPE_HOLDING_WINDOW_MS).toISOString(),
  };
  const freshTerminal: ArtifactEventIdentity = {
    eventId: identities.terminalEventId,
    idempotencyKey: keys.succeeded,
    occurredAt: recordedAt,
    recordedAt,
  };

  if (intention === undefined) {
    return {
      content: parsed.envelopeBytes,
      declaredContentSha256: parsed.contentSha256,
      mediaType: TASK_ENVELOPE_MEDIA_TYPE,
      encryptionStatus: "PLAINTEXT",
      encryptionProfile: TASK_ENVELOPE_ENCRYPTION_PROFILE,
      commandId: identities.commandId,
      artifactPinId: identities.artifactPinId,
      reference: {
        artifactReferenceId: identities.artifactReferenceId,
        artifactClass: "TASK_ENVELOPE",
        classification: "INTERNAL",
        scopeKind: "TASK",
        scopeId: taskId,
        producerIdentity: parsed.recordedBy,
        accessPolicyId: ARTIFACT_ACCESS_POLICY_IDS[0],
        retentionClass: "PERMANENT",
        expiresAt: null,
      },
      recordedBy: parsed.recordedBy,
      intention: { eventId: identities.intentionEventId, idempotencyKey: keys.intended, occurredAt: recordedAt, recordedAt },
      terminal: terminal === undefined ? freshTerminal : identityOf(terminal),
      holding,
    };
  }

  const recorded = intention.event;
  if (recorded.artifactEventKind !== "PUBLICATION_INTENDED" || recorded.payload.intendedReference === undefined) {
    // Another producer wrote under this door's derived key: nothing here may
    // complete a publication whose reference it cannot name.
    return refuse("CONTENT_REJECTED", "NO_INTENDED_REFERENCE", "envelope");
  }
  return {
    content: parsed.envelopeBytes,
    declaredContentSha256: parsed.contentSha256,
    mediaType: recorded.payload.mediaType,
    encryptionStatus: recorded.payload.encryptionStatus,
    encryptionProfile: recorded.payload.encryptionProfile,
    commandId: recorded.payload.commandId,
    artifactPinId: recorded.payload.artifactPinId,
    reference: recorded.payload.intendedReference,
    recordedBy: recorded.recordedBy,
    intention: identityOf(intention),
    terminal: terminal === undefined ? freshTerminal : identityOf(terminal),
    holding,
  };
}

/**
 * The preconditions of contracts §5 that read the ledger, after the key: the task
 * is new, the initiative exists, the roadmap version exists for it, the role is
 * one the envelope admits, and the registry resolves the role for this slot and
 * transport. The resolution carries the vector it was read at.
 */
function preconditions(ledger: Ledger, parsed: ParsedTaskIntake): TaskIntakeResolution | TaskIntakeRefused {
  const { envelope } = parsed;
  if (ledger.getTask(envelope.taskId) !== null) {
    return refuse("CONFLICT", "TASK_ALREADY_RECORDED", "envelope.taskId");
  }
  if (ledger.getInitiative(envelope.initiativeId) === null) {
    return refuse("REQUEST_INVALID", "INITIATIVE_UNKNOWN", "envelope.initiativeId");
  }
  if (parsed.roadmapVersionId !== null) {
    const version = ledger
      .listRoadmapVersions(envelope.initiativeId)
      .find((candidate) => candidate.roadmapVersionId === parsed.roadmapVersionId);
    if (version === undefined) {
      return refuse("REQUEST_INVALID", "ROADMAP_VERSION_UNKNOWN", "roadmapVersionId");
    }
    // The step exists in the version it names (P-27 cut A; decision 193, ADR 0087's
    // debt). A version recorded before steps existed declares nothing, and says so by
    // its own word, never as an unknown step; one that declares none refuses every
    // stepId by the second word. Unknown is never zero.
    if (version.stepCount === null) {
      return refuse("REQUEST_INVALID", "ROADMAP_STEPS_UNDECLARED", "stepId");
    }
    if (!ledger.listRoadmapSteps(version.roadmapVersionId).some((step) => step.stepId === parsed.stepId)) {
      return refuse("REQUEST_INVALID", "ROADMAP_STEP_UNKNOWN", "stepId");
    }
  }
  if (!envelope.eligibility.roles.includes(parsed.role)) {
    return refuse("REQUEST_INVALID", "ROLE_NOT_IN_ENVELOPE", "role");
  }

  const reading = ledger.getGlobalRoutingAssignment({ role: parsed.role, slot: parsed.slot });
  const resolved = resolveAssignment(
    { role: parsed.role, slot: parsed.slot, transportKind: parsed.transportKind },
    assignmentReadingOf(reading),
  );
  if (!resolved.ok) {
    return refuse(assignmentRefusalClass(resolved.reason), resolved.reason, resolved.at, resolved.proposal);
  }
  return {
    assignmentId: resolved.assignmentId,
    assignmentVersion: resolved.assignmentVersion,
    slot: resolved.slot,
    modelVersionId: resolved.modelVersionId,
    provider: resolved.provider,
    model: resolved.model,
    release: resolved.release,
    transportKind: resolved.transportKind,
    watermarks: resolved.watermarks,
  };
}

/**
 * Enter one task, by command or by API.
 *
 * The order is the design: decide, publish, append. A refused decision
 * publishes nothing. A publication the plane refuses appends nothing. An append
 * that loses a race re-reads the key and decides again: the same request is a
 * replay, another is `CONFLICT`, and a task another key entered first is
 * `CONFLICT` on its id.
 */
/**
 * The refusal a content reference earns when the plane does not hold it, or null.
 *
 * Scoped to the task the envelope names: a reference that exists under another
 * task's scope is not this task's to read, so it earns the same word rather than
 * being admitted because the id happened to resolve.
 */
function contentReferenceRefusal(ledger: Ledger, envelope: TaskEnvelope): TaskIntakeRefused | null {
  const blocks = envelope.content.blocks;
  for (let index = 0; index < blocks.length; index += 1) {
    const artifactRefId = blocks[index]?.artifactRefId;
    if (artifactRefId === undefined || artifactRefId === null) continue;
    const reference = ledger.getArtifactReference(artifactRefId);
    const mine = reference?.scopeKind === "TASK" && reference.scopeId === envelope.taskId;
    if (!mine) {
      return refuse(
        "REQUEST_INVALID",
        "CONTENT_REFERENCE_UNKNOWN",
        "envelope.content.blocks[" + String(index) + "].artifactRefId",
      );
    }
  }
  return null;
}

export function intakeTask(input: TaskIntakeInput): TaskIntakeOutcome {
  const { ledger, plane, identities } = input;

  const form = parseTaskIntake(input.request);
  if (!form.ok) return form;
  const { parsed } = form;
  const taskId = parsed.envelope.taskId;

  // Every reference the content names has to exist, and belong to this task
  // (P-06/B, ADR 0094). Escalón A's contract makes a reference obligatory for
  // everything but short text and says nothing about whether it resolves — that is a
  // fact about the plane, not about the payload's shape, so it is checked here, and
  // in both doors, because both come through this function.
  //
  // The door **verifies**; it does not publish. The envelope carries a reference and
  // a digest, never bytes, so there is nothing here to publish: the producer
  // publishes what it references before it submits, and admitting an envelope whose
  // content points at nothing would record work no worker can read.
  const unresolved = contentReferenceRefusal(ledger, parsed.envelope);
  if (unresolved !== null) return unresolved;

  const decided = againstRecorded(ledger, parsed);
  if (decided !== null) return decided;

  const resolution = preconditions(ledger, parsed);
  if ("ok" in resolution) return resolution;

  const publication = publicationRequestFor(input, parsed);
  if ("ok" in publication) return publication;

  let published;
  try {
    published = plane.publish(publication);
  } catch (error: unknown) {
    // Two doors publishing the same envelope at once: the second intention
    // under the derived key is refused by the ledger's own uniqueness. Whoever
    // won may already have entered the task under this key.
    if (error instanceof LedgerError && RACE_LOST_CODES.includes(error.code)) {
      return againstRecorded(ledger, parsed) ?? refuse("WRITE_CONFLICT", "WRITE_RACE_LOST", "envelope");
    }
    throw error;
  }
  if (published.verb === "ABANDONED" || published.verb === "REFUSE") {
    return refuse("CONTENT_REJECTED", published.refusal, "envelope");
  }
  if (published.verb !== "PUBLISHED") {
    throw new LedgerIntegrityError(["a publication answered with a reconciler's verb"]);
  }
  const reference = published.reference;
  if (
    reference.contentSha256 !== parsed.contentSha256 ||
    reference.artifactClass !== "TASK_ENVELOPE" ||
    reference.scopeKind !== "TASK" ||
    reference.scopeId !== taskId
  ) {
    throw new LedgerIntegrityError(["the envelope's publication names a reference of another content, class or scope"]);
  }
  input.__testFaults?.afterEnvelopePublished?.();

  const event = taskIntakeEvent({
    parsed,
    resolution,
    envelopeArtifactReferenceId: reference.artifactReferenceId,
    eventId: identities.eventId,
    revisionId: identities.revisionId,
    recordedAt: input.recordedAt,
  });

  let appended;
  try {
    appended = ledger.append(event);
  } catch (error: unknown) {
    if (!(error instanceof LedgerError) || !RACE_LOST_CODES.includes(error.code)) throw error;
    // The race loser re-reads and decides again. Whoever won either recorded
    // this request under this key — a replay — another request under it — a
    // conflict — or this task under another key.
    const again = againstRecorded(ledger, parsed);
    if (again !== null) return again;
    if (ledger.getTask(taskId) !== null) return refuse("CONFLICT", "TASK_ALREADY_RECORDED", "envelope.taskId");
    return refuse("WRITE_CONFLICT", "WRITE_RACE_LOST", "envelope");
  }

  const recorded = recordedIntake(ledger, parsed.clientScope, parsed.clientRequestKey);
  if (recorded === null || recorded.submission.sequence !== appended.record.sequence) {
    throw new LedgerIntegrityError(["an appended intake reads back without the client key it recorded"]);
  }
  return answerOf(ledger, recorded, !appended.inserted);
}

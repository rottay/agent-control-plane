import {
  CONTRACT_VERSION,
  ControlPlaneEvent,
  SUPPORTED_CONTRACT_VERSIONS,
  TaskEnvelope,
  isSha256Hex,
} from "@acp/contracts";
import { TASK_INTAKE_TRANSITION_ID, envelopeSha256, isInstant, taskIntakePayloadOf } from "@acp/ledger";

import { canonicalSubmissionDigest, deriveInvocation } from "../submission/index.js";

import type {
  RecordedTaskOutcome,
  RecordedTaskReaderInput,
  RecordedTaskRefusal,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and
 * are re-exported here unchanged so every importer reads them from this module
 * (owner law §7).
 */
export type {
  RecordedTask,
  RecordedTaskLedgerPort,
  RecordedTaskOutcome,
  RecordedTaskPlanePort,
  RecordedTaskReaderInput,
  RecordedTaskRefusal,
} from "./types/index.js";

/**
 * The recorded-task reader — P-15 escalón D1, ADR 0105 (adjudication v2 C2).
 *
 * A task the intake recorded is read back whole, or refused by a closed word: the
 * intake event, the envelope by reference from the private plane, the revision the
 * intake folded and the submission a walk runs under. Nothing is minted. The walk
 * that consumes it is P-15/D3's; this concept opens nothing, reads no clock and
 * writes nothing — the ledger and the plane arrive as read ports.
 *
 * 1. **The intake.** The task's first event, parsed by the contract, must be a
 *    `TASK_DISCOVERED` under `TASK_INTAKE_TRANSITION_ID` out of no state, of this
 *    task. The three revision fields a walk carries forward are read by name, so a
 *    missing, null, empty or mistyped one is refused at its own path; the rest of
 *    the payload is read by the fold's own `taskIntakePayloadOf`, never restated.
 * 2. **The envelope by reference.** The plane reads the bytes the intake's
 *    reference names, under the task's scope. They must parse as the contract's
 *    `TaskEnvelope` and hash, with the ledger's one encoder, to the digest the
 *    intake recorded; the envelope must name this task and the intake's initiative.
 *    A refusal of the plane is carried by name.
 *
 *    **Version before shape (P-16/A1, ADR 0120).** Before the bytes are parsed as
 *    an envelope, their `contractVersion` is read off the object by itself: a
 *    version that is absent, not a string or not in the reader's supported set is
 *    not an envelope (`ENVELOPE_UNREADABLE`); a version other than the one the
 *    hash-chained intake event carries is `ENVELOPE_VERSION_MISMATCH`, because the
 *    payload's version is the event's; and a supported version other than the one
 *    in force is `ENVELOPE_VERSION_SUPERSEDED`, lawful history that this build does
 *    not run. The declared path for such a task is **re-submission** under the
 *    version in force, through `acp intake` or `POST /api/v1/tasks`. Only then is
 *    the one `TaskEnvelope` parse reached. A superseded envelope's digest is not
 *    re-derived — the one encoder parses with the current schema — and its version
 *    claim is corroborated by the chained event instead. The chain catches an
 *    edit that does not recompute it from genesis and the head; a writer with raw
 *    database access who recomputes everything is outside what it alone proves.
 * 3. **The revision** is the intake's own: revision 1, attempt 1.
 * 4. **The submission.** `submittedAt` is the intake event's `occurredAt` — the
 *    door's instant, recorded once and the same on every restart, and held to the
 *    ledger's canonical form (`isInstant`), because it is compared as text downstream; `attempt` is the
 *    intake's flat attempt, which the opening of its coordinate reuses; the digest
 *    is `canonicalSubmissionDigest` over the route the caller elected, the same
 *    producer the inline form uses. So a restart under another route derives
 *    another discovery, and continuity refuses it.
 * 5. **Route agreement.** The route must agree with the intake's resolution on the
 *    provider, the model alias and the transport. The account is the caller's
 *    election: the intake records none.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Every way the reader declines, sorted.
 *
 * - `ENVELOPE_DIGEST_MISMATCH` — the bytes the reference names do not hash to the
 *   digest the intake recorded.
 * - `ENVELOPE_UNREADABLE` — the plane refused the read (its word is carried), or
 *   the bytes are not an envelope, including an absent, non-string or unsupported
 *   `contractVersion`.
 * - `ENVELOPE_VERSION_MISMATCH` — the envelope's `contractVersion` is not the one
 *   the intake event carries: integrity, not history.
 * - `ENVELOPE_VERSION_SUPERSEDED` — the envelope and its intake were recorded under
 *   a supported version that is no longer the one in force: re-submit.
 * - `INTAKE_UNREADABLE` — the first event is not this task's intake, or a field of
 *   it is not what the intake records.
 * - `ROUTE_DISAGREES_WITH_INTAKE` — the elected route differs from the resolution
 *   the intake admitted the task on.
 * - `TASK_UNKNOWN` — no task under this id.
 */
export const RECORDED_TASK_REFUSALS = [
  "ENVELOPE_DIGEST_MISMATCH",
  "ENVELOPE_UNREADABLE",
  "ENVELOPE_VERSION_MISMATCH",
  "ENVELOPE_VERSION_SUPERSEDED",
  "INTAKE_UNREADABLE",
  "ROUTE_DISAGREES_WITH_INTAKE",
  "TASK_UNKNOWN",
] as const;

/** The revision fields a walk carries forward, each read by name before anything else of the payload. */
const NAMED_REVISION_FIELDS = ["revisionId", "envelopeSha256", "envelopeArtifactReferenceId"] as const;

/** The three route fields the intake's resolution fixes. */
const ROUTE_FIELDS = ["provider", "model", "transportKind"] as const;

function refuse(refusal: RecordedTaskRefusal, at: string, word: string | null = null): RecordedTaskOutcome & { ok: false } {
  return Object.freeze({ ok: false as const, refusal, at, word });
}

/**
 * The stored envelope's `contractVersion`, read before its shape, or `null`.
 *
 * Only off a plain object that owns the key, only a string, and only a member of the
 * reader's supported set: anything else is not a version this build can name, and the
 * caller refuses it as unreadable without echoing it.
 */
function recordedVersionOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "contractVersion")) return null;
  const version: unknown = (value as { readonly contractVersion?: unknown }).contractVersion;
  if (typeof version !== "string") return null;
  const supported: readonly string[] = SUPPORTED_CONTRACT_VERSIONS;
  return supported.includes(version) ? version : null;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/** Read one recorded task back whole, or refuse by name. */
export function readRecordedTask(input: RecordedTaskReaderInput): RecordedTaskOutcome {
  const { ledger, plane, taskId, route } = input;

  const task = ledger.getTask(taskId);
  if (task === null) return refuse("TASK_UNKNOWN", "task");

  const first = ledger.getEventBySequence(task.firstSequence);
  if (first === null) return refuse("INTAKE_UNREADABLE", "task.firstSequence");
  let raw: unknown;
  try {
    raw = JSON.parse(first.canonicalJson);
  } catch {
    return refuse("INTAKE_UNREADABLE", "task.firstSequence");
  }
  const parsed = ControlPlaneEvent.safeParse(raw);
  if (!parsed.success) return refuse("INTAKE_UNREADABLE", "task.firstSequence");
  const event = parsed.data;
  if (event.type !== "TASK_DISCOVERED" || event.transitionId !== TASK_INTAKE_TRANSITION_ID || event.fromState !== null) {
    return refuse("INTAKE_UNREADABLE", "intake.transitionId");
  }
  if (event.taskId !== taskId) return refuse("INTAKE_UNREADABLE", "intake.taskId");
  // The instant becomes the submission's, which the catalog pin and the dispatch door
  // compare as text: the canonical form or nothing, refused here rather than carried.
  if (!isInstant(event.occurredAt)) return refuse("INTAKE_UNREADABLE", "intake.occurredAt");

  for (const key of NAMED_REVISION_FIELDS) {
    const value: unknown = event.payload[key];
    const readable =
      typeof value === "string" && value.length > 0 && (key !== "envelopeSha256" || isSha256Hex(value));
    if (!readable) return refuse("INTAKE_UNREADABLE", "intake.payload." + key);
  }
  const intake = taskIntakePayloadOf(event);
  if (intake === null) return refuse("INTAKE_UNREADABLE", "intake.payload");

  const read = plane.read({
    artifactReferenceId: intake.envelopeArtifactReferenceId,
    scopeKind: "TASK",
    scopeId: taskId,
  });
  if (read.verb !== "READ") {
    return refuse("ENVELOPE_UNREADABLE", "intake.payload.envelopeArtifactReferenceId", read.refusal);
  }
  let envelopeJson: unknown;
  try {
    envelopeJson = JSON.parse(read.content.toString("utf8"));
  } catch {
    return refuse("ENVELOPE_UNREADABLE", "envelope");
  }
  const version = recordedVersionOf(envelopeJson);
  if (version === null) return refuse("ENVELOPE_UNREADABLE", "envelope");
  if (version !== event.contractVersion) return refuse("ENVELOPE_VERSION_MISMATCH", "envelope.contractVersion");
  if (version !== CONTRACT_VERSION) return refuse("ENVELOPE_VERSION_SUPERSEDED", "envelope.contractVersion");
  const envelope = TaskEnvelope.safeParse(envelopeJson);
  if (!envelope.success) return refuse("ENVELOPE_UNREADABLE", "envelope");
  if (envelopeSha256(envelope.data) !== intake.envelopeSha256) return refuse("ENVELOPE_DIGEST_MISMATCH", "envelope");
  if (envelope.data.taskId !== taskId) return refuse("INTAKE_UNREADABLE", "envelope.taskId");
  if (envelope.data.initiativeId !== intake.initiativeId) return refuse("INTAKE_UNREADABLE", "envelope.initiativeId");

  for (const field of ROUTE_FIELDS) {
    if (route[field] !== intake.resolution[field]) return refuse("ROUTE_DISAGREES_WITH_INTAKE", "route." + field);
  }

  const revision = Object.freeze({
    revisionId: intake.revisionId,
    revisionNumber: intake.revisionNumber,
    attemptNumber: intake.attemptNumber,
    envelopeSha256: intake.envelopeSha256,
    envelopeArtifactReferenceId: intake.envelopeArtifactReferenceId,
  });
  const submittedAt = event.occurredAt;
  const submissionDigest = canonicalSubmissionDigest({
    taskId,
    attempt: event.attempt,
    submittedAt,
    initiativeId: intake.initiativeId,
    route,
  });
  return Object.freeze({
    ok: true as const,
    task: Object.freeze({
      taskId,
      envelope: envelope.data,
      revision,
      attempt: event.attempt,
      submittedAt,
      initiativeId: intake.initiativeId,
      submissionDigest,
      invocation: deriveInvocation(taskId, event.attempt, submittedAt, submissionDigest, revision),
      role: intake.role,
      resolution: intake.resolution,
    }),
  });
}

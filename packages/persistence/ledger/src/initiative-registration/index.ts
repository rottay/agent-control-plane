import { createHash } from "node:crypto";

import { CONTRACT_VERSION, Initiative, WorkerIdentityString, buildInitiativeIdempotencyKey } from "@acp/contracts";
import type { InitiativeEvent } from "@acp/contracts";

import { readByReference } from "../artifact-plane/index.js";
import type {
  ArtifactEventIdentity,
  ArtifactPublicationRequest,
} from "../artifact-plane/index.js";
import { LedgerError, LedgerIntegrityError } from "../errors/index.js";
import type { Ledger } from "../ledger/index.js";
import { initiativeRegistrationPayloadOf } from "../projection/index.js";
import { ARTIFACT_ACCESS_POLICY_IDS } from "../types/index.js";
import type { ArtifactEventRecord, InitiativeEventRecord } from "../types/index.js";

import type {
  InitiativeRegistrationDecision,
  InitiativeRegistrationDecisionRequest,
  InitiativeRegistrationInput,
  InitiativeRegistrationOutcome,
  InitiativeRegistrationRefusal,
  InitiativeRegistrationWriteRefusal,
  RecordedInitiativeRegistration,
  RegisteredInitiative,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf,
 * `./types/index.ts`, and are re-exported here unchanged so every importer
 * keeps reading them from this module (owner law §7, ADR 0088 errata,
 * decision 90; `outbox-store`'s and `projection`'s precedent).
 */
export type {
  InitiativeRegistrationRefusal,
  InitiativeRegistrationWriteRefusal,
  RecordedInitiativeRegistration,
  InitiativeRegistrationDecisionRequest,
  InitiativeRegistrationDecision,
  InitiativeRegistrationFields,
  InitiativeRegistrationIdentities,
  InitiativeRegistrationTestFaults,
  InitiativeRegistrationInput,
  RegisteredInitiative,
  InitiativeRegistrationOutcome,
} from "./types/index.js";

/**
 * The initiative registration — P-14 escalón B, ADR 0086.
 *
 * ## What this is
 *
 * The one orchestration both doors call to register an initiative: the gateway's
 * `POST initiatives` and the CLI's `acp initiative`. It decides, publishes the
 * objective to the private plane, and appends one `INITIATIVE_REGISTERED`, in
 * that order and in no other. The doors open the handles, mint the identities,
 * read the clock and map the outcome; nothing about **whether** an initiative may
 * be registered, or **what** its event says, lives in either of them. Two doors
 * that each held a copy of this would be two answers to one question.
 *
 * It opens nothing and reads no clock: the writable ledger, the plane, the
 * instant, the pid and every identifier arrive with the input. The one instant it
 * derives — the holding's informative expiry — is arithmetic on the one it was
 * given.
 *
 * ## The request is not the payload (H-1)
 *
 * The request is validated through `Initiative` whole — the objective included —
 * so the contract's credential guards run over the objective **before anything is
 * published**. The payload the stream records is a closed vocabulary of four keys
 * (`INITIATIVE_REGISTRATION_PAYLOAD_KEYS`): the slug, the title, the digest of the
 * objective and the private reference that names its bytes. The objective is never
 * in `event_json`. `InitiativeEvent` does not change: its payload is still a
 * bounded record, and this module is the one producer of the closed shape
 * (L-P14B-1).
 *
 * ## The key, and what a second registration is (H-2)
 *
 * The coordinate is the client's own `initiativeId`, with the transition fixed at
 * `register`, so the idempotency key is `initiativeId/1/register`. A second
 * registration under the same id is compared, as a content precondition, against
 * the `INITIATIVE_REGISTERED` the stream holds: the same slug, title and objective
 * digest is a replay that publishes nothing and appends nothing and answers the
 * row that exists; a difference is `CONFLICT`, naming the field that differs. This
 * is not E10 — that is the task's client key, escalón C's.
 *
 * ## The objective's publication, and the gaps it leaves (H-4, V3 §3.a/§3.b)
 *
 * `PLAN_DOCUMENT`, `INTERNAL`, scoped to the initiative, `PERMANENT`, under the
 * plane's one access policy, as `text/plain; charset=utf-8` in plaintext. The
 * intention and the terminal keys are derived from the initiative and the digest,
 * so one objective of one initiative has **exactly one publication**. A retry does
 * not start another: it finds the intention by its derived key and reuses every
 * identity and instant the intention recorded, and the fresh identifiers the door
 * minted are ignored from that point on. Two consequences, accepted by name:
 *
 * - an initiative whose objective was published and whose event never landed —
 *   a process that died between the publication and the append — holds a
 *   reference that names no initiative until a retry completes the registration;
 * - a publication of that pair that ended `ABANDONED` is never retried by this
 *   door: the plane answers `PUBLICATION_ALREADY_ABANDONED` and the registration
 *   is refused until another decision.
 *
 * The holding is taken under the door's `recordedBy` and pid, from `recordedAt`
 * for `INITIATIVE_OBJECTIVE_HOLDING_WINDOW_MS`. The expiry is informative: the
 * lease store releases nothing by the clock. A holding a dead process left on this
 * digest is not displaced here — the plane answers `QUIESCENCE_UNPROVEN` — and its
 * reconciliation is not this escalón's.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The decision's closed refusal vocabulary, sorted.
 *
 * - `CONFLICT` — the id is registered with another slug, title or objective.
 * - `REQUEST_INVALID` — the request does not satisfy `Initiative`, its guards
 *   included, or names a producer that is not a worker identity.
 */
export const INITIATIVE_REGISTRATION_REFUSALS = ["CONFLICT", "REQUEST_INVALID"] as const;

/**
 * Every refusal the registration can answer with: the decision's two, the
 * plane's `CONTENT_REJECTED` and the lost race's `WRITE_CONFLICT`. Sorted, like
 * `ROADMAP_WRITE_REFUSALS`, so a door can exhaust it.
 */
export const INITIATIVE_REGISTRATION_WRITE_REFUSALS = Object.freeze(
  [...INITIATIVE_REGISTRATION_REFUSALS, "CONTENT_REJECTED" as const, "WRITE_CONFLICT" as const].sort(),
);

/** The one transition a registration records. There is no attempt to count. */
export const INITIATIVE_REGISTRATION_TRANSITION_ID = "register";

/** How the objective's bytes are described to the plane. */
export const INITIATIVE_OBJECTIVE_MEDIA_TYPE = "text/plain; charset=utf-8";

/** The encryption profile of a plaintext objective, as the plane records it. */
export const INITIATIVE_OBJECTIVE_ENCRYPTION_PROFILE = "local-plaintext-v1";

/** The holding's informative window: five minutes from the recording instant (V3 §3.b). */
export const INITIATIVE_OBJECTIVE_HOLDING_WINDOW_MS = 5 * 60 * 1000;

/** The idempotency key of an initiative's registration: `initiativeId/1/register`. */
export function initiativeRegistrationIdempotencyKey(initiativeId: string): string {
  return buildInitiativeIdempotencyKey({ initiativeId, transitionId: INITIATIVE_REGISTRATION_TRANSITION_ID });
}

/**
 * The idempotency keys of the objective's intention and terminal, derived from
 * the initiative and the digest alone (H-4 ii). The terminal key is the
 * success's name; an abandonment is recorded under the same identity.
 */
export function initiativeObjectiveIdempotencyKeys(
  initiativeId: string,
  objectiveSha256: string,
): { readonly intended: string; readonly succeeded: string } {
  const prefix = initiativeId + "/objective/" + objectiveSha256 + "/";
  return { intended: prefix + "intended", succeeded: prefix + "succeeded" };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** The recorded registration one initiative-stream record carries, if it is one. */
export function recordedInitiativeRegistrationOf(record: InitiativeEventRecord): RecordedInitiativeRegistration | null {
  if (record.event.type !== "INITIATIVE_REGISTERED") return null;
  const payload = initiativeRegistrationPayloadOf(record.event);
  return {
    initiativeId: record.event.initiativeId,
    sequence: record.sequence,
    slug: payload?.slug ?? null,
    title: payload?.title ?? null,
    objectiveSha256: payload?.objectiveSha256 ?? null,
    objectiveArtifactReferenceId: payload?.objectiveArtifactReferenceId ?? null,
  };
}

/**
 * Decide whether one candidate initiative may be registered.
 *
 * Pure: no ledger, no clock, no plane. The contract first, so every refusal of
 * form — the credential guards over the objective among them — lands before a
 * comparison could; then the status a registration opens with; then the stream's
 * registration, field by field, in the order a reader of a conflict wants: the
 * handle, the title, the objective.
 */
export function decideInitiativeRegistration(
  request: InitiativeRegistrationDecisionRequest,
): InitiativeRegistrationDecision {
  const parsed = Initiative.safeParse(request.candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refuse("REQUEST_INVALID", "candidate." + (issue?.path ?? []).map((segment) => String(segment)).join("."));
  }
  const initiative = parsed.data;
  if (initiative.status !== "ACTIVE") return refuse("REQUEST_INVALID", "candidate.status");

  const existing = request.existing;
  if (existing !== null && existing.initiativeId !== initiative.initiativeId) {
    return refuse("REQUEST_INVALID", "existing.initiativeId");
  }

  const objectiveBytes = Buffer.from(initiative.objective, "utf8");
  const objectiveSha256 = createHash("sha256").update(objectiveBytes).digest("hex");

  if (existing !== null) {
    if (existing.slug !== initiative.slug) return refuse("CONFLICT", "candidate.slug");
    if (existing.title !== initiative.title) return refuse("CONFLICT", "candidate.title");
    if (existing.objectiveSha256 !== objectiveSha256) return refuse("CONFLICT", "candidate.objective");
    return { ok: true, replay: true, existing };
  }
  return { ok: true, replay: false, initiative, objectiveSha256, objectiveBytes };
}

function refuse(reason: InitiativeRegistrationRefusal, at: string): InitiativeRegistrationDecision & { ok: false } {
  return { ok: false, reason, at };
}

/**
 * The `INITIATIVE_REGISTERED` a granted decision records, as a value.
 *
 * The one construction of that event in production source (L-P14B-1). The
 * payload is the closed four keys; the objective is not among them.
 */
export function initiativeRegistrationEvent(input: {
  readonly initiative: Initiative;
  readonly objectiveSha256: string;
  readonly objectiveArtifactReferenceId: string;
  readonly eventId: string;
  readonly recordedBy: string;
}): Record<string, unknown> {
  const { initiative } = input;
  return {
    contractVersion: initiative.contractVersion,
    eventId: input.eventId,
    initiativeId: initiative.initiativeId,
    transitionId: INITIATIVE_REGISTRATION_TRANSITION_ID,
    idempotencyKey: initiativeRegistrationIdempotencyKey(initiative.initiativeId),
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: initiative.status,
    emittedBy: input.recordedBy,
    occurredAt: initiative.createdAt,
    recordedAt: initiative.createdAt,
    payload: {
      slug: initiative.slug,
      title: initiative.title,
      objectiveSha256: input.objectiveSha256,
      objectiveArtifactReferenceId: input.objectiveArtifactReferenceId,
    },
  };
}

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

/**
 * The ledger codes that mean another writer got there first. Matched by name,
 * for `ROADMAP_WRITE_REFUSALS`'s reason: a lost race is re-read and re-decided,
 * and any other ledger fault keeps throwing.
 */
const RACE_LOST_CODES: readonly string[] = Object.freeze([
  "LEDGER_IDEMPOTENCY_CONFLICT",
  "LEDGER_EVENT_ID_CONFLICT",
  "LEDGER_LIFECYCLE_CONFLICT",
]);

function writeRefusal(
  reason: InitiativeRegistrationWriteRefusal,
  at: string,
): InitiativeRegistrationOutcome & { ok: false } {
  return Object.freeze({ ok: false as const, reason, at });
}

/** The registration the stream holds for one id, or null. */
function recordedRegistration(ledger: Ledger, initiativeId: string): RecordedInitiativeRegistration | null {
  const page = ledger.listInitiativeEvents({ initiativeId, type: "INITIATIVE_REGISTERED", limit: 1 });
  const record = page.events[0];
  return record === undefined ? null : recordedInitiativeRegistrationOf(record);
}

/** The row that exists, answered for a registration the stream holds in the closed payload. */
function registrationOf(ledger: Ledger, recorded: RecordedInitiativeRegistration): RegisteredInitiative {
  const row = ledger.getInitiative(recorded.initiativeId);
  if (row === null || recorded.slug === null || row.title === null || row.objectiveSha256 === null) {
    throw new LedgerIntegrityError([
      "a registration the stream holds in the closed payload is not what the initiative projection folded",
    ]);
  }
  return Object.freeze({
    initiativeId: row.initiativeId,
    slug: recorded.slug,
    title: row.title,
    objectiveSha256: row.objectiveSha256,
    status: row.currentStatus,
    eventCount: row.eventCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
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
 * The publication request for one objective: fresh when no intention stands
 * under the derived key, and the recorded intention's own otherwise (V3 §3.a).
 */
function publicationRequestFor(
  input: InitiativeRegistrationInput,
  initiativeId: string,
  objectiveSha256: string,
  objectiveBytes: Uint8Array,
): ArtifactPublicationRequest | InitiativeRegistrationOutcome {
  const { ledger, request, recordedAt, holderPid, identities } = input;
  const keys = initiativeObjectiveIdempotencyKeys(initiativeId, objectiveSha256);
  const events = ledger.listArtifactEvents(objectiveSha256);
  const intention = events.find((record) => record.idempotencyKey === keys.intended);
  const terminal = events.find((record) => record.idempotencyKey === keys.succeeded);
  const holding = {
    holder: request.recordedBy,
    holderPid,
    acquiredAt: recordedAt,
    expiresAt: new Date(Date.parse(recordedAt) + INITIATIVE_OBJECTIVE_HOLDING_WINDOW_MS).toISOString(),
  };
  const freshTerminal: ArtifactEventIdentity = {
    eventId: identities.terminalEventId,
    idempotencyKey: keys.succeeded,
    occurredAt: recordedAt,
    recordedAt,
  };

  if (intention === undefined) {
    return {
      content: objectiveBytes,
      declaredContentSha256: objectiveSha256,
      mediaType: INITIATIVE_OBJECTIVE_MEDIA_TYPE,
      encryptionStatus: "PLAINTEXT",
      encryptionProfile: INITIATIVE_OBJECTIVE_ENCRYPTION_PROFILE,
      commandId: identities.commandId,
      artifactPinId: identities.artifactPinId,
      reference: {
        artifactReferenceId: identities.artifactReferenceId,
        artifactClass: "PLAN_DOCUMENT",
        classification: "INTERNAL",
        scopeKind: "INITIATIVE",
        scopeId: initiativeId,
        producerIdentity: request.recordedBy,
        accessPolicyId: ARTIFACT_ACCESS_POLICY_IDS[0],
        retentionClass: "PERMANENT",
        expiresAt: null,
      },
      recordedBy: request.recordedBy,
      intention: { eventId: identities.intentionEventId, idempotencyKey: keys.intended, occurredAt: recordedAt, recordedAt },
      terminal: terminal === undefined ? freshTerminal : identityOf(terminal),
      holding,
    };
  }

  const recorded = intention.event;
  if (recorded.artifactEventKind !== "PUBLICATION_INTENDED" || recorded.payload.intendedReference === undefined) {
    // Another producer wrote under this door's derived key: nothing here may
    // complete a publication whose reference it cannot name.
    return writeRefusal("CONTENT_REJECTED", "NO_INTENDED_REFERENCE");
  }
  return {
    content: objectiveBytes,
    declaredContentSha256: objectiveSha256,
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
 * Register one initiative, by command or by API.
 *
 * The order is the design (H-4 iii): decide, publish, append. A refused
 * decision publishes nothing. A publication the plane refuses appends nothing.
 * An append that loses a race re-reads the stream and decides again: the same
 * registration is a replay, another is `CONFLICT`.
 */
export function registerInitiative(input: InitiativeRegistrationInput): InitiativeRegistrationOutcome {
  const { ledger, plane, request, recordedAt, identities } = input;

  if (!WorkerIdentityString.safeParse(request.recordedBy).success) {
    return writeRefusal("REQUEST_INVALID", "recordedBy");
  }

  // Composed, never accepted: the decision parses it through the contract.
  const candidate = {
    contractVersion: CONTRACT_VERSION,
    initiativeId: request.initiativeId,
    slug: request.slug,
    title: request.title,
    objective: request.objective,
    status: "ACTIVE",
    createdAt: recordedAt,
  };

  const decision = decideInitiativeRegistration({
    candidate,
    existing: recordedRegistration(ledger, request.initiativeId),
  });
  if (!decision.ok) return writeRefusal(decision.reason, decision.at);
  if (decision.replay) {
    return Object.freeze({
      ok: true as const,
      replayed: true,
      sequence: decision.existing.sequence,
      registration: registrationOf(ledger, decision.existing),
    });
  }

  const { initiative, objectiveSha256, objectiveBytes } = decision;
  const publication = publicationRequestFor(input, initiative.initiativeId, objectiveSha256, objectiveBytes);
  if ("ok" in publication) return publication;

  let published;
  try {
    published = plane.publish(publication);
  } catch (error: unknown) {
    // Two doors publishing the same objective at once: the second intention
    // under the derived key is refused by the ledger's own uniqueness. Late,
    // not broken, and a retry finds the winner's intention.
    if (error instanceof LedgerError && RACE_LOST_CODES.includes(error.code)) {
      return writeRefusal("WRITE_CONFLICT", "objective");
    }
    throw error;
  }
  if (published.verb === "ABANDONED" || published.verb === "REFUSE") {
    return writeRefusal("CONTENT_REJECTED", published.refusal);
  }
  if (published.verb !== "PUBLISHED") {
    throw new LedgerIntegrityError(["a publication answered with a reconciler's verb"]);
  }
  const reference = published.reference;
  if (
    reference.contentSha256 !== objectiveSha256 ||
    reference.scopeKind !== "INITIATIVE" ||
    reference.scopeId !== initiative.initiativeId
  ) {
    throw new LedgerIntegrityError(["the objective's publication names a reference of another content or scope"]);
  }
  input.__testFaults?.afterObjectivePublished?.();

  const event = initiativeRegistrationEvent({
    initiative,
    objectiveSha256,
    objectiveArtifactReferenceId: reference.artifactReferenceId,
    eventId: identities.eventId,
    recordedBy: request.recordedBy,
  });

  let appended;
  try {
    appended = ledger.appendInitiativeEvent(event);
  } catch (error: unknown) {
    if (!(error instanceof LedgerError) || !RACE_LOST_CODES.includes(error.code)) throw error;
    // The race loser re-reads and decides again (V3 §3.d). Whoever won either
    // recorded this registration — a replay — or another one — a conflict.
    const again = decideInitiativeRegistration({
      candidate,
      existing: recordedRegistration(ledger, initiative.initiativeId),
    });
    if (!again.ok) return writeRefusal(again.reason, again.at);
    if (again.replay) {
      return Object.freeze({
        ok: true as const,
        replayed: true,
        sequence: again.existing.sequence,
        registration: registrationOf(ledger, again.existing),
      });
    }
    return writeRefusal("WRITE_CONFLICT", "initiativeId");
  }

  const recorded = recordedInitiativeRegistrationOf(appended.record);
  if (recorded === null) {
    throw new LedgerIntegrityError(["an appended registration reads back as another event type"]);
  }
  return Object.freeze({
    ok: true as const,
    replayed: !appended.inserted,
    sequence: appended.record.sequence,
    registration: registrationOf(ledger, recorded),
  });
}

// ---------------------------------------------------------------------------
// The objective, read back (V3 §3.c)
// ---------------------------------------------------------------------------

/**
 * The objective a registration names, read from the private plane under the
 * initiative's own scope.
 *
 * Null when the event is not a registration in the closed payload: that history
 * never published an objective, and whatever its payload says is the caller's to
 * read as before. For a registration of the closed payload the answer is the
 * objective or a throw — `LedgerIntegrityError` when the private root is absent
 * or the plane refuses the read — and never null: a registration that names
 * bytes the plane cannot produce is the ledger and the plane disagreeing, not an
 * initiative with no objective.
 *
 * Reads through `readByReference` (P-15/F), which checks that the root stands
 * before it opens the plane over the handle it is given, read-only or not, with
 * a lease store that refuses every holding: the plane would otherwise create the
 * root. The refusals and their texts are the ones this reader always threw.
 */
export function readInitiativeObjective(ledger: Ledger, event: InitiativeEvent): string | null {
  const payload = initiativeRegistrationPayloadOf(event);
  if (payload === null) return null;

  const read = readByReference(ledger, {
    artifactReferenceId: payload.objectiveArtifactReferenceId,
    scopeKind: "INITIATIVE",
    scopeId: event.initiativeId,
  });
  if (read.verb !== "READ") {
    if (read.refusal === "ROOT_ABSENT") {
      throw new LedgerIntegrityError(["a registration names an objective and the private artifact root is absent"]);
    }
    if (read.refusal === "ROOT_NOT_A_DIRECTORY") {
      throw new LedgerIntegrityError(["a registration names an objective and the private artifact root is not a directory"]);
    }
    throw new LedgerIntegrityError(["a registration names an objective the private plane refuses to read: " + read.refusal]);
  }
  if (read.reference.contentSha256 !== payload.objectiveSha256) {
    throw new LedgerIntegrityError(["a registration's objective reference names content of another digest"]);
  }
  return read.content.toString("utf8");
}

import { TRANSPORT_KINDS, WORKER_ROLES } from "@acp/contracts";
import type { TransportKind, WorkerRole } from "@acp/contracts";

/**
 * The GLOBAL assignment resolver: a role resolves from the registry alone, or
 * not at all (P-14 escalón A, ADR 0085).
 *
 * The capability registry of accounts §6 is folded by the ledger from the
 * registry stream, and the ledger's append door already refuses an assignment
 * naming a version that is unknown, not `ACTIVE`, or not eligible for its role.
 * This module is the other half, and the half that happens later: resolving a
 * role against what is in force **now**, for a transport the caller names.
 *
 * Four laws hold it in shape.
 *
 * **The registry is the only source.** It reads the reading it is handed and
 * nothing else. It does not import the policy module, does not consult the
 * capability policy file, and has no default: a role with no assignment in force
 * is refused (N-P14-2). `resolveRoute` and the policy file stay as the legacy
 * path they are, and their convergence is P-28's and P-19's to decide.
 *
 * **The input is structural.** This package may not import `@acp/ledger`, so
 * the reading is described by this module's own types and the caller maps the
 * ledger's `getGlobalRoutingAssignment` onto them. A reading that does not
 * describe the coordinate asked about, or carries no vector, is refused rather
 * than trusted.
 *
 * **What the door cannot see is decided here.** Transport: the assignment names
 * none, so admission for a transport can only be checked where the transport is
 * known. And time: a version retired after its assignment was admitted is
 * refused at resolution, with the proposal to migrate, never silently replaced
 * by a fallback (contracts §5: a retired version blocks and proposes migration).
 *
 * **The vector travels.** Every outcome, resolved or refused, carries the
 * watermarks the reading was taken at, so the caller records the vector that was
 * read and not whatever the registry has become since (N-P14-3).
 *
 * Pure: no clock, no I/O, and the same input gives the same output.
 */

// ---------------------------------------------------------------------------
// The reading, as this package describes it
// ---------------------------------------------------------------------------

/** One watermark row the reading was taken against. */
export interface AssignmentWatermark {
  readonly projectionName: string;
  readonly sourceStream: string;
  readonly appliedThroughSequence: number;
  readonly eventCount: number;
  readonly sourceHeadSha256: string;
}

/** The GLOBAL assignment in force, reduced to what resolution reads. */
export interface GlobalAssignment {
  readonly assignmentId: string;
  readonly version: number;
  readonly role: string;
  readonly slot: number;
  readonly provider: string;
  readonly modelVersionId: string;
}

/**
 * The model version the assignment names, with its two child lists.
 *
 * Its policy version is deliberately not part of the reading. Restriction 6 of
 * the capability registry keeps every read of a policy version inside the policy
 * module, and whether the registry's `policy_version` becomes the version a route
 * stamps is the convergence P-28 and P-19 own, not a field this resolver may
 * decide by carrying it.
 */
export interface AssignmentModelVersion {
  readonly modelVersionId: string;
  readonly provider: string;
  readonly model: string;
  readonly release: string;
  readonly status: string;
  readonly eligibleRoles: readonly string[];
  readonly transports: readonly string[];
}

/** One read of the registry, taken at one vector. */
export interface AssignmentReading {
  readonly assignment: GlobalAssignment | null;
  readonly fallbacks: readonly string[];
  readonly modelVersion: AssignmentModelVersion | null;
  readonly watermarks: readonly AssignmentWatermark[];
}

/** What is being resolved: a role, its slot, and the transport it will run over. */
export interface AssignmentRequest {
  readonly role: WorkerRole;
  readonly slot: number;
  readonly transportKind: TransportKind;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type AssignmentRefusal =
  // the request names no role, slot or transport this system knows
  | "ASSIGNMENT_REQUEST_INVALID"
  // the reading carries no vector, or describes another coordinate or version
  | "ASSIGNMENT_READING_INVALID"
  // no GLOBAL assignment is in force for the role and slot; nothing is defaulted
  | "ASSIGNMENT_ABSENT"
  // the assignment names a model version the registry does not hold
  | "MODEL_VERSION_UNKNOWN"
  // the model version was retired; it blocks, and the assignment must migrate
  | "MODEL_VERSION_RETIRED"
  // the model version is deprecated; an assignment resolves to ACTIVE only
  | "MODEL_VERSION_DEPRECATED"
  // the model version does not declare the role eligible
  | "ROLE_NOT_ELIGIBLE"
  // the model version does not admit the transport
  | "TRANSPORT_NOT_ADMITTED"
  // the assignment and the model version it names disagree about the provider
  | "ASSIGNMENT_PROVIDER_MISMATCH";

export const ASSIGNMENT_REFUSALS: readonly AssignmentRefusal[] = Object.freeze([
  "ASSIGNMENT_REQUEST_INVALID",
  "ASSIGNMENT_READING_INVALID",
  "ASSIGNMENT_ABSENT",
  "MODEL_VERSION_UNKNOWN",
  "MODEL_VERSION_RETIRED",
  "MODEL_VERSION_DEPRECATED",
  "ROLE_NOT_ELIGIBLE",
  "TRANSPORT_NOT_ADMITTED",
  "ASSIGNMENT_PROVIDER_MISMATCH",
]);

/**
 * The one proposal a refusal can carry. There is no successor column in the
 * registry, so the proposal names what to do, never which version to do it with.
 */
export type AssignmentProposal = "MIGRATE_TO_ACTIVE_MODEL_VERSION";

export interface AssignmentRefused {
  readonly ok: false;
  readonly reason: AssignmentRefusal;
  /** A field path on the request or the reading. Never a value from either. */
  readonly at: string;
  /** Set on `MODEL_VERSION_RETIRED` alone. */
  readonly proposal: AssignmentProposal | null;
  /** The vector the reading was taken at, or empty when the reading had none. */
  readonly watermarks: readonly AssignmentWatermark[];
}

export interface AssignmentResolution {
  readonly ok: true;
  readonly role: WorkerRole;
  readonly slot: number;
  readonly transportKind: TransportKind;
  readonly assignmentId: string;
  readonly assignmentVersion: number;
  readonly provider: string;
  readonly modelVersionId: string;
  readonly model: string;
  readonly release: string;
  /** The assignment's fallbacks, in attempt order, carried and never taken here. */
  readonly fallbacks: readonly string[];
  /** The vector the resolution was made at. */
  readonly watermarks: readonly AssignmentWatermark[];
}

export type AssignmentOutcome = AssignmentResolution | AssignmentRefused;

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isWatermark(value: unknown): value is AssignmentWatermark {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    isText(entry["projectionName"]) &&
    isText(entry["sourceStream"]) &&
    isCount(entry["appliedThroughSequence"]) &&
    isCount(entry["eventCount"]) &&
    typeof entry["sourceHeadSha256"] === "string" &&
    SHA256_PATTERN.test(entry["sourceHeadSha256"])
  );
}

function isTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isText);
}

/**
 * Resolve one role against one reading of the registry.
 *
 * The order is the order of what could be wrong: the question, the reading,
 * whether anything is assigned, whether what is assigned still exists and
 * still rules, and only then whether it fits this role, this transport and this
 * provider. The first failure is the answer.
 */
export function resolveAssignment(
  request: AssignmentRequest,
  reading: AssignmentReading,
): AssignmentOutcome {
  const vector: readonly AssignmentWatermark[] =
    Array.isArray(reading.watermarks) && reading.watermarks.every(isWatermark)
      ? Object.freeze(reading.watermarks.map((watermark) => Object.freeze({ ...watermark })))
      : Object.freeze([]);

  const deny = (reason: AssignmentRefusal, at: string): AssignmentRefused =>
    Object.freeze({
      ok: false as const,
      reason,
      at,
      proposal: reason === "MODEL_VERSION_RETIRED" ? ("MIGRATE_TO_ACTIVE_MODEL_VERSION" as const) : null,
      watermarks: vector,
    });

  if (!(WORKER_ROLES as readonly unknown[]).includes(request.role)) {
    return deny("ASSIGNMENT_REQUEST_INVALID", "request.role");
  }
  if (!isCount(request.slot)) return deny("ASSIGNMENT_REQUEST_INVALID", "request.slot");
  if (!(TRANSPORT_KINDS as readonly unknown[]).includes(request.transportKind)) {
    return deny("ASSIGNMENT_REQUEST_INVALID", "request.transportKind");
  }

  // A reading with no vector cannot be recorded as having been read at one.
  if (vector.length === 0) return deny("ASSIGNMENT_READING_INVALID", "reading.watermarks");

  const assignment = reading.assignment;
  if (assignment === null) return deny("ASSIGNMENT_ABSENT", "request.role");
  if (assignment.role !== request.role) return deny("ASSIGNMENT_READING_INVALID", "reading.assignment.role");
  if (assignment.slot !== request.slot) return deny("ASSIGNMENT_READING_INVALID", "reading.assignment.slot");
  if (!isText(assignment.assignmentId) || !isText(assignment.provider) || !isText(assignment.modelVersionId)) {
    return deny("ASSIGNMENT_READING_INVALID", "reading.assignment");
  }
  if (!isTextList(reading.fallbacks)) return deny("ASSIGNMENT_READING_INVALID", "reading.fallbacks");

  const version = reading.modelVersion;
  if (version === null) return deny("MODEL_VERSION_UNKNOWN", "reading.assignment.modelVersionId");
  if (version.modelVersionId !== assignment.modelVersionId) {
    return deny("ASSIGNMENT_READING_INVALID", "reading.modelVersion.modelVersionId");
  }
  if (!isTextList(version.eligibleRoles) || !isTextList(version.transports)) {
    return deny("ASSIGNMENT_READING_INVALID", "reading.modelVersion");
  }

  if (version.status === "RETIRED") return deny("MODEL_VERSION_RETIRED", "reading.modelVersion.status");
  if (version.status === "DEPRECATED") return deny("MODEL_VERSION_DEPRECATED", "reading.modelVersion.status");
  if (version.status !== "ACTIVE") return deny("ASSIGNMENT_READING_INVALID", "reading.modelVersion.status");

  if (!version.eligibleRoles.includes(request.role)) return deny("ROLE_NOT_ELIGIBLE", "request.role");
  if (!version.transports.includes(request.transportKind)) {
    return deny("TRANSPORT_NOT_ADMITTED", "request.transportKind");
  }
  if (version.provider !== assignment.provider) {
    return deny("ASSIGNMENT_PROVIDER_MISMATCH", "reading.assignment.provider");
  }

  return Object.freeze({
    ok: true as const,
    role: request.role,
    slot: request.slot,
    transportKind: request.transportKind,
    assignmentId: assignment.assignmentId,
    assignmentVersion: assignment.version,
    provider: assignment.provider,
    modelVersionId: version.modelVersionId,
    model: version.model,
    release: version.release,
    fallbacks: Object.freeze([...reading.fallbacks]),
    watermarks: vector,
  });
}

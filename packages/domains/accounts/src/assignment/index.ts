import { TRANSPORT_KINDS, WORKER_ROLES } from "@acp/contracts";

import type {
  AssignmentOutcome,
  AssignmentReading,
  AssignmentRefusal,
  AssignmentRefused,
  AssignmentRequest,
  AssignmentWatermark,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf,
 * `./types/index.ts`, and are re-exported here unchanged so every importer
 * keeps reading them from this module (owner law §7, ADR 0088 errata,
 * decision 90; `outbox-store`'s and `projection`'s precedent).
 */
export type {
  AssignmentWatermark,
  GlobalAssignment,
  AssignmentModelVersion,
  AssignmentReading,
  AssignmentRequest,
  AssignmentRefusal,
  AssignmentProposal,
  AssignmentRefused,
  AssignmentResolution,
  AssignmentOutcome,
} from "./types/index.js";

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
// Refusals
// ---------------------------------------------------------------------------

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

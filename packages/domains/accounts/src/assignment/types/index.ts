/**
 * The value types of GLOBAL assignment resolution (P-14 escalón A, ADR 0085).
 *
 * The watermark, the assignment, the model version it names, the reading, the
 * request, the refusal vocabulary's derived union, the proposal, and the refused and
 * resolved outcomes: the declarations this concept owns, in the concept's own leaf
 * rather than interleaved with the resolver that reads them (owner law
 * `docs/audit/architecture/index.md` §7; the ADR 0088 errata of 2026-09-14 withdraws
 * that record's "Types live inline in the module" for every new declaration, and
 * decision 90 registers this seam).
 *
 * A pure type leaf, on `@acp/ledger`'s `src/types/index.ts` pattern: it declares data
 * and nothing else, and imports only types. `ASSIGNMENT_REFUSALS`, which is a value
 * typed by the union below, stays in `../index.ts` beside the resolver.
 *
 * Nothing was renamed and no field changed: these are the same declarations, moved,
 * and `../index.ts` re-exports every one of them, so no importer sees a difference.
 */

import type { TransportKind, WorkerRole } from "@acp/contracts";

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

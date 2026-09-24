/**
 * The value types of a roadmap's steps (P-26 cut B, ADR 0111).
 *
 * The derived step, the digest outcome, the manifest read, and the producer's
 * input and outcome: the declarations this concept owns, in the concept's own
 * leaf (owner law `docs/audit/architecture/index.md` §7; the initiative
 * registration's leaf is the precedent). A pure type leaf: it declares data and
 * imports only types, and `../index.ts` re-exports every one.
 */

import type { RoadmapVersion, RoadmapVersionKind } from "@acp/contracts";
import type { ArtifactPlane, ReferenceReadRefusal } from "../../artifact-plane/index.js";
import type { Ledger } from "../../ledger/index.js";
import type { RoadmapVersionRefusal } from "../../roadmap-version/index.js";

/**
 * One step as the door and the producer derive it from the manifest: the
 * declaration a `ROADMAP_STEP_DECLARED` must carry, field for field.
 */
export interface RoadmapStepDigest {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly title: string;
  readonly objectiveSha256: string;
  readonly acceptanceSha256: string;
  readonly expectedWriteSetSha256: string;
  readonly dependsOn: readonly string[];
  /** The longest path from a step with no dependencies: 0 for such a step. */
  readonly dependencyRank: number;
}

/** The digests of a manifest's steps, or the cycle that has none. */
export type RoadmapStepDigestOutcome =
  | { readonly ok: true; readonly steps: readonly RoadmapStepDigest[] }
  | {
      readonly ok: false;
      readonly reason: "STEP_DEPENDENCY_CYCLE";
      /** The first stepId on the cycle, in manifest order. An identifier, never content. */
      readonly at: string;
    };

/** What reading a version's manifest back by reference gives the door. */
export type RoadmapStepManifestRead =
  | {
      readonly ok: true;
      /** The document, JSON-parsed and not yet trusted: the decision parses it. */
      readonly manifest: unknown;
      /** The digest of the bytes read, which the plane verified on the way out. */
      readonly contentSha256: string;
    }
  | { readonly ok: false; readonly refusal: ReferenceReadRefusal | "NOT_JSON" };

/** What a caller asks to record: `RoadmapVersionWriteRequest`'s fields, `steps` optional. */
export interface RoadmapRevisionRequest {
  readonly content: string;
  readonly expectedHeadDigest: string | null;
  readonly kind: RoadmapVersionKind;
  readonly restoresVersionId: string | null;
  readonly recordedBy: string;
  /** The step manifest, parsed again here through the contract; absent records no steps. */
  readonly steps?: unknown;
}

/** The identities a steps-bearing revision needs, minted by the door. */
export interface RoadmapRevisionStepIdentities {
  /** One event id per step, in step order. */
  readonly stepEventIds: readonly string[];
  readonly commandId: string;
  readonly artifactPinId: string;
  readonly artifactReferenceId: string;
  readonly intentionEventId: string;
  readonly terminalEventId: string;
}

export interface RoadmapRevisionInput {
  /** The handle the head is folded from. Never appended through. */
  readonly reader: Ledger;
  /** A writable handle of the same ledger: every append goes through it. */
  readonly writable: Ledger;
  /** The private plane of the same ledger; required exactly when `steps` is given. */
  readonly plane: ArtifactPlane | null;
  readonly initiativeId: string;
  readonly request: RoadmapRevisionRequest;
  /** Injected: the recording instant, ISO-8601 in UTC with milliseconds. */
  readonly recordedAt: string;
  /** Injected: the version's identity and its event's. */
  readonly roadmapVersionId: string;
  readonly eventId: string;
  /** Injected, for a steps-bearing revision: the pid the manifest's holding records. */
  readonly holderPid: number | null;
  /** Injected, for a steps-bearing revision. */
  readonly stepIdentities: RoadmapRevisionStepIdentities | null;
}

export type RoadmapRevisionOutcome =
  | {
      readonly ok: true;
      /** The recorded version, as the contract parsed it. */
      readonly version: RoadmapVersion;
      /** The initiative-stream position of the version event. */
      readonly sequence: number;
    }
  | {
      readonly ok: false;
      readonly reason: RoadmapVersionRefusal | "CONTENT_REJECTED";
      /** A field path or a store observation. Never roadmap content. */
      readonly at: string;
    };

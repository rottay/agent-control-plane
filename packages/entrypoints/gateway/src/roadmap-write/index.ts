import type { RoadmapVersionWriteRequest } from "@acp/protocol";
import {
  LedgerError,
  LedgerInitiativeBatchConflictError,
  LedgerRoadmapVersionRefusedError,
  artifactBlobLeaseStorePath,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  recordRoadmapRevision,
} from "@acp/ledger";
import type { Ledger, RoadmapRevisionOutcome, RoadmapRevisionStepIdentities } from "@acp/ledger";
import { ROADMAP_VERSION_REFUSALS } from "@acp/ledger";
import type { RoadmapVersionRefusal } from "@acp/ledger";

/**
 * The roadmap-version write seam — the plane's only write.
 *
 * This module opens what a revision needs, hands it to the ledger's one producer,
 * `recordRoadmapRevision` (P-26 cut B, ADR 0111), and maps what comes back. It
 * **decides nothing**: every law about when a version may be recorded already lives
 * in `decideRoadmapVersion`, which owns the twelve-name refusal vocabulary and
 * reasons over a folded head it is handed
 * rather than a ledger it reads. Re-checking any of that here would be a second
 * opinion about the same question, and two opinions drift. The producer's call is
 * the fast path; the law is the ledger door's call of the same function, inside
 * the append (P-26/A, ADR 0110).
 *
 * **The write capability is scoped to this module, and is short-lived.** The
 * server's long-lived handle is opened `{ readOnly: true }` at exactly one call
 * site and stays that way; a writable handle is opened here, used for one
 * append, and closed in a `finally`. The process therefore never holds a
 * writable ledger between requests, and the read path cannot append even by
 * mistake — it has no handle that could.
 *
 * **The instant and the identifiers are injected** rather than read from a clock
 * or a random source, under the house determinism laws, and the producer builds
 * the envelope from them, so the same request with the same coordinates builds
 * the same events on every run. That is what makes the append idempotent at the
 * ledger's own key rather than merely usually-once.
 *
 * **Content goes to the store, the digest goes to the ledger.** The Checkpoint
 * law keeps content out of events, and the artifact store is content-addressed,
 * so publishing is idempotent: a retried write re-publishes the same bytes to
 * the same digest and writes nothing the second time.
 */

/**
 * The artifact root rule is `@acp/ledger`'s, and this seam is now a caller of
 * it (V2-B1f/F3).
 *
 * It was declared here — `ARTIFACT_DIRECTORY` and `artifactRootFor` — while a
 * roadmap document was the only artifact anyone published. It is not any more:
 * the checkpoint store resolves through the same rule, and `@acp/runtime`,
 * `@acp/durability` and the daemon may not import this package. Re-stating the
 * rule on the ledger side would have been the *"second answer to where a digest
 * in this ledger resolves"* the note below warns against, so the declaration
 * MOVED rather than being copied, and this module imports it like every other
 * consumer.
 */

export interface RoadmapWriteInput {
  /** The read-only handle, used to fold the head. Never appended through. */
  readonly ledger: Ledger;
  readonly initiativeId: string;
  readonly request: RoadmapVersionWriteRequest;
  /** Injected: the recording instant. This module reads no clock. */
  readonly recordedAt: string;
  /** Injected: the version's identity and the event's. No randomness here. */
  readonly roadmapVersionId: string;
  readonly eventId: string;
  /**
   * Injected, for a request that carries `steps` (P-26 cut B): the identities of
   * the manifest's publication and of each step event, the pid its holding records,
   * and the lease store's incarnation — the registration route's set, minted by the
   * route. Null for a request without steps.
   */
  readonly steps: {
    readonly identities: RoadmapRevisionStepIdentities;
    readonly holderPid: number;
    readonly leaseStoreIncarnationId: string;
  } | null;
}

/**
 * The recorded version, in the fields a response is built from.
 *
 * Restated field by field rather than passed through as the contract value,
 * for the reason `mappers` already gives: a spread would carry
 * `contractVersion` and `expectedHeadDigest` into a strict DTO that has
 * neither, and would silently carry any field the contract gains later. The
 * strict schema would catch it at `.parse()` — this catches it at the type.
 */
export interface RecordedRoadmapVersion {
  readonly roadmapVersionId: string;
  readonly initiativeId: string;
  readonly version: number;
  readonly contentDigest: string;
  readonly parentVersionId: string | null;
  readonly kind: "EDIT" | "ROLLBACK";
  readonly restoresVersionId: string | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** Null for a version recorded before steps existed; never here, where every version is 2.10.0. */
  readonly stepCount: number | null;
  readonly stepManifestSha256: string | null;
}

export interface RoadmapWriteGranted {
  readonly ok: true;
  readonly version: RecordedRoadmapVersion;
  readonly sequence: number;
}

export interface RoadmapWriteRefused {
  readonly ok: false;
  readonly reason: RoadmapVersionRefusal | "CONTENT_REJECTED" | "WRITE_CONFLICT";
  /** A field path or a store observation. Never roadmap content. */
  readonly at: string;
}

export type RoadmapWriteOutcome = RoadmapWriteGranted | RoadmapWriteRefused;

/** Every refusal this seam can answer with, for the route's own exhaustion. */
export const ROADMAP_WRITE_REFUSALS: readonly (
  | RoadmapVersionRefusal
  | "CONTENT_REJECTED"
  | "WRITE_CONFLICT"
)[] = Object.freeze(
  [...ROADMAP_VERSION_REFUSALS, "CONTENT_REJECTED" as const, "WRITE_CONFLICT" as const].sort(),
);

/**
 * The ledger codes that mean "another writer got there first" (P8-8G R1).
 *
 * Exactly two, matched **by name** rather than by catching everything the
 * append can throw. The distinction is the whole point: a lost race is the
 * caller's to retry and answers 409, while a ledger that failed for any other
 * reason is this server's problem and must keep answering 500. A broad catch
 * would convert every future ledger fault into a cheerful "try again", which
 * is the most expensive kind of wrong answer — it tells a caller to repeat
 * something that will never work.
 */
const RACE_LOST_CODES: readonly string[] = Object.freeze([
  "LEDGER_IDEMPOTENCY_CONFLICT",
  "LEDGER_EVENT_ID_CONFLICT",
]);

/**
 * Record one roadmap version, with its steps or without.
 *
 * The composition — publish, fold, decide, publish the manifest, append — is the
 * ledger's `recordRoadmapRevision`, the one producer both paths share (P-26 cut B).
 * This function opens its handles, calls it, and maps its answer; a ledger error it
 * throws is mapped here by name and nowhere else.
 */
export function recordRoadmapVersion(input: RoadmapWriteInput): RoadmapWriteOutcome {
  const { ledger, initiativeId, request, recordedAt, roadmapVersionId, eventId } = input;

  // The short-lived writable handle, and for a revision with steps the blob lease
  // store and the plane: opened here, closed in `finally`, never held between
  // requests and never reachable from the read path.
  const writable = openLedger(ledger.path);
  try {
    const leaseStore =
      input.steps === null
        ? null
        : openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledger.path), {
            incarnationId: input.steps.leaseStoreIncarnationId,
            createdAt: recordedAt,
          });
    try {
      const plane =
        leaseStore === null ? null : openArtifactPlane({ ledger: writable, leaseStore, ledgerPath: ledger.path });
      let outcome: RoadmapRevisionOutcome;
      try {
        outcome = recordRoadmapRevision({
          reader: ledger,
          writable,
          plane,
          initiativeId,
          request: {
            content: request.content,
            expectedHeadDigest: request.expectedHeadDigest,
            kind: request.kind,
            restoresVersionId: request.restoresVersionId,
            recordedBy: request.recordedBy,
            ...(request.steps === undefined ? {} : { steps: request.steps }),
          },
          recordedAt,
          roadmapVersionId,
          eventId,
          holderPid: input.steps === null ? null : input.steps.holderPid,
          stepIdentities: input.steps === null ? null : input.steps.identities,
        });
      } catch (error: unknown) {
        // The race loser hears the truth (R1). Two writers folded the same head
        // and assembled the same version number; the ledger's uniqueness let
        // exactly one through. The loser is not broken and its request was not
        // malformed — it is late, and "late" is a 409 it can act on. A retry
        // re-folds a head that has moved and gets a clean `HEAD_MISMATCH`.
        //
        // The door refused a version this seam's producer granted (P-26/A), or a
        // batch met a stream holding part of it (P-26 cut B): the producer and the
        // door ran the same decision over the same history, so by construction the
        // fold moved between the read and the append — another producer got there
        // first. One branch for both: a lost race, and no new word reaches a caller.
        //
        // Narrow by name: anything else is re-thrown untouched and still
        // classifies as `INTERNAL`.
        if (
          (error instanceof LedgerError && RACE_LOST_CODES.includes(error.code)) ||
          error instanceof LedgerRoadmapVersionRefusedError ||
          error instanceof LedgerInitiativeBatchConflictError
        ) {
          return Object.freeze({
            ok: false as const,
            reason: "WRITE_CONFLICT" as const,
            at: "roadmapVersion",
          });
        }
        throw error;
      }
      if (!outcome.ok) {
        return Object.freeze({ ok: false as const, reason: outcome.reason, at: outcome.at });
      }
      const recorded = outcome.version;
      return Object.freeze({
        ok: true as const,
        version: Object.freeze({
          roadmapVersionId: recorded.roadmapVersionId,
          initiativeId: recorded.initiativeId,
          version: recorded.version,
          contentDigest: recorded.contentDigest,
          parentVersionId: recorded.parentVersionId,
          kind: recorded.kind,
          restoresVersionId: recorded.restoresVersionId,
          recordedBy: recorded.recordedBy,
          recordedAt: recorded.recordedAt,
          stepCount: recorded.stepCount ?? null,
          stepManifestSha256: recorded.stepManifestSha256 ?? null,
        }),
        sequence: outcome.sequence,
      });
    } finally {
      leaseStore?.close();
    }
  } finally {
    writable.close();
  }
}

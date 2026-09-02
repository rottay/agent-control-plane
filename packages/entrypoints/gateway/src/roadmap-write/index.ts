import { dirname, join } from "node:path";

import { LEDGER_CONTRACT_VERSION } from "@acp/protocol";
import type { RoadmapVersionWriteRequest } from "@acp/protocol";
import { LedgerError, openLedger, publishArtifact } from "@acp/ledger";
import type { Ledger, RoadmapVersionReadModel } from "@acp/ledger";
import { ROADMAP_VERSION_REFUSALS, decideRoadmapVersion } from "@acp/ledger";
import type { RoadmapVersionRefusal } from "@acp/ledger";

/**
 * The roadmap-version write seam — the plane's only write.
 *
 * This module gathers what the decision needs, hands it over, and appends
 * exactly what a grant produced. It **decides nothing**: every law about when a
 * version may be recorded already lives in `decideRoadmapVersion`, which owns
 * the six-name refusal vocabulary and reasons over a folded head it is handed
 * rather than a ledger it reads. Re-checking any of that here would be a second
 * opinion about the same question, and two opinions drift.
 *
 * **The write capability is scoped to this module, and is short-lived.** The
 * server's long-lived handle is opened `{ readOnly: true }` at exactly one call
 * site and stays that way; a writable handle is opened here, used for one
 * append, and closed in a `finally`. The process therefore never holds a
 * writable ledger between requests, and the read path cannot append even by
 * mistake — it has no handle that could.
 *
 * **The envelope is this module's to construct**, under the house determinism
 * laws: the instant and the identifiers are **injected** rather than read from
 * a clock or a random source, so the same request with the same coordinates
 * builds the same event on every run. That is what makes the append idempotent
 * at the ledger's own key rather than merely usually-once.
 *
 * **Content goes to the store, the digest goes to the ledger.** The Checkpoint
 * law keeps content out of events, and the artifact store is content-addressed,
 * so publishing is idempotent: a retried write re-publishes the same bytes to
 * the same digest and writes nothing the second time.
 */

/** Where the artifacts live, relative to the ledger the server was given. */
export const ARTIFACT_DIRECTORY = "artifacts";

/**
 * The artifact root for a ledger path.
 *
 * A sibling of the database rather than a separate configured root: the ledger
 * owns the data root, and a second configurable location would be a second
 * answer to "where does a digest in this ledger resolve?".
 */
export function artifactRootFor(ledgerPath: string): string {
  return join(dirname(ledgerPath), ARTIFACT_DIRECTORY);
}

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
 * Record one roadmap version.
 *
 * The order is the design: publish the bytes, fold the head, decide, then
 * append. Publishing first means a refused decision leaves a stored artifact
 * nothing references — which is correct and cheap, because the store is
 * content-addressed and a later successful attempt with the same bytes finds
 * them already there. Appending first and publishing second would be the
 * unrecoverable order: an event naming a digest the store does not hold.
 */
export function recordRoadmapVersion(input: RoadmapWriteInput): RoadmapWriteOutcome {
  const { ledger, initiativeId, request, recordedAt, roadmapVersionId, eventId } = input;

  const published = publishArtifact(artifactRootFor(ledger.path), request.content);
  if (!published.ok) {
    return Object.freeze({ ok: false as const, reason: "CONTENT_REJECTED" as const, at: published.reason });
  }

  const knownVersions: readonly RoadmapVersionReadModel[] = ledger.listRoadmapVersions(initiativeId);
  const head = knownVersions.at(-1) ?? null;

  // The candidate is assembled, never accepted: `decideRoadmapVersion` parses
  // it through the contract itself and refuses what it does not like.
  const candidate = {
    contractVersion: LEDGER_CONTRACT_VERSION,
    roadmapVersionId,
    initiativeId,
    version: head === null ? 1 : head.version + 1,
    // The digest the store computed, never one this module derived. There is
    // one arithmetic on the content and the store owns it.
    contentDigest: published.digest,
    parentVersionId: head === null ? null : head.roadmapVersionId,
    expectedHeadDigest: request.expectedHeadDigest,
    kind: request.kind,
    restoresVersionId: request.restoresVersionId,
    recordedBy: request.recordedBy,
    recordedAt,
  };

  const decision = decideRoadmapVersion({ candidate, head, knownVersions });
  if (!decision.ok) {
    return Object.freeze({ ok: false as const, reason: decision.reason, at: decision.at });
  }

  const transitionId = "roadmap.v" + String(decision.version.version);
  const event = {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId,
    initiativeId,
    transitionId,
    idempotencyKey: initiativeId + "/1/" + transitionId,
    type: "ROADMAP_VERSION_RECORDED",
    fromStatus: "ACTIVE",
    toStatus: "ACTIVE",
    emittedBy: request.recordedBy,
    occurredAt: recordedAt,
    recordedAt,
    payload: decision.version,
  };

  // The short-lived writable handle: opened here, closed in `finally`, never
  // held between requests and never reachable from the read path.
  const writable = openLedger(ledger.path);
  try {
    let appended;
    try {
      appended = writable.appendInitiativeEvent(event);
    } catch (error: unknown) {
      // The race loser hears the truth (R1). Two writers folded the same head
      // and assembled the same version number; the ledger's uniqueness let
      // exactly one through. The loser is not broken and its request was not
      // malformed — it is late, and "late" is a 409 it can act on. A retry
      // re-folds a head that has moved and gets a clean `HEAD_MISMATCH`.
      //
      // Narrow by name: anything else is re-thrown untouched and still
      // classifies as `INTERNAL`.
      if (error instanceof LedgerError && RACE_LOST_CODES.includes(error.code)) {
        return Object.freeze({
          ok: false as const,
          reason: "WRITE_CONFLICT" as const,
          at: "roadmapVersion",
        });
      }
      throw error;
    }
    const recorded = decision.version;
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
      }),
      sequence: appended.record.sequence,
    });
  } finally {
    writable.close();
  }
}

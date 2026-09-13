/**
 * The value types of the projection's P-18/protocolo folds (CORR-2, ADR 0079).
 *
 * What a resolution reads as (escalón C), what an occurrence reads as and what
 * it links to (escalón D), and what an outbox event reads as and what the
 * outbox fold carries (escalón F): the shapes the pure readers hand the append
 * door and the fold, rejecting unions included. Declared in the concept that
 * owns them rather than in the package-wide `../../types/index.ts`, whose read
 * models they refer to and which stays where it is.
 *
 * A pure type leaf, on `packages/persistence/ledger/src/types/index.ts`'s
 * pattern: it declares data and nothing else and imports only types. The types
 * of the folds that predate P-18 stay in `../index.ts`; this leaf does not
 * reorganise them.
 *
 * `../index.ts` re-exports every name here, so no importer of the projection
 * sees a difference. One declaration is new rather than moved,
 * `DispatchOutcomeReading`; every other is the same declaration, moved.
 */

import type { ControlPlaneEvent } from "@acp/contracts";

import type { OutboxCommandKind, OutboxState, OutboxStream } from "../../outbox-store/index.js";
import type {
  CausationRef,
  DispatchState,
  EffectOutcomeStatus,
  OutboxCommandReadModel,
  OutboxFailureCode,
} from "../../types/index.js";

/**
 * What a resolution event says happened to one delivery, and to its effect.
 *
 * The third type is the one that is easy to leave out of a three-type cut, and
 * without it `dispatch_state` could never leave `INTENDED` and
 * `effect_read_model.outcome_status` could never be written at all. "Outcome"
 * here spans every move after the intention, because every one of them is a
 * report about how that delivery went: claimed locally, accepted externally,
 * settled, abandoned.
 *
 * `effectOutcomeStatus` is optional because not every move is also the effect's
 * ending — `INTENDED → CLAIMED` says nothing about the operation's result. When
 * it is present, the effect's pair is written from it and from this event's own
 * instant.
 *
 * `null` in the four optional fields means **the event did not say**, and only
 * that. A key the event carries with a value its grammar does not admit is never
 * read as absence: it makes the whole resolution a refusal, which is what
 * `DispatchOutcomeReading` is for (CORR-2, ADR 0079).
 */
export interface DispatchOutcomeRecord {
  readonly dispatchAttemptId: string;
  readonly dispatchState: DispatchState;
  readonly terminalAt: string | null;
  readonly acceptedAt: string | null;
  readonly externalHandle: string | null;
  readonly providerIdempotencyKey: string | null;
  readonly effectOutcomeStatus: EffectOutcomeStatus | null;
  readonly recordedAt: string;
  readonly sequence: number;
}

/**
 * How one resolution event reads: a record, or the field that stops it being one.
 *
 * `OccurrenceReading`'s shape, one escalón earlier in the chain: the append
 * door throws the refusal by name and the fold throws the same one, so a
 * rebuild refuses the history the door refuses with the door's own words. The
 * refusal is reserved for a field that is **present and inadmissible**; a
 * payload that is not a resolution at all — no record, no delivery, no state,
 * a terminal pair that disagrees — still reads as `null`, as it always has.
 */
export type DispatchOutcomeReading =
  | { readonly kind: "record"; readonly record: DispatchOutcomeRecord }
  | { readonly kind: "refused"; readonly path: string; readonly message: string };

/**
 * How one occurrence event reads: a row, or the reason it is not one.
 *
 * One reader serves both callers, which is the projection's founding rule applied
 * to a refusal as well as to a row. The append door throws the refusal by name;
 * the fold projects no row for it. Written twice, the door and a rebuild would
 * come to disagree about which payloads are occurrences, and the disagreement
 * would only surface as a rebuild quietly holding fewer rows than the live base.
 */
export type OccurrenceReading<T> =
  | { readonly kind: "row"; readonly row: T }
  | { readonly kind: "refused"; readonly path: string; readonly message: string };

/** Why one occurrence cannot be linked to what it claims to belong to. */
export interface OccurrenceRefusal {
  readonly path: string;
  readonly message: string;
}

/** The attempt coordinate a delivery's effect belongs to. */
export interface OccurrenceOwner {
  readonly taskId: string;
  readonly revisionNumber: number;
  readonly attemptNumber: number;
}

/** What an intention says, once its grammar has been checked. */
export interface OutboxCommandIntention {
  readonly sagaId: string;
  readonly commandId: string;
  readonly phase: string;
  readonly commandKind: OutboxCommandKind;
  readonly intentStream: OutboxStream;
  readonly targetKind: string;
  readonly targetId: string;
  readonly deadlineAt: string;
  readonly fence: number | null;
  readonly targetStoreIncarnationId: string | null;
}

/** What an attempt says. */
export interface OutboxDeliveryAttempt {
  readonly commandId: string;
  readonly deliveryAttemptId: string;
}

/** What an observation says. */
export interface OutboxDeliveryObservation {
  readonly commandId: string;
  readonly deliveryAttemptId: string;
  readonly outboxState: OutboxState;
  readonly failureCode: OutboxFailureCode | null;
  readonly responseHandle: string | null;
}

/**
 * How one outbox event reads: what it says, or the reason it says nothing.
 *
 * `readPromptOccurrence`'s rule, one escalón later: one reader serves the door
 * and the fold, so the two cannot come to disagree about which payloads are
 * commands.
 */
export type OutboxReading =
  | { readonly kind: "intention"; readonly row: OutboxCommandIntention }
  | { readonly kind: "attempt"; readonly row: OutboxDeliveryAttempt }
  | { readonly kind: "observation"; readonly row: OutboxDeliveryObservation }
  | { readonly kind: "refused"; readonly path: string; readonly message: string };

/**
 * One event as the outbox fold sees it: the event, where it sits, and what it
 * names as its cause.
 *
 * The digest and the causal reference are inputs no other fold of the projection needs,
 * because an outbox command is anchored on events rather than on rows: the
 * intention's own digest is what the cache stores as its anchor, and an
 * attempt's cause is what ties it to the intention it serves.
 */
export interface OutboxEventEntry {
  readonly event: ControlPlaneEvent;
  readonly sequence: number;
  readonly sha256: string;
  readonly causation: CausationRef | null;
}

/** One recorded delivery attempt: which command it serves and the event that recorded it. */
export interface OutboxAttemptRecord {
  readonly deliveryAttemptId: string;
  readonly commandId: string;
  readonly sequence: number;
  readonly sha256: string;
}

/** The event immediately before an intention: the one a revocation answers. */
export interface OutboxPredecessor {
  readonly taskId: string;
  readonly type: ControlPlaneEvent["type"];
  readonly toState: ControlPlaneEvent["toState"];
}

/**
 * The outbox fold over a whole stream: every command, every attempt, and the
 * last event seen.
 *
 * Kept apart from `ProjectionSnapshot` because what it folds is not a table.
 * `rebuildReadModel` and `verifyIntegrity` drive it beside the snapshot, so a
 * stored history the door would have refused fails at the event that caused it,
 * and `listOutboxCommands` drives it to answer what a lost cache would be
 * rebuilt to.
 */
export interface OutboxFold {
  readonly commands: Map<string, OutboxCommandReadModel>;
  readonly attempts: Map<string, OutboxAttemptRecord>;
  /** The event most recently folded, of any type, under its one key. Replaced, never accumulated. */
  readonly previous: Map<"event", OutboxPredecessor>;
}

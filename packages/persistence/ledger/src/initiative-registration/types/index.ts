/**
 * The value types of initiative registration (P-14 escalón B, ADR 0086).
 *
 * The two refusal vocabularies' derived unions, the recorded registration, the
 * decision and its request, the fields and identities a registration carries, the
 * test faults, the input, the registered initiative and the outcome: the
 * declarations this concept owns, in the concept's own leaf rather than interleaved
 * with the registration that writes them (owner law
 * `docs/audit/architecture/index.md` §7; the ADR 0088 errata of 2026-09-14
 * withdraws that record's "Types live inline in the module" for every new
 * declaration, and decision 90 registers this seam).
 *
 * A pure type leaf, on `../../types/index.ts`' and `../../outbox-store/types/index.ts`'
 * pattern: it declares data and nothing else, and imports only types. The closed sets
 * the unions are derived from stay in `../index.ts` beside the registration, and are
 * read here type-only, which is §7.1's one-way derivation and is erased at emit.
 *
 * Nothing was renamed and no field changed: these are the same declarations, moved,
 * and `../index.ts` re-exports every one of them, so no importer sees a difference.
 */

import type { Initiative, InitiativeStatus } from "@acp/contracts";
import type { ArtifactPlane } from "../../artifact-plane/index.js";
import type { Ledger } from "../../ledger/index.js";
import type {
  INITIATIVE_REGISTRATION_REFUSALS,
  INITIATIVE_REGISTRATION_WRITE_REFUSALS,
} from "../index.js";

export type InitiativeRegistrationRefusal = (typeof INITIATIVE_REGISTRATION_REFUSALS)[number];

export type InitiativeRegistrationWriteRefusal = (typeof INITIATIVE_REGISTRATION_WRITE_REFUSALS)[number];

/**
 * The registration the stream holds for an initiative, folded from its
 * `INITIATIVE_REGISTERED`.
 *
 * A registration written before the closed payload carries none of these facts,
 * and reads as nulls: a request compared against it differs on the slug, which
 * is the truth — the door cannot say the two are the same registration.
 */
export interface RecordedInitiativeRegistration {
  readonly initiativeId: string;
  readonly sequence: number;
  readonly slug: string | null;
  readonly title: string | null;
  readonly objectiveSha256: string | null;
  readonly objectiveArtifactReferenceId: string | null;
}

export interface InitiativeRegistrationDecisionRequest {
  /** The candidate initiative, composed by the caller. Parsed here, never trusted. */
  readonly candidate: unknown;
  /** The registration the stream holds under the candidate's id, or null. */
  readonly existing: RecordedInitiativeRegistration | null;
}

export type InitiativeRegistrationDecision =
  | {
      readonly ok: true;
      readonly replay: false;
      readonly initiative: Initiative;
      /** The SHA-256 of the objective's UTF-8 bytes. */
      readonly objectiveSha256: string;
      readonly objectiveBytes: Uint8Array;
    }
  | { readonly ok: true; readonly replay: true; readonly existing: RecordedInitiativeRegistration }
  | {
      readonly ok: false;
      readonly reason: InitiativeRegistrationRefusal;
      /** The field that failed. Never its value. */
      readonly at: string;
    };

/** What a door hands over. Structural: the doors parse their own request schema first. */
export interface InitiativeRegistrationFields {
  readonly initiativeId: string;
  readonly slug: string;
  readonly title: string;
  readonly objective: string;
  readonly recordedBy: string;
}

/** The identifiers a door mints for one attempt. A retry's are ignored once an intention stands. */
export interface InitiativeRegistrationIdentities {
  /** The `INITIATIVE_REGISTERED` event's id. */
  readonly eventId: string;
  readonly commandId: string;
  readonly artifactPinId: string;
  readonly artifactReferenceId: string;
  readonly intentionEventId: string;
  readonly terminalEventId: string;
}

/** Test-only fault points. Production callers never set this. */
export interface InitiativeRegistrationTestFaults {
  /** The objective is published and referenced; the registration is not appended yet. */
  readonly afterObjectivePublished?: (() => void) | undefined;
}

export interface InitiativeRegistrationInput {
  /** A writable ledger. The registration and the plane append through it. */
  readonly ledger: Ledger;
  /** The private plane of the same ledger. */
  readonly plane: ArtifactPlane;
  readonly request: InitiativeRegistrationFields;
  /** Injected: the recording instant, ISO-8601 in UTC with milliseconds. */
  readonly recordedAt: string;
  /** Injected: the pid the objective's holding records. */
  readonly holderPid: number;
  readonly identities: InitiativeRegistrationIdentities;
  /** Test-only. */
  readonly __testFaults?: InitiativeRegistrationTestFaults;
}

/** The registration a response is built from: the row that exists, and its slug. */
export interface RegisteredInitiative {
  readonly initiativeId: string;
  readonly slug: string;
  readonly title: string;
  readonly objectiveSha256: string;
  readonly status: InitiativeStatus;
  readonly eventCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type InitiativeRegistrationOutcome =
  | {
      readonly ok: true;
      /** true when the stream already held this registration and nothing was written. */
      readonly replayed: boolean;
      /** The initiative-stream position of the registration. */
      readonly sequence: number;
      readonly registration: RegisteredInitiative;
    }
  | {
      readonly ok: false;
      readonly reason: InitiativeRegistrationWriteRefusal;
      /** A field path or the plane's own word. Never a value. */
      readonly at: string;
    };

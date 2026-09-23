/**
 * The value types of registry publication (P-15 escalón R, ADR 0104).
 *
 * The refusal vocabulary's derived unions, the request a door hands over, the input
 * and the outcome: the declarations this concept owns, in the concept's own leaf
 * rather than interleaved with the publication that writes them (owner law
 * `docs/audit/architecture/index.md` §7; the initiative registration's leaf is the
 * precedent).
 *
 * A pure type leaf: it declares data and nothing else, and imports only types. The
 * closed sets the unions are derived from stay in `../index.ts` beside the
 * publication, and are read here type-only, which is §7.1's one-way derivation and
 * is erased at emit.
 */

import type { Ledger } from "../../ledger/index.js";
import type { DocumentKind, RegistryEventRecord } from "../../types/index.js";
import type { PUBLISHABLE_DOCUMENT_KINDS, REGISTRY_PUBLICATION_REFUSALS } from "../index.js";

export type PublishableDocumentKind = (typeof PUBLISHABLE_DOCUMENT_KINDS)[number];

export type RegistryPublicationRefusal = (typeof REGISTRY_PUBLICATION_REFUSALS)[number];

/**
 * What the operator states, and nothing the door derives.
 *
 * Structural: a door parses its own request schema first. `documentKind` is a string
 * rather than a `DocumentKind`, because a kind outside the three is refused here by
 * name (`REGISTRY_KIND_NOT_PUBLISHABLE`) and not by a type the caller had to satisfy.
 */
export interface RegistryPublicationFields {
  readonly documentKind: string;
  readonly documentId: string;
  readonly documentVersion: number;
  /** Null exactly on a first version; otherwise the version this one supersedes. */
  readonly parentDocumentVersion: number | null;
  /** The instant from which the version rules, ISO-8601 in UTC with milliseconds. */
  readonly effectiveFrom: string;
  readonly recordedBy: string;
  readonly payload: Record<string, unknown>;
}

export interface RegistryPublicationInput {
  /** A writable ledger. The publication appends through it. */
  readonly ledger: Ledger;
  readonly request: RegistryPublicationFields;
  /** Injected: the door's instant, ISO-8601 in UTC with milliseconds. It is both `occurredAt` and `recordedAt`. */
  readonly recordedAt: string;
}

/** The version a publication recorded, or found recorded. */
export interface PublishedRegistryDocument {
  readonly documentKind: DocumentKind;
  readonly documentId: string;
  readonly documentVersion: number;
  readonly parentDocumentVersion: number | null;
  readonly contentDigest: string;
  readonly effectiveFrom: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly eventId: string;
}

export type RegistryPublicationOutcome =
  | {
      readonly ok: true;
      /** true when the stream already held this version and nothing was appended. */
      readonly replayed: boolean;
      /** The registry-stream position of the version. */
      readonly sequence: number;
      readonly document: PublishedRegistryDocument;
      /** The record the stream holds. */
      readonly record: RegistryEventRecord;
    }
  | {
      readonly ok: false;
      readonly reason: RegistryPublicationRefusal;
      /** The field that failed. Never its value. */
      readonly at: string;
      /**
       * The closed word at the head of the door's refusal (`PRICE_TABLE_REFUSALS`,
       * `GLOBAL_ASSIGNMENT_REFUSALS`, `REGISTRY_DOCUMENT_REFUSALS`), or null when the
       * door's issue carries none.
       */
      readonly word: string | null;
    };

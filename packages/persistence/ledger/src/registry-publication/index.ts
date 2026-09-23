import { createHash } from "node:crypto";

import { CONTRACT_VERSION } from "@acp/contracts";

import { canonicalJsonStringify, sha256Hex } from "../canonical-json/index.js";
import {
  LedgerCanonicalizationError,
  LedgerError,
  LedgerIntegrityError,
  LedgerQueryError,
  LedgerValidationError,
} from "../errors/index.js";
import { normalizeRegistryDocument } from "../ledger/index.js";
import type { Ledger } from "../ledger/index.js";
import type { RegistryDocument, RegistryEventRecord } from "../types/index.js";

import type {
  PublishableDocumentKind,
  PublishedRegistryDocument,
  RegistryPublicationInput,
  RegistryPublicationOutcome,
  RegistryPublicationRefusal,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and
 * are re-exported here unchanged so every importer reads them from this module
 * (owner law §7; the initiative registration's precedent).
 */
export type {
  PublishableDocumentKind,
  PublishedRegistryDocument,
  RegistryPublicationFields,
  RegistryPublicationInput,
  RegistryPublicationOutcome,
  RegistryPublicationRefusal,
} from "./types/index.js";

/**
 * Registry publication — P-15 escalón R, ADR 0104.
 *
 * ## What this is
 *
 * The one orchestration that publishes a configuration version a first task needs:
 * a `MODEL_VERSION`, a `ROUTING_ASSIGNMENT_GLOBAL` and a `PRICE_TABLE`. The CLI's
 * `acp registry` calls it; no other door exists (CLI only, decision 128). It is the
 * one caller of `appendRegistryEvent` in production source (L-P15R-1), so the next
 * producer cannot skip its idempotence or its refusals.
 *
 * It opens nothing and reads no clock: the writable ledger and the door's instant
 * arrive with the input.
 *
 * ## What the operator states, and what the door derives
 *
 * The operator states the kind, the document and its version, the parent, the
 * instant from which the version rules, the author and the payload. The door
 * derives, and never accepts:
 *
 * - `contentDigest`, the SHA-256 of the payload's canonical JSON (ND-R1 (a)): these
 *   three kinds carry their content inline, and the ledger door verifies the digest;
 * - `idempotencyKey`, `registry/<documentId>/<documentVersion>`, one per version;
 * - `eventId`, a version 5 UUID over that key under
 *   `REGISTRY_PUBLICATION_UUID_NAMESPACE`, so an exact retry derives the same id;
 * - `occurredAt` and `recordedAt`, the door's instant;
 * - `contractVersion`, the version in force.
 *
 * ## Validation stays the ledger door's
 *
 * No second validator lives here. The payload's shape, the model versions a
 * routing assignment or a price interval names, the lineage and the two P-15/R
 * rules (the digest, a `PRICE_TABLE` instant already taken) are the ledger door's.
 * This module reads the door's typed refusal and answers it as
 * `REGISTRY_DOCUMENT_REFUSED`, with the field and the door's closed word. The
 * candidate is parsed by the door's own `normalizeRegistryDocument` before it is
 * compared with anything recorded, so a form problem is never answered as a
 * conflict.
 *
 * ## Idempotent by document and version
 *
 * Before appending, the version the stream holds at `(documentId, documentVersion)`
 * is read. The same kind, digest, parent and instant is a replay: nothing is
 * appended and the recorded version is answered. The author and the door's instants
 * are not compared — a retry reads a new clock, and who repeats a publication does
 * not make it another version. Any other difference is `REGISTRY_VERSION_CONFLICT`
 * naming the first field that differs, never a new version. A version recorded
 * before this door, with a placeholder digest, therefore conflicts at
 * `contentDigest` when republished through it. A lost race re-reads and decides
 * again.
 *
 * ## Never a price it was not given
 *
 * A `PRICE_TABLE` is data the owner supplies. Nothing here defaults an interval,
 * fills an `effectiveTo`, assumes a currency, or derives, scales or rounds a price:
 * the payload is stored as it came, or refused.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The three kinds this door publishes. The other eleven have owners in later packets. */
export const PUBLISHABLE_DOCUMENT_KINDS = ["MODEL_VERSION", "PRICE_TABLE", "ROUTING_ASSIGNMENT_GLOBAL"] as const;

/**
 * The publication's closed refusal vocabulary, sorted.
 *
 * - `REGISTRY_DOCUMENT_REFUSED` — the ledger door refused the document; `at` is the
 *   field and `word` the door's closed word, when its issue carries one.
 * - `REGISTRY_KIND_NOT_PUBLISHABLE` — a kind outside `PUBLISHABLE_DOCUMENT_KINDS`.
 * - `REGISTRY_VERSION_CONFLICT` — the version is recorded with another kind, digest,
 *   parent or instant.
 * - `REGISTRY_WRITE_CONFLICT` — another writer's append lost this one the race and a
 *   re-read found no version to decide against.
 */
export const REGISTRY_PUBLICATION_REFUSALS = [
  "REGISTRY_DOCUMENT_REFUSED",
  "REGISTRY_KIND_NOT_PUBLISHABLE",
  "REGISTRY_VERSION_CONFLICT",
  "REGISTRY_WRITE_CONFLICT",
] as const;

/**
 * The namespace every publication's event id is derived under (version 5).
 *
 * Its own constant, distinct from the runtime's and the providers', so a
 * publication's id can never collide with an id derived from the same words
 * elsewhere. Pinned by a vector: changing it changes every id a retry derives.
 */
export const REGISTRY_PUBLICATION_UUID_NAMESPACE = "2f704b2b-1dc7-40df-b428-95feb11010de";

/** The idempotency key of one version: `registry/<documentId>/<documentVersion>`. */
export function registryPublicationIdempotencyKey(documentId: string, documentVersion: number): string {
  return "registry/" + documentId + "/" + String(documentVersion);
}

/** The event id of one version: a version 5 UUID over its idempotency key. */
export function registryPublicationEventId(documentId: string, documentVersion: number): string {
  const digest = createHash("sha1")
    .update(Buffer.from(REGISTRY_PUBLICATION_UUID_NAMESPACE.replaceAll("-", ""), "hex"))
    .update(registryPublicationIdempotencyKey(documentId, documentVersion), "utf8")
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

/** The digest an inline-content document carries: the SHA-256 of its payload's canonical JSON. */
export function registryPayloadDigest(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalJsonStringify(payload));
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * The fields a replay compares, in the order a reader of a conflict wants them.
 * The author and the door's instants are not among them.
 */
const SEMANTIC_FIELDS = ["documentKind", "contentDigest", "parentDocumentVersion", "effectiveFrom"] as const;

function refuse(reason: RegistryPublicationRefusal, at: string, word: string | null = null): RegistryPublicationOutcome & { ok: false } {
  return Object.freeze({ ok: false as const, reason, at, word });
}

function publishedOf(record: RegistryEventRecord): PublishedRegistryDocument {
  const { document } = record;
  return Object.freeze({
    documentKind: document.documentKind,
    documentId: document.documentId,
    documentVersion: document.documentVersion,
    parentDocumentVersion: document.parentDocumentVersion,
    contentDigest: document.contentDigest,
    effectiveFrom: document.effectiveFrom,
    recordedBy: document.recordedBy,
    recordedAt: document.recordedAt,
    eventId: record.eventId,
  });
}

function answered(record: RegistryEventRecord, replayed: boolean): RegistryPublicationOutcome {
  return Object.freeze({ ok: true as const, replayed, sequence: record.sequence, document: publishedOf(record), record });
}

/**
 * Decide a candidate against the version the stream holds at its coordinate: a
 * replay, a conflict naming the first field that differs, or nothing recorded.
 */
function decideAgainst(
  candidate: RegistryDocument,
  existing: RegistryEventRecord | null,
): RegistryPublicationOutcome | null {
  if (existing === null) return null;
  for (const field of SEMANTIC_FIELDS) {
    if (existing.document[field] !== candidate[field]) return refuse("REGISTRY_VERSION_CONFLICT", field);
  }
  return answered(existing, true);
}

/** The ledger door's refusal, as the publication answers it: the field and the closed word. */
function documentRefused(error: LedgerValidationError): RegistryPublicationOutcome & { ok: false } {
  const issue = error.issues[0];
  const word = issue === undefined ? null : (/^([A-Z][A-Z0-9_]*):/.exec(issue.message)?.[1] ?? null);
  return refuse("REGISTRY_DOCUMENT_REFUSED", issue?.path ?? "<root>", word);
}

/**
 * The ledger codes that mean another writer got there first. Matched by name, for
 * the initiative registration's reason: a lost race is re-read and re-decided, and
 * any other ledger fault keeps throwing.
 */
const RACE_LOST_CODES: readonly string[] = Object.freeze(["LEDGER_IDEMPOTENCY_CONFLICT", "LEDGER_EVENT_ID_CONFLICT"]);

/**
 * The version the stream holds at a coordinate, or null. A coordinate the read
 * refuses holds nothing: the append then meets the door, which refuses the same
 * field by name.
 */
function versionAt(ledger: Ledger, documentId: string, documentVersion: number): RegistryEventRecord | null {
  try {
    return ledger.getRegistryDocumentVersion(documentId, documentVersion);
  } catch (error: unknown) {
    if (error instanceof LedgerQueryError) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

/**
 * Publish one version of a `MODEL_VERSION`, a `ROUTING_ASSIGNMENT_GLOBAL` or a
 * `PRICE_TABLE`.
 *
 * The order is the design: the kind, the derivations, the recorded version, then the
 * append. A kind outside the three appends nothing. A recorded version is answered
 * or conflicts before any append. The ledger door refuses what is not admissible.
 */
export function publishRegistryDocument(input: RegistryPublicationInput): RegistryPublicationOutcome {
  const { ledger, request } = input;

  if (!(PUBLISHABLE_DOCUMENT_KINDS as readonly string[]).includes(request.documentKind)) {
    return refuse("REGISTRY_KIND_NOT_PUBLISHABLE", "documentKind");
  }
  const documentKind = request.documentKind as PublishableDocumentKind;

  let contentDigest: string;
  try {
    contentDigest = registryPayloadDigest(request.payload);
  } catch (error: unknown) {
    // A payload with no canonical JSON form has no digest to derive.
    if (error instanceof LedgerCanonicalizationError) return refuse("REGISTRY_DOCUMENT_REFUSED", "payload");
    throw error;
  }

  const candidate = {
    contractVersion: CONTRACT_VERSION,
    eventId: registryPublicationEventId(request.documentId, request.documentVersion),
    idempotencyKey: registryPublicationIdempotencyKey(request.documentId, request.documentVersion),
    documentKind,
    documentId: request.documentId,
    documentVersion: request.documentVersion,
    parentDocumentVersion: request.parentDocumentVersion,
    contentDigest,
    recordedBy: request.recordedBy,
    effectiveFrom: request.effectiveFrom,
    occurredAt: input.recordedAt,
    recordedAt: input.recordedAt,
    payload: request.payload,
  } satisfies RegistryDocument;

  // The door's own parse, first: a form problem is refused as one, at its field,
  // before any comparison could report it as a conflict with a recorded version.
  let document: RegistryDocument;
  try {
    document = normalizeRegistryDocument(candidate);
  } catch (error: unknown) {
    if (error instanceof LedgerValidationError) return documentRefused(error);
    throw error;
  }

  const decided = decideAgainst(document, versionAt(ledger, document.documentId, document.documentVersion));
  if (decided !== null) return decided;

  let appended;
  try {
    appended = ledger.appendRegistryEvent(document);
  } catch (error: unknown) {
    if (error instanceof LedgerValidationError) {
      // A version another writer recorded between the read and the append reaches
      // the lineage check as a version already held: re-read and decide again.
      const again = decideAgainst(document, versionAt(ledger, document.documentId, document.documentVersion));
      if (again !== null) return again;
      return documentRefused(error);
    }
    if (!(error instanceof LedgerError) || !RACE_LOST_CODES.includes(error.code)) throw error;
    // The race loser re-reads and decides again: whoever won either recorded this
    // version — a replay — or another — a conflict.
    const again = decideAgainst(document, versionAt(ledger, document.documentId, document.documentVersion));
    return again ?? refuse("REGISTRY_WRITE_CONFLICT", "documentVersion");
  }

  if (appended.record.document.contentDigest !== contentDigest) {
    throw new LedgerIntegrityError(["an appended registry version reads back with another digest"]);
  }
  return answered(appended.record, !appended.inserted);
}

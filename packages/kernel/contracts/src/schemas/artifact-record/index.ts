/**
 * The artifact record — `@acp/contracts` (P-36/local escalón A, ADR 0081).
 *
 * The vocabularies of artifacts §2 and the strict shape of the six events the
 * ledger's artifact plane records in `registry_events`, with
 * `subject_kind = 'ARTIFACT'`.
 *
 * **Storage of facts, never of bytes.** Every field below is an identifier, a
 * digest, a count, a vocabulary word or an instant. The bytes a digest names
 * live beside the database, and nothing in this module can carry them: the
 * credential and transcript guards run over the whole event, exactly as they do
 * over `ControlPlaneEvent`.
 *
 * **Nine words, six shapes.** `ARTIFACT_EVENT_KINDS` is the closed vocabulary
 * of the contract — version 1, nine names — and the base's CHECK names all nine
 * so that P-36 completo does not rebuild the authority a second time. This
 * escalón delivers six of them. The other three (`RECLAIM_INTENDED`,
 * `RECLAIM_COMPLETED`, `REFERENCE_TOMBSTONED`) have no shape here and are
 * refused by name at the ledger's door, before this schema is asked.
 *
 * **No identity is computed here.** `artifactReferenceId`, `artifactPinId` and
 * `commandId` are identifiers the producer carries; none is derived from a
 * digest or from anything else. A derivation would be a preimage, and a
 * preimage is a version of the contract (ADR 0076's criterion, fixed for this
 * escalón by the DT: no bump).
 *
 * The module imports `zod` and its sibling primitives and nothing else. It
 * opens no file and reads no clock.
 */

import { z } from "zod";
import { attachGuards } from "../credential-guards/index.js";
import { CanonicalInstant, ContractVersion, Sha256Hex, Uuid } from "../primitives/index.js";
import { WorkerIdentityString } from "../worker-identity/index.js";

// ---------------------------------------------------------------------------
// Vocabularies (artifacts §2)
// ---------------------------------------------------------------------------

/**
 * What an artifact is. Closed, version 1: a new class is a version of the
 * contract. The attribute is `artifact_class`, never an ambiguous `kind`.
 */
export const ARTIFACT_CLASSES = [
  "TASK_ENVELOPE",
  "PROMPT",
  "RESPONSE",
  "TOOL_ARGUMENT",
  "TOOL_RESULT",
  "CHECKPOINT",
  "RECEIPT",
  "EVIDENCE",
  "PLAN_DOCUMENT",
  "POLICY_DOCUMENT",
  "PRICE_CATALOG",
  "EXPORT",
] as const;
export const ArtifactClass = z.enum(ARTIFACT_CLASSES);
export type ArtifactClass = z.infer<typeof ArtifactClass>;

/**
 * Which channel may carry a reference. `SECRET_BEARING` is a word of the
 * vocabulary and is never published in the stream: the ledger refuses it by
 * name. It is not a permission to store credentials.
 */
export const ARTIFACT_CLASSIFICATIONS = [
  "PUBLIC_SAFE",
  "INTERNAL",
  "SENSITIVE",
  "SECRET_BEARING",
] as const;
export const ArtifactClassification = z.enum(ARTIFACT_CLASSIFICATIONS);
export type ArtifactClassification = z.infer<typeof ArtifactClassification>;

export const ENCRYPTION_STATUSES = ["PLAINTEXT", "ENCRYPTED_AT_REST"] as const;
export const EncryptionStatus = z.enum(ENCRYPTION_STATUSES);
export type EncryptionStatus = z.infer<typeof EncryptionStatus>;

/** Fixes the grace period and the default expiry. */
export const RETENTION_CLASSES = ["EPHEMERAL", "STANDARD", "EXTENDED", "PERMANENT"] as const;
export const RetentionClass = z.enum(RETENTION_CLASSES);
export type RetentionClass = z.infer<typeof RetentionClass>;

export const REFERENCE_SCOPE_KINDS = ["INITIATIVE", "TASK", "ACCOUNT", "SYSTEM"] as const;
export const ReferenceScopeKind = z.enum(REFERENCE_SCOPE_KINDS);
export type ReferenceScopeKind = z.infer<typeof ReferenceScopeKind>;

/** The state of a **blob generation**, never of a reference. */
export const BLOB_LIFECYCLE_STATES = [
  "STAGED",
  "PUBLISHED",
  "PUBLICATION_ABANDONED",
  "RECLAIM_INTENDED",
  "RECLAIMED",
] as const;
export const BlobLifecycleState = z.enum(BLOB_LIFECYCLE_STATES);
export type BlobLifecycleState = z.infer<typeof BlobLifecycleState>;

/** The nine event names of the contract, all of them, in artifacts §2's order. */
export const ARTIFACT_EVENT_KINDS = [
  "PUBLICATION_INTENDED",
  "PUBLICATION_SUCCEEDED",
  "PUBLICATION_ABANDONED",
  "REFERENCE_RECORDED",
  "PIN_ACQUIRED",
  "PIN_RELEASED",
  "RECLAIM_INTENDED",
  "RECLAIM_COMPLETED",
  "REFERENCE_TOMBSTONED",
] as const;
export const ArtifactEventKind = z.enum(ARTIFACT_EVENT_KINDS);
export type ArtifactEventKind = z.infer<typeof ArtifactEventKind>;

/** Why a pin exists (artifacts §5, `ck_artifact_pin_read_model__pin_holder_kind_enum`). */
export const PIN_HOLDER_KINDS = ["PUBLICATION", "TASK", "BACKUP", "LEGAL_HOLD"] as const;
export const PinHolderKind = z.enum(PIN_HOLDER_KINDS);
export type PinHolderKind = z.infer<typeof PinHolderKind>;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * An identifier the producer carries. The bound is the registry door's own
 * (`REGISTRY_IDENTIFIER_MAX`), because every identifier here may become a
 * `registry_events.document_id`.
 */
const Identifier = z.string().min(1).max(512);

/**
 * The one instant form the registry stores: the canonical instant (P-15 escalón I,
 * ADR 0106), read from `primitives`, the one predicate. Stricter than `Timestamp`,
 * which admits an offset: the ledger orders these lexicographically and records
 * `first_published_at` verbatim, so two spellings of one instant would be two facts.
 */
const Instant = CanonicalInstant;

const Count = z.number().int().positive();

/** The reference half of `PUBLICATION_SUCCEEDED` and `REFERENCE_RECORDED` (artifacts §4). */
const ArtifactReferenceRecord = z
  .strictObject({
    artifactReferenceId: Identifier,
    artifactClass: ArtifactClass,
    classification: ArtifactClassification,
    scopeKind: ReferenceScopeKind,
    scopeId: Identifier.nullable(),
    producerIdentity: WorkerIdentityString,
    accessPolicyId: Identifier,
    retentionClass: RetentionClass,
    expiresAt: Instant.nullable(),
  })
  .superRefine((value, ctx) => {
    // `ck_artifact_reference_read_model__scope_id_matches_scope_kind`: NULL
    // only for SYSTEM. One direction, as the dictionary writes it.
    if (value.scopeId === null && value.scopeKind !== "SYSTEM") {
      ctx.addIssue({
        code: "custom",
        message: "a reference names its owning scope; only a SYSTEM scope has none",
        path: ["scopeId"],
      });
    }
    // `ck_artifact_reference_read_model__expires_at_matches_retention_class`.
    if ((value.expiresAt === null) !== (value.retentionClass === "PERMANENT")) {
      ctx.addIssue({
        code: "custom",
        message: "a reference expires if and only if its retention class is not PERMANENT",
        path: ["expiresAt"],
      });
    }
  });

/**
 * The intention of a publication (artifacts §8, step 2).
 *
 * `intendedReference` is the reference the publication will record if it
 * succeeds, stated before a byte moves (P-36/local escalón C, ADR 0083, decision
 * 64). Artifacts §8 `:260-262` lets reconciliation "complete the original
 * reference" after a crash between the rename and the success, and without this
 * block nothing durable says which reference that was. It is the whole
 * `ArtifactReferenceRecord` — the id included, which is what makes the completed
 * reference the original one — with its two refinements inherited rather than
 * restated.
 *
 * **Facts, not identity.** The fold reads no field of it, no key is derived from
 * it, and a body without it parses exactly as before: optional in the schema,
 * so a historical intention keeps its digest and a reader of either shape reads
 * both. That is ADR 0076's criterion for staying on the version in force. The
 * private plane always writes it; an intention without it can only come from
 * another producer, and reconciliation abandons one rather than invent a
 * reference.
 */
const PublicationIntendedPayload = z
  .strictObject({
    commandId: Identifier,
    contentSha256: Sha256Hex,
    blobGeneration: Count,
    mediaType: z.string().min(1).max(100),
    sizeBytes: z.number().int().nonnegative(),
    encryptionStatus: EncryptionStatus,
    keyReference: Identifier.nullable(),
    encryptionProfile: Identifier,
    artifactPinId: Identifier,
    intendedReference: ArtifactReferenceRecord.optional(),
  })
  .superRefine((value, ctx) => {
    // `ck_artifact_blob_read_model__key_reference_matches_encryption`.
    if ((value.keyReference === null) !== (value.encryptionStatus === "PLAINTEXT")) {
      ctx.addIssue({
        code: "custom",
        message: "a key reference is carried if and only if the blob is encrypted at rest",
        path: ["keyReference"],
      });
    }
  });

const PublicationSucceededPayload = z.strictObject({
  commandId: Identifier,
  contentSha256: Sha256Hex,
  blobGeneration: Count,
  artifactPinId: Identifier,
  reference: ArtifactReferenceRecord,
});

const PublicationAbandonedPayload = z.strictObject({
  commandId: Identifier,
  contentSha256: Sha256Hex,
  blobGeneration: Count,
  artifactPinId: Identifier,
});

const ReferenceRecordedPayload = z.strictObject({
  contentSha256: Sha256Hex,
  blobGeneration: Count,
  reference: ArtifactReferenceRecord,
});

const PinAcquiredPayload = z.strictObject({
  artifactPinId: Identifier,
  contentSha256: Sha256Hex,
  blobGeneration: Count,
  pinHolderKind: PinHolderKind,
  pinHolderId: Identifier,
});

const PinReleasedPayload = z.strictObject({
  artifactPinId: Identifier,
  contentSha256: Sha256Hex,
  blobGeneration: Count,
});

/**
 * The fields every artifact event carries, beside its kind and its payload.
 *
 * `subjectOrdinal` is the position of this event among the events of its
 * subject — `1 + MAX` over the subject, proposed by the producer and verified
 * by the ledger. `parentSubjectOrdinal` is the one before it, or null on the
 * first. Both land in `document_version` and `parent_document_version`, and
 * `subjectKind` and `artifactEventKind` land in columns of their own; all four
 * are also here, inside the body the chain digests, because a column is outside
 * the preimage.
 */
const common = {
  contractVersion: ContractVersion,
  eventId: Uuid,
  idempotencyKey: Identifier,
  subjectKind: z.literal("ARTIFACT"),
  subjectOrdinal: Count,
  parentSubjectOrdinal: Count.nullable(),
  recordedBy: Identifier,
  occurredAt: Instant,
  recordedAt: Instant,
};

/**
 * One artifact event, as `registry_events` records it (artifacts §8.1).
 *
 * Six shapes, discriminated by `artifactEventKind`. Strict at every level, so a
 * drifting producer fails closed instead of smuggling state into the stream.
 */
export const ArtifactRegistryEvent = z
  .discriminatedUnion("artifactEventKind", [
    z.strictObject({
      ...common,
      artifactEventKind: z.literal("PUBLICATION_INTENDED"),
      payload: PublicationIntendedPayload,
    }),
    z.strictObject({
      ...common,
      artifactEventKind: z.literal("PUBLICATION_SUCCEEDED"),
      payload: PublicationSucceededPayload,
    }),
    z.strictObject({
      ...common,
      artifactEventKind: z.literal("PUBLICATION_ABANDONED"),
      payload: PublicationAbandonedPayload,
    }),
    z.strictObject({
      ...common,
      artifactEventKind: z.literal("REFERENCE_RECORDED"),
      payload: ReferenceRecordedPayload,
    }),
    z.strictObject({
      ...common,
      artifactEventKind: z.literal("PIN_ACQUIRED"),
      payload: PinAcquiredPayload,
    }),
    z.strictObject({
      ...common,
      artifactEventKind: z.literal("PIN_RELEASED"),
      payload: PinReleasedPayload,
    }),
  ])
  .superRefine((value, ctx) => {
    // Law 4 and law 5, over the whole event, exactly as `ControlPlaneEvent`
    // runs them. A credential key or a secret-shaped value anywhere in the tree
    // is refused, and the issue names the path, never the value.
    attachGuards(value, ctx, { transcript: true });

    // The ordinal is contiguous per subject, so its parent is not a free
    // choice: the first event has none, and every later one names the one
    // immediately before it.
    const expectedParent = value.subjectOrdinal === 1 ? null : value.subjectOrdinal - 1;
    if (value.parentSubjectOrdinal !== expectedParent) {
      ctx.addIssue({
        code: "custom",
        message:
          "a subject's first event has no parent ordinal, and every later one names the ordinal immediately before it",
        path: ["parentSubjectOrdinal"],
      });
    }

    // Fixed width, UTC, zero-padded: lexicographic order is exact here.
    if (value.recordedAt < value.occurredAt) {
      ctx.addIssue({
        code: "custom",
        message: "an artifact event is recorded no earlier than it occurred",
        path: ["recordedAt"],
      });
    }
  });
export type ArtifactRegistryEvent = z.infer<typeof ArtifactRegistryEvent>;

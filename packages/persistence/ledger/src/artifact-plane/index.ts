import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { ArtifactRegistryEvent, CONTRACT_VERSION, REFERENCE_SCOPE_KINDS, isSha256Hex } from "@acp/contracts";

import type {
  ArtifactBlobLeaseGrant,
  ArtifactBlobLeaseStore,
  ArtifactBlobLeaseOutcome,
  ArtifactBlobLeaseQuiescence,
  ArtifactBlobLeaseRefusal,
  ArtifactBlobLeaseRow,
  ArtifactBlobLeaseToken,
} from "../artifact-lease-store/index.js";
import { canonicalJsonStringify, sha256Hex } from "../canonical-json/index.js";
import {
  LedgerError,
  LedgerIdempotencyConflictError,
  LedgerIntegrityError,
  LedgerOpenError,
  LedgerQueryError,
  LedgerValidationError,
  type LedgerValidationIssue,
} from "../errors/index.js";
import {
  ARTIFACT_ACCESS_POLICY_IDS,
  type ArtifactEventRecord,
} from "../types/index.js";

import type {
  ArtifactEventIdentity,
  ArtifactPlane,
  ArtifactPlaneHolding,
  ArtifactPlaneOutcome,
  ArtifactPlaneRefusal,
  ArtifactPublicationRequest,
  ArtifactReadOutcome,
  ArtifactReadRequest,
  ArtifactReconciliationRequest,
  ArtifactReferenceIntent,
  CheckedPublication,
  Entry,
  Inspection,
  IntendedEvent,
  OpenArtifactPlaneOptions,
  Placement,
  ReferenceReadOutcome,
  Work,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf,
 * `./types/index.ts`, and are re-exported here unchanged so every importer
 * keeps reading them from this module (owner law §7, ADR 0088 errata,
 * decision 90; `outbox-store`'s and `projection`'s precedent).
 */
export type {
  ArtifactPlaneRefusal,
  ArtifactReferenceIntent,
  ArtifactEventIdentity,
  ArtifactPlaneHolding,
  ArtifactPublicationRequest,
  ArtifactReconciliationRequest,
  ArtifactReadRequest,
  ArtifactPlaneOutcome,
  ArtifactReadOutcome,
  ArtifactPlaneTestFaults,
  ReferenceReadOutcome,
  ReferenceReadRefusal,
  OpenArtifactPlaneOptions,
  ArtifactPlane,
} from "./types/index.js";

/**
 * The private artifact plane — P-36/local escalón C.
 *
 * ## What this is
 *
 * The publisher, the reader and the reconciler of artifacts §8 and §10, over
 * the two substrates the earlier escalones delivered: the ledger's artifact
 * events and read models (A, ADR 0081) and the blob lease store (B, ADR 0082).
 * It is the first module in this package that moves the bytes a digest names,
 * and it moves them in its own subroot — `private-artifacts/`, beside the
 * ledger, produced only by {@link artifactPlaneRootFor} — so the legacy digest
 * store and its readers, which resolve a bare digest, cannot reach a private
 * object at all (adjudication 2, decision 65).
 *
 * ## The order, and why it is the whole design
 *
 * Artifacts §8 `:238-252`, step by step, and nothing in between:
 *
 * 1. the blob lease, `PUBLISH`, taken before anything else is looked at;
 * 2. `PUBLICATION_INTENDED` through `appendArtifactEvent` — the blob staged or
 *    deduplicated and the publication pin, in the ledger's one transaction;
 * 3. the bytes written to staging, **their hash verified**, the file
 *    synchronized, renamed onto the digest's path, the directory synchronized;
 * 4. `PUBLICATION_SUCCEEDED` — the reference and the pin's release, atomically;
 * 5. the lease released.
 *
 * **The reference is named only after the bytes survived the directory's
 * synchronization.** A reader that finds a reference finds bytes, or an
 * explicit refusal saying they are gone; it never finds a name for content that
 * was not there.
 *
 * ## What the ledger and the lease each give, and what this module adds
 *
 * The ledger and the lease file share no transaction (coordination §1), and a
 * transaction of neither crosses into the filesystem (§9 `:309-311`). What
 * makes the three one operation is the exclusion: every mutation below — of the
 * ledger for this digest, of the staging file, of the destination — happens
 * under the one holding, and before each one this module reads the token again
 * and refuses, as a value, to continue under a holding that no longer stands.
 * That comparison is defence in depth and not the guarantee: §9 `:343-347` puts
 * the guarantee in the quiescence proven before anybody else may take the blob.
 *
 * ## Every crash leaves something the reconciler can name
 *
 * Artifacts §8 `:260-271`. {@link ArtifactPlane.reconcile} reads the lease row
 * and the live publication pins of one digest and decides from them alone:
 *
 * - a holding with no intention (1→2), or with its outcome already recorded
 *   (4→5), is revoked — after quiescence is attested, never before;
 * - a holding with a live pin (2→3, 3→4) is taken over and driven to its end: a
 *   destination that verifies completes **the reference the intention
 *   recorded**, field for field; absent or unverifiable bytes are an
 *   abandonment, which the fold records with the blob's original grace instant;
 * - a success the ledger refuses is an abandonment too, under the same terminal
 *   identity, and any other failure of a terminal append releases the holding
 *   and is thrown: no refusal leaves a digest held (C-1).
 *
 * A restarted publisher does not need the reconciler for its own command: it
 * calls {@link ArtifactPlane.publish} again with the same request and the
 * attestation, and the plane takes the holding over, **finds** the intention
 * rather than appending it again, and continues from step 3.
 *
 * ## What it reads, and what it may not
 *
 * No clock: every instant is in the request. No process and no environment: the
 * pid a holding records and the pid an attestation names are the caller's, and
 * the attestation is the caller's proof. No identity is minted: event ids,
 * idempotency keys, the command id, the pin id and the reference id all arrive
 * with the request, so nothing here is a preimage and the contract does not
 * move. No published object is ever removed — the one unlink in this module is
 * of its own staging path — and no `RECLAIM` holding is asked for.
 *
 * ## Paths
 *
 * Artifacts §10 `:362-366`. A path is derived from a digest that was checked to
 * be 64 lowercase hex characters first, sharded by its first two. The root is
 * resolved once, at open, and every use checks that the directory standing
 * there is still the one resolved. Below it every component is examined without
 * following it, and every file is opened with `O_NOFOLLOW`: a symbolic link is
 * refused at the moment of opening, not by an earlier look.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The largest content this plane publishes or reads, in bytes.
 *
 * The contract admits any `sizeBytes`, and the legacy store's bound is a
 * roadmap's, over a string. This plane holds the whole object in memory to
 * digest it before the lease is asked for, so the bound is a memory bound,
 * declared here and refused before anything is touched (decision 66).
 */
export const ARTIFACT_PLANE_CONTENT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Why the plane declined or ended a publication. Closed; facts, never values.
 *
 * - `LEASE_HELD` — another holding stands on this digest, or the command id
 *   holds another digest.
 * - `LEASE_SUPERSEDED` — the holding this call worked under is no longer the one
 *   that stands; nothing further was written.
 * - `QUIESCENCE_UNPROVEN` — ending another holding was needed and no attestation
 *   was given.
 * - `QUIESCENCE_OF_ANOTHER_PROCESS` — the attestation is about a process the row
 *   does not record.
 * - `HELD_FOR_RECLAIM` — the holding that stands is a collector's.
 * - `PUBLICATION_IN_FLIGHT` — a staged generation belongs to another command.
 * - `PUBLICATION_ALREADY_ABANDONED` — this command's publication was abandoned;
 *   a retry is a new command.
 * - `CONTENT_ABSENT` — no bytes stand at the digest's path.
 * - `CONTENT_DOES_NOT_VERIFY` — the bytes there are not the digest's.
 * - `SYMLINK_REFUSED` — a symbolic link stands where a directory or a file of
 *   this plane should.
 * - `NO_INTENDED_REFERENCE` — the intention names no reference to complete.
 * - `REFERENCE_REFUSED_BY_DOOR` — the ledger refused the success the bytes earned:
 *   the reference was recorded meanwhile, or the intention carries one no success
 *   may record. The bytes stay.
 * - `REFERENCE_NOT_READABLE` — no reference this reader may read; it does not
 *   say whether one exists.
 * - `CONTENT_DELETED` — the reference is tombstoned.
 * - `BLOB_NOT_PUBLISHED` — the reference's generation is not published.
 * - `ENCRYPTED_AT_REST_NOT_DELIVERED` — encryption at rest is not this escalón's.
 */
export const ARTIFACT_PLANE_REFUSALS = [
  "LEASE_HELD",
  "LEASE_SUPERSEDED",
  "QUIESCENCE_UNPROVEN",
  "QUIESCENCE_OF_ANOTHER_PROCESS",
  "HELD_FOR_RECLAIM",
  "PUBLICATION_IN_FLIGHT",
  "PUBLICATION_ALREADY_ABANDONED",
  "CONTENT_ABSENT",
  "CONTENT_DOES_NOT_VERIFY",
  "SYMLINK_REFUSED",
  "NO_INTENDED_REFERENCE",
  "REFERENCE_REFUSED_BY_DOOR",
  "REFERENCE_NOT_READABLE",
  "CONTENT_DELETED",
  "BLOB_NOT_PUBLISHED",
  "ENCRYPTED_AT_REST_NOT_DELIVERED",
] as const;

/**
 * The private subroot that belongs to one ledger. **One producer, no second
 * spelling** (decision 65).
 *
 * A sibling of the legacy `artifacts/` directory and not beneath it, so that
 * nothing that resolves a bare digest there can reach an object here; and not
 * derived from the legacy root rule, which `L-F3-2` keeps in one home.
 */
export function artifactPlaneRootFor(ledgerPath: string): string {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
    throw new LedgerQueryError("ledgerPath must be a non-empty string");
  }
  return join(dirname(ledgerPath), "private-artifacts");
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function refused(path: string, message: string): never {
  throw new LedgerValidationError([{ path, message }]);
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerQueryError(field + " must be a non-empty string");
  }
  return value;
}

/** A digest in artifacts §3's domain, checked before any path is derived from it. */
function requireDigest(value: string, field: string): string {
  if (typeof value !== "string" || !isSha256Hex(value)) {
    throw new LedgerQueryError(field + " must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function requireHolding(holding: ArtifactPlaneHolding): ArtifactPlaneHolding {
  const stated = holding as Partial<ArtifactPlaneHolding> | null | undefined;
  if (stated === null || stated === undefined) throw new LedgerQueryError("holding is required");
  if (!Number.isInteger(holding.holderPid) || holding.holderPid < 1) {
    throw new LedgerQueryError("holding.holderPid must be a positive integer");
  }
  return {
    holder: requireText(holding.holder, "holding.holder"),
    holderPid: holding.holderPid,
    acquiredAt: requireText(holding.acquiredAt, "holding.acquiredAt"),
    expiresAt: requireText(holding.expiresAt, "holding.expiresAt"),
  };
}

function requireQuiescence(
  quiescence: ArtifactBlobLeaseQuiescence | undefined,
): ArtifactBlobLeaseQuiescence | null {
  if (quiescence === undefined) return null;
  const stated = quiescence as Partial<ArtifactBlobLeaseQuiescence> | null;
  if (stated === null) return null;
  if (stated.basis !== "DEATH_AND_REAP_PROVEN" && stated.basis !== "STALE_FENCE_REFUSED_BY_BACKEND") {
    throw new LedgerQueryError("quiescence.basis must be DEATH_AND_REAP_PROVEN or STALE_FENCE_REFUSED_BY_BACKEND");
  }
  if (!Number.isInteger(quiescence.holderPid) || quiescence.holderPid < 1) {
    throw new LedgerQueryError("quiescence.holderPid must be a positive integer");
  }
  return { basis: stated.basis, holderPid: quiescence.holderPid };
}

/** Zod's issues in the ledger's words: a path and a reason, never the value. */
function contractRefusal(candidate: Record<string, unknown>, prefix: string): void {
  const parsed = ArtifactRegistryEvent.safeParse(candidate);
  if (parsed.success) return;
  const issues: LedgerValidationIssue[] = parsed.error.issues.map((issue) => ({
    path: prefix + (issue.path.length === 0 ? "" : "." + issue.path.map((segment) => String(segment)).join(".")),
    message: issue.message,
  }));
  throw new LedgerValidationError(issues);
}

function envelope(identity: ArtifactEventIdentity, recordedBy: string, ordinal: number): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: identity.eventId,
    idempotencyKey: identity.idempotencyKey,
    subjectKind: "ARTIFACT",
    subjectOrdinal: ordinal,
    parentSubjectOrdinal: ordinal === 1 ? null : ordinal - 1,
    recordedBy,
    occurredAt: identity.occurredAt,
    recordedAt: identity.recordedAt,
  };
}

function intentionBody(checked: CheckedPublication, ordinal: number, blobGeneration: number): Record<string, unknown> {
  const { request } = checked;
  return {
    ...envelope(request.intention, request.recordedBy, ordinal),
    artifactEventKind: "PUBLICATION_INTENDED",
    payload: {
      commandId: request.commandId,
      contentSha256: checked.contentSha256,
      blobGeneration,
      mediaType: request.mediaType,
      sizeBytes: checked.sizeBytes,
      encryptionStatus: request.encryptionStatus,
      keyReference: null,
      encryptionProfile: request.encryptionProfile,
      artifactPinId: request.artifactPinId,
      intendedReference: request.reference,
    },
  };
}

/**
 * Everything a publication can be refused for without touching a substrate,
 * refused before the lease is asked for (N-P36C-4, N-P36C-16, N-P36-17).
 *
 * The digest and the size are computed from the bytes. The encryption word, the
 * stream's two rules about a reference, and the whole contract — the credential
 * and transcript guards included — are run over the intention and the success
 * this request would record, so a sentinel in any field is refused by path here
 * and never reaches a lease row, an event or a file.
 */
function checkPublication(request: ArtifactPublicationRequest): CheckedPublication {
  const content: unknown = (request as Partial<ArtifactPublicationRequest> | null)?.content;
  if (!(content instanceof Uint8Array)) refused("content", "the content to publish is a byte array");
  if (content.byteLength > ARTIFACT_PLANE_CONTENT_MAX_BYTES) {
    refused(
      "content",
      "the content exceeds " + String(ARTIFACT_PLANE_CONTENT_MAX_BYTES) + " bytes, the largest this plane publishes",
    );
  }
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const sizeBytes = content.byteLength;
  if (request.declaredContentSha256 !== undefined && request.declaredContentSha256 !== contentSha256) {
    refused("declaredContentSha256", "the declared digest is not the digest of the content; the plane computes it");
  }
  if (request.declaredSizeBytes !== undefined && request.declaredSizeBytes !== sizeBytes) {
    refused("declaredSizeBytes", "the declared size is not the size of the content; the plane computes it");
  }
  if (request.encryptionStatus === "ENCRYPTED_AT_REST") {
    refused(
      "encryptionStatus",
      "ENCRYPTED_AT_REST is not delivered by this escalón: the plane publishes PLAINTEXT only, and a digest is" +
        " always of the content in clear",
    );
  }
  const reference = request.reference as Partial<ArtifactReferenceIntent> | null | undefined;
  if (reference === null || reference === undefined) {
    refused("reference", "a publication names the reference it will record before a byte moves");
  }
  if (reference.classification === "SECRET_BEARING") {
    refused(
      "reference.classification",
      "a SECRET_BEARING artifact is never published in the stream: it designates material that demands review" +
        " and blocking, and it is not a permission to store credentials",
    );
  }
  if (!(ARTIFACT_ACCESS_POLICY_IDS as readonly string[]).includes(String(reference.accessPolicyId))) {
    refused("reference.accessPolicyId", "the closed set of access policies is " + ARTIFACT_ACCESS_POLICY_IDS.join(", "));
  }
  const holding = requireHolding(request.holding);
  const quiescence = requireQuiescence(request.quiescence);
  const checked: CheckedPublication = { request, content, contentSha256, sizeBytes, holding, quiescence };

  const intention = request.intention as Partial<ArtifactEventIdentity> | null | undefined;
  const terminal = request.terminal as Partial<ArtifactEventIdentity> | null | undefined;
  if (intention === null || intention === undefined) refused("intention", "the intention's identity is required");
  if (terminal === null || terminal === undefined) refused("terminal", "the outcome's identity is required");
  contractRefusal(intentionBody(checked, 1, 1), "intention");
  contractRefusal(
    {
      ...envelope(request.terminal, request.recordedBy, 2),
      artifactEventKind: "PUBLICATION_SUCCEEDED",
      payload: {
        commandId: request.commandId,
        contentSha256,
        blobGeneration: 1,
        artifactPinId: request.artifactPinId,
        reference: request.reference,
      },
    },
    "terminal",
  );
  return checked;
}

// ---------------------------------------------------------------------------
// The filesystem, without following a link
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

/** What stands at a path, looked at with `lstat`: a link is a link, never its target. */
function entryAt(path: string): Entry {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return "SYMLINK";
    if (stats.isDirectory()) return "DIRECTORY";
    if (stats.isFile()) return "FILE";
    return "OTHER";
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "ABSENT";
    throw error;
  }
}

/** The one place this module opens a descriptor, and it never follows the last component. */
function openNoFollow(path: string, flags: number, mode?: number): number {
  return openSync(path, flags | constants.O_NOFOLLOW, mode);
}

/** A directory's own entry made durable: what a rename or a mkdir promised is on disk. */
function syncDirectory(path: string): void {
  const descriptor = openNoFollow(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** `0700`, explicit and independent of the umask, set through a descriptor that followed no link. */
function restrictDirectory(path: string): void {
  const descriptor = openNoFollow(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fchmodSync(descriptor, DIRECTORY_MODE);
  } finally {
    closeSync(descriptor);
  }
}

/** A directory of this plane created without `recursive`, which would follow a link in a component. */
function createDirectory(path: string): void {
  mkdirSync(path, { mode: DIRECTORY_MODE });
  restrictDirectory(path);
}

/** The staging name of a digest's object: beside it, derived from the checked digest alone. */
function stagingPathOf(shard: string, contentSha256: string): string {
  return join(shard, contentSha256 + ".staging");
}

/**
 * The one unlink this module performs, and only of its own staging path: a
 * residue of a dead attempt, a link planted there, or bytes that failed their
 * verification. `unlink` removes a link and never its target. A published
 * object is never removed here.
 */
function removeOwnStaging(staging: string): void {
  unlinkSync(staging);
}

/**
 * Open a file without following it and verify that it is the digest's content:
 * a regular file, of the expected size, whose SHA-256 is the digest.
 */
function inspect(path: string, contentSha256: string, sizeBytes: number): Inspection {
  let descriptor: number;
  try {
    descriptor = openNoFollow(path, constants.O_RDONLY);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ENOENT") return { state: "ABSENT" };
    if (code === "ELOOP" || code === "EMLINK") return { state: "SYMLINK" };
    if (code === "ENOTDIR" || code === "EISDIR") return { state: "DOES_NOT_VERIFY" };
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size !== sizeBytes || stats.size > ARTIFACT_PLANE_CONTENT_MAX_BYTES) {
      return { state: "DOES_NOT_VERIFY" };
    }
    const bytes = Buffer.alloc(sizeBytes);
    let offset = 0;
    while (offset < sizeBytes) {
      const read = readSync(descriptor, bytes, offset, sizeBytes - offset, offset);
      if (read === 0) return { state: "DOES_NOT_VERIFY" };
      offset += read;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, sizeBytes) !== 0) return { state: "DOES_NOT_VERIFY" };
    if (createHash("sha256").update(bytes).digest("hex") !== contentSha256) return { state: "DOES_NOT_VERIFY" };
    return { state: "VERIFIED", bytes };
  } finally {
    closeSync(descriptor);
  }
}

// ---------------------------------------------------------------------------
// The plane
// ---------------------------------------------------------------------------

function isIntention(record: ArtifactEventRecord): record is ArtifactEventRecord & { readonly event: IntendedEvent } {
  return record.event.artifactEventKind === "PUBLICATION_INTENDED";
}

/**
 * Open the private plane of one ledger.
 *
 * The subroot is created if it is absent — `0700`, without `recursive` — and
 * refused if a link or anything but a directory stands there. It is then
 * resolved, **once**, and its identity recorded: every later use checks that the
 * directory at the resolved path is still that one, and fails closed with
 * `LedgerIntegrityError` if it is not.
 */
export function openArtifactPlane(options: OpenArtifactPlaneOptions): ArtifactPlane {
  const { ledger, leaseStore } = options;
  const faults = options.__testFaults ?? {};
  const intended = artifactPlaneRootFor(options.ledgerPath);

  const standing = entryAt(intended);
  if (standing === "ABSENT") {
    createDirectory(intended);
    syncDirectory(dirname(intended));
  } else if (standing === "SYMLINK") {
    throw new LedgerOpenError(intended, "the private artifact root is a symbolic link, and this plane follows none");
  } else if (standing !== "DIRECTORY") {
    throw new LedgerOpenError(intended, "the private artifact root is not a directory");
  } else {
    restrictDirectory(intended);
  }
  const root = realpathSync(intended);
  const rootStats = lstatSync(root);
  const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };

  const assertRootIntact = (): void => {
    let stats;
    try {
      stats = lstatSync(root);
    } catch {
      throw new LedgerIntegrityError(["the private artifact root resolved at open can no longer be inspected"]);
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      stats.dev !== rootIdentity.dev ||
      stats.ino !== rootIdentity.ino
    ) {
      throw new LedgerIntegrityError(["the private artifact root is no longer the directory resolved at open"]);
    }
  };

  const shardOf = (contentSha256: string): string => join(root, requireDigest(contentSha256, "contentSha256").slice(0, 2));
  const objectPathOf = (contentSha256: string): string => join(shardOf(contentSha256), contentSha256);

  /** Does the holding this call works under still stand, under the live incarnation? */
  const stillHolds = (token: ArtifactBlobLeaseToken): boolean => {
    const now = leaseStore.readToken(token.contentSha256);
    return (
      now !== null &&
      now.incarnationId === leaseStore.incarnation().incarnationId &&
      now.incarnationId === token.incarnationId &&
      now.generation === token.generation &&
      now.holder === token.holder &&
      now.operationId === token.operationId
    );
  };

  const refuse = (
    refusal: ArtifactPlaneRefusal,
    lease: ArtifactBlobLeaseRow | null,
    leaseRefusal: ArtifactBlobLeaseRefusal | null = null,
  ): ArtifactPlaneOutcome => ({ verb: "REFUSE", refusal, leaseRefusal, lease });

  const refuseByStore = (outcome: ArtifactBlobLeaseOutcome & { readonly verb: "REFUSE" }): ArtifactPlaneOutcome => {
    const word: ArtifactPlaneRefusal =
      outcome.refusal === "HELD" || outcome.refusal === "OPERATION_ID_IN_USE"
        ? "LEASE_HELD"
        : outcome.refusal === "QUIESCENCE_OF_ANOTHER_PROCESS"
          ? "QUIESCENCE_OF_ANOTHER_PROCESS"
          : "LEASE_SUPERSEDED";
    return refuse(word, outcome.row, outcome.refusal);
  };

  const superseded = (token: ArtifactBlobLeaseToken): ArtifactPlaneOutcome =>
    refuse("LEASE_SUPERSEDED", leaseStore.read(token.contentSha256));

  /**
   * The holding that ending somebody else's requires: an attestation, about the
   * process the row records, from a holder that names itself differently — the
   * lease store answers a take-over under the same holder as a replay, and would
   * keep the dead process's pid on the row (B's O-1, answered here).
   */
  const displacement = (
    row: ArtifactBlobLeaseRow,
    quiescence: ArtifactBlobLeaseQuiescence | null,
    holding: ArtifactPlaneHolding,
  ): ArtifactPlaneOutcome | ArtifactBlobLeaseQuiescence => {
    if (quiescence === null) return refuse("QUIESCENCE_UNPROVEN", row);
    if (quiescence.holderPid !== row.holderPid) return refuse("QUIESCENCE_OF_ANOTHER_PROCESS", row);
    if (holding.holder === row.holder) {
      throw new LedgerQueryError(
        "holding.holder must differ from the holder it displaces: a take-over under the same holder is a replay," +
          " and the row would keep recording the quiescent process",
      );
    }
    return quiescence;
  };

  /** The token of the holding just granted, read back and checked to be this call's. */
  const tokenFor = (contentSha256: string, grant: ArtifactBlobLeaseGrant): ArtifactBlobLeaseToken | null => {
    const token = leaseStore.readToken(contentSha256);
    return token !== null && token.holder === grant.holder && token.operationId === grant.operationId ? token : null;
  };

  const eventsOf = (contentSha256: string): readonly ArtifactEventRecord[] => ledger.listArtifactEvents(contentSha256);

  const nextOrdinal = (contentSha256: string): number => {
    const last = eventsOf(contentSha256).at(-1);
    return last === undefined ? 1 : last.event.subjectOrdinal + 1;
  };

  const intentionOf = (
    contentSha256: string,
    artifactPinId: string,
  ): (ArtifactEventRecord & { readonly event: IntendedEvent }) | null => {
    const found = eventsOf(contentSha256).filter(isIntention).filter((record) => record.event.payload.artifactPinId === artifactPinId);
    return found.at(-1) ?? null;
  };

  const terminalOf = (contentSha256: string, artifactPinId: string): ArtifactEventRecord | null =>
    eventsOf(contentSha256).find(
      (record) =>
        (record.event.artifactEventKind === "PUBLICATION_SUCCEEDED" ||
          record.event.artifactEventKind === "PUBLICATION_ABANDONED") &&
        record.event.payload.artifactPinId === artifactPinId,
    ) ?? null;

  /**
   * Step 3. A publisher writes, verifies, synchronizes, renames and synchronizes
   * the directory; a reconciler, with no bytes, only removes a dead attempt's
   * staging and verifies what stands at the digest's path. Either way a
   * destination that already exists is verified and never rewritten, and one
   * that does not verify is neither overwritten nor removed. The holding is read
   * again before every mutation.
   */
  const place = (work: Work): Placement => {
    assertRootIntact();
    const payload = work.intention.event.payload;
    const shard = shardOf(payload.contentSha256);
    const destination = objectPathOf(payload.contentSha256);
    const staging = stagingPathOf(shard, payload.contentSha256);

    const shardEntry = entryAt(shard);
    if (shardEntry === "SYMLINK") return "SYMLINK";
    if (shardEntry === "ABSENT") {
      if (work.content === null) return "ABSENT";
      if (!stillHolds(work.token)) return "SUPERSEDED";
      createDirectory(shard);
      syncDirectory(root);
    } else if (shardEntry !== "DIRECTORY") {
      return "DOES_NOT_VERIFY";
    }

    if (entryAt(staging) !== "ABSENT") {
      if (!stillHolds(work.token)) return "SUPERSEDED";
      removeOwnStaging(staging);
    }

    const present = inspect(destination, payload.contentSha256, payload.sizeBytes);
    if (present.state === "VERIFIED") {
      if (!stillHolds(work.token)) return "SUPERSEDED";
      syncDirectory(shard);
      return "PRESENT";
    }
    if (present.state !== "ABSENT" || work.content === null) return present.state;

    if (!stillHolds(work.token)) return "SUPERSEDED";
    const content = work.content;
    const descriptor = openNoFollow(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
    let verified: boolean;
    try {
      fchmodSync(descriptor, FILE_MODE);
      let offset = 0;
      while (offset < content.byteLength) {
        offset += writeSync(descriptor, content, offset, content.byteLength - offset, offset);
      }
      faults.afterStagingWritten?.();
      verified = inspect(staging, payload.contentSha256, payload.sizeBytes).state === "VERIFIED";
      if (verified) {
        faults.afterStagingVerified?.();
        fsyncSync(descriptor);
      }
    } finally {
      closeSync(descriptor);
    }
    if (!verified) {
      if (!stillHolds(work.token)) return "SUPERSEDED";
      removeOwnStaging(staging);
      return "DOES_NOT_VERIFY";
    }
    faults.afterStagingSynced?.();

    if (!stillHolds(work.token)) return "SUPERSEDED";
    renameSync(staging, destination);
    faults.afterRename?.();
    syncDirectory(shard);
    faults.afterDirectorySynced?.();
    return "WRITTEN";
  };

  /**
   * Steps 3 to 5 for an intention that stands, shared by a publisher and a
   * reconciler. An outcome already recorded is answered from the stream; a live
   * pin is driven to its success, which records the intention's own reference,
   * or to its abandonment.
   */
  const drive = (work: Work): ArtifactPlaneOutcome => {
    const payload = work.intention.event.payload;
    const { contentSha256, blobGeneration, artifactPinId, commandId } = payload;
    const pin = ledger.getArtifactPin(artifactPinId);
    if (pin === null) {
      throw new LedgerIntegrityError(["an intention stands with no pin of its own; the fold would not have written it"]);
    }

    if (pin.releasedSequence !== null) {
      const terminal = terminalOf(contentSha256, artifactPinId);
      const release = leaseStore.release(work.token);
      if (terminal !== null && terminal.event.artifactEventKind === "PUBLICATION_SUCCEEDED") {
        const reference = ledger.getArtifactReference(terminal.event.payload.reference.artifactReferenceId);
        if (reference === null) {
          throw new LedgerIntegrityError(["a recorded success names a reference the read model does not hold"]);
        }
        return { verb: "PUBLISHED", contentSha256, blobGeneration, reference, bytesWritten: false, replayed: true, release };
      }
      return { verb: "ABANDONED", refusal: "PUBLICATION_ALREADY_ABANDONED", contentSha256, blobGeneration, release };
    }

    const placement = place(work);
    if (placement === "SUPERSEDED") return superseded(work.token);
    const reference = payload.intendedReference;
    const abandonment: ArtifactPlaneRefusal | null =
      placement === "WRITTEN" || placement === "PRESENT"
        ? reference === undefined
          ? "NO_INTENDED_REFERENCE"
          : null
        : placement === "ABSENT"
          ? "CONTENT_ABSENT"
          : placement === "SYMLINK"
            ? "SYMLINK_REFUSED"
            : "CONTENT_DOES_NOT_VERIFY";

    if (!stillHolds(work.token)) return superseded(work.token);
    const ordinal = nextOrdinal(contentSha256);
    let ending: ArtifactPlaneRefusal = abandonment ?? "NO_INTENDED_REFERENCE";

    if (abandonment === null && reference !== undefined) {
      try {
        ledger.appendArtifactEvent({
          ...envelope(work.terminal, work.recordedBy, ordinal),
          artifactEventKind: "PUBLICATION_SUCCEEDED",
          payload: { commandId, contentSha256, blobGeneration, artifactPinId, reference },
        });
      } catch (error: unknown) {
        // Anything but the door's refusal: it wrote nothing and this process is
        // alive, so the holding is its own to end, and the pin stays live for a
        // retry under a corrected identity.
        if (!(error instanceof LedgerValidationError)) {
          leaseStore.release(work.token);
          throw error;
        }
        // The door refused the success itself — a reference recorded since the
        // check before the lease, or a block another producer wrote that no
        // success may carry. Its answer will not change, so the publication is
        // abandoned under the same terminal identity: the bytes stay, the
        // generation keeps its grace, and the next intention re-stages it
        // (decision 64). A digest is never left held for a refusal (C-1).
        ending = "REFERENCE_REFUSED_BY_DOOR";
      }
      if (ending !== "REFERENCE_REFUSED_BY_DOOR") {
        faults.afterOutcomeRecorded?.();
        const release = leaseStore.release(work.token);
        const recorded = ledger.getArtifactReference(reference.artifactReferenceId);
        if (recorded === null) {
          throw new LedgerIntegrityError(["a success was recorded and its reference is not in the read model"]);
        }
        return {
          verb: "PUBLISHED",
          contentSha256,
          blobGeneration,
          reference: recorded,
          bytesWritten: placement === "WRITTEN",
          replayed: false,
          release,
        };
      }
      if (!stillHolds(work.token)) return superseded(work.token);
    }

    try {
      ledger.appendArtifactEvent({
        ...envelope(work.terminal, work.recordedBy, ordinal),
        artifactEventKind: "PUBLICATION_ABANDONED",
        payload: { commandId, contentSha256, blobGeneration, artifactPinId },
      });
    } catch (error: unknown) {
      leaseStore.release(work.token);
      throw error;
    }
    faults.afterOutcomeRecorded?.();
    const release = leaseStore.release(work.token);
    return { verb: "ABANDONED", refusal: ending, contentSha256, blobGeneration, release };
  };

  const publish = (request: ArtifactPublicationRequest): ArtifactPlaneOutcome => {
    const checked = checkPublication(request);
    assertRootIntact();
    const digest = checked.contentSha256;

    // A reference id already recorded is refused before the lease, like every
    // other refusal a request carries on its face — unless it is this command's
    // own recorded success, which a retry replays. The fold would refuse it at
    // step 4, after the bytes moved (C-1).
    const named = ledger.getArtifactReference(request.reference.artifactReferenceId);
    if (named !== null) {
      const own = terminalOf(digest, request.artifactPinId);
      if (
        own?.event.artifactEventKind !== "PUBLICATION_SUCCEEDED" ||
        own.event.payload.reference.artifactReferenceId !== named.artifactReferenceId
      ) {
        refused("reference.artifactReferenceId", "this reference is already recorded; a publication names a new one");
      }
    }

    const grant: ArtifactBlobLeaseGrant = {
      contentSha256: digest,
      operation: "PUBLISH",
      operationId: request.commandId,
      ...checked.holding,
    };

    // Step 1. A holding of this same command is either this process re-entering
    // — the same holder, pid and incarnation, answered `UNCHANGED` — or a dead
    // attempt of it, which is taken over only on an attestation. Any other
    // holding is somebody else's publication, and a collector's is never taken
    // over as a publication, whatever id it carries (O-2).
    const row = leaseStore.read(digest);
    let granted: ArtifactBlobLeaseOutcome;
    if (row !== null && row.operation !== null) {
      if (row.operationId !== request.commandId) return refuse("LEASE_HELD", row);
      if (row.operation !== "PUBLISH") return refuse("HELD_FOR_RECLAIM", row);
      const reentry =
        row.holder === grant.holder &&
        row.holderPid === grant.holderPid &&
        row.storeIncarnationId === leaseStore.incarnation().incarnationId;
      if (reentry) {
        granted = leaseStore.acquire(grant);
      } else {
        const attested = displacement(row, checked.quiescence, checked.holding);
        if ("verb" in attested) return attested;
        const standingToken = leaseStore.readToken(digest);
        if (standingToken === null) return refuse("LEASE_SUPERSEDED", leaseStore.read(digest));
        granted = leaseStore.takeOver(standingToken, attested, grant);
      }
    } else {
      granted = leaseStore.acquire(grant);
    }
    if (granted.verb === "REFUSE") return refuseByStore(granted);
    const token = tokenFor(digest, grant);
    if (token === null) return refuse("LEASE_SUPERSEDED", leaseStore.read(digest));
    faults.afterLeaseAcquired?.();

    // Step 2. The intention is found if this command already recorded it — a
    // retry never appends it again — and appended otherwise, with the
    // generation and the ordinal proposed from the stream under the holding.
    let intention: ArtifactEventRecord & { readonly event: IntendedEvent };
    if (ledger.getArtifactPin(request.artifactPinId) === null) {
      const current = ledger.getUnreclaimedArtifactBlob(digest);
      if (current !== null && current.lifecycleState === "STAGED") {
        const release = leaseStore.release(token);
        return refuse("PUBLICATION_IN_FLIGHT", release.row);
      }
      const blobGeneration = current === null ? ledger.getHighestArtifactBlobGeneration(digest) + 1 : current.blobGeneration;
      if (!stillHolds(token)) return superseded(token);
      let appended: ArtifactEventRecord;
      try {
        appended = ledger.appendArtifactEvent(intentionBody(checked, nextOrdinal(digest), blobGeneration)).record;
      } catch (error: unknown) {
        // The door refused and wrote nothing; this process is alive, so the
        // holding it took for nothing is its own to end.
        if (error instanceof LedgerError) leaseStore.release(token);
        throw error;
      }
      if (!isIntention(appended)) throw new LedgerIntegrityError(["an appended intention reads back as another kind"]);
      intention = appended;
    } else {
      const recorded = intentionOf(digest, request.artifactPinId);
      if (recorded === null) {
        leaseStore.release(token);
        refused("artifactPinId", "this pin already exists and is not the intention of a publication of this content");
      }
      const candidate = canonicalJsonStringify(
        intentionBody(checked, recorded.event.subjectOrdinal, recorded.event.payload.blobGeneration),
      );
      if (candidate !== recorded.canonicalJson) {
        leaseStore.release(token);
        throw new LedgerIdempotencyConflictError(
          recorded.idempotencyKey,
          sha256Hex(recorded.canonicalJson),
          sha256Hex(candidate),
        );
      }
      intention = recorded;
    }
    faults.afterIntentionRecorded?.();

    return drive({ token, intention, content: checked.content, terminal: request.terminal, recordedBy: request.recordedBy });
  };

  const reconcile = (request: ArtifactReconciliationRequest): ArtifactPlaneOutcome => {
    const digest = requireDigest(request.contentSha256, "contentSha256");
    const holding = requireHolding(request.holding);
    const quiescence = requireQuiescence(request.quiescence);
    const terminal = request.terminal as Partial<ArtifactEventIdentity> | null | undefined;
    if (terminal === null || terminal === undefined) refused("terminal", "the outcome's identity is required");
    contractRefusal(
      {
        ...envelope(request.terminal, request.recordedBy, 2),
        artifactEventKind: "PUBLICATION_ABANDONED",
        payload: { commandId: "reconciliation", contentSha256: digest, blobGeneration: 1, artifactPinId: "reconciliation" },
      },
      "terminal",
    );
    assertRootIntact();

    const row = leaseStore.read(digest);
    const livePins = ledger.listLiveArtifactPins("PUBLICATION").filter((pin) => pin.contentSha256 === digest);
    const grantFor = (operationId: string): ArtifactBlobLeaseGrant => ({
      contentSha256: digest,
      operation: "PUBLISH",
      operationId,
      ...holding,
    });

    let pinId: string;
    let grant: ArtifactBlobLeaseGrant;
    let granted: ArtifactBlobLeaseOutcome;
    if (row !== null && row.operation !== null) {
      if (row.operation !== "PUBLISH") return refuse("HELD_FOR_RECLAIM", row);
      const attested = displacement(row, quiescence, holding);
      if ("verb" in attested) return attested;
      const standingToken = leaseStore.readToken(digest);
      if (standingToken === null) return refuse("LEASE_SUPERSEDED", leaseStore.read(digest));
      const pin = livePins.find((candidate) => candidate.pinHolderId === row.operationId);
      if (pin === undefined) {
        // No intention stands for this holding (1→2), or its outcome is already
        // recorded (4→5): nothing to write and nothing to append. The holding
        // ends, and only because quiescence is attested.
        const revoked = leaseStore.revoke(standingToken, attested);
        if (revoked.verb === "REFUSE") return refuseByStore(revoked);
        return { verb: "HOLDING_REVOKED", lease: revoked.row };
      }
      pinId = pin.artifactPinId;
      grant = grantFor(standingToken.operationId);
      granted = leaseStore.takeOver(standingToken, attested, grant);
    } else {
      const pin = livePins[0];
      if (pin === undefined) return { verb: "NOTHING_TO_RECONCILE", lease: row };
      pinId = pin.artifactPinId;
      grant = grantFor(pin.pinHolderId);
      granted = leaseStore.acquire(grant);
    }
    if (granted.verb === "REFUSE") return refuseByStore(granted);
    const token = tokenFor(digest, grant);
    if (token === null) return refuse("LEASE_SUPERSEDED", leaseStore.read(digest));
    faults.afterLeaseAcquired?.();

    const intention = intentionOf(digest, pinId);
    if (intention === null) {
      throw new LedgerIntegrityError(["a live publication pin stands with no intention on its content's subject"]);
    }
    return drive({ token, intention, content: null, terminal: request.terminal, recordedBy: request.recordedBy });
  };

  const read = (request: ArtifactReadRequest): ArtifactReadOutcome => {
    const refuseRead = (refusal: ArtifactPlaneRefusal): ArtifactReadOutcome => ({ verb: "REFUSE", refusal });
    const artifactReferenceId = requireText(request.artifactReferenceId, "artifactReferenceId");
    if (!(REFERENCE_SCOPE_KINDS as readonly string[]).includes(request.scopeKind)) {
      throw new LedgerQueryError("scopeKind must be one of " + REFERENCE_SCOPE_KINDS.join(", "));
    }
    if ((request.scopeId === null) !== (request.scopeKind === "SYSTEM")) {
      throw new LedgerQueryError("a reader names its scope's id, and only a SYSTEM reader has none");
    }
    if (request.scopeId !== null) requireText(request.scopeId, "scopeId");

    // Authorization first, and one word for "no such reference" and "not yours":
    // a refusal to a foreign scope does not reveal that the reference exists.
    const reference = ledger.getArtifactReference(artifactReferenceId);
    if (
      reference?.accessPolicyId !== "SCOPE_EQUALITY_V1" ||
      reference.scopeKind !== request.scopeKind ||
      reference.scopeId !== request.scopeId
    ) {
      return refuseRead("REFERENCE_NOT_READABLE");
    }
    // Expiry is not read: vencer no revoca (artifacts §10). Revocation is a
    // recorded decision, and this build records none.
    if (reference.tombstonedAt !== null) return refuseRead("CONTENT_DELETED");
    const blob = ledger.getArtifactBlob(reference.contentSha256, reference.blobGeneration);
    if (blob?.lifecycleState !== "PUBLISHED") return refuseRead("BLOB_NOT_PUBLISHED");
    if (blob.encryptionStatus !== "PLAINTEXT") return refuseRead("ENCRYPTED_AT_REST_NOT_DELIVERED");

    assertRootIntact();
    const shardEntry = entryAt(shardOf(blob.contentSha256));
    if (shardEntry === "SYMLINK") return refuseRead("SYMLINK_REFUSED");
    if (shardEntry === "ABSENT") return refuseRead("CONTENT_ABSENT");
    if (shardEntry !== "DIRECTORY") return refuseRead("CONTENT_DOES_NOT_VERIFY");
    const found = inspect(objectPathOf(blob.contentSha256), blob.contentSha256, blob.sizeBytes);
    if (found.state !== "VERIFIED") {
      return refuseRead(
        found.state === "ABSENT" ? "CONTENT_ABSENT" : found.state === "SYMLINK" ? "SYMLINK_REFUSED" : "CONTENT_DOES_NOT_VERIFY",
      );
    }
    return { verb: "READ", content: found.bytes, reference };
  };

  return { publish, read, reconcile };
}

// ---------------------------------------------------------------------------
// Reading by reference, with no holding (P-15 escalón F, ADR 0107)
// ---------------------------------------------------------------------------

/**
 * The two words a reader by reference adds to the plane's own: the private root
 * is not there to read from, or something other than a directory stands there.
 * They are the reader's, not the plane's -- `openArtifactPlane` would create an
 * absent root, and a read must never create what it reads from -- so they stay
 * out of {@link ARTIFACT_PLANE_REFUSALS}, whose sixteen words do not move.
 */
export const REFERENCE_READ_ROOT_REFUSALS = ["ROOT_ABSENT", "ROOT_NOT_A_DIRECTORY"] as const;

function refuseReaderHolding(): never {
  throw new LedgerQueryError("a reader takes no holding: reading a reference asks the blob lease store nothing");
}

/**
 * The lease store a reader hands the plane: it refuses everything.
 *
 * `read` goes by reference and scope and never asks the lease store, and opening
 * the real one on a read would create and migrate a coordination file on a GET.
 * One declaration for every ledger-side reader (P-15/F): the objective reader's
 * private copy moved here.
 */
const READER_LEASE_STORE: ArtifactBlobLeaseStore = Object.freeze({
  incarnation: refuseReaderHolding,
  read: refuseReaderHolding,
  readToken: refuseReaderHolding,
  acquire: refuseReaderHolding,
  release: refuseReaderHolding,
  revoke: refuseReaderHolding,
  takeOver: refuseReaderHolding,
  listOverdue: refuseReaderHolding,
  close: (): void => undefined,
});

/**
 * Read the bytes a reference authorizes one scope to read, holding nothing.
 *
 * The one ledger-side reader (P-15 escalón F, ADR 0107). It checks that the
 * private root stands -- present, not a symbolic link, a directory -- **before**
 * it opens the plane, because the plane creates an absent root and a read must
 * create nothing; then it asks the plane, with a lease store that refuses every
 * holding, and returns the plane's own answer unchanged. A refusal is a value:
 * the caller decides what a refusal means to it (the objective reader calls
 * every one an integrity failure; the result reader maps each to its word).
 *
 * Opens the plane over the handle it is given, read-only or not.
 */
export function readByReference(ledger: OpenArtifactPlaneOptions["ledger"], request: ArtifactReadRequest): ReferenceReadOutcome {
  const root = artifactPlaneRootFor(ledger.path);
  let standing;
  try {
    standing = lstatSync(root);
  } catch {
    return { verb: "REFUSE", refusal: "ROOT_ABSENT" };
  }
  if (standing.isSymbolicLink() || !standing.isDirectory()) {
    return { verb: "REFUSE", refusal: "ROOT_NOT_A_DIRECTORY" };
  }
  return openArtifactPlane({ ledger, leaseStore: READER_LEASE_STORE, ledgerPath: ledger.path }).read(request);
}

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CLASSES,
  ARTIFACT_CLASSIFICATIONS,
  ARTIFACT_EVENT_KINDS,
  ArtifactRegistryEvent,
  BLOB_LIFECYCLE_STATES,
  CONTRACT_VERSION,
  ENCRYPTION_STATUSES,
  PIN_HOLDER_KINDS,
  REFERENCE_SCOPE_KINDS,
  RETENTION_CLASSES,
  SUPPORTED_CONTRACT_VERSIONS,
} from "../../../src/index.js";

/**
 * Evidence for the artifact record (P-36/local escalón A, ADR 0081).
 *
 * Four claims. The vocabularies are artifacts §2 word for word, so the base's
 * CHECKs and this module are two declarations of one list. The six shapes are
 * strict at every level and carry the base's pairing rules, so the ledger's door
 * refuses by path what the base would refuse by constraint. The guards of laws 4
 * and 5 run over the whole event, and a refusal names a path, never a value. And
 * nothing here computes an identity: a parsed event is the value it was given.
 */

const AT = "2026-09-13T10:00:00.000Z";
const CONTENT = "c".repeat(64);

function event(kind: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "artifact/1",
    subjectKind: "ARTIFACT",
    artifactEventKind: kind,
    subjectOrdinal: 1,
    parentSubjectOrdinal: null,
    recordedBy: "claude/opus/implementer/01",
    occurredAt: AT,
    recordedAt: AT,
    payload,
    ...overrides,
  };
}

function reference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactReferenceId: "ref-1",
    artifactClass: "EVIDENCE",
    classification: "INTERNAL",
    scopeKind: "TASK",
    scopeId: "task-1",
    producerIdentity: "claude/opus/implementer/01",
    accessPolicyId: "SCOPE_EQUALITY_V1",
    retentionClass: "STANDARD",
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...overrides,
  };
}

function intention(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return event("PUBLICATION_INTENDED", {
    commandId: "cmd-1",
    contentSha256: CONTENT,
    blobGeneration: 1,
    mediaType: "application/json",
    sizeBytes: 10,
    encryptionStatus: "PLAINTEXT",
    keyReference: null,
    encryptionProfile: "local-plaintext-v1",
    artifactPinId: "pin-1",
    ...overrides,
  });
}

/** One valid event of each of the six shapes. */
const SIX: readonly Record<string, unknown>[] = [
  intention(),
  event("PUBLICATION_SUCCEEDED", { commandId: "cmd-1", contentSha256: CONTENT, blobGeneration: 1, artifactPinId: "pin-1", reference: reference() }, { subjectOrdinal: 2, parentSubjectOrdinal: 1 }),
  event("PUBLICATION_ABANDONED", { commandId: "cmd-1", contentSha256: CONTENT, blobGeneration: 1, artifactPinId: "pin-1" }, { subjectOrdinal: 2, parentSubjectOrdinal: 1 }),
  event("REFERENCE_RECORDED", { contentSha256: CONTENT, blobGeneration: 1, reference: reference() }),
  event("PIN_ACQUIRED", { artifactPinId: "pin-2", contentSha256: CONTENT, blobGeneration: 1, pinHolderKind: "TASK", pinHolderId: "task-1" }),
  event("PIN_RELEASED", { artifactPinId: "pin-2", contentSha256: CONTENT, blobGeneration: 1 }, { subjectOrdinal: 2, parentSubjectOrdinal: 1 }),
];

describe("the artifact vocabularies are artifacts §2 word for word", () => {
  it("pins each closed list, in the dictionary's order", () => {
    expect(ARTIFACT_CLASSES).toEqual([
      "TASK_ENVELOPE", "PROMPT", "RESPONSE", "TOOL_ARGUMENT", "TOOL_RESULT", "CHECKPOINT",
      "RECEIPT", "EVIDENCE", "PLAN_DOCUMENT", "POLICY_DOCUMENT", "PRICE_CATALOG", "EXPORT",
    ]);
    expect(ARTIFACT_CLASSIFICATIONS).toEqual(["PUBLIC_SAFE", "INTERNAL", "SENSITIVE", "SECRET_BEARING"]);
    expect(ENCRYPTION_STATUSES).toEqual(["PLAINTEXT", "ENCRYPTED_AT_REST"]);
    expect(RETENTION_CLASSES).toEqual(["EPHEMERAL", "STANDARD", "EXTENDED", "PERMANENT"]);
    expect(REFERENCE_SCOPE_KINDS).toEqual(["INITIATIVE", "TASK", "ACCOUNT", "SYSTEM"]);
    expect(BLOB_LIFECYCLE_STATES).toEqual(["STAGED", "PUBLISHED", "PUBLICATION_ABANDONED", "RECLAIM_INTENDED", "RECLAIMED"]);
    expect(PIN_HOLDER_KINDS).toEqual(["PUBLICATION", "TASK", "BACKUP", "LEGAL_HOLD"]);
  });

  it("names all nine event kinds, and gives shapes to six of them", () => {
    expect(ARTIFACT_EVENT_KINDS).toEqual([
      "PUBLICATION_INTENDED", "PUBLICATION_SUCCEEDED", "PUBLICATION_ABANDONED", "REFERENCE_RECORDED",
      "PIN_ACQUIRED", "PIN_RELEASED", "RECLAIM_INTENDED", "RECLAIM_COMPLETED", "REFERENCE_TOMBSTONED",
    ]);
    for (const candidate of SIX) {
      expect(ArtifactRegistryEvent.safeParse(candidate).success, String(candidate["artifactEventKind"])).toBe(true);
    }
    // The three words with no shape have no payload that could parse.
    for (const kind of ["RECLAIM_INTENDED", "RECLAIM_COMPLETED", "REFERENCE_TOMBSTONED"]) {
      expect(ArtifactRegistryEvent.safeParse(event(kind, { contentSha256: CONTENT })).success, kind).toBe(false);
    }
  });

  it("admits SECRET_BEARING as a word: refusing it in the stream is the ledger door's rule, by name", () => {
    expect(
      ArtifactRegistryEvent.safeParse(event("REFERENCE_RECORDED", { contentSha256: CONTENT, blobGeneration: 1, reference: reference({ classification: "SECRET_BEARING" }) })).success,
    ).toBe(true);
  });
});

describe("the six shapes are strict and carry the base's pairing rules", () => {
  it("refuses an unknown key at the top, in the payload and in the reference", () => {
    const [first] = SIX;
    expect(ArtifactRegistryEvent.safeParse({ ...first, extra: 1 }).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse(intention({ contentText: "the bytes" })).success).toBe(false);
    expect(
      ArtifactRegistryEvent.safeParse(event("REFERENCE_RECORDED", { contentSha256: CONTENT, blobGeneration: 1, reference: { ...reference(), acl: ["a"] } })).success,
    ).toBe(false);
  });

  it("is an ARTIFACT subject, never a document", () => {
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), subjectKind: "DOCUMENT" }).success).toBe(false);
  });

  it("ties the parent ordinal to the ordinal: none on the first, the one before on every later", () => {
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), subjectOrdinal: 1, parentSubjectOrdinal: 1 }).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), subjectOrdinal: 3, parentSubjectOrdinal: 1 }).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), subjectOrdinal: 3, parentSubjectOrdinal: null }).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), subjectOrdinal: 3, parentSubjectOrdinal: 2 }).success).toBe(true);
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), subjectOrdinal: 0 }).success).toBe(false);
  });

  it("takes one instant form, in UTC with milliseconds, and never records before it occurred", () => {
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), occurredAt: "2026-09-13T10:00:00Z" }).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), occurredAt: "2026-09-13T12:00:00.000+02:00" }).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), occurredAt: "2026-02-30T10:00:00.000Z", recordedAt: "2026-03-01T10:00:00.000Z" }).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), recordedAt: "2026-09-13T09:59:59.999Z" }).success).toBe(false);
  });

  it("carries a key reference if and only if the blob is encrypted at rest", () => {
    expect(ArtifactRegistryEvent.safeParse(intention({ keyReference: "keychain://acp/artifacts" })).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse(intention({ encryptionStatus: "ENCRYPTED_AT_REST" })).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse(intention({ encryptionStatus: "ENCRYPTED_AT_REST", keyReference: "keychain://acp/artifacts" })).success).toBe(true);
  });

  it("gives only a SYSTEM scope no owner, and expires every retention but PERMANENT", () => {
    const recorded = (overrides: Record<string, unknown>): boolean =>
      ArtifactRegistryEvent.safeParse(event("REFERENCE_RECORDED", { contentSha256: CONTENT, blobGeneration: 1, reference: reference(overrides) })).success;
    expect(recorded({ scopeId: null })).toBe(false);
    expect(recorded({ scopeKind: "SYSTEM", scopeId: null })).toBe(true);
    expect(recorded({ expiresAt: null })).toBe(false);
    expect(recorded({ retentionClass: "PERMANENT" })).toBe(false);
    expect(recorded({ retentionClass: "PERMANENT", expiresAt: null })).toBe(true);
  });

  it("carries an intended reference in an intention, strictly and with the reference's own rules (escalón C, decision 64)", () => {
    // With the block: the whole reference record, parsed.
    expect(ArtifactRegistryEvent.safeParse(intention({ intendedReference: reference() })).success).toBe(true);
    // Without it: an intention recorded before the block existed still parses.
    expect(ArtifactRegistryEvent.safeParse(intention()).success).toBe(true);
    // An unknown key inside the block is refused, as it is inside a success's reference.
    expect(ArtifactRegistryEvent.safeParse(intention({ intendedReference: { ...reference(), acl: ["a"] } })).success).toBe(false);
    // The two refinements are inherited: an owner on every scope but SYSTEM, and
    // an expiry on every retention but PERMANENT.
    expect(ArtifactRegistryEvent.safeParse(intention({ intendedReference: reference({ scopeKind: "TASK", scopeId: null }) })).success).toBe(false);
    expect(ArtifactRegistryEvent.safeParse(intention({ intendedReference: reference({ retentionClass: "STANDARD", expiresAt: null }) })).success).toBe(false);
    // A partial block is not a reference.
    expect(ArtifactRegistryEvent.safeParse(intention({ intendedReference: { artifactReferenceId: "ref-1" } })).success).toBe(false);
  });

  it("admits only the versions a reader reads", () => {
    for (const version of SUPPORTED_CONTRACT_VERSIONS) {
      expect(ArtifactRegistryEvent.safeParse({ ...intention(), contractVersion: version }).success, version).toBe(true);
    }
    expect(ArtifactRegistryEvent.safeParse({ ...intention(), contractVersion: "9.9.9" }).success).toBe(false);
  });
});

describe("laws 4 and 5 run over the whole artifact event", () => {
  const sentinel = "sk-ant-api03-SENTINELSENTINELSENTINEL";

  it("refuses a credential key anywhere, a secret-shaped value anywhere, and a transcript key", () => {
    const refused: readonly Record<string, unknown>[] = [
      event("PIN_ACQUIRED", { artifactPinId: "pin-2", contentSha256: CONTENT, blobGeneration: 1, pinHolderKind: "TASK", pinHolderId: sentinel }),
      intention({ keyReference: sentinel, encryptionStatus: "ENCRYPTED_AT_REST" }),
      event("REFERENCE_RECORDED", { contentSha256: CONTENT, blobGeneration: 1, reference: reference({ scopeId: "Bearer abcdefghijklmnopqrstuvwxyz012345" }) }),
      { ...intention(), recordedBy: sentinel },
      intention({ intendedReference: reference({ accessPolicyId: sentinel }) }),
    ];
    for (const candidate of refused) {
      const parsed = ArtifactRegistryEvent.safeParse(candidate);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(JSON.stringify(parsed.error.issues)).not.toContain(sentinel);
        expect(parsed.error.issues.some((issue) => issue.message.startsWith("credential material is forbidden"))).toBe(true);
      }
    }
  });
});

describe("the contract computes no identity", () => {
  it("returns exactly the value it was given: no default, no derivation, no rewrite", () => {
    for (const candidate of SIX) {
      expect(ArtifactRegistryEvent.parse(candidate)).toEqual(candidate);
    }
    // The intended reference is carried as given, and its absence stays absent:
    // no default is written into a historical body.
    const withBlock = intention({ intendedReference: reference() });
    expect(ArtifactRegistryEvent.parse(withBlock)).toEqual(withBlock);
    expect(Object.keys((ArtifactRegistryEvent.parse(intention()) as { payload: object }).payload)).not.toContain("intendedReference");
  });
});

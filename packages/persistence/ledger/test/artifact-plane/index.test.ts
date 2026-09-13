import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "@acp/contracts";

import {
  ARTIFACT_PLANE_CONTENT_MAX_BYTES,
  ARTIFACT_PLANE_REFUSALS,
  LedgerIdempotencyConflictError,
  LedgerIntegrityError,
  LedgerQueryError,
  LedgerValidationError,
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  artifactRootFor,
  hasArtifact,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  publishArtifact,
  readArtifact,
  type ArtifactBlobLeaseStore,
  type ArtifactPlane,
  type ArtifactPlaneOutcome,
  type ArtifactPlaneTestFaults,
  type ArtifactPublicationRequest,
  type ArtifactReconciliationRequest,
  type ArtifactReferenceReadModel,
  type Ledger,
} from "../../src/index.js";

/**
 * Evidence for the private artifact plane (P-36/local escalón C, ADR 0083).
 *
 * The escalón is an order — lease, intention, bytes, reference, release — and
 * the promise that a crash between any two of those steps leaves something a
 * reconciler can name and finish. So the suite is organised around the
 * negatives rather than the surface:
 *
 *   • the order itself: the reference is named only after the bytes survive the
 *     directory's synchronization (N-P36-7, N-P36-12, N-P36C-10);
 *   • the reader: by reference and scope, never by digest (N-P36-1, N-P36-2,
 *     N-P36-3, N-P36-5, N-P36-16, N-P36C-5, N-P36C-9);
 *   • what is refused before the lease (N-P36C-4, N-P36C-16, N-P36-17, E11);
 *   • two publishers of one digest, end to end (N-P36-13, N-P36C-15, N-P36C-2);
 *   • staging and a destination that already exists (N-P36C-2, N-P36C-3);
 *   • a holder whose lease was taken over (N-P36-14's filesystem half, N-P36C-6,
 *     N-P36C-1);
 *   • a crash at each seam, reconciled from a NEW plane over the same three
 *     substrates, with quiescence as an input (N-P36-4, N-P36-6, N-P36-8..11,
 *     N-P36C-1, N-P36C-7, N-P36C-8, N-P36C-17, N-P36C-18), and a success the
 *     ledger refuses, which holds no digest (N-P36C-19, N-P36C-20, O-2);
 *   • what the module may not do (N-P36C-11, N-P36C-12, N-P36C-14).
 *
 * A crash is a fault hook that throws: the call ends where it stands, with no
 * cleanup, and the handles are closed as a dead process's would be. No child
 * process and no wall-clock sleep: every instant is a literal and every pid a
 * fixture.
 */

const I1 = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const AT = "2026-09-13T10:00:00.000Z";
const LATER = "2026-09-13T11:00:00.000Z";
const RECONCILED_AT = "2026-09-13T12:00:00.000Z";
const PUBLISHER = "claude/opus/publisher/01";
const RESTARTED = "claude/opus/publisher/01#restarted";
const RECONCILER = "claude/opus/reconciler/01";
const DEAD_PID = 4242;
const LIVE_PID = 5151;
const SENTINEL = "sk-ant-api03-SENTINELSENTINELSENTINEL";

const BYTES = Buffer.from("the private bytes of one evidence artifact\n", "utf8");
const DIGEST = sha256(BYTES);
const OTHER_BYTES = Buffer.from("another artifact entirely, of other length\n", "utf8");

const SEAMS = [
  "afterLeaseAcquired",
  "afterIntentionRecorded",
  "afterStagingWritten",
  "afterStagingVerified",
  "afterStagingSynced",
  "afterRename",
  "afterDirectorySynced",
  "afterOutcomeRecorded",
] as const;
type Seam = (typeof SEAMS)[number];

const temporaryDirectories: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      /* a test may have closed it already */
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function temporaryLedgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-artifact-plane-"));
  temporaryDirectories.push(directory);
  return join(directory, "control-plane.sqlite");
}

interface Substrates {
  readonly ledger: Ledger;
  readonly leaseStore: ArtifactBlobLeaseStore;
  readonly plane: ArtifactPlane;
  /** A dead process's handles are closed; nothing it held is released. */
  readonly die: () => void;
}

/** A plane over the ledger, the lease file and the subroot of one ledger path: a process of its own. */
function substrates(ledgerPath: string, faults?: ArtifactPlaneTestFaults): Substrates {
  const ledger = openLedger(ledgerPath);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledgerPath), {
    incarnationId: I1,
    createdAt: CREATED_AT,
  });
  const die = (): void => {
    if (!ledger.closed) ledger.close();
    leaseStore.close();
  };
  closers.push(die);
  const plane = openArtifactPlane({
    ledger,
    leaseStore,
    ledgerPath,
    ...(faults === undefined ? {} : { __testFaults: faults }),
  });
  return { ledger, leaseStore, plane, die };
}

function reference(overrides: Record<string, unknown> = {}): ArtifactPublicationRequest["reference"] {
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
  } as ArtifactPublicationRequest["reference"];
}

function uuid(n: number): string {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

interface RequestInput {
  readonly content?: Buffer;
  readonly command?: number;
  readonly reference?: ArtifactPublicationRequest["reference"];
  readonly holder?: string;
  readonly holderPid?: number;
  readonly overrides?: Partial<ArtifactPublicationRequest>;
}

/** A publication request whose every identity is a fixture, numbered by its command. */
function request(input: RequestInput = {}): ArtifactPublicationRequest {
  const command = input.command ?? 1;
  return {
    content: input.content ?? BYTES,
    mediaType: "text/plain",
    encryptionStatus: "PLAINTEXT",
    encryptionProfile: "local-plaintext-v1",
    commandId: "cmd-" + String(command),
    artifactPinId: "pin-publication-" + String(command),
    reference: input.reference ?? reference({ artifactReferenceId: "ref-" + String(command) }),
    recordedBy: PUBLISHER,
    intention: {
      eventId: uuid(command * 10 + 1),
      idempotencyKey: "artifact/cmd-" + String(command) + "/intended",
      occurredAt: AT,
      recordedAt: AT,
    },
    terminal: {
      eventId: uuid(command * 10 + 2),
      idempotencyKey: "artifact/cmd-" + String(command) + "/terminal",
      occurredAt: LATER,
      recordedAt: LATER,
    },
    holding: {
      holder: input.holder ?? PUBLISHER,
      holderPid: input.holderPid ?? DEAD_PID,
      acquiredAt: AT,
      expiresAt: LATER,
    },
    ...input.overrides,
  };
}

/** A reconciliation request; `attested: false` leaves the quiescence attestation out entirely. */
function reconciliation(
  overrides: Partial<ArtifactReconciliationRequest> = {},
  attested = true,
): ArtifactReconciliationRequest {
  return {
    contentSha256: DIGEST,
    holding: { holder: RECONCILER, holderPid: LIVE_PID, acquiredAt: RECONCILED_AT, expiresAt: "2026-09-13T13:00:00.000Z" },
    ...(attested ? { quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID } as const } : {}),
    terminal: {
      eventId: uuid(9001),
      idempotencyKey: "artifact/reconciliation/terminal",
      occurredAt: RECONCILED_AT,
      recordedAt: RECONCILED_AT,
    },
    recordedBy: RECONCILER,
    ...overrides,
  };
}

function rootOf(ledgerPath: string): string {
  return realpathSync(artifactPlaneRootFor(ledgerPath));
}

function objectPath(ledgerPath: string, digest = DIGEST): string {
  return join(rootOf(ledgerPath), digest.slice(0, 2), digest);
}

function stagingPath(ledgerPath: string, digest = DIGEST): string {
  return objectPath(ledgerPath, digest) + ".staging";
}

/** The nine fields a reference request carries, picked out of a read model. */
function referenceFields(model: ArtifactReferenceReadModel): Record<string, unknown> {
  return {
    artifactReferenceId: model.artifactReferenceId,
    artifactClass: model.artifactClass,
    classification: model.classification,
    scopeKind: model.scopeKind,
    scopeId: model.scopeId,
    producerIdentity: model.producerIdentity,
    accessPolicyId: model.accessPolicyId,
    retentionClass: model.retentionClass,
    expiresAt: model.expiresAt,
  };
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function inodeOf(path: string): { readonly ino: number; readonly mtimeMs: number } {
  const stats = lstatSync(path);
  return { ino: stats.ino, mtimeMs: stats.mtimeMs };
}

/** Every entry under the subroot, with what it is, depth-first and sorted. */
function tree(ledgerPath: string): readonly string[] {
  const root = rootOf(ledgerPath);
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      const relative = path.slice(root.length + 1);
      if (stats.isSymbolicLink()) entries.push(relative + " -> link");
      else if (stats.isDirectory()) {
        entries.push(relative + "/");
        walk(path);
      } else entries.push(relative + " " + String(stats.size));
    }
  };
  walk(root);
  return entries;
}

function rows(ledgerPath: string, sql: string): readonly Record<string, unknown>[] {
  const raw = new Database(ledgerPath, { readonly: true });
  try {
    return raw.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

function leaseRows(ledgerPath: string): readonly Record<string, unknown>[] {
  const raw = new Database(artifactBlobLeaseStorePath(ledgerPath), { readonly: true });
  try {
    return raw.prepare("SELECT * FROM artifact_blob_lease ORDER BY content_sha256").all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

/** Everything the three substrates hold, for "nothing moved". */
function world(ledgerPath: string): unknown {
  return {
    registry: rows(ledgerPath, "SELECT sequence, artifact_event_kind, event_json FROM registry_events ORDER BY sequence"),
    blobs: rows(ledgerPath, "SELECT * FROM artifact_blob_read_model ORDER BY content_sha256, blob_generation"),
    references: rows(ledgerPath, "SELECT * FROM artifact_reference_read_model ORDER BY artifact_reference_id"),
    pins: rows(ledgerPath, "SELECT * FROM artifact_pin_read_model ORDER BY artifact_pin_id"),
    lease: leaseRows(ledgerPath),
    tree: tree(ledgerPath),
  };
}

function kinds(ledgerPath: string): readonly unknown[] {
  return rows(ledgerPath, "SELECT artifact_event_kind FROM registry_events ORDER BY sequence").map(
    (row) => row["artifact_event_kind"],
  );
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

function expectVerb<V extends ArtifactPlaneOutcome["verb"]>(
  outcome: ArtifactPlaneOutcome,
  verb: V,
): Extract<ArtifactPlaneOutcome, { readonly verb: V }> {
  expect(outcome.verb).toBe(verb);
  return outcome as Extract<ArtifactPlaneOutcome, { readonly verb: V }>;
}

/** Publish with a fault that throws at one seam, and let the process die there. */
function crashAt(ledgerPath: string, seam: Seam, input: RequestInput = {}): void {
  const doomed = substrates(ledgerPath, {
    [seam]: () => {
      throw new Error("the process dies at " + seam);
    },
  });
  expect(() => doomed.plane.publish(request(input))).toThrow("the process dies at " + seam);
  doomed.die();
}

// ---------------------------------------------------------------------------

describe("a publication names its bytes only after they survive the fsync (artifacts §8)", () => {
  it("takes the lease, records the intention, writes, verifies, renames, synchronizes, records the reference and releases, in that order", () => {
    const ledgerPath = temporaryLedgerPath();
    const trace: string[] = [];
    let observer: Substrates | null = null;
    const look = (seam: string) => (): void => {
      const eye = observer;
      if (eye === null) throw new Error("no observer");
      const lease = eye.leaseStore.read(DIGEST);
      const blob = eye.ledger.getUnreclaimedArtifactBlob(DIGEST);
      trace.push(
        [
          seam,
          "lease=" + String(lease?.operation ?? null),
          "blob=" + String(blob?.lifecycleState ?? null),
          "reference=" + String(eye.ledger.getArtifactReference("ref-1") !== null),
          "livePins=" + String(eye.ledger.listLiveArtifactPins("PUBLICATION").length),
          "staging=" + String(existsSync(stagingPath(ledgerPath))),
          "object=" + String(existsSync(objectPath(ledgerPath))),
        ].join(" "),
      );
    };
    const faults = Object.fromEntries(SEAMS.map((seam) => [seam, look(seam)])) as ArtifactPlaneTestFaults;
    const live = substrates(ledgerPath, faults);
    observer = substrates(ledgerPath);

    const outcome = expectVerb(live.plane.publish(request()), "PUBLISHED");
    expect(outcome).toMatchObject({ contentSha256: DIGEST, blobGeneration: 1, bytesWritten: true, replayed: false });
    expect(outcome.release.verb).toBe("APPLIED");

    expect(trace).toEqual([
      "afterLeaseAcquired lease=PUBLISH blob=null reference=false livePins=0 staging=false object=false",
      "afterIntentionRecorded lease=PUBLISH blob=STAGED reference=false livePins=1 staging=false object=false",
      "afterStagingWritten lease=PUBLISH blob=STAGED reference=false livePins=1 staging=true object=false",
      "afterStagingVerified lease=PUBLISH blob=STAGED reference=false livePins=1 staging=true object=false",
      "afterStagingSynced lease=PUBLISH blob=STAGED reference=false livePins=1 staging=true object=false",
      "afterRename lease=PUBLISH blob=STAGED reference=false livePins=1 staging=false object=true",
      "afterDirectorySynced lease=PUBLISH blob=STAGED reference=false livePins=1 staging=false object=true",
      "afterOutcomeRecorded lease=PUBLISH blob=PUBLISHED reference=true livePins=0 staging=false object=true",
    ]);
    expect(kinds(ledgerPath)).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_SUCCEEDED"]);
  });

  it("N-P36-12: a success leaves no live pin and a free lease, and the reference is the one requested", () => {
    const ledgerPath = temporaryLedgerPath();
    const { plane, ledger, leaseStore } = substrates(ledgerPath);
    const outcome = expectVerb(plane.publish(request()), "PUBLISHED");

    expect(ledger.listLiveArtifactPins("PUBLICATION")).toEqual([]);
    expect(ledger.getArtifactPin("pin-publication-1")?.releasedSequence).toBe(2);
    expect(ledger.getArtifactBlob(DIGEST, 1)).toMatchObject({ lifecycleState: "PUBLISHED", sizeBytes: BYTES.byteLength, encryptionStatus: "PLAINTEXT" });
    expect(leaseStore.read(DIGEST)).toMatchObject({ operation: null, generation: 1 });
    expect(referenceFields(outcome.reference)).toEqual(reference());
    expect(outcome.reference).toMatchObject({ tombstonedAt: null, tombstoneReason: null, contentSha256: DIGEST, blobGeneration: 1 });
    expect(readFileSync(objectPath(ledgerPath))).toEqual(BYTES);
    expect(tree(ledgerPath)).toEqual([DIGEST.slice(0, 2) + "/", DIGEST.slice(0, 2) + "/" + DIGEST + " " + String(BYTES.byteLength)]);
  });

  it("N-P36C-10: the subroot and its shard are 0700 and the object 0600, whatever the umask", () => {
    const ledgerPath = temporaryLedgerPath();
    const previous = process.umask(0o377);
    let outcome: ArtifactPlaneOutcome;
    try {
      const { plane } = substrates(ledgerPath);
      outcome = plane.publish(request());
    } finally {
      process.umask(previous);
    }
    expect(outcome.verb).toBe("PUBLISHED");
    expect(modeOf(rootOf(ledgerPath))).toBe(0o700);
    expect(modeOf(dirname(objectPath(ledgerPath)))).toBe(0o700);
    expect(modeOf(objectPath(ledgerPath))).toBe(0o600);
  });

  it("N-P36-7: while the generation is STAGED no reference row exists, and the staged file is already 0600", () => {
    const ledgerPath = temporaryLedgerPath();
    const seen: unknown[] = [];
    let eye: Substrates | null = null;
    const { plane } = substrates(ledgerPath, {
      afterStagingSynced: () => {
        if (eye === null) throw new Error("no observer");
        seen.push({
          blob: eye.ledger.getArtifactBlob(DIGEST, 1)?.lifecycleState,
          references: rows(ledgerPath, "SELECT COUNT(*) AS n FROM artifact_reference_read_model")[0],
          staging: modeOf(stagingPath(ledgerPath)),
          read: eye.plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" }),
        });
      },
    });
    eye = substrates(ledgerPath);
    expect(plane.publish(request()).verb).toBe("PUBLISHED");
    expect(seen).toEqual([
      { blob: "STAGED", references: { n: 0 }, staging: 0o600, read: { verb: "REFUSE", refusal: "REFERENCE_NOT_READABLE" } },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("a read goes by reference and scope, and verifies the bytes on the way out (artifacts §4, §10)", () => {
  function published(input: RequestInput = {}): { readonly ledgerPath: string; readonly plane: ArtifactPlane; readonly ledger: Ledger } {
    const ledgerPath = temporaryLedgerPath();
    const { plane, ledger } = substrates(ledgerPath);
    expect(plane.publish(request(input)).verb).toBe("PUBLISHED");
    return { ledgerPath, plane, ledger };
  }

  it("returns the verified bytes to the reference's own scope", () => {
    const { plane } = published();
    const outcome = plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" });
    expect(outcome.verb).toBe("READ");
    if (outcome.verb === "READ") {
      expect(outcome.content).toEqual(BYTES);
      expect(outcome.reference.artifactReferenceId).toBe("ref-1");
    }
  });

  it("N-P36-1, N-P36C-9: another scope is refused with the same word as a reference that does not exist", () => {
    const { plane } = published();
    const absent = plane.read({ artifactReferenceId: "ref-nobody-recorded", scopeKind: "TASK", scopeId: "task-1" });
    expect(absent).toEqual({ verb: "REFUSE", refusal: "REFERENCE_NOT_READABLE" });
    for (const scope of [
      { scopeKind: "TASK", scopeId: "task-2" },
      { scopeKind: "INITIATIVE", scopeId: "task-1" },
      { scopeKind: "ACCOUNT", scopeId: "task-1" },
      { scopeKind: "SYSTEM", scopeId: null },
    ] as const) {
      expect(plane.read({ artifactReferenceId: "ref-1", ...scope }), JSON.stringify(scope)).toEqual(absent);
    }
  });

  it("N-P36C-9: a SYSTEM reference is read only by a SYSTEM reader, and a reader names its id unless it is SYSTEM", () => {
    const { plane } = published({ reference: reference({ scopeKind: "SYSTEM", scopeId: null }) });
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "SYSTEM", scopeId: null }).verb).toBe("READ");
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" }).verb).toBe("REFUSE");
    expect(caught(() => plane.read({ artifactReferenceId: "ref-1", scopeKind: "SYSTEM", scopeId: "x" }))).toBeInstanceOf(LedgerQueryError);
    expect(caught(() => plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: null }))).toBeInstanceOf(LedgerQueryError);
    expect(caught(() => plane.read({ artifactReferenceId: "", scopeKind: "SYSTEM", scopeId: null }))).toBeInstanceOf(LedgerQueryError);
  });

  it("N-P36-16: a reference whose expiry has long passed is still readable; expiring revokes nothing", () => {
    const { plane } = published({ reference: reference({ expiresAt: "2001-01-01T00:00:00.000Z" }) });
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" }).verb).toBe("READ");
  });

  it("N-P36-5: a live reference whose bytes are gone is an explicit refusal, never an empty answer", () => {
    const { plane, ledgerPath } = published();
    rmSync(objectPath(ledgerPath));
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" })).toEqual({ verb: "REFUSE", refusal: "CONTENT_ABSENT" });
    rmSync(dirname(objectPath(ledgerPath)), { recursive: true });
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" })).toEqual({ verb: "REFUSE", refusal: "CONTENT_ABSENT" });
  });

  it("N-P36C-5: bytes that stand and do not verify are refused, and no byte is handed back", () => {
    const { plane, ledgerPath } = published();
    const corrupt = Buffer.from(BYTES);
    corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
    writeFileSync(objectPath(ledgerPath), corrupt);
    const sameSize = plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" });
    expect(sameSize).toEqual({ verb: "REFUSE", refusal: "CONTENT_DOES_NOT_VERIFY" });
    writeFileSync(objectPath(ledgerPath), Buffer.concat([BYTES, Buffer.from("x")]));
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" })).toEqual({ verb: "REFUSE", refusal: "CONTENT_DOES_NOT_VERIFY" });
  });

  it("N-P36-3: a symbolic link at the object or at the shard is refused when opened, even if it leads to the right bytes", () => {
    const { plane, ledgerPath } = published();
    const outside = join(dirname(ledgerPath), "outside");
    mkdirSync(join(outside, DIGEST.slice(0, 2)), { recursive: true });
    writeFileSync(join(outside, DIGEST.slice(0, 2), DIGEST), BYTES);

    const object = objectPath(ledgerPath);
    renameSync(object, object + ".moved");
    symlinkSync(join(outside, DIGEST.slice(0, 2), DIGEST), object);
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" })).toEqual({ verb: "REFUSE", refusal: "SYMLINK_REFUSED" });

    const shard = dirname(object);
    renameSync(shard, shard + ".moved");
    symlinkSync(join(outside, DIGEST.slice(0, 2)), shard);
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" })).toEqual({ verb: "REFUSE", refusal: "SYMLINK_REFUSED" });
  });

  it("the root is resolved once: a directory swapped in under its name, or a link, fails closed", () => {
    const { plane, ledgerPath } = published();
    const root = rootOf(ledgerPath);
    renameSync(root, root + ".moved");
    mkdirSync(root, { mode: 0o700 });
    expect(caught(() => plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" }))).toBeInstanceOf(LedgerIntegrityError);
    rmSync(root, { recursive: true });
    symlinkSync(root + ".moved", root);
    expect(caught(() => plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" }))).toBeInstanceOf(LedgerIntegrityError);
    // And a plane opened over a link refuses to open at all.
    const ledger = openLedger(ledgerPath);
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledgerPath), { incarnationId: I1, createdAt: CREATED_AT });
    closers.push(() => {
      ledger.close();
      leaseStore.close();
    });
    expect(() => openArtifactPlane({ ledger, leaseStore, ledgerPath })).toThrow(/symbolic link/);
  });

  it("H-15: a tombstoned reference reads as deleted, and a generation that is no longer published is refused", () => {
    const tombstoned = published();
    tombstoned.ledger.close();
    const raw = new Database(tombstoned.ledgerPath);
    raw.prepare("UPDATE artifact_reference_read_model SET tombstoned_at = ?, tombstone_reason = 'OWNER_REQUEST'").run(LATER);
    raw.close();
    const again = substrates(tombstoned.ledgerPath);
    expect(again.plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" })).toEqual({ verb: "REFUSE", refusal: "CONTENT_DELETED" });

    const reclaiming = published();
    reclaiming.ledger.close();
    const second = new Database(reclaiming.ledgerPath);
    second.prepare("UPDATE artifact_blob_read_model SET lifecycle_state = 'RECLAIM_INTENDED', reclaim_id = 'reclaim-1'").run();
    second.close();
    const later = substrates(reclaiming.ledgerPath);
    expect(later.plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" })).toEqual({ verb: "REFUSE", refusal: "BLOB_NOT_PUBLISHED" });
  });

  it("E11: a generation another producer recorded ENCRYPTED_AT_REST is refused by name, not decrypted and not served", () => {
    const ledgerPath = temporaryLedgerPath();
    const { ledger, plane } = substrates(ledgerPath);
    const common = { contractVersion: CONTRACT_VERSION, subjectKind: "ARTIFACT", recordedBy: PUBLISHER, occurredAt: AT, recordedAt: AT };
    ledger.appendArtifactEvent({
      ...common,
      eventId: uuid(1),
      idempotencyKey: "foreign/intended",
      artifactEventKind: "PUBLICATION_INTENDED",
      subjectOrdinal: 1,
      parentSubjectOrdinal: null,
      payload: { commandId: "foreign", contentSha256: DIGEST, blobGeneration: 1, mediaType: "text/plain", sizeBytes: BYTES.byteLength, encryptionStatus: "ENCRYPTED_AT_REST", keyReference: "keychain://acp/artifacts", encryptionProfile: "aes-gcm-v1", artifactPinId: "pin-foreign" },
    });
    ledger.appendArtifactEvent({
      ...common,
      eventId: uuid(2),
      idempotencyKey: "foreign/succeeded",
      artifactEventKind: "PUBLICATION_SUCCEEDED",
      subjectOrdinal: 2,
      parentSubjectOrdinal: 1,
      payload: { commandId: "foreign", contentSha256: DIGEST, blobGeneration: 1, artifactPinId: "pin-foreign", reference: reference() },
    });
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" })).toEqual({ verb: "REFUSE", refusal: "ENCRYPTED_AT_REST_NOT_DELIVERED" });
  });

  it("N-P36-2: the legacy digest store cannot reach a private object, and the two roots are siblings", () => {
    const { ledgerPath, plane } = published();
    const legacyRoot = artifactRootFor(ledgerPath);
    expect(readArtifact(legacyRoot, DIGEST)).toMatchObject({ ok: false, reason: "ARTIFACT_ABSENT" });
    expect(hasArtifact(legacyRoot, DIGEST)).toBe(false);
    expect(dirname(artifactPlaneRootFor(ledgerPath))).toBe(dirname(legacyRoot));
    expect([basename(legacyRoot), basename(artifactPlaneRootFor(ledgerPath))]).toEqual(["artifacts", "private-artifacts"]);

    // And the other way: a legacy object is no private publication.
    const legacy = publishArtifact(legacyRoot, "a roadmap's bytes");
    expect(legacy.ok).toBe(true);
    rmSync(objectPath(ledgerPath));
    expect(plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" })).toEqual({ verb: "REFUSE", refusal: "CONTENT_ABSENT" });
  });
});

// ---------------------------------------------------------------------------

describe("what a publication is refused for, before the lease is asked for", () => {
  function refusedBeforeTheLease(mutate: (base: ArtifactPublicationRequest) => ArtifactPublicationRequest): unknown {
    const ledgerPath = temporaryLedgerPath();
    const { plane } = substrates(ledgerPath);
    const before = world(ledgerPath);
    const error = caught(() => plane.publish(mutate(request())));
    expect(world(ledgerPath)).toEqual(before);
    expect(leaseRows(ledgerPath)).toEqual([]);
    return error;
  }

  it("N-P36C-4: a declared digest or size that is not the content's; the plane computes both", () => {
    expect(refusedBeforeTheLease((base) => ({ ...base, declaredContentSha256: "0".repeat(64) }))).toBeInstanceOf(LedgerValidationError);
    expect(refusedBeforeTheLease((base) => ({ ...base, declaredSizeBytes: BYTES.byteLength + 1 }))).toBeInstanceOf(LedgerValidationError);
    const ledgerPath = temporaryLedgerPath();
    const { plane } = substrates(ledgerPath);
    expect(plane.publish({ ...request(), declaredContentSha256: DIGEST, declaredSizeBytes: BYTES.byteLength }).verb).toBe("PUBLISHED");
  });

  it("N-P36C-16: content over the plane's bound, and anything that is not bytes", () => {
    const tooLarge = refusedBeforeTheLease((base) => ({ ...base, content: Buffer.alloc(ARTIFACT_PLANE_CONTENT_MAX_BYTES + 1) }));
    expect(tooLarge).toBeInstanceOf(LedgerValidationError);
    expect((tooLarge as Error).message).toContain(String(ARTIFACT_PLANE_CONTENT_MAX_BYTES));
    expect(refusedBeforeTheLease((base) => ({ ...base, content: "text" as unknown as Uint8Array }))).toBeInstanceOf(LedgerValidationError);
  });

  it("E11: ENCRYPTED_AT_REST is refused by name", () => {
    const error = refusedBeforeTheLease((base) => ({ ...base, encryptionStatus: "ENCRYPTED_AT_REST" }));
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as Error).message).toContain("ENCRYPTED_AT_REST");
  });

  it("a SECRET_BEARING reference and a policy outside the closed set", () => {
    const secret = refusedBeforeTheLease((base) => ({ ...base, reference: reference({ classification: "SECRET_BEARING" }) }));
    expect((secret as LedgerValidationError).issues.map((issue) => issue.path)).toEqual(["reference.classification"]);
    const policy = refusedBeforeTheLease((base) => ({ ...base, reference: reference({ accessPolicyId: "OPEN_TO_ALL" }) }));
    expect((policy as LedgerValidationError).issues.map((issue) => issue.path)).toEqual(["reference.accessPolicyId"]);
    expect(refusedBeforeTheLease((base) => ({ ...base, reference: reference({ scopeId: null }) }))).toBeInstanceOf(LedgerValidationError);
  });

  it("N-P36-17: a credential sentinel in any metadata field is refused by path and appears in no error, row or file", () => {
    for (const mutate of [
      (base: ArtifactPublicationRequest) => ({ ...base, reference: reference({ scopeId: SENTINEL }) }),
      (base: ArtifactPublicationRequest) => ({ ...base, recordedBy: SENTINEL }),
      (base: ArtifactPublicationRequest) => ({ ...base, commandId: SENTINEL }),
      (base: ArtifactPublicationRequest) => ({ ...base, terminal: { ...base.terminal, idempotencyKey: SENTINEL } }),
    ]) {
      const error = refusedBeforeTheLease(mutate);
      expect(error).toBeInstanceOf(LedgerValidationError);
      expect((error as Error).message).not.toContain(SENTINEL);
      expect(JSON.stringify((error as LedgerValidationError).issues)).not.toContain(SENTINEL);
    }
  });

  it("N-P36-17: a sentinel inside the content is the content's: the bytes are published and no event, row or lease names them", () => {
    const ledgerPath = temporaryLedgerPath();
    const { plane } = substrates(ledgerPath);
    const content = Buffer.from("a transcript that quotes " + SENTINEL + " verbatim", "utf8");
    expect(plane.publish(request({ content })).verb).toBe("PUBLISHED");
    const stored = JSON.stringify({ registry: rows(ledgerPath, "SELECT * FROM registry_events"), lease: leaseRows(ledgerPath) });
    expect(stored).not.toContain(SENTINEL);
    expect(stored).toContain(sha256(content));
  });

  it("a malformed holding or attestation is refused by name", () => {
    expect(refusedBeforeTheLease((base) => ({ ...base, holding: { ...base.holding, holderPid: 0 } }))).toBeInstanceOf(LedgerQueryError);
    expect(refusedBeforeTheLease((base) => ({ ...base, holding: { ...base.holding, holder: "" } }))).toBeInstanceOf(LedgerQueryError);
    expect(
      refusedBeforeTheLease((base) => ({ ...base, quiescence: { basis: "IT_LOOKED_QUIET" as never, holderPid: DEAD_PID } })),
    ).toBeInstanceOf(LedgerQueryError);
  });
});

// ---------------------------------------------------------------------------

describe("two publishers of one digest, end to end (N-P36-13, N-P36C-15, N-P36C-2)", () => {
  it("the loser is refused without an intention or a file; its later publication deduplicates and verifies without rewriting", () => {
    const ledgerPath = temporaryLedgerPath();
    const rival = substrates(ledgerPath);
    const during: unknown[] = [];
    const winner = substrates(ledgerPath, {
      afterIntentionRecorded: () => {
        const before = world(ledgerPath);
        const lost = rival.plane.publish(request({ command: 2, holder: "claude/opus/publisher/02", holderPid: LIVE_PID }));
        during.push({ lost, unchanged: JSON.stringify(world(ledgerPath)) === JSON.stringify(before) });
      },
    });

    expect(winner.plane.publish(request()).verb).toBe("PUBLISHED");
    expect(during).toHaveLength(1);
    const [first] = during as { lost: ArtifactPlaneOutcome; unchanged: boolean }[];
    expect(first?.unchanged).toBe(true);
    expect(first?.lost).toMatchObject({ verb: "REFUSE", refusal: "LEASE_HELD", leaseRefusal: null });
    expect(rows(ledgerPath, "SELECT COUNT(*) AS n FROM registry_events WHERE event_json LIKE '%cmd-2%'")).toEqual([{ n: 0 }]);

    const before = inodeOf(objectPath(ledgerPath));
    const later = expectVerb(rival.plane.publish(request({ command: 2, holder: "claude/opus/publisher/02", holderPid: LIVE_PID })), "PUBLISHED");
    expect(later).toMatchObject({ blobGeneration: 1, bytesWritten: false, replayed: false });
    expect(inodeOf(objectPath(ledgerPath))).toEqual(before);
    expect(rows(ledgerPath, "SELECT blob_generation, lifecycle_state FROM artifact_blob_read_model")).toEqual([
      { blob_generation: 1, lifecycle_state: "PUBLISHED" },
    ]);
    expect(rows(ledgerPath, "SELECT artifact_reference_id FROM artifact_reference_read_model ORDER BY 1")).toEqual([
      { artifact_reference_id: "ref-1" },
      { artifact_reference_id: "ref-2" },
    ]);
    expect(rival.ledger.listLiveArtifactPins("PUBLICATION")).toEqual([]);
    expect(leaseRows(ledgerPath)).toMatchObject([{ operation: null, generation: 2 }]);
  });
});

// ---------------------------------------------------------------------------

describe("a destination or a staging path that is already there (N-P36C-2, N-P36C-3)", () => {
  function planted(ledgerPath: string, bytes: Buffer): void {
    const shard = join(rootOf(ledgerPath), DIGEST.slice(0, 2));
    mkdirSync(shard, { mode: 0o700 });
    writeFileSync(join(shard, DIGEST), bytes, { mode: 0o600 });
  }

  it("the right bytes already at the digest's path are verified, not rewritten, not renamed", () => {
    const ledgerPath = temporaryLedgerPath();
    const { plane } = substrates(ledgerPath);
    planted(ledgerPath, BYTES);
    const before = inodeOf(objectPath(ledgerPath));
    expect(expectVerb(plane.publish(request()), "PUBLISHED").bytesWritten).toBe(false);
    expect(inodeOf(objectPath(ledgerPath))).toEqual(before);
  });

  it("other bytes at the digest's path are neither overwritten nor removed, and the publication is abandoned", () => {
    const ledgerPath = temporaryLedgerPath();
    const { plane, ledger, leaseStore } = substrates(ledgerPath);
    planted(ledgerPath, OTHER_BYTES);
    const outcome = expectVerb(plane.publish(request()), "ABANDONED");
    expect(outcome.refusal).toBe("CONTENT_DOES_NOT_VERIFY");
    expect(readFileSync(objectPath(ledgerPath))).toEqual(OTHER_BYTES);
    expect(ledger.getArtifactBlob(DIGEST, 1)?.lifecycleState).toBe("PUBLICATION_ABANDONED");
    expect(ledger.getArtifactReference("ref-1")).toBeNull();
    expect(ledger.listLiveArtifactPins("PUBLICATION")).toEqual([]);
    expect(leaseStore.read(DIGEST)?.operation).toBeNull();
  });

  it("a link at the digest's path is refused and left alone, and so is what it points to", () => {
    const ledgerPath = temporaryLedgerPath();
    const { plane } = substrates(ledgerPath);
    const target = join(dirname(ledgerPath), "target");
    writeFileSync(target, BYTES);
    mkdirSync(join(rootOf(ledgerPath), DIGEST.slice(0, 2)), { mode: 0o700 });
    symlinkSync(target, objectPath(ledgerPath));
    expect(expectVerb(plane.publish(request()), "ABANDONED").refusal).toBe("SYMLINK_REFUSED");
    expect(lstatSync(objectPath(ledgerPath)).isSymbolicLink()).toBe(true);
    expect(readFileSync(target)).toEqual(BYTES);
  });

  it("N-P36C-3: a dead attempt's staging residue, or a link planted there, is replaced and never followed", () => {
    const ledgerPath = temporaryLedgerPath();
    const { plane } = substrates(ledgerPath);
    planted(ledgerPath, BYTES);
    rmSync(objectPath(ledgerPath));
    writeFileSync(stagingPath(ledgerPath), "half of a dead attempt");
    expect(expectVerb(plane.publish(request()), "PUBLISHED").bytesWritten).toBe(true);
    expect(existsSync(stagingPath(ledgerPath))).toBe(false);

    const second = temporaryLedgerPath();
    const other = substrates(second);
    const victim = join(dirname(second), "victim");
    writeFileSync(victim, "must not be written through a link");
    mkdirSync(join(rootOf(second), DIGEST.slice(0, 2)), { mode: 0o700 });
    symlinkSync(victim, stagingPath(second));
    expect(other.plane.publish(request()).verb).toBe("PUBLISHED");
    expect(readFileSync(victim, "utf8")).toBe("must not be written through a link");
    expect(readFileSync(objectPath(second))).toEqual(BYTES);
  });

  it("staged bytes that do not verify are removed and the publication abandoned, keeping the generation's grace", () => {
    const ledgerPath = temporaryLedgerPath();
    const { plane, ledger } = substrates(ledgerPath, {
      afterStagingWritten: () => {
        writeFileSync(stagingPath(ledgerPath), OTHER_BYTES);
      },
    });
    expect(expectVerb(plane.publish(request()), "ABANDONED").refusal).toBe("CONTENT_DOES_NOT_VERIFY");
    expect(existsSync(stagingPath(ledgerPath))).toBe(false);
    expect(existsSync(objectPath(ledgerPath))).toBe(false);
    expect(ledger.getArtifactBlob(DIGEST, 1)).toMatchObject({ lifecycleState: "PUBLICATION_ABANDONED", graceStartedAt: AT });
  });
});

// ---------------------------------------------------------------------------

describe("a holder whose lease was taken over writes nothing more (N-P36-14, N-P36C-6, N-P36C-1)", () => {
  function takenOverAt(seam: "afterIntentionRecorded" | "afterStagingSynced" | "afterDirectorySynced"): {
    readonly ledgerPath: string;
    readonly outcome: ArtifactPlaneOutcome;
    readonly after: unknown;
    readonly afterSeam: unknown;
  } {
    const ledgerPath = temporaryLedgerPath();
    const other = substrates(ledgerPath);
    let afterSeam: unknown = null;
    const { plane } = substrates(ledgerPath, {
      [seam]: () => {
        const token = other.leaseStore.readToken(DIGEST);
        if (token === null) throw new Error("no holding to take over");
        const taken = other.leaseStore.takeOver(token, { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID }, {
          contentSha256: DIGEST,
          operation: "PUBLISH",
          operationId: "cmd-1",
          holder: RECONCILER,
          holderPid: LIVE_PID,
          acquiredAt: RECONCILED_AT,
          expiresAt: "2026-09-13T13:00:00.000Z",
        });
        expect(taken.verb).toBe("APPLIED");
        afterSeam = world(ledgerPath);
      },
    });
    const outcome = plane.publish(request());
    return { ledgerPath, outcome, after: world(ledgerPath), afterSeam };
  }

  it("taken over after the intention: no staging, no object, no success", () => {
    const { ledgerPath, outcome, after, afterSeam } = takenOverAt("afterIntentionRecorded");
    expect(outcome).toMatchObject({ verb: "REFUSE", refusal: "LEASE_SUPERSEDED" });
    expect(after).toEqual(afterSeam);
    expect(tree(ledgerPath)).toEqual([]);
    expect(kinds(ledgerPath)).toEqual(["PUBLICATION_INTENDED"]);
  });

  it("taken over before the rename: the staged file is not renamed and no success is recorded", () => {
    const { ledgerPath, outcome, after, afterSeam } = takenOverAt("afterStagingSynced");
    expect(outcome).toMatchObject({ verb: "REFUSE", refusal: "LEASE_SUPERSEDED" });
    expect(after).toEqual(afterSeam);
    expect(existsSync(objectPath(ledgerPath))).toBe(false);
    expect(existsSync(stagingPath(ledgerPath))).toBe(true);
    expect(kinds(ledgerPath)).toEqual(["PUBLICATION_INTENDED"]);
  });

  it("taken over after the bytes are durable: the success is not recorded and the pin stays live", () => {
    const { ledgerPath, outcome, after, afterSeam } = takenOverAt("afterDirectorySynced");
    expect(outcome).toMatchObject({ verb: "REFUSE", refusal: "LEASE_SUPERSEDED" });
    expect(after).toEqual(afterSeam);
    expect(kinds(ledgerPath)).toEqual(["PUBLICATION_INTENDED"]);
    expect(rows(ledgerPath, "SELECT COUNT(*) AS n FROM artifact_pin_read_model WHERE released_sequence IS NULL")).toEqual([{ n: 1 }]);
  });

  it("N-P36C-1: taken over after the success, the refused release is a value and the publication stands", () => {
    const ledgerPath = temporaryLedgerPath();
    const other = substrates(ledgerPath);
    const { plane } = substrates(ledgerPath, {
      afterOutcomeRecorded: () => {
        const token = other.leaseStore.readToken(DIGEST);
        if (token === null) throw new Error("no holding");
        other.leaseStore.revoke(token, { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID });
      },
    });
    const outcome = expectVerb(plane.publish(request()), "PUBLISHED");
    expect(outcome.release).toMatchObject({ verb: "REFUSE", refusal: "GENERATION_SUPERSEDED" });
    expect(other.plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" }).verb).toBe("READ");
  });
});

// ---------------------------------------------------------------------------

describe("a crash at each seam is reconciled from a new plane over the same substrates (artifacts §8 :260-271)", () => {
  it("N-P36-8, N-P36C-8: a holding with no intention survives until quiescence is attested about its own process, then ends", () => {
    const ledgerPath = temporaryLedgerPath();
    crashAt(ledgerPath, "afterLeaseAcquired");
    const next = substrates(ledgerPath);
    const before = world(ledgerPath);

    expect(next.plane.reconcile(reconciliation({}, false))).toMatchObject({ verb: "REFUSE", refusal: "QUIESCENCE_UNPROVEN" });
    expect(next.plane.reconcile(reconciliation({ quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: 9999 } }))).toMatchObject({
      verb: "REFUSE",
      refusal: "QUIESCENCE_OF_ANOTHER_PROCESS",
    });
    expect(next.plane.publish(request({ command: 2, holder: "claude/opus/publisher/02", holderPid: LIVE_PID }))).toMatchObject({
      verb: "REFUSE",
      refusal: "LEASE_HELD",
    });
    expect(world(ledgerPath)).toEqual(before);

    const revoked = expectVerb(next.plane.reconcile(reconciliation()), "HOLDING_REVOKED");
    expect(revoked.lease).toMatchObject({ operation: null, generation: 2 });
    expect(kinds(ledgerPath)).toEqual([]);
    expect(tree(ledgerPath)).toEqual([]);
    expect(next.plane.publish(request({ command: 2, holder: "claude/opus/publisher/02", holderPid: LIVE_PID })).verb).toBe("PUBLISHED");
  });

  it("N-P36-9, N-P36C-7: a restarted publisher finds its intention, appends no second one, and finishes under the same keys", () => {
    const ledgerPath = temporaryLedgerPath();
    crashAt(ledgerPath, "afterIntentionRecorded");
    expect(kinds(ledgerPath)).toEqual(["PUBLICATION_INTENDED"]);
    const intention = rows(ledgerPath, "SELECT sequence, event_json FROM registry_events");

    const restarted = substrates(ledgerPath);
    // Without an attestation, and with one about somebody else, it moves nothing.
    const before = world(ledgerPath);
    expect(restarted.plane.publish(request({ holder: RESTARTED, holderPid: LIVE_PID }))).toMatchObject({ verb: "REFUSE", refusal: "QUIESCENCE_UNPROVEN" });
    expect(
      restarted.plane.publish({ ...request({ holder: RESTARTED, holderPid: LIVE_PID }), quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: 7 } }),
    ).toMatchObject({ verb: "REFUSE", refusal: "QUIESCENCE_OF_ANOTHER_PROCESS" });
    // The same holder name would be answered by the store as a replay that keeps the dead pid.
    expect(caught(() => restarted.plane.publish({ ...request({ holderPid: LIVE_PID }), quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID } }))).toBeInstanceOf(
      LedgerQueryError,
    );
    expect(world(ledgerPath)).toEqual(before);

    const outcome = expectVerb(
      restarted.plane.publish({ ...request({ holder: RESTARTED, holderPid: LIVE_PID }), quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID } }),
      "PUBLISHED",
    );
    expect(outcome).toMatchObject({ blobGeneration: 1, bytesWritten: true, replayed: false });
    expect(kinds(ledgerPath)).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_SUCCEEDED"]);
    expect(rows(ledgerPath, "SELECT sequence, event_json FROM registry_events WHERE sequence = 1")).toEqual(intention);
    expect(rows(ledgerPath, "SELECT COUNT(*) AS n FROM artifact_pin_read_model")).toEqual([{ n: 1 }]);
    expect(rows(ledgerPath, "SELECT idempotency_key FROM registry_events ORDER BY sequence")).toEqual([
      { idempotency_key: "artifact/cmd-1/intended" },
      { idempotency_key: "artifact/cmd-1/terminal" },
    ]);
    expect(leaseRows(ledgerPath)).toMatchObject([{ operation: null, generation: 2 }]);
  });

  it("N-P36C-7: a retry that brings another reference under the same key is a conflict, not a second intention", () => {
    const ledgerPath = temporaryLedgerPath();
    crashAt(ledgerPath, "afterIntentionRecorded");
    const restarted = substrates(ledgerPath);
    const conflicting = {
      ...request({ holder: RESTARTED, holderPid: LIVE_PID, reference: reference({ artifactReferenceId: "ref-other" }) }),
      quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID },
    } as const;
    expect(caught(() => restarted.plane.publish(conflicting))).toBeInstanceOf(LedgerIdempotencyConflictError);
    expect(kinds(ledgerPath)).toEqual(["PUBLICATION_INTENDED"]);
    expect(restarted.ledger.listLiveArtifactPins("PUBLICATION")).toHaveLength(1);
    expect(tree(ledgerPath)).toEqual([]);
  });

  it("N-P36-11: a reconciler with no bytes to write abandons an intention whose bytes never arrived, keeping the grace instant", () => {
    for (const seam of ["afterIntentionRecorded", "afterStagingWritten", "afterStagingVerified", "afterStagingSynced"] as const) {
      const ledgerPath = temporaryLedgerPath();
      crashAt(ledgerPath, seam);
      const next = substrates(ledgerPath);
      const outcome = expectVerb(next.plane.reconcile(reconciliation()), "ABANDONED");
      expect(outcome.refusal, seam).toBe("CONTENT_ABSENT");
      expect(outcome.release.verb, seam).toBe("APPLIED");
      expect(next.ledger.getArtifactBlob(DIGEST, 1), seam).toMatchObject({ lifecycleState: "PUBLICATION_ABANDONED", graceStartedAt: AT });
      expect(next.ledger.getArtifactReference("ref-1"), seam).toBeNull();
      expect(next.ledger.listLiveArtifactPins("PUBLICATION"), seam).toEqual([]);
      // N-P36C-3: a staged residue is the reconciler's to remove; nothing else is.
      expect(existsSync(stagingPath(ledgerPath)), seam).toBe(false);
      expect(kinds(ledgerPath), seam).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_ABANDONED"]);
    }
  });

  it("N-P36-10, N-P36C-17: bytes that reached their path complete the ORIGINAL reference, field for field from the intention", () => {
    for (const seam of ["afterRename", "afterDirectorySynced"] as const) {
      const ledgerPath = temporaryLedgerPath();
      const original = reference({ artifactReferenceId: "ref-1", classification: "SENSITIVE", scopeKind: "INITIATIVE", scopeId: "initiative-9", retentionClass: "PERMANENT", expiresAt: null });
      crashAt(ledgerPath, seam, { reference: original });
      const next = substrates(ledgerPath);
      const before = inodeOf(objectPath(ledgerPath));

      const outcome = expectVerb(next.plane.reconcile(reconciliation()), "PUBLISHED");
      expect(outcome).toMatchObject({ bytesWritten: false, replayed: false, blobGeneration: 1 });
      expect(inodeOf(objectPath(ledgerPath))).toEqual(before);

      const [intended, succeeded] = next.ledger.listArtifactEvents(DIGEST).map((record) => record.event);
      if (intended?.artifactEventKind !== "PUBLICATION_INTENDED" || succeeded?.artifactEventKind !== "PUBLICATION_SUCCEEDED") {
        throw new Error("expected an intention and a success");
      }
      expect(intended.payload.intendedReference).toEqual(original);
      expect(succeeded.payload.reference).toEqual(original);
      expect(succeeded.recordedBy).toBe(RECONCILER);
      expect(referenceFields(outcome.reference)).toEqual(original);
      expect(next.plane.read({ artifactReferenceId: "ref-1", scopeKind: "INITIATIVE", scopeId: "initiative-9" }).verb).toBe("READ");
    }
  });

  it("N-P36-6: bytes at their path that do not verify are an abandonment, and they are not removed", () => {
    const ledgerPath = temporaryLedgerPath();
    crashAt(ledgerPath, "afterDirectorySynced");
    const corrupt = Buffer.from(BYTES);
    corrupt[3] = (corrupt[3] ?? 0) ^ 0x01;
    writeFileSync(objectPath(ledgerPath), corrupt);
    const next = substrates(ledgerPath);
    expect(expectVerb(next.plane.reconcile(reconciliation()), "ABANDONED").refusal).toBe("CONTENT_DOES_NOT_VERIFY");
    expect(readFileSync(objectPath(ledgerPath))).toEqual(corrupt);
    expect(next.ledger.getArtifactBlob(DIGEST, 1)).toMatchObject({ lifecycleState: "PUBLICATION_ABANDONED", graceStartedAt: AT });
    expect(next.ledger.getArtifactReference("ref-1")).toBeNull();
  });

  it("N-P36C-1: a holding left after the success is ended without a file touched or an event appended; a retry replays it", () => {
    const ledgerPath = temporaryLedgerPath();
    crashAt(ledgerPath, "afterOutcomeRecorded");
    expect(kinds(ledgerPath)).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_SUCCEEDED"]);
    expect(leaseRows(ledgerPath)).toMatchObject([{ operation: "PUBLISH", holder_pid: DEAD_PID }]);

    const retried = temporaryLedgerPath();
    crashAt(retried, "afterOutcomeRecorded");
    const restarted = substrates(retried);
    const replay = expectVerb(
      restarted.plane.publish({ ...request({ holder: RESTARTED, holderPid: LIVE_PID }), quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID } }),
      "PUBLISHED",
    );
    expect(replay).toMatchObject({ replayed: true, bytesWritten: false });
    expect(kinds(retried)).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_SUCCEEDED"]);

    const next = substrates(ledgerPath);
    const before = { registry: kinds(ledgerPath), tree: tree(ledgerPath), tables: world(ledgerPath) };
    expectVerb(next.plane.reconcile(reconciliation()), "HOLDING_REVOKED");
    expect(kinds(ledgerPath)).toEqual(before.registry);
    expect(tree(ledgerPath)).toEqual(before.tree);
    expect(leaseRows(ledgerPath)).toMatchObject([{ operation: null, generation: 2 }]);
    expect(next.plane.read({ artifactReferenceId: "ref-1", scopeKind: "TASK", scopeId: "task-1" }).verb).toBe("READ");
  });

  it("N-P36C-18: an intention with no intended reference is abandoned even over valid bytes, which stay; the next intention re-stages the generation and verifies them", () => {
    const ledgerPath = temporaryLedgerPath();
    const foreign = substrates(ledgerPath);
    // A producer other than this plane: a holding, an intention without the block, and the bytes.
    expect(
      foreign.leaseStore.acquire({ contentSha256: DIGEST, operation: "PUBLISH", operationId: "cmd-foreign", holder: "someone/else/01", holderPid: DEAD_PID, acquiredAt: AT, expiresAt: LATER }).verb,
    ).toBe("APPLIED");
    foreign.ledger.appendArtifactEvent({
      contractVersion: CONTRACT_VERSION,
      eventId: uuid(777),
      idempotencyKey: "foreign/intended",
      subjectKind: "ARTIFACT",
      artifactEventKind: "PUBLICATION_INTENDED",
      subjectOrdinal: 1,
      parentSubjectOrdinal: null,
      recordedBy: "someone/else/01",
      occurredAt: AT,
      recordedAt: AT,
      payload: { commandId: "cmd-foreign", contentSha256: DIGEST, blobGeneration: 1, mediaType: "text/plain", sizeBytes: BYTES.byteLength, encryptionStatus: "PLAINTEXT", keyReference: null, encryptionProfile: "local-plaintext-v1", artifactPinId: "pin-foreign" },
    });
    mkdirSync(join(rootOf(ledgerPath), DIGEST.slice(0, 2)), { mode: 0o700 });
    writeFileSync(objectPath(ledgerPath), BYTES, { mode: 0o600 });
    foreign.die();

    const next = substrates(ledgerPath);
    const outcome = expectVerb(next.plane.reconcile(reconciliation()), "ABANDONED");
    expect(outcome.refusal).toBe("NO_INTENDED_REFERENCE");
    expect(readFileSync(objectPath(ledgerPath))).toEqual(BYTES);
    expect(rows(ledgerPath, "SELECT COUNT(*) AS n FROM artifact_reference_read_model")).toEqual([{ n: 0 }]);
    expect(next.ledger.getArtifactBlob(DIGEST, 1)).toMatchObject({ lifecycleState: "PUBLICATION_ABANDONED", graceStartedAt: AT });

    const before = inodeOf(objectPath(ledgerPath));
    const republished = expectVerb(next.plane.publish(request({ command: 2, holder: "claude/opus/publisher/02", holderPid: LIVE_PID })), "PUBLISHED");
    expect(republished).toMatchObject({ blobGeneration: 1, bytesWritten: false });
    expect(inodeOf(objectPath(ledgerPath))).toEqual(before);
    expect(next.ledger.getArtifactBlob(DIGEST, 1)).toMatchObject({ lifecycleState: "PUBLISHED", graceStartedAt: AT });
  });

  it("N-P36C-19: a reference already recorded is refused before the lease; recorded after that check, the door's refusal abandons under the same terminal identity and holds nothing; any other failure releases and keeps the pin", () => {
    // Before the lease: nothing moves, and this command's own success still replays.
    const ledgerPath = temporaryLedgerPath();
    const { plane } = substrates(ledgerPath);
    expect(plane.publish(request({ content: OTHER_BYTES })).verb).toBe("PUBLISHED");
    const before = world(ledgerPath);
    const reused = caught(() => plane.publish(request({ command: 2, reference: reference({ artifactReferenceId: "ref-1" }) })));
    expect(reused).toBeInstanceOf(LedgerValidationError);
    expect((reused as LedgerValidationError).issues.map((issue) => issue.path)).toEqual(["reference.artifactReferenceId"]);
    expect(world(ledgerPath)).toEqual(before);
    expect(expectVerb(plane.publish(request({ content: OTHER_BYTES })), "PUBLISHED").replayed).toBe(true);

    // After the check: another command records the same reference while these bytes move.
    const raced = temporaryLedgerPath();
    const rival = substrates(raced);
    const rivalOutcomes: ArtifactPlaneOutcome[] = [];
    const racing = substrates(raced, {
      afterDirectorySynced: () => {
        rivalOutcomes.push(
          rival.plane.publish(request({ command: 3, content: OTHER_BYTES, reference: reference({ artifactReferenceId: "ref-2" }), holder: "claude/opus/publisher/03", holderPid: LIVE_PID })),
        );
      },
    });
    const abandoned = expectVerb(racing.plane.publish(request({ command: 2 })), "ABANDONED");
    expect(rivalOutcomes.map((outcome) => outcome.verb)).toEqual(["PUBLISHED"]);
    expect(abandoned).toMatchObject({ refusal: "REFERENCE_REFUSED_BY_DOOR", blobGeneration: 1, release: { verb: "APPLIED" } });
    expect(racing.leaseStore.read(DIGEST)?.operation).toBeNull();
    expect(racing.ledger.listLiveArtifactPins("PUBLICATION")).toEqual([]);
    const events = racing.ledger.listArtifactEvents(DIGEST).map((record) => record.event);
    expect(events.map((event) => event.artifactEventKind)).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_ABANDONED"]);
    expect(events[1]).toMatchObject({ eventId: uuid(22), idempotencyKey: "artifact/cmd-2/terminal", recordedBy: PUBLISHER });
    expect(racing.ledger.getArtifactBlob(DIGEST, 1)).toMatchObject({ lifecycleState: "PUBLICATION_ABANDONED", graceStartedAt: AT });
    expect(racing.ledger.getArtifactReference("ref-2")?.contentSha256).toBe(sha256(OTHER_BYTES));
    const durable = inodeOf(objectPath(raced));
    expect(readFileSync(objectPath(raced))).toEqual(BYTES);
    const restaged = expectVerb(racing.plane.publish(request({ command: 4 })), "PUBLISHED");
    expect(restaged).toMatchObject({ blobGeneration: 1, bytesWritten: false });
    expect(inodeOf(objectPath(raced))).toEqual(durable);

    // Any other failure of the success — here a terminal key already spent — releases the holding and is thrown.
    const conflicted = temporaryLedgerPath();
    const third = substrates(conflicted);
    expect(third.plane.publish(request({ content: OTHER_BYTES })).verb).toBe("PUBLISHED");
    const corrected = request({ command: 2 });
    const spent = { ...corrected, terminal: { ...corrected.terminal, idempotencyKey: "artifact/cmd-1/terminal" } };
    expect(caught(() => third.plane.publish(spent))).toBeInstanceOf(LedgerIdempotencyConflictError);
    expect(third.leaseStore.read(DIGEST)?.operation).toBeNull();
    expect(third.ledger.listLiveArtifactPins("PUBLICATION").map((pin) => pin.artifactPinId)).toEqual(["pin-publication-2"]);
    expect(third.ledger.getUnreclaimedArtifactBlob(DIGEST)?.lifecycleState).toBe("STAGED");
    expect(readFileSync(objectPath(conflicted))).toEqual(BYTES);
    expect(expectVerb(third.plane.publish(corrected), "PUBLISHED")).toMatchObject({ bytesWritten: false, replayed: false });
    expect(third.ledger.listLiveArtifactPins("PUBLICATION")).toEqual([]);
  });

  it("N-P36C-20: another producer's intention whose block no success may carry is abandoned over valid bytes, which stay; the reconciler keeps no holding and the next intention re-stages the generation", () => {
    const ledgerPath = temporaryLedgerPath();
    const foreign = substrates(ledgerPath);
    expect(
      foreign.leaseStore.acquire({ contentSha256: DIGEST, operation: "PUBLISH", operationId: "cmd-foreign", holder: "someone/else/01", holderPid: DEAD_PID, acquiredAt: AT, expiresAt: LATER }).verb,
    ).toBe("APPLIED");
    foreign.ledger.appendArtifactEvent({
      contractVersion: CONTRACT_VERSION,
      eventId: uuid(777),
      idempotencyKey: "foreign/intended",
      subjectKind: "ARTIFACT",
      artifactEventKind: "PUBLICATION_INTENDED",
      subjectOrdinal: 1,
      parentSubjectOrdinal: null,
      recordedBy: "someone/else/01",
      occurredAt: AT,
      recordedAt: AT,
      payload: { commandId: "cmd-foreign", contentSha256: DIGEST, blobGeneration: 1, mediaType: "text/plain", sizeBytes: BYTES.byteLength, encryptionStatus: "PLAINTEXT", keyReference: null, encryptionProfile: "local-plaintext-v1", artifactPinId: "pin-foreign", intendedReference: reference({ classification: "SECRET_BEARING" }) },
    });
    mkdirSync(join(rootOf(ledgerPath), DIGEST.slice(0, 2)), { mode: 0o700 });
    writeFileSync(objectPath(ledgerPath), BYTES, { mode: 0o600 });
    foreign.die();

    const next = substrates(ledgerPath);
    const durable = inodeOf(objectPath(ledgerPath));
    const outcome = expectVerb(next.plane.reconcile(reconciliation()), "ABANDONED");
    expect(outcome).toMatchObject({ refusal: "REFERENCE_REFUSED_BY_DOOR", blobGeneration: 1, release: { verb: "APPLIED" } });
    expect(leaseRows(ledgerPath)).toMatchObject([{ operation: null }]);
    const events = next.ledger.listArtifactEvents(DIGEST).map((record) => record.event);
    expect(events.map((event) => event.artifactEventKind)).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_ABANDONED"]);
    expect(events[1]).toMatchObject({ eventId: uuid(9001), idempotencyKey: "artifact/reconciliation/terminal", recordedBy: RECONCILER });
    expect(rows(ledgerPath, "SELECT COUNT(*) AS n FROM artifact_reference_read_model")).toEqual([{ n: 0 }]);
    expect(next.ledger.listLiveArtifactPins("PUBLICATION")).toEqual([]);
    expect(next.ledger.getArtifactBlob(DIGEST, 1)).toMatchObject({ lifecycleState: "PUBLICATION_ABANDONED", graceStartedAt: AT });
    expect(readFileSync(objectPath(ledgerPath))).toEqual(BYTES);
    expect(inodeOf(objectPath(ledgerPath))).toEqual(durable);
    expect(next.plane.reconcile(reconciliation())).toMatchObject({ verb: "NOTHING_TO_RECONCILE" });

    const republished = expectVerb(next.plane.publish(request({ command: 2, holder: "claude/opus/publisher/02", holderPid: LIVE_PID })), "PUBLISHED");
    expect(republished).toMatchObject({ blobGeneration: 1, bytesWritten: false });
    expect(inodeOf(objectPath(ledgerPath))).toEqual(durable);
  });

  it("a live pin whose holding was revoked is reconciled without an attestation: nobody is displaced", () => {
    const ledgerPath = temporaryLedgerPath();
    crashAt(ledgerPath, "afterIntentionRecorded");
    const next = substrates(ledgerPath);
    const token = next.leaseStore.readToken(DIGEST);
    if (token === null) throw new Error("no holding");
    expect(next.leaseStore.revoke(token, { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID }).verb).toBe("APPLIED");
    const outcome = expectVerb(next.plane.reconcile(reconciliation({}, false)), "ABANDONED");
    expect(outcome.refusal).toBe("CONTENT_ABSENT");
    expect(next.ledger.listLiveArtifactPins("PUBLICATION")).toEqual([]);
  });

  it("nothing to reconcile, a collector's holding, and a digest that is no digest", () => {
    const ledgerPath = temporaryLedgerPath();
    const { plane, leaseStore } = substrates(ledgerPath);
    expect(plane.reconcile(reconciliation())).toEqual({ verb: "NOTHING_TO_RECONCILE", lease: null });

    expect(
      leaseStore.acquire({ contentSha256: DIGEST, operation: "RECLAIM", operationId: "reclaim-1", holder: "collector/01", holderPid: DEAD_PID, acquiredAt: AT, expiresAt: LATER }).verb,
    ).toBe("APPLIED");
    const before = world(ledgerPath);
    expect(plane.reconcile(reconciliation())).toMatchObject({ verb: "REFUSE", refusal: "HELD_FOR_RECLAIM" });
    expect(plane.publish(request())).toMatchObject({ verb: "REFUSE", refusal: "LEASE_HELD" });
    expect(world(ledgerPath)).toEqual(before);

    // N-P36-4: refused before a path is derived, and no directory appears.
    for (const bad of ["../../../etc/passwd", "A".repeat(64), "a".repeat(63), "a".repeat(62) + "/.", "..".padEnd(64, "a")]) {
      expect(caught(() => plane.reconcile(reconciliation({ contentSha256: bad }))), bad).toBeInstanceOf(LedgerQueryError);
    }
    expect(tree(ledgerPath)).toEqual([]);
  });

  it("O-2: a collector's holding under this command's own id is refused by name, never taken over as a publication", () => {
    const ledgerPath = temporaryLedgerPath();
    const { plane, leaseStore } = substrates(ledgerPath);
    expect(
      leaseStore.acquire({ contentSha256: DIGEST, operation: "RECLAIM", operationId: "cmd-1", holder: "collector/01", holderPid: DEAD_PID, acquiredAt: AT, expiresAt: LATER }).verb,
    ).toBe("APPLIED");
    const before = world(ledgerPath);
    const attested = { ...request({ holder: RESTARTED, holderPid: LIVE_PID }), quiescence: { basis: "DEATH_AND_REAP_PROVEN", holderPid: DEAD_PID } } as const;
    expect(plane.publish(attested)).toMatchObject({ verb: "REFUSE", refusal: "HELD_FOR_RECLAIM", leaseRefusal: null, lease: { operation: "RECLAIM" } });
    expect(world(ledgerPath)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------

describe("what the plane may not do, read off its own source (N-P36C-11, N-P36C-12, N-P36C-14)", () => {
  const SOURCE = fileURLToPath(new URL("../../src/artifact-plane/index.ts", import.meta.url));

  /** The code without its comments, which name what the code must not do. */
  function code(): string {
    return readFileSync(SOURCE, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("reads no clock, no process and no environment, and mints no identity", () => {
    const source = code();
    for (const forbidden of ["Date.now(", "new Date(", "process.env", "process.pid", "process.hrtime", "randomUUID", "randomBytes", "Math.random"]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("removes nothing but its own staging path, and never asks for a RECLAIM holding", () => {
    const source = code();
    // One call, of the staging path, inside the one function that exists for it.
    expect([...source.matchAll(/unlinkSync\(/g)]).toHaveLength(1);
    expect([...source.matchAll(/unlinkSync\(staging\)/g)]).toHaveLength(1);
    for (const forbidden of ["rmSync", "rmdirSync", "truncateSync", '"RECLAIM"']) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it("opens every descriptor without following a link, and resolves its root exactly once", () => {
    const source = code();
    expect([...source.matchAll(/\bopenSync\(/g)]).toHaveLength(1);
    expect(source).toContain("openSync(path, flags | constants.O_NOFOLLOW, mode)");
    expect([...source.matchAll(/\brealpathSync\(/g)]).toHaveLength(1);
    expect(source).not.toMatch(/recursive\s*:\s*true/);
    for (const following of ["readFileSync", "writeFileSync", "existsSync", "statSync(", "chmodSync("]) {
      const pattern = new RegExp("(?<![a-z])" + following.replace("(", "\\("));
      expect({ following, present: pattern.test(source) }).toEqual({ following, present: false });
    }
  });

  it("imports neither the legacy digest store nor its root rule", () => {
    const source = code();
    // Assembled, so the fence's import scanner does not read this pattern as an import of the suite.
    const specifier = new RegExp("\\bfro" + 'm "([^"]+)";', "g");
    const imports = [...source.matchAll(specifier)].map((match) => String(match[1])).sort();
    expect(imports).toEqual([
      "../artifact-lease-store/index.js",
      "../canonical-json/index.js",
      "../errors/index.js",
      "../ledger/index.js",
      "../types/index.js",
      "@acp/contracts",
      "@acp/contracts",
      "node:crypto",
      "node:fs",
      "node:path",
    ]);
    for (const legacy of ["artifact-store", "publishArtifact", "readArtifact", "hasArtifact", "artifactRootFor"]) {
      expect({ legacy, present: source.includes(legacy) }).toEqual({ legacy, present: false });
    }
  });

  it("names its refusals as facts, closed, and derives its root by rule beside the ledger", () => {
    expect([...ARTIFACT_PLANE_REFUSALS]).toEqual([
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
    ]);
    expect(artifactPlaneRootFor("/data/scenario/control-plane.sqlite")).toBe("/data/scenario/private-artifacts");
    expect(artifactPlaneRootFor("/data/scenario/other.sqlite")).toBe(artifactPlaneRootFor("/data/scenario/control-plane.sqlite"));
    expect(caught(() => artifactPlaneRootFor(""))).toBeInstanceOf(LedgerQueryError);
  });
});

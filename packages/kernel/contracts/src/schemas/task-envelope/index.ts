/**
 * TaskEnvelope — `@acp/contracts` (P8-T G6).
 *
 * The unit of authorized work: objective, authority, exact write-set, budget.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import { attachGuards } from "../credential-guards/index.js";
import {
  AdmittedContractVersion,
  RepoRelativePath,
  Timestamp,
  Uuid,
} from "../primitives/index.js";
import { PathDigest } from "../shared-references/index.js";
import { WORKER_ROLES, WorkerIdentityString, WorkerRole } from "../worker-identity/index.js";

/**
 * The version prefix of the envelope revision preimage (P-05/A).
 *
 * ## What the digest is for
 *
 * `envelope_sha256` identifies **the revision of the work**, and it is the
 * third of the four digests the contract keeps apart. It is not
 * `authority_sha256`, which moves when the authority document moves and the
 * work does not; it is not `prompt_sha256` or `content_sha256`, which are bytes
 * of an instruction or an artifact. A change to any field of this envelope is a
 * new revision, and a new revision does not inherit the marker, the result or
 * the cost of the one before it.
 *
 * ## The preimage, stated once
 *
 *     preimage = ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1 + canonicalJson(TaskEnvelope.parse(value))
 *
 * There is **no separator between the two**: the LF is the last byte of the
 * prefix itself, exactly as `ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1` carries its
 * own. One LF, and it belongs to the prefix — a formula that added a second
 * would be a different byte string and every pinned vector would move.
 *
 * ## Why the rule lives here and the function does not
 *
 * `docs/audit/architecture/database/index.md` §6.2 makes this package the
 * master contract for the preimage, and it refuses to enumerate the fields
 * because a list written down twice goes stale. So the rule is stated and the
 * enumeration is not: the preimage is the **whole parsed envelope**, and
 * "covers every field" is a property of `TaskEnvelope` being a
 * `z.strictObject` rather than of a list somebody has to remember to extend.
 * A field added to the schema enters the preimage the day it is added.
 *
 * The function that computes it is in `@acp/ledger`, and the split is forced
 * rather than chosen. This package may import `zod` and nothing else — no
 * `node:` builtin at all — because every other package imports it, **including
 * the browser client**, and one `node:crypto` here would make the whole
 * contract surface unloadable in a page. `@acp/ledger` already owns
 * `canonicalJsonStringify` and `sha256Hex`, and a second canonicalizer or a
 * second sha-256 declared here — including one reached through
 * `crypto.subtle` — would be a second authority on a question already answered.
 *
 * ## Versioned, and never changed in place
 *
 * `v1` is frozen. A change to the encoding is a **new** prefix with a new name;
 * this constant is never edited, and no history is ever rehashed. That is the
 * rule `ACCOUNT_INTEGRITY_PREIMAGE_PREFIX_V1` set at P-08/A1 and it holds for
 * the same reason: a digest whose preimage can be redefined identifies nothing.
 *
 * The `\n` is a single LF byte (`0x0a`), not the two characters a backslash and
 * an `n` would be if this were written into a document by hand. A test pins the
 * byte.
 */
export const ENVELOPE_IDENTITY_PREIMAGE_PREFIX_V1 = "acp/task-envelope/v1\n";

export const TaskClassification = z.enum(["MECHANICAL", "SEMANTIC", "ARCHITECTURAL"]);
export type TaskClassification = z.infer<typeof TaskClassification>;

export const CommitPolicy = z.enum(["NO_COMMIT", "LOCAL_COMMIT_WITH_RECEIPT"]);
export type CommitPolicy = z.infer<typeof CommitPolicy>;

export const TaskEnvelope = z
  .strictObject({
    /**
     * The version in force, and only it (P-18/protocolo C, ADR 0076).
     *
     * One of the three shapes ADR 0072 named when it wrote the obligation the
     * escalón that bumps `CONTRACT_VERSION` inherits: a set that is right for
     * reading history is wrong for admitting new work. An envelope is issued
     * now — it is not a cohort of stored rows anybody re-parses — so the rule
     * here is `AdmittedContractVersion`, "only the version in force is
     * emitted", rather than the reader's two-member set.
     *
     * The cost is stated rather than hidden: a fixture holding an envelope at
     * `"2.2.0"` no longer parses, and `envelope_sha256` therefore differs for
     * the same work issued before and after the bump (consequence V3, ADR
     * 0076). That is correct — the envelope preimage covers every field of this
     * schema, and the version is one of them.
     */
    contractVersion: AdmittedContractVersion,
    taskId: Uuid,
    /**
     * The initiative this packet belongs to. Required, and the only place the
     * attribution lives: leases bind worktrees, worktrees serve tasks, events
     * carry taskId, so scoping through the task is the one shape that cannot
     * hold two disagreeing copies of the same fact. Isolation here means no
     * data bleed between initiatives — admission and quota stay global, so two
     * initiatives declaring the same conflict key still conflict.
     */
    initiativeId: Uuid,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(4_000),
    classification: TaskClassification,
    issuedBy: WorkerIdentityString,
    issuedAt: Timestamp,

    /** Authority is path plus content digest. Nothing else grants authority. */
    authority: z.array(PathDigest).max(1_000),
    readSet: z.array(RepoRelativePath).max(1_000),
    /** The exact write-set. An empty write-set means a read-only packet. */
    writeSet: z.array(RepoRelativePath).max(500),
    /** Opaque keys used to build the conflict graph between parallel packets. */
    conflictKeys: z.array(z.string().min(1).max(200)).max(200),

    allowedCommands: z.array(z.string().min(1).max(400)).max(100),
    forbiddenActions: z.array(z.string().min(1).max(400)).max(100),

    output: z.strictObject({
      kind: z.enum(["DIFF", "REPORT", "FIXTURE", "NONE"]),
      description: z.string().max(1_000),
    }),
    validation: z.strictObject({
      commands: z.array(z.string().min(1).max(400)).max(50),
      independentVerifierRequired: z.boolean(),
    }),

    eligibility: z.strictObject({
      roles: z.array(WorkerRole).min(1).max(WORKER_ROLES.length),
      /** null means provider neutral: any provider may serve this packet. */
      providers: z.array(z.string().min(1).max(40)).max(20).nullable(),
      requiredCapabilities: z.array(z.string().min(1).max(80)).max(50),
    }),

    budget: z.strictObject({
      maxTokens: z.number().int().positive().max(100_000_000),
      maxWallClockSeconds: z.number().int().positive().max(86_400),
      /** Never spend the reserve. It pays for checkpoint, verify and audit. */
      reserveTokensForCheckpoint: z.number().int().nonnegative().max(10_000_000),
    }),

    visualEvidenceRequired: z.boolean(),
    commitPolicy: CommitPolicy,
    checkpointPolicy: z.strictObject({
      onEveryAtomicStep: z.boolean(),
      maxStepsWithoutCheckpoint: z.number().int().positive().max(100),
    }),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });

    if (value.budget.reserveTokensForCheckpoint >= value.budget.maxTokens) {
      ctx.addIssue({
        code: "custom",
        message: "checkpoint reserve must be strictly smaller than the token budget",
        path: ["budget", "reserveTokensForCheckpoint"],
      });
    }

    if (value.commitPolicy === "LOCAL_COMMIT_WITH_RECEIPT" && value.writeSet.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a packet with an empty write-set may not carry a commit policy",
        path: ["commitPolicy"],
      });
    }

    const duplicates = value.writeSet.filter(
      (path, index) => value.writeSet.indexOf(path) !== index,
    );
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "write-set entries must be unique",
        path: ["writeSet"],
      });
    }
  });
export type TaskEnvelope = z.infer<typeof TaskEnvelope>;

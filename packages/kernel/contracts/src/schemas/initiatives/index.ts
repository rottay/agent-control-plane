/**
 * Initiatives and the versioned roadmap — `@acp/contracts` (P8-T G6).
 *
 * Initiatives, the versioned roadmap, and the events that move them.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import { AccountStatus } from "../account-record/index.js";
import { EVENT_PAYLOAD_MAX_BYTES } from "../control-plane-event/index.js";
import { attachGuards, serializedByteLength } from "../credential-guards/index.js";
import {
  ContractVersion,
  Sha256Hex,
  Timestamp,
  Uuid,
} from "../primitives/index.js";
import { WorkerIdentityString } from "../worker-identity/index.js";

/**
 * The largest roadmap document the plane accepts, in **UTF-8 bytes**.
 *
 * One declaration, one unit (P8-8G R2). It lived in two packages before this,
 * with the same number written twice and a comment in each promising they
 * would not drift — a promise nothing enforced. Worse, the two were measured
 * differently: the store counted bytes and the API schema counted `String`
 * length, which is UTF-16 code units. For ASCII those agree, which is why the
 * gap survived; for any multibyte document they do not, and the surface that
 * accepted a document the store would refuse was the API.
 *
 * **The unit is bytes, and it is the law.** Anything bounding a document
 * against this constant measures UTF-8 bytes, never characters and never code
 * units. `utf8ByteLength` below is the one measurement, so a caller, a schema
 * and a store cannot disagree about what "one megabyte" means.
 */
export const ROADMAP_CONTENT_MAX_BYTES = 1024 * 1024;

/**
 * The lifecycle of an initiative, closed like every other vocabulary here.
 *
 * An initiative is the unit of work a task is scoped to. The ACP's own roadmap
 * is one of these, registered like any other — a reserved, well-known
 * initiative rather than a special case in the schema.
 */
export const INITIATIVE_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"] as const;

export const InitiativeStatus = z.enum(INITIATIVE_STATUSES);
export type InitiativeStatus = z.infer<typeof InitiativeStatus>;

/**
 * A stable, human-readable handle. Lowercase so two initiatives cannot differ
 * only by case, and bounded like every other identifier in this file.
 */
const InitiativeSlug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "expected a lowercase kebab-case slug");

export const Initiative = z
  .strictObject({
    contractVersion: ContractVersion,
    initiativeId: Uuid,
    slug: InitiativeSlug,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(4_000),
    status: InitiativeStatus,
    createdAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });
  });
export type Initiative = z.infer<typeof Initiative>;

export const ROADMAP_VERSION_KINDS = ["EDIT", "ROLLBACK"] as const;

export const RoadmapVersionKind = z.enum(ROADMAP_VERSION_KINDS);
export type RoadmapVersionKind = z.infer<typeof RoadmapVersionKind>;

/**
 * One immutable version of an initiative's roadmap.
 *
 * `contentDigest` is a digest and nothing else. The bytes it names live
 * outside the ledger, reached by artifact reference: the Checkpoint law is
 * that a record carries digests and references rather than content, and the
 * event payload budget makes roadmap bytes unstorable in an event anyway.
 *
 * A rollback is a new version, never a rewrite of history — `kind:
 * "ROLLBACK"` with `restoresVersionId` naming the version whose bytes are
 * being restored. Append-only holds all the way down.
 *
 * What this schema enforces is what a single value can prove about itself:
 * the bootstrap exceptions and the kind/restore coherence. The laws that need
 * the folded head — that `version` is the head's successor, that
 * `parentVersionId` is the head's id, that a rollback's digest equals the
 * digest of the version it restores, and the refusal vocabulary that names
 * each failure — belong to the decision module beside the fold, not here.
 */
export const RoadmapVersion = z
  .strictObject({
    contractVersion: ContractVersion,
    roadmapVersionId: Uuid,
    initiativeId: Uuid,
    version: z.number().int().positive().max(1_000_000),
    /** sha256 of the canonical roadmap bytes. Digest only, never content. */
    contentDigest: Sha256Hex,
    /** The version this one succeeds. Null exactly at the bootstrap. */
    parentVersionId: Uuid.nullable(),
    /** The head the writer believed it was appending to. Null at the bootstrap. */
    expectedHeadDigest: Sha256Hex.nullable(),
    kind: RoadmapVersionKind,
    /** The version a rollback restores. Null exactly when the kind is EDIT. */
    restoresVersionId: Uuid.nullable(),
    recordedBy: WorkerIdentityString,
    recordedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    // The bootstrap exception is a biconditional in both directions. Version 1
    // has no predecessor, so a parent or a head claim there is a lie; every
    // later version has one, and a null claim there is unconditional-overwrite
    // semantics wearing a bootstrap's clothes.
    if ((value.parentVersionId === null) !== (value.version === 1)) {
      ctx.addIssue({
        code: "custom",
        message: "parentVersionId must be null for version 1 and set for every later version",
        path: ["parentVersionId"],
      });
    }

    if ((value.expectedHeadDigest === null) !== (value.version === 1)) {
      ctx.addIssue({
        code: "custom",
        message: "expectedHeadDigest must be null for version 1 and set for every later version",
        path: ["expectedHeadDigest"],
      });
    }

    if ((value.restoresVersionId === null) !== (value.kind === "EDIT")) {
      ctx.addIssue({
        code: "custom",
        message: "restoresVersionId must be null for an EDIT and set for a ROLLBACK",
        path: ["restoresVersionId"],
      });
    }
  });
export type RoadmapVersion = z.infer<typeof RoadmapVersion>;

/**
 * The initiative stream's vocabulary, closed at three names.
 *
 * `ROADMAP_VERSION_RECORDED` **is** the receipt for a recorded version, the
 * way `COMMIT_RECORDED` is the receipt for a commit. A separate receipt type
 * would record the same fact twice.
 */
export const INITIATIVE_EVENT_TYPES = [
  "INITIATIVE_REGISTERED",
  "INITIATIVE_STATE_CHANGED",
  "ROADMAP_VERSION_RECORDED",
] as const;

export const InitiativeEventType = z.enum(INITIATIVE_EVENT_TYPES);
export type InitiativeEventType = z.infer<typeof InitiativeEventType>;

/**
 * The idempotency coordinates of an initiative-stream append.
 *
 * There is no attempt number: a registration is not retried the way a task
 * step is, so the key fixes the attempt segment at 1 rather than carrying a
 * counter nothing would increment. The coordinates are their own type rather
 * than reusing the task's, because putting an initiative id in a field named
 * `taskId` would make the name lie.
 */
export const InitiativeIdempotencyCoordinates = z.strictObject({
  initiativeId: Uuid,
  transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});
export type InitiativeIdempotencyCoordinates = z.infer<typeof InitiativeIdempotencyCoordinates>;

export function buildInitiativeIdempotencyKey(
  coordinates: InitiativeIdempotencyCoordinates,
): string {
  return coordinates.initiativeId + "/1/" + coordinates.transitionId;
}

/**
 * An event in the initiative stream — a sibling of `ControlPlaneEvent`, under
 * the same laws, in the same ledger, on its own chain.
 *
 * It is a separate contract rather than three more names in the task
 * vocabulary because an initiative registration has no task and no
 * `TaskState`, and the task stream's storage requires both. Forcing it in
 * would mean either a column that cannot be null being null, or an
 * initiative id living in a field named `taskId`.
 */
/**
 * What an operator may do to an account (P8-8G packet 2).
 *
 * Four verbs, closed. Three name an intent whose resulting state is a fact
 * about the verb rather than a parameter — draining an account puts it in
 * `DRAINING` and nothing else — and the fourth exists because an operator
 * sometimes knows something the vocabulary does not, and needs to say the
 * state outright rather than pick the nearest verb and hope.
 */
export const ACCOUNT_ACTIONS = ["DRAIN", "ACCOUNT_READY", "REAUTH_REQUIRED", "OWNER_OVERRIDE"] as const;
export const AccountAction = z.enum(ACCOUNT_ACTIONS);
export type AccountAction = z.infer<typeof AccountAction>;

/**
 * The state each verb produces, as a frozen fact rather than a branch.
 *
 * A table, so the mapping is one thing a reader can check against the
 * vocabulary above rather than a switch spread across a decision function.
 * `OWNER_OVERRIDE` is `null` here precisely because it is the one verb whose
 * resulting state is not implied by the verb — it comes from the request's
 * own `setState`, and the schema below refuses the two mismatched shapes:
 * an override without a state, and a non-override that supplies one.
 */
export const ACCOUNT_ACTION_STATE: Readonly<Record<AccountAction, AccountStatus | null>> =
  Object.freeze({
    DRAIN: "DRAINING",
    ACCOUNT_READY: "AVAILABLE",
    REAUTH_REQUIRED: "AUTH_REQUIRED",
    OWNER_OVERRIDE: null,
  });

/** The largest note an operator may attach. A reason, not a document. */
export const ACCOUNT_ACTION_NOTE_MAX = 500;

/**
 * One recorded operator action against one account.
 *
 * A sibling of `InitiativeEvent` and deliberately shaped like it: the same
 * envelope, the same idempotency law, the same guards. What differs is the
 * subject — an account rather than an initiative — and that the resulting
 * state is derived from the action rather than claimed independently, which is
 * what stops a caller recording "I drained it" beside "it is now AVAILABLE".
 *
 * `note` is the only free text this event carries, and it rides the standing
 * content guards: an operator explaining why they drained an account must not
 * be the way a credential reaches the ledger.
 */
export const AccountActionEvent = z
  .strictObject({
    contractVersion: ContractVersion,
    eventId: Uuid,

    accountId: z.string().min(1).max(80),
    /** Monotone per account, assigned by the seam from the folded history. */
    version: z.number().int().positive(),
    /** Must equal accountId/1/action.<version>. The ledger uniques on this. */
    idempotencyKey: z.string().min(1).max(300),

    action: AccountAction,
    /** The state this action put the account into. Derived, never claimed. */
    resultingState: AccountStatus,

    actor: WorkerIdentityString,
    note: z.string().max(ACCOUNT_ACTION_NOTE_MAX).nullable(),
    occurredAt: Timestamp,
    recordedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const expected =
      value.accountId + "/1/action." + String(value.version);
    if (value.idempotencyKey !== expected) {
      ctx.addIssue({
        code: "custom",
        message: "idempotencyKey must be exactly accountId/1/action.<version>",
        path: ["idempotencyKey"],
      });
    }

    // The verb governs the state, except for the one verb that does not.
    const implied = ACCOUNT_ACTION_STATE[value.action];
    if (implied !== null && value.resultingState !== implied) {
      ctx.addIssue({
        code: "custom",
        message:
          "action " + value.action + " always results in " + implied + ", never " + value.resultingState,
        path: ["resultingState"],
      });
    }
  });
export type AccountActionEvent = z.infer<typeof AccountActionEvent>;

/** One account's action history entry, as the ledger projects it. */
export const AccountActionRecord = z
  .strictObject({
    sequence: z.number().int().positive(),
    eventId: Uuid,
    accountId: z.string().min(1).max(80),
    version: z.number().int().positive(),
    action: AccountAction,
    resultingState: AccountStatus,
    actor: WorkerIdentityString,
    note: z.string().max(ACCOUNT_ACTION_NOTE_MAX).nullable(),
    occurredAt: Timestamp,
    recordedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });
  });
export type AccountActionRecord = z.infer<typeof AccountActionRecord>;

export const InitiativeEvent = z
  .strictObject({
    contractVersion: ContractVersion,
    eventId: Uuid,

    initiativeId: Uuid,
    transitionId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    /** Must equal initiativeId/1/transitionId. The ledger uniques on this. */
    idempotencyKey: z.string().min(1).max(300),

    type: InitiativeEventType,
    fromStatus: InitiativeStatus.nullable(),
    toStatus: InitiativeStatus,

    emittedBy: WorkerIdentityString,
    occurredAt: Timestamp,
    recordedAt: Timestamp,

    /** Bounded structured payload. Never a provider transcript. */
    payload: z.record(z.string().max(80), z.unknown()),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: true });

    const expected = buildInitiativeIdempotencyKey({
      initiativeId: value.initiativeId,
      transitionId: value.transitionId,
    });
    if (value.idempotencyKey !== expected) {
      ctx.addIssue({
        code: "custom",
        message: "idempotencyKey must be exactly initiativeId/1/transitionId",
        path: ["idempotencyKey"],
      });
    }

    // Registration is the one event with no prior status, and the only one:
    // every later event is a transition from something.
    if ((value.fromStatus === null) !== (value.type === "INITIATIVE_REGISTERED")) {
      ctx.addIssue({
        code: "custom",
        message: "fromStatus must be null for INITIATIVE_REGISTERED and set for every other type",
        path: ["fromStatus"],
      });
    }

    // The task law, mirrored: a change event must change something, and a
    // passthrough must not pretend to.
    if (value.type === "INITIATIVE_STATE_CHANGED" && value.fromStatus === value.toStatus) {
      ctx.addIssue({
        code: "custom",
        message: "a status change event must actually change status",
        path: ["toStatus"],
      });
    }

    if (value.type === "ROADMAP_VERSION_RECORDED" && value.fromStatus !== value.toStatus) {
      ctx.addIssue({
        code: "custom",
        message: "recording a roadmap version does not move the initiative's status",
        path: ["toStatus"],
      });
    }

    const size = serializedByteLength(value.payload);
    if (size > EVENT_PAYLOAD_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message:
          "event payload is " +
          String(size) +
          " bytes which exceeds the " +
          String(EVENT_PAYLOAD_MAX_BYTES) +
          " byte budget",
        path: ["payload"],
      });
    }
  });
export type InitiativeEvent = z.infer<typeof InitiativeEvent>;

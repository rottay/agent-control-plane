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
import { BoundedIdentifier } from "../bounded-identifier/index.js";
import {
  ContractVersion,
  RepoRelativePath,
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

/**
 * The bounds of a roadmap's steps (P-26 cut B, ADR 0111; ND-B6, Fable C4).
 *
 * `ROADMAP_STEPS_MAX` bounds a manifest's steps and so a version's `stepCount`;
 * `ROADMAP_STEP_DEPENDS_ON_MAX` bounds one step's dependencies, which keeps one
 * `ROADMAP_STEP_DECLARED` payload well under `EVENT_PAYLOAD_MAX_BYTES`. The counts
 * shape the manifest; `ROADMAP_STEP_MANIFEST_MAX_BYTES` stops it. It is the binding
 * bound, in serialized UTF-8 bytes — `ROADMAP_CONTENT_MAX_BYTES`' unit — because
 * the counts alone admit a manifest of tens of megabytes, past the private plane's
 * own ceiling.
 */
export const ROADMAP_STEPS_MAX = 200;
export const ROADMAP_STEP_DEPENDS_ON_MAX = 32;
export const ROADMAP_STEP_MANIFEST_MAX_BYTES = 1024 * 1024;

/**
 * The version prefix of an expected write set's digest preimage (P-26 cut B,
 * ADR 0111; Fable C6).
 *
 * `OUTBOX_COMMAND_ID_PREIMAGE_PREFIX_V1`'s placement, for its reason: the preimage
 * is contract-level identity, so its prefix is declared here; the computation —
 * `sha256(prefix + canonicalJson(sorted paths))` — is the ledger's, because this
 * package reaches no `node:` builtin. Frozen at `v1`: a change is a new prefix.
 */
export const ROADMAP_WRITE_SET_PREIMAGE_PREFIX_V1 = "acp/roadmap-write-set/v1\n";

/** One step of a manifest, before any digest is taken. */
const RoadmapStepEntry = z.strictObject({
  /** Stable across versions: cut C diffs by it. */
  stepId: BoundedIdentifier,
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(4_000),
  acceptance: z.string().min(1).max(4_000),
  expectedWriteSet: z.array(RepoRelativePath).max(500),
  dependsOn: z.array(BoundedIdentifier).max(ROADMAP_STEP_DEPENDS_ON_MAX),
});

/** Each entry of a list once, reported at the second occurrence. */
function refuseRepeats(
  values: readonly string[],
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
  what: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      ctx.addIssue({ code: "custom", message: what + " must not repeat", path: [...path, index] });
    }
    seen.add(value);
  }
}

/**
 * A roadmap version's steps, as one private document (P-26 cut B, ADR 0111).
 *
 * The texts — objective, acceptance, the expected write set — live here and only
 * here: published to the private plane as a `PLAN_DOCUMENT` scoped to the
 * initiative, read back by reference at the door to re-derive the digests, and
 * never carried by an event, a response or a log. What an event carries is
 * `RoadmapStepDeclaration`: the step's title and the digests of the rest.
 *
 * What one value can prove about itself is proved here: step ids unique, a step
 * that does not depend on itself, dependencies that name steps of this manifest,
 * no repeated path or dependency, and the serialized size. A cycle cannot be seen
 * one step at a time and is the ledger's to refuse, where the rank is computed.
 */
export const RoadmapStepManifest = z
  .strictObject({
    manifestContractVersion: z.literal(1),
    steps: z.array(RoadmapStepEntry).min(1).max(ROADMAP_STEPS_MAX),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });

    refuseRepeats(value.steps.map((step) => step.stepId), ctx, ["steps"], "a stepId");
    const known = new Set(value.steps.map((step) => step.stepId));
    for (const [index, step] of value.steps.entries()) {
      refuseRepeats(step.expectedWriteSet, ctx, ["steps", index, "expectedWriteSet"], "an expected path");
      refuseRepeats(step.dependsOn, ctx, ["steps", index, "dependsOn"], "a dependency");
      for (const [position, dependency] of step.dependsOn.entries()) {
        if (dependency === step.stepId) {
          ctx.addIssue({ code: "custom", message: "a step does not depend on itself", path: ["steps", index, "dependsOn", position] });
        } else if (!known.has(dependency)) {
          ctx.addIssue({
            code: "custom",
            message: "a dependency names a step of this manifest",
            path: ["steps", index, "dependsOn", position],
          });
        }
      }
    }

    const size = serializedByteLength(value);
    if (size > ROADMAP_STEP_MANIFEST_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message:
          "the step manifest is " +
          String(size) +
          " bytes which exceeds the " +
          String(ROADMAP_STEP_MANIFEST_MAX_BYTES) +
          " byte bound",
        path: [],
      });
    }
  });
export type RoadmapStepManifest = z.infer<typeof RoadmapStepManifest>;

/**
 * One step, as a `ROADMAP_STEP_DECLARED` payload records it (P-26 cut B, ADR 0111).
 *
 * The title is the one text it carries, the class of `initiative_read_model.title`
 * (decision 76); the rest is digests the door re-derives from the manifest and never
 * believes. `dependencyRank` is the cycle computation's result, recorded on the event
 * that declares the step's dependencies (planning §4; ND-B1, DT admission): the
 * longest path from a step with none, so an acyclic graph is exactly one where every
 * rank exists. The declaration rides its event's contract version; it carries none.
 */
export const RoadmapStepDeclaration = z
  .strictObject({
    roadmapVersionId: Uuid,
    stepId: BoundedIdentifier,
    stepIndex: z.number().int().min(0).max(ROADMAP_STEPS_MAX - 1),
    title: z.string().min(1).max(200),
    objectiveSha256: Sha256Hex,
    acceptanceSha256: Sha256Hex,
    expectedWriteSetSha256: Sha256Hex,
    dependsOn: z.array(BoundedIdentifier).max(ROADMAP_STEP_DEPENDS_ON_MAX),
    dependencyRank: z.number().int().min(0).max(ROADMAP_STEPS_MAX - 1),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });
    refuseRepeats(value.dependsOn, ctx, ["dependsOn"], "a dependency");
    for (const [position, dependency] of value.dependsOn.entries()) {
      if (dependency === value.stepId) {
        ctx.addIssue({ code: "custom", message: "a step does not depend on itself", path: ["dependsOn", position] });
      }
    }
  });
export type RoadmapStepDeclaration = z.infer<typeof RoadmapStepDeclaration>;

/**
 * The versions no build before P-26 cut B could stamp with steps (ADR 0111).
 *
 * A closed list frozen here, never a comparison of version strings: a
 * `RoadmapVersion` of one of these carries no step fields at all, and one of any
 * later version carries all three. Migration 25's triggers spell the same eight.
 */
const PRE_ROADMAP_STEP_CONTRACT_VERSIONS: readonly string[] = [
  "2.2.0",
  "2.3.0",
  "2.4.0",
  "2.5.0",
  "2.6.0",
  "2.7.0",
  "2.8.0",
  "2.9.0",
];

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
    /**
     * From 2.10.0 (P-26 cut B, ADR 0111): how many steps the version declares, and
     * the private manifest that holds their texts — its reference and its digest,
     * both null exactly when the count is 0. Absent on every earlier version.
     */
    stepCount: z.number().int().min(0).max(ROADMAP_STEPS_MAX).optional(),
    stepManifestArtifactReferenceId: z.string().min(1).max(512).nullable().optional(),
    stepManifestSha256: Sha256Hex.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    // The step cohort, by the closed list, both ways.
    const fields = ["stepCount", "stepManifestArtifactReferenceId", "stepManifestSha256"] as const;
    if (PRE_ROADMAP_STEP_CONTRACT_VERSIONS.includes(value.contractVersion)) {
      for (const field of fields) {
        if (value[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: field + " must be absent on a version of contract version " + value.contractVersion,
            path: [field],
          });
        }
      }
    } else {
      for (const field of fields) {
        if (value[field] === undefined) {
          ctx.addIssue({
            code: "custom",
            message: field + " is required from contract version 2.10.0",
            path: [field],
          });
        }
      }
      if (
        value.stepManifestArtifactReferenceId !== undefined &&
        value.stepManifestSha256 !== undefined &&
        (value.stepManifestArtifactReferenceId === null) !== (value.stepManifestSha256 === null)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "stepManifestArtifactReferenceId and stepManifestSha256 are both null or both set",
          path: ["stepManifestSha256"],
        });
      }
      if (
        value.stepCount !== undefined &&
        value.stepManifestSha256 !== undefined &&
        (value.stepManifestSha256 === null) !== (value.stepCount === 0)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "a version names a step manifest exactly when it declares steps",
          path: ["stepManifestSha256"],
        });
      }
    }

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
 * The bounds of one task graph revision (P-27 cut A, ADR 0115).
 *
 * `TASK_GRAPH_NODES_MAX` bounds a revision's `nodeCount`; `TASK_GRAPH_DEPENDS_ON_MAX`
 * bounds one node's edges, which keeps one `TASK_GRAPH_NODE_DECLARED` payload well
 * under `EVENT_PAYLOAD_MAX_BYTES`: the roadmap step's bounds, for the same reason.
 */
export const TASK_GRAPH_NODES_MAX = 200;
export const TASK_GRAPH_DEPENDS_ON_MAX = 32;

/**
 * What a dependant asks of the task it depends on (P-27 cut A, ADR 0115; datos §6.4,
 * planning §5.3), closed and sorted.
 *
 * The catalogue is datos §6.4's; its meaning is ADR 0115's oracle, because planning
 * §5.3 delegates it to a scheduler contract that does not exist. Datos names
 * `WAIT_SUCCESS` the default; a declaration carries the word explicitly anyway, and
 * the door fills in nothing.
 */
export const DEPENDENCY_FAILURE_POLICIES = ["ALLOW_FAILURE", "REQUIRE_TERMINAL", "WAIT_SUCCESS"] as const;

/** A task revision named across streams: typed and checked at the door, never a foreign key. */
const TaskGraphTaskRevision = {
  taskId: Uuid,
  taskRevisionNumber: z.number().int().min(1).max(1_000_000),
};

/**
 * The header of one task graph revision, as a `TASK_GRAPH_DECLARED` payload records
 * it (P-27 cut A, ADR 0115; planning §5.1).
 *
 * The revision belongs to one declared step, `(roadmapVersionId, stepId)`, and names
 * the revision it supersedes: null for the step's first, the step's current one
 * otherwise, which the door holds by optimistic concurrency. `graphRevisionId` is
 * the producer's, checked for existence and never derived. Ids and counts only.
 */
export const TaskGraphDeclaration = z
  .strictObject({
    graphRevisionId: Uuid,
    roadmapVersionId: Uuid,
    stepId: BoundedIdentifier,
    supersedesGraphRevisionId: Uuid.nullable(),
    nodeCount: z.number().int().min(1).max(TASK_GRAPH_NODES_MAX),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });
    if (value.supersedesGraphRevisionId === value.graphRevisionId) {
      ctx.addIssue({
        code: "custom",
        message: "a graph revision does not supersede itself",
        path: ["supersedesGraphRevisionId"],
      });
    }
  });
export type TaskGraphDeclaration = z.infer<typeof TaskGraphDeclaration>;

/**
 * One node of a task graph revision and its incoming dependencies, as a
 * `TASK_GRAPH_NODE_DECLARED` payload records it (P-27 cut A, ADR 0115; planning §5.2,
 * §5.3).
 *
 * A node is a task revision; an edge names the task revision it depends on and the
 * policy it asks. What one value can prove about itself is proved here: an edge
 * repeated or naming its own node. Whether an edge's end is a node of the same
 * revision, a cycle, and whether the task revision exists are the ledger's, where the
 * whole revision and the task stream are visible.
 */
export const TaskGraphNodeDeclaration = z
  .strictObject({
    graphRevisionId: Uuid,
    ...TaskGraphTaskRevision,
    nodeIndex: z.number().int().min(0).max(TASK_GRAPH_NODES_MAX - 1),
    dependsOn: z
      .array(
        z.strictObject({
          ...TaskGraphTaskRevision,
          failPolicy: z.enum(DEPENDENCY_FAILURE_POLICIES),
        }),
      )
      .max(TASK_GRAPH_DEPENDS_ON_MAX),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });
    refuseRepeats(
      value.dependsOn.map((edge) => edge.taskId + "@" + String(edge.taskRevisionNumber)),
      ctx,
      ["dependsOn"],
      "a dependency",
    );
    for (const [position, edge] of value.dependsOn.entries()) {
      if (edge.taskId === value.taskId && edge.taskRevisionNumber === value.taskRevisionNumber) {
        ctx.addIssue({ code: "custom", message: "a node does not depend on itself", path: ["dependsOn", position] });
      }
    }
  });
export type TaskGraphNodeDeclaration = z.infer<typeof TaskGraphNodeDeclaration>;

/**
 * A task's link to a declared step, as a `TASK_STEP_LINKED` payload records it (P-27
 * cut C, ADR 0116; decision 200).
 *
 * The target pair `(roadmapVersionId, stepId)` is the step the task is of from this
 * link on; the `from` pair is the step it was of before, both null for an adoption (a
 * task that entered with no link) and both set for a re-link. The link's identity is
 * its task and its target version: the producer derives the transition from them and
 * carries no id of its own. Both step ids are the declared step's grammar,
 * `BoundedIdentifier`: an intake's pair copies into `from` because decision 197 admits
 * an intake step only when its version declares it, not because the intake's own
 * grammar is narrower. What one value can prove about itself is proved here: the
 * `from` pair is whole or absent, and the target is not the `from` pair. Whether the
 * step is declared, whether the task exists and is of this initiative, whether `from`
 * is the task's current link and whether the target is a later version of the same
 * step are the ledger's, where the history is visible. Ids only.
 */
export const TaskStepLinkDeclaration = z
  .strictObject({
    taskId: Uuid,
    roadmapVersionId: Uuid,
    stepId: BoundedIdentifier,
    fromRoadmapVersionId: Uuid.nullable(),
    fromStepId: BoundedIdentifier.nullable(),
  })
  .superRefine((value, ctx) => {
    attachGuards(value, ctx, { transcript: false });
    if ((value.fromRoadmapVersionId === null) !== (value.fromStepId === null)) {
      ctx.addIssue({
        code: "custom",
        message: "the from pair is both null or both set",
        path: [value.fromRoadmapVersionId === null ? "fromRoadmapVersionId" : "fromStepId"],
      });
    }
    if (value.fromRoadmapVersionId === value.roadmapVersionId && value.fromStepId === value.stepId) {
      ctx.addIssue({
        code: "custom",
        message: "a task is not linked to the step it is already of",
        path: ["roadmapVersionId"],
      });
    }
  });
export type TaskStepLinkDeclaration = z.infer<typeof TaskStepLinkDeclaration>;

/**
 * The initiative stream's vocabulary, closed at seven names.
 *
 * `ROADMAP_VERSION_RECORDED` **is** the receipt for a recorded version, the
 * way `COMMIT_RECORDED` is the receipt for a commit. A separate receipt type
 * would record the same fact twice. `ROADMAP_STEP_DECLARED` (P-26 cut B, ADR 0111)
 * declares one step of a version, in the same all-or-none batch as the version.
 * `TASK_GRAPH_DECLARED` and `TASK_GRAPH_NODE_DECLARED` (P-27 cut A, ADR 0115) declare
 * one revision of a step's task graph and its nodes, in one all-or-none batch.
 * `TASK_STEP_LINKED` (P-27 cut C, ADR 0116) links one task to a declared step, alone,
 * through the single door.
 */
export const INITIATIVE_EVENT_TYPES = [
  "INITIATIVE_REGISTERED",
  "INITIATIVE_STATE_CHANGED",
  "ROADMAP_VERSION_RECORDED",
  "ROADMAP_STEP_DECLARED",
  "TASK_GRAPH_DECLARED",
  "TASK_GRAPH_NODE_DECLARED",
  "TASK_STEP_LINKED",
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

    // Every type but the registration and the change is a passthrough: recording
    // a roadmap version, declaring a step, declaring a task graph or linking a task
    // to a step does not move the initiative's status.
    if (
      value.type !== "INITIATIVE_REGISTERED" &&
      value.type !== "INITIATIVE_STATE_CHANGED" &&
      value.fromStatus !== value.toStatus
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          value.type === "ROADMAP_VERSION_RECORDED"
            ? "recording a roadmap version does not move the initiative's status"
            : value.type === "ROADMAP_STEP_DECLARED"
              ? "declaring a roadmap step does not move the initiative's status"
              : value.type === "TASK_STEP_LINKED"
                ? "linking a task to a step does not move the initiative's status"
                : "declaring a task graph does not move the initiative's status",
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

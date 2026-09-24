import {
  CONTRACT_VERSION,
  ROADMAP_WRITE_SET_PREIMAGE_PREFIX_V1,
  RoadmapStepManifest,
  RoadmapVersion,
  buildInitiativeIdempotencyKey,
} from "@acp/contracts";

import { readByReference } from "../artifact-plane/index.js";
import type { ArtifactEventIdentity, ArtifactPublicationRequest } from "../artifact-plane/index.js";
import { artifactRootFor, publishArtifact } from "../artifact-store/index.js";
import { canonicalJsonStringify, sha256Hex } from "../canonical-json/index.js";
import { LedgerIntegrityError } from "../errors/index.js";
import type { Ledger } from "../ledger/index.js";
import { decideRoadmapVersion } from "../roadmap-version/index.js";
import type { RoadmapVersionRefusal } from "../roadmap-version/index.js";
import { ARTIFACT_ACCESS_POLICY_IDS } from "../types/index.js";
import type { ArtifactEventRecord, InitiativeAppendResult, RoadmapVersionReadModel } from "../types/index.js";

import type {
  RoadmapRevisionInput,
  RoadmapRevisionOutcome,
  RoadmapStepDigest,
  RoadmapStepDigestOutcome,
  RoadmapStepManifestRead,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`,
 * and are re-exported here unchanged (owner law §7).
 */
export type {
  RoadmapRevisionInput,
  RoadmapRevisionOutcome,
  RoadmapRevisionRequest,
  RoadmapRevisionStepIdentities,
  RoadmapStepDigest,
  RoadmapStepDigestOutcome,
  RoadmapStepManifestRead,
} from "./types/index.js";

/**
 * A roadmap's steps — P-26 cut B, ADR 0111.
 *
 * ## One home for the digests and the rank (L-P26B-2)
 *
 * `roadmapStepDigests` is the one derivation of what a `ROADMAP_STEP_DECLARED`
 * must say about a step of a manifest: the digest of its objective, of its
 * acceptance, of its expected write set, and its `dependencyRank`. The producer
 * calls it to build the declarations, and the door calls it — through the
 * decision — to re-derive them from the manifest it reads back by reference. Two
 * derivations would be two answers to one question, and the door exists to refuse
 * the history in which they differ.
 *
 * - `objectiveSha256` and `acceptanceSha256` are the sha-256 of the text's UTF-8
 *   bytes, the objective's own rule (decision 75).
 * - `expectedWriteSetSha256` is the sha-256 of `ROADMAP_WRITE_SET_PREIMAGE_PREFIX_V1`
 *   followed by the canonical JSON of the paths **sorted**: order is not identity.
 *   The prefix is the contract's; the computation is this package's, because the
 *   contract reaches no `node:` builtin.
 * - `dependencyRank` is the longest path from a step with no dependencies (0 for
 *   one), the cycle computation's result recorded on the event that declares the
 *   dependencies (planning §4; ND-B1). A cycle has no rank and is refused as
 *   `STEP_DEPENDENCY_CYCLE` at the first stepId on it in manifest order: an
 *   identifier, never content.
 *
 * ## The manifest is private
 *
 * The texts — objective, acceptance, paths — live in the manifest, published to
 * the private plane as a `PLAN_DOCUMENT` scoped to the initiative, and nowhere
 * else. The door's read of it is a re-derivation, not a sink: nothing it reads
 * reaches an event, a response or a log. The one text the stream carries is each
 * step's title, the class of an initiative's title (decision 76).
 *
 * ## One producer
 *
 * `recordRoadmapRevision` composes publish → decide → append for a version with
 * steps and one without, so the gateway seam that calls it keeps only its handles
 * and its error mapping.
 */

/** The canonical bytes of a manifest, and their digest: what the plane stores and the version names. */
export function roadmapStepManifestDocument(manifest: RoadmapStepManifest): {
  readonly json: string;
  readonly sha256: string;
} {
  const json = canonicalJsonStringify(manifest);
  return { json, sha256: sha256Hex(json) };
}

function expectedWriteSetSha256(paths: readonly string[]): string {
  return sha256Hex(ROADMAP_WRITE_SET_PREIMAGE_PREFIX_V1 + canonicalJsonStringify([...paths].sort()));
}

/**
 * Derive every step's declaration from a manifest the contract already parsed.
 *
 * The rank is computed by a depth-first walk in manifest order with three colours;
 * a dependency met while still open closes a cycle, and the cycle's member of the
 * lowest index names it. A dependency the manifest does not declare cannot reach
 * here: the contract refused it.
 */
export function roadmapStepDigests(manifest: RoadmapStepManifest): RoadmapStepDigestOutcome {
  const indexOf = new Map<string, number>();
  for (const [index, step] of manifest.steps.entries()) indexOf.set(step.stepId, index);

  const OPEN = 1;
  const DONE = 2;
  const colour = new Map<string, number>();
  const rank = new Map<string, number>();

  const visit = (stepId: string, path: readonly string[]): string | null => {
    const state = colour.get(stepId);
    if (state === DONE) return null;
    if (state === OPEN) {
      const cycle = path.slice(path.indexOf(stepId));
      return cycle.reduce((first, member) =>
        (indexOf.get(member) ?? 0) < (indexOf.get(first) ?? 0) ? member : first,
      );
    }
    colour.set(stepId, OPEN);
    const step = manifest.steps[indexOf.get(stepId) ?? -1];
    let depth = 0;
    for (const dependency of step?.dependsOn ?? []) {
      const closed = visit(dependency, [...path, stepId]);
      if (closed !== null) return closed;
      depth = Math.max(depth, (rank.get(dependency) ?? 0) + 1);
    }
    colour.set(stepId, DONE);
    rank.set(stepId, depth);
    return null;
  };

  for (const step of manifest.steps) {
    const closed = visit(step.stepId, []);
    if (closed !== null) return { ok: false, reason: "STEP_DEPENDENCY_CYCLE", at: closed };
  }

  const steps: RoadmapStepDigest[] = manifest.steps.map((step, stepIndex) => ({
    stepId: step.stepId,
    stepIndex,
    title: step.title,
    objectiveSha256: sha256Hex(step.objective),
    acceptanceSha256: sha256Hex(step.acceptance),
    expectedWriteSetSha256: expectedWriteSetSha256(step.expectedWriteSet),
    dependsOn: [...step.dependsOn],
    dependencyRank: rank.get(step.stepId) ?? 0,
  }));
  return { ok: true, steps };
}

/**
 * Read a version's manifest back by reference, under its initiative's scope.
 *
 * The door's one read of the private plane, outside its transaction: the blob is
 * content-addressed and immutable, and `readByReference` verifies the bytes
 * against the reference's digest on the way out, so whatever this returns hashes
 * to the digest the reference row pins. The door then asserts that row inside the
 * transaction. The bytes are parsed as JSON and handed on untrusted: the decision
 * parses them through the contract.
 */
export function readRoadmapStepManifest(
  ledger: Ledger,
  reference: { readonly artifactReferenceId: string; readonly initiativeId: string },
): RoadmapStepManifestRead {
  const read = readByReference(ledger, {
    artifactReferenceId: reference.artifactReferenceId,
    scopeKind: "INITIATIVE",
    scopeId: reference.initiativeId,
  });
  if (read.verb !== "READ") return { ok: false, refusal: read.refusal };
  let manifest: unknown;
  try {
    manifest = JSON.parse(read.content.toString("utf8"));
  } catch {
    return { ok: false, refusal: "NOT_JSON" };
  }
  return { ok: true, manifest, contentSha256: read.reference.contentSha256 };
}

/** The transition id of a version's event and of each of its steps' (ND-B2). */
export function roadmapVersionTransitionId(version: number): string {
  return "roadmap.v" + String(version);
}

export function roadmapStepTransitionId(version: number, stepIndex: number): string {
  return roadmapVersionTransitionId(version) + ".step." + String(stepIndex);
}

/** How the manifest's bytes are described to the plane. */
export const ROADMAP_STEP_MANIFEST_MEDIA_TYPE = "application/json";

/** The profile a plaintext manifest is stored under: the objective's. */
export const ROADMAP_STEP_MANIFEST_ENCRYPTION_PROFILE = "local-plaintext-v1";

/** The holding's informative window: the objective's five minutes. */
const MANIFEST_HOLDING_WINDOW_MS = 5 * 60 * 1000;

function refuse(reason: RoadmapVersionRefusal | "CONTENT_REJECTED", at: string): RoadmapRevisionOutcome {
  return Object.freeze({ ok: false as const, reason, at });
}

function identityOf(record: ArtifactEventRecord): ArtifactEventIdentity {
  return {
    eventId: record.eventId,
    idempotencyKey: record.idempotencyKey,
    occurredAt: record.event.occurredAt,
    recordedAt: record.event.recordedAt,
  };
}

/**
 * The manifest's publication request: fresh when no intention stands under the
 * derived key, and the recorded intention's own otherwise — the objective's rule
 * (`initiative-registration`), so a retry resumes rather than forks.
 */
function manifestPublicationFor(
  input: RoadmapRevisionInput,
  document: { readonly json: string; readonly sha256: string },
): ArtifactPublicationRequest | null {
  const identities = input.stepIdentities;
  if (identities === null || input.holderPid === null) return null;
  const prefix = input.initiativeId + "/step-manifest/" + document.sha256 + "/";
  const keys = { intended: prefix + "intended", succeeded: prefix + "succeeded" };
  const events = input.writable.listArtifactEvents(document.sha256);
  const intention = events.find((record) => record.idempotencyKey === keys.intended);
  const terminal = events.find((record) => record.idempotencyKey === keys.succeeded);
  const holding = {
    holder: input.request.recordedBy,
    holderPid: input.holderPid,
    acquiredAt: input.recordedAt,
    expiresAt: new Date(Date.parse(input.recordedAt) + MANIFEST_HOLDING_WINDOW_MS).toISOString(),
  };
  const freshTerminal: ArtifactEventIdentity = {
    eventId: identities.terminalEventId,
    idempotencyKey: keys.succeeded,
    occurredAt: input.recordedAt,
    recordedAt: input.recordedAt,
  };
  const content = Buffer.from(document.json, "utf8");

  if (intention === undefined) {
    return {
      content,
      declaredContentSha256: document.sha256,
      mediaType: ROADMAP_STEP_MANIFEST_MEDIA_TYPE,
      encryptionStatus: "PLAINTEXT",
      encryptionProfile: ROADMAP_STEP_MANIFEST_ENCRYPTION_PROFILE,
      commandId: identities.commandId,
      artifactPinId: identities.artifactPinId,
      reference: {
        artifactReferenceId: identities.artifactReferenceId,
        artifactClass: "PLAN_DOCUMENT",
        classification: "INTERNAL",
        scopeKind: "INITIATIVE",
        scopeId: input.initiativeId,
        producerIdentity: input.request.recordedBy,
        accessPolicyId: ARTIFACT_ACCESS_POLICY_IDS[0],
        retentionClass: "PERMANENT",
        expiresAt: null,
      },
      recordedBy: input.request.recordedBy,
      intention: {
        eventId: identities.intentionEventId,
        idempotencyKey: keys.intended,
        occurredAt: input.recordedAt,
        recordedAt: input.recordedAt,
      },
      terminal: terminal === undefined ? freshTerminal : identityOf(terminal),
      holding,
    };
  }

  const recorded = intention.event;
  if (recorded.artifactEventKind !== "PUBLICATION_INTENDED" || recorded.payload.intendedReference === undefined) {
    return null;
  }
  return {
    content,
    declaredContentSha256: document.sha256,
    mediaType: recorded.payload.mediaType,
    encryptionStatus: recorded.payload.encryptionStatus,
    encryptionProfile: recorded.payload.encryptionProfile,
    commandId: recorded.payload.commandId,
    artifactPinId: recorded.payload.artifactPinId,
    reference: recorded.payload.intendedReference,
    recordedBy: recorded.recordedBy,
    intention: identityOf(intention),
    terminal: terminal === undefined ? freshTerminal : identityOf(terminal),
    holding,
  };
}

/**
 * Record one roadmap revision, with steps or without.
 *
 * The order is the design. Publish the document's bytes to the content store (an
 * idempotent, content-addressed write a refused decision leaves unreferenced, which
 * is cheap and lawful); fold the head; derive the steps and decide, **before** the
 * manifest is published, so a refused revision — a cycle among them — publishes no
 * manifest; publish the manifest; append. A version with no steps goes through the
 * single initiative door with `stepCount` 0; one with steps goes through the batch
 * door, all or none, whose own decision re-derives every step from the manifest it
 * reads back.
 *
 * It opens nothing and reads no clock and no random source: the handles, the
 * plane, the instant, the pid and every identity arrive with the input. Ledger
 * errors are thrown untouched, so the caller keeps its own mapping of a lost race.
 */
export function recordRoadmapRevision(input: RoadmapRevisionInput): RoadmapRevisionOutcome {
  const { reader, writable, initiativeId, request, recordedAt, roadmapVersionId, eventId } = input;

  const published = publishArtifact(artifactRootFor(writable.path), request.content);
  if (!published.ok) return refuse("CONTENT_REJECTED", published.reason);

  const knownVersions: readonly RoadmapVersionReadModel[] = reader.listRoadmapVersions(initiativeId);
  const head = knownVersions.at(-1) ?? null;

  let manifest: RoadmapStepManifest | null = null;
  if (request.steps !== undefined) {
    const parsed = RoadmapStepManifest.safeParse(request.steps);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refuse("STEP_DECLARATION_INVALID", "steps." + (issue?.path ?? []).map(String).join("."));
    }
    manifest = parsed.data;
  }
  const document = manifest === null ? null : roadmapStepManifestDocument(manifest);
  const publication = document === null ? null : manifestPublicationFor(input, document);
  if (document !== null && (publication === null || input.plane === null)) {
    // A steps-bearing revision needs the plane, the identities and the pid, and a
    // derived key another producer wrote under names no reference this can use.
    return refuse("CONTENT_REJECTED", "NO_STEP_MANIFEST_PUBLICATION");
  }

  const version = head === null ? 1 : head.version + 1;
  const candidate = {
    contractVersion: CONTRACT_VERSION,
    roadmapVersionId,
    initiativeId,
    version,
    contentDigest: published.digest,
    parentVersionId: head === null ? null : head.roadmapVersionId,
    expectedHeadDigest: request.expectedHeadDigest,
    kind: request.kind,
    restoresVersionId: request.restoresVersionId,
    recordedBy: request.recordedBy,
    recordedAt,
    stepCount: manifest === null ? 0 : manifest.steps.length,
    stepManifestArtifactReferenceId: publication === null ? null : publication.reference.artifactReferenceId,
    stepManifestSha256: document === null ? null : document.sha256,
  };

  let declarations: readonly Record<string, unknown>[] = [];
  if (manifest !== null) {
    const derived = roadmapStepDigests(manifest);
    if (!derived.ok) return refuse(derived.reason, derived.at);
    declarations = derived.steps.map((step) => ({ roadmapVersionId, ...step }));
  }

  const decision = decideRoadmapVersion({
    candidate,
    head,
    knownVersions,
    steps: { declarations, manifest },
  });
  if (!decision.ok) return refuse(decision.reason, decision.at);

  const transitionId = roadmapVersionTransitionId(version);
  const envelope = (id: string, transition: string, type: string, payload: unknown): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId: id,
    initiativeId,
    transitionId: transition,
    idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId, transitionId: transition }),
    type,
    fromStatus: "ACTIVE",
    toStatus: "ACTIVE",
    emittedBy: request.recordedBy,
    occurredAt: recordedAt,
    recordedAt,
    payload,
  });
  const versionEvent = envelope(eventId, transitionId, "ROADMAP_VERSION_RECORDED", decision.version);

  let appended: InitiativeAppendResult;
  if (manifest === null || publication === null || input.plane === null || input.stepIdentities === null) {
    appended = writable.appendInitiativeEvent(versionEvent);
  } else {
    const stepEventIds = input.stepIdentities.stepEventIds;
    if (stepEventIds.length !== declarations.length) {
      return refuse("CONTENT_REJECTED", "STEP_EVENT_IDS");
    }
    const outcome = input.plane.publish(publication);
    if (outcome.verb === "ABANDONED" || outcome.verb === "REFUSE") {
      return refuse("CONTENT_REJECTED", outcome.refusal);
    }
    if (outcome.verb !== "PUBLISHED") {
      throw new LedgerIntegrityError(["a manifest's publication answered with a reconciler's verb"]);
    }
    const reference = outcome.reference;
    if (
      reference.artifactReferenceId !== candidate.stepManifestArtifactReferenceId ||
      reference.contentSha256 !== candidate.stepManifestSha256 ||
      reference.scopeKind !== "INITIATIVE" ||
      reference.scopeId !== initiativeId
    ) {
      throw new LedgerIntegrityError(["a manifest's publication names a reference of another identity, content or scope"]);
    }
    const stepEvents = declarations.map((declaration, stepIndex) =>
      envelope(
        stepEventIds[stepIndex] ?? "",
        roadmapStepTransitionId(version, stepIndex),
        "ROADMAP_STEP_DECLARED",
        declaration,
      ),
    );
    const batch = writable.appendInitiativeBatch([versionEvent, ...stepEvents]);
    const first = batch.records[0];
    if (first === undefined) throw new LedgerIntegrityError(["a revision's batch answered with no records"]);
    appended = { inserted: batch.insertedCount > 0, record: first };
  }

  const recorded = RoadmapVersion.safeParse(appended.record.event.payload);
  if (!recorded.success) {
    throw new LedgerIntegrityError(["an appended roadmap version reads back as another shape"]);
  }
  return Object.freeze({ ok: true as const, version: recorded.data, sequence: appended.record.sequence });
}

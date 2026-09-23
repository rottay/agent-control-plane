import { createHash } from "node:crypto";

import {
  CONTENT_ARTIFACT_MAX_BYTES,
  CONTENT_INLINE_TEXT_MAX_CHARS,
  RESULT_BLOCK_LIST_MAX,
  RESULT_CONTRACT_VERSION,
  ResultContractSchema,
  findCredentialViolations,
  utf8ByteLength,
} from "@acp/contracts";
import type { ContentBlock, ExecutionEvent, ResultStatus } from "@acp/contracts";
import { ARTIFACT_ACCESS_POLICY_IDS, canonicalJsonStringify, effectOutcomeArrival } from "@acp/ledger";
import type {
  ArtifactEventIdentity,
  ArtifactEventRecord,
  ArtifactPublicationRequest,
  EffectReadModel,
} from "@acp/ledger";

import type {
  ArtifactIdentities,
  OperationDecision,
  OperationFacts,
  PublishedResult,
  ResultAssembly,
  ResultPublicationInput,
  ResultSample,
} from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and
 * are re-exported here unchanged (owner law §7, decision 90).
 */
export type {
  ArtifactIdentities,
  OperationDecision,
  OperationDecisionReason,
  OperationFact,
  OperationFacts,
  OutputCondition,
  ProcessFact,
  PublishedResult,
  ResultAssembly,
  ResultPublicationInput,
  ResultSample,
  ResultSink,
} from "./types/index.js";

/**
 * An operation's result — P-07 escalón D, ADR 0100.
 *
 * Four pure pieces and one impure one, in the order a completed execution meets
 * them:
 *
 * 1. `operationFactsOf` reads the three facts of contratos §4.2 from a trail, by
 *    event kind and nothing else;
 * 2. `decideOperationOutcome` decides the result's status from them, once;
 * 3. `assembleResult` turns the output text into a result document v1 under the
 *    C4 rule, or into nothing when nothing may be published;
 * 4. `completeOverflow` finishes a document whose answer needed its own artifact;
 * 5. `publishResult` asks the ledger's own comparison whether the effect may take
 *    this result, and only then publishes the document as a `RESPONSE` artifact,
 *    before anything references it (datos §11 step 7).
 *
 * **What this concept never does.** It appends no event, writes no row, reads no
 * clock and mints no id: every identity is the caller's. Output text reaches the
 * private plane as an artifact's bytes and nowhere else (L-P07C-1). Appending the
 * outcome and the response occurrence is the caller's, through the ledger's door.
 */

/** Why an operation's result is what it is. Closed and sorted. */
export const OPERATION_DECISION_REASONS = [
  "NO_OUTPUT",
  "OPERATION_FAILED",
  "OPERATION_NOT_OBSERVED",
  "OPERATION_SUCCEEDED",
  "OUTPUT_OVER_PROFILE",
  "OUTPUT_REFUSED",
  "OUTPUT_UNREADABLE",
  "PROCESS_ABNORMAL",
] as const;

/** Whether the collected output is whole. Closed. */
export const OUTPUT_CONDITIONS = ["HELD", "OVER_PROFILE", "UNREADABLE"] as const;

/** The media type of a result document, and of the overflow document it may name. */
export const RESULT_DOCUMENT_MEDIA_TYPE = "application/json; charset=utf-8";
export const RESULT_OVERFLOW_MEDIA_TYPE = "text/markdown; charset=utf-8";
const TEXT_BLOCK_MEDIA_TYPE = "text/plain; charset=utf-8";

/** The plaintext profile the plane records, the intake's own. */
const RESULT_ENCRYPTION_PROFILE = "local-plaintext-v1";

/** The holding's informative window, the intake's own: five minutes from the recording instant. */
const RESULT_HOLDING_WINDOW_MS = 5 * 60 * 1000;

/**
 * A refusal of this concept, by name.
 *
 * `CONFLICT` carries the ledger's own `path` and `message` verbatim: the comparison
 * is the ledger's, and so are its words.
 */
export class OperationResultError extends Error {
  readonly code: "CONFLICT" | "EFFECT_UNKNOWN" | "FACTS_INCONSISTENT" | "PUBLICATION_REFUSED";
  readonly path: string;

  constructor(code: OperationResultError["code"], path: string, message: string) {
    super(message);
    this.name = "OperationResultError";
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// 1. The facts
// ---------------------------------------------------------------------------

/**
 * The three facts of one trail (contratos §4.2; ADR 0099).
 *
 * Read by `kind` and nothing else. An absent `processExited` is `NOT_OBSERVABLE`,
 * never exit 0; an absent `operationResult` is `NOT_OBSERVABLE`, never success. The
 * port emits each at most once and exactly one terminal, and this function holds
 * that too: a second of any is refused rather than overwritten.
 */
export function operationFactsOf(trail: readonly ExecutionEvent[]): OperationFacts {
  let terminal: OperationFacts["terminal"] = "none";
  let process: OperationFacts["process"] = { kind: "NOT_OBSERVABLE" };
  let operation: OperationFacts["operation"] = "NOT_OBSERVABLE";
  let exits = 0;
  let verdicts = 0;
  for (const event of trail) {
    if (event.kind === "completed" || event.kind === "error") {
      if (terminal !== "none") throw inconsistent("a trail ends once, and this one ends twice");
      terminal = event.kind;
    } else if (event.kind === "processExited") {
      exits += 1;
      if (exits > 1) throw inconsistent("a process ends once, and this trail reports two exits");
      process = { kind: "EXITED", exitCode: event.exitCode, signal: event.signal };
    } else if (event.kind === "operationResult") {
      verdicts += 1;
      if (verdicts > 1) throw inconsistent("an operation reports its outcome once, and this trail reports two");
      operation = event.status;
    }
  }
  return { terminal, process, operation };
}

function inconsistent(message: string): OperationResultError {
  return new OperationResultError("FACTS_INCONSISTENT", "trail", message);
}

// ---------------------------------------------------------------------------
// 2. The decider
// ---------------------------------------------------------------------------

/**
 * Decide an operation's result from its three facts, once (ADR 0100 One).
 *
 * Only a `completed` terminal is decided; `error` and a missing terminal keep the
 * legacy refusal path. On `completed`:
 *
 * | operation | process | status | reason |
 * | --- | --- | --- | --- |
 * | `FAILED` | any | `FAILED` | `OPERATION_FAILED` |
 * | `SUCCEEDED` | exit 0, or not observable | `SUCCEEDED` | `OPERATION_SUCCEEDED` |
 * | `SUCCEEDED` | a non-zero exit, or a signal | `FAILED` | `PROCESS_ABNORMAL` |
 * | not observable | any | `FAILED` | `OPERATION_NOT_OBSERVED` |
 *
 * A process that was not observed is never read as exit 0: `SUCCEEDED` stands on
 * it only because the API and local legs own no process to observe.
 */
export function decideOperationOutcome(facts: OperationFacts): OperationDecision {
  if (facts.terminal !== "completed") return { decided: false };
  const operation = facts.operation;
  switch (operation) {
    case "FAILED":
      return { decided: true, status: "FAILED", reason: "OPERATION_FAILED" };
    case "SUCCEEDED": {
      const process = facts.process;
      const clean =
        process.kind === "NOT_OBSERVABLE" || (process.exitCode === 0 && process.signal === null);
      return clean
        ? { decided: true, status: "SUCCEEDED", reason: "OPERATION_SUCCEEDED" }
        : { decided: true, status: "FAILED", reason: "PROCESS_ABNORMAL" };
    }
    case "NOT_OBSERVABLE":
      return { decided: true, status: "FAILED", reason: "OPERATION_NOT_OBSERVED" };
    default: {
      const unreachable: never = operation;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The assembler
// ---------------------------------------------------------------------------

/**
 * Split output text into chunks of at most `CONTENT_INLINE_TEXT_MAX_CHARS` UTF-16
 * units, never splitting a surrogate pair: a chunk that would end on a high
 * surrogate ends one unit early instead.
 */
export function chunkOutput(output: string): readonly string[] {
  const chunks: string[] = [];
  let from = 0;
  while (from < output.length) {
    let to = Math.min(from + CONTENT_INLINE_TEXT_MAX_CHARS, output.length);
    if (to < output.length) {
      const last = output.charCodeAt(to - 1);
      if (last >= 0xd800 && last <= 0xdbff) to -= 1;
    }
    chunks.push(output.slice(from, to));
    from = to;
  }
  return chunks;
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textBlock(chunk: string, index: number): ContentBlock {
  const bytes = Buffer.from(chunk, "utf8");
  return {
    kind: "text",
    blockId: "output-" + String(index + 1).padStart(3, "0"),
    mediaType: TEXT_BLOCK_MEDIA_TYPE,
    byteLength: bytes.byteLength,
    contentSha256: sha256Of(bytes),
    artifactRefId: null,
    text: chunk,
    toolCallId: null,
    effectId: null,
  };
}

/**
 * The document for `blocks`, parsed and canonical, or the refusal that stops it.
 * A refused document is never published: its bytes go nowhere (D10).
 */
function documentOf(
  effectId: string,
  status: ResultStatus,
  reason: Extract<OperationDecision, { decided: true }>["reason"],
  blocks: readonly ContentBlock[],
): ResultAssembly {
  const parsed = ResultContractSchema.safeParse({
    resultContractVersion: RESULT_CONTRACT_VERSION,
    effectId,
    status,
    blocks,
    usageReference: effectId,
  });
  if (!parsed.success) return { kind: "NO_DOCUMENT", status: "FAILED", reason: "OUTPUT_REFUSED" };
  const bytes = Buffer.from(canonicalJsonStringify(parsed.data), "utf8");
  return { kind: "DOCUMENT", status, reason, document: parsed.data, bytes, sha256: sha256Of(bytes) };
}

/**
 * Assemble a result document from one sample under the C4 rule (ADR 0100 Two).
 *
 * - Output that is not whole — over the profile, or unreadable — assembles
 *   nothing, and is never truncated.
 * - No output assembles nothing: an effect that answered nothing did not succeed.
 * - Output that fits in `RESULT_BLOCK_LIST_MAX` text blocks becomes those blocks,
 *   in order.
 * - Otherwise the whole output becomes ONE `document` by reference, published as
 *   its own markdown artifact first — never text and a document for one answer.
 *
 * A `FAILED` decision with output still gets its document (the DT's Q-D9). A
 * document the result contract refuses — the credential guard included — is
 * `FAILED` with nothing published.
 */
export function assembleResult(effectId: string, sample: ResultSample): ResultAssembly {
  const decision = decideOperationOutcome(sample.facts);
  if (!decision.decided) {
    throw new OperationResultError("FACTS_INCONSISTENT", "facts.terminal", "a result is assembled for a completed execution only");
  }
  if (sample.outputCondition === "OVER_PROFILE") {
    return { kind: "NO_DOCUMENT", status: "FAILED", reason: "OUTPUT_OVER_PROFILE" };
  }
  if (sample.outputCondition === "UNREADABLE") {
    return { kind: "NO_DOCUMENT", status: "FAILED", reason: "OUTPUT_UNREADABLE" };
  }
  if (sample.output === "") {
    return {
      kind: "NO_DOCUMENT",
      status: "FAILED",
      reason: decision.status === "SUCCEEDED" ? "NO_OUTPUT" : decision.reason,
    };
  }
  if (utf8ByteLength(sample.output) > CONTENT_ARTIFACT_MAX_BYTES) {
    return { kind: "NO_DOCUMENT", status: "FAILED", reason: "OUTPUT_OVER_PROFILE" };
  }

  // The guard reads the whole output before it is cut: a credential that straddles
  // a chunk boundary matches no single block, and an overflow's text is no block
  // the result contract's guard reads. Credential-shaped output is refused, never
  // published and never redacted (D10).
  if (findCredentialViolations({ output: sample.output }).length > 0) {
    return { kind: "NO_DOCUMENT", status: "FAILED", reason: "OUTPUT_REFUSED" };
  }
  const chunks = chunkOutput(sample.output);
  if (chunks.length <= RESULT_BLOCK_LIST_MAX) {
    return documentOf(effectId, decision.status, decision.reason, chunks.map(textBlock));
  }
  const overflowBytes = Buffer.from(sample.output, "utf8");
  return {
    kind: "OVERFLOW",
    status: decision.status,
    reason: decision.reason,
    effectId,
    overflowBytes,
    overflowSha256: sha256Of(overflowBytes),
  };
}

/**
 * Finish an overflowing answer: the one `document` block naming the markdown
 * artifact `overflowReferenceId` will hold. Pure; the reference is the caller's.
 */
export function completeOverflow(
  assembly: Extract<ResultAssembly, { kind: "OVERFLOW" }>,
  overflowReferenceId: string,
): ResultAssembly {
  const block: ContentBlock = {
    kind: "document",
    blockId: "output-001",
    mediaType: RESULT_OVERFLOW_MEDIA_TYPE,
    byteLength: assembly.overflowBytes.byteLength,
    contentSha256: assembly.overflowSha256,
    artifactRefId: overflowReferenceId,
    text: null,
    toolCallId: null,
    effectId: null,
  };
  return documentOf(assembly.effectId, assembly.status, assembly.reason, [block]);
}

// ---------------------------------------------------------------------------
// 4. The publisher
// ---------------------------------------------------------------------------

/** The idempotency keys of one publication, derived from the effect and the bytes' digest. */
export function resultIdempotencyKeys(
  effectId: string,
  role: "result" | "output",
  sha256: string,
): { readonly intended: string; readonly succeeded: string } {
  const prefix = effectId + "/" + role + "/" + sha256 + "/";
  return { intended: prefix + "intended", succeeded: prefix + "succeeded" };
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
 * The publication request for one document: fresh when no intention stands under
 * the derived key, and the recorded intention's own otherwise — a crash between
 * the intention and the outcome resumes, never re-mints (the intake's mould).
 */
function publicationRequest(
  input: ResultPublicationInput,
  identities: ArtifactIdentities,
  role: "result" | "output",
  bytes: Buffer,
  sha256: string,
  mediaType: string,
): ArtifactPublicationRequest {
  const { ledger, recordedAt, recordedBy, holderPid, taskId } = input;
  const keys = resultIdempotencyKeys(input.effectId, role, sha256);
  const events = ledger.listArtifactEvents(sha256);
  const intention = events.find((record) => record.idempotencyKey === keys.intended);
  const terminal = events.find((record) => record.idempotencyKey === keys.succeeded);
  const holding = {
    holder: recordedBy,
    holderPid,
    acquiredAt: recordedAt,
    expiresAt: new Date(Date.parse(recordedAt) + RESULT_HOLDING_WINDOW_MS).toISOString(),
  };
  const freshTerminal: ArtifactEventIdentity = {
    eventId: identities.terminalEventId,
    idempotencyKey: keys.succeeded,
    occurredAt: recordedAt,
    recordedAt,
  };
  if (intention === undefined) {
    return {
      content: bytes,
      declaredContentSha256: sha256,
      mediaType,
      encryptionStatus: "PLAINTEXT",
      encryptionProfile: RESULT_ENCRYPTION_PROFILE,
      commandId: identities.commandId,
      artifactPinId: identities.artifactPinId,
      reference: {
        artifactReferenceId: identities.artifactReferenceId,
        artifactClass: "RESPONSE",
        classification: "INTERNAL",
        scopeKind: "TASK",
        scopeId: taskId,
        producerIdentity: recordedBy,
        accessPolicyId: ARTIFACT_ACCESS_POLICY_IDS[0],
        // The intake's TASK_ENVELOPE retention (the DT's Q-D4): retention policy is P-36's.
        retentionClass: "PERMANENT",
        expiresAt: null,
      },
      recordedBy,
      intention: { eventId: identities.intentionEventId, idempotencyKey: keys.intended, occurredAt: recordedAt, recordedAt },
      terminal: terminal === undefined ? freshTerminal : identityOf(terminal),
      holding,
    };
  }
  const recorded = intention.event;
  if (recorded.artifactEventKind !== "PUBLICATION_INTENDED" || recorded.payload.intendedReference === undefined) {
    throw new OperationResultError(
      "PUBLICATION_REFUSED",
      role,
      "another producer wrote under this result's derived key, and a publication whose reference cannot be named is not completed",
    );
  }
  return {
    content: bytes,
    declaredContentSha256: sha256,
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

/** Publish one document and return its reference, or refuse by the plane's verb. */
function publishDocument(
  input: ResultPublicationInput,
  identities: ArtifactIdentities,
  role: "result" | "output",
  bytes: Buffer,
  sha256: string,
  mediaType: string,
): string {
  const outcome = input.plane.publish(publicationRequest(input, identities, role, bytes, sha256, mediaType));
  if (outcome.verb !== "PUBLISHED") {
    throw new OperationResultError("PUBLICATION_REFUSED", role, "the plane answered " + outcome.verb + ", and no pair exists until a publication succeeds");
  }
  const reference = outcome.reference;
  if (
    reference.artifactClass !== "RESPONSE" ||
    reference.scopeKind !== "TASK" ||
    reference.scopeId !== input.taskId ||
    reference.contentSha256 !== sha256 ||
    outcome.contentSha256 !== sha256
  ) {
    throw new OperationResultError("PUBLICATION_REFUSED", role, "the publication names a reference of another content, class or scope");
  }
  return reference.artifactReferenceId;
}

/**
 * The arriving record the ledger's comparison is asked about. `effectOutcomeArrival`
 * reads the status and the pair; the other fields are declared, and unread.
 */
function candidateOf(
  input: ResultPublicationInput,
  status: ResultStatus,
  referenceId: string | null,
  sha256: string | null,
): Parameters<typeof effectOutcomeArrival>[1] {
  return {
    dispatchAttemptId: input.effectId,
    dispatchState: "SETTLED",
    terminalAt: input.recordedAt,
    acceptedAt: null,
    externalHandle: null,
    providerIdempotencyKey: null,
    effectOutcomeStatus: status,
    resultArtifactReferenceId: referenceId,
    resultSha256: sha256,
    recordedAt: input.recordedAt,
    sequence: 0,
  };
}

/**
 * Publish an operation's result, or say why there is none (ADR 0100 Three).
 *
 * The order is the design. The effect must be one the ledger holds. The ledger's
 * own comparison, `effectOutcomeArrival`, is asked whether this result may be the
 * effect's — called, never restated — BEFORE any byte moves:
 *
 * - `write`: publish (the overflow document first, when there is one, then the
 *   result document) and return the pair taken from the plane's outcome;
 * - `replay`: publish nothing and return the stored pair;
 * - `refused`: refuse `CONFLICT` with the ledger's own path and message, having
 *   published nothing, so a conflicting result leaves no orphan artifact.
 *
 * A result with no document returns no pair — all three of reference, digest and
 * length are null together, never half — after the same comparison.
 */
export function publishResult(input: ResultPublicationInput): PublishedResult {
  const stored: EffectReadModel | null = input.ledger.getEffect(input.effectId);
  if (stored === null) {
    throw new OperationResultError("EFFECT_UNKNOWN", "effectId", "a result names an effect the ledger holds, and this one holds none under this id");
  }
  const planned =
    input.assembly.kind === "OVERFLOW"
      ? completeOverflow(input.assembly, input.overflow.artifactReferenceId)
      : input.assembly;

  if (planned.kind === "NO_DOCUMENT") {
    const arrival = effectOutcomeArrival(stored, candidateOf(input, "FAILED", null, null));
    if (arrival.kind === "refused") throw new OperationResultError("CONFLICT", arrival.path, arrival.message);
    return { status: "FAILED", reason: planned.reason, resultArtifactReferenceId: null, resultSha256: null, responseBytes: null };
  }
  if (planned.kind !== "DOCUMENT") {
    throw new OperationResultError("FACTS_INCONSISTENT", "assembly", "an overflow completes into a document or into nothing");
  }

  const candidateReference = stored.resultArtifactReferenceId ?? input.result.artifactReferenceId;
  const arrival = effectOutcomeArrival(stored, candidateOf(input, planned.status, candidateReference, planned.sha256));
  if (arrival.kind === "refused") throw new OperationResultError("CONFLICT", arrival.path, arrival.message);
  if (arrival.kind === "replay" && stored.resultArtifactReferenceId !== null && stored.resultSha256 !== null) {
    return {
      status: planned.status,
      reason: planned.reason,
      resultArtifactReferenceId: stored.resultArtifactReferenceId,
      resultSha256: stored.resultSha256,
      responseBytes: planned.bytes.byteLength,
    };
  }

  if (input.assembly.kind === "OVERFLOW") {
    const overflowReference = publishDocument(
      input,
      input.overflow,
      "output",
      input.assembly.overflowBytes,
      input.assembly.overflowSha256,
      RESULT_OVERFLOW_MEDIA_TYPE,
    );
    if (overflowReference !== input.overflow.artifactReferenceId) {
      throw new OperationResultError("PUBLICATION_REFUSED", "output", "the overflow was published under another reference than the document names");
    }
  }
  const referenceId = publishDocument(input, input.result, "result", planned.bytes, planned.sha256, RESULT_DOCUMENT_MEDIA_TYPE);
  return {
    status: planned.status,
    reason: planned.reason,
    resultArtifactReferenceId: referenceId,
    resultSha256: planned.sha256,
    responseBytes: planned.bytes.byteLength,
  };
}

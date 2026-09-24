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
import type { ContentBlock, ExecutionEvent, ResultContract, ResultStatus } from "@acp/contracts";
import {
  ARTIFACT_ACCESS_POLICY_IDS,
  LedgerIntegrityError,
  PRE_RESULT_REFERENCE_CONTRACT_VERSIONS,
  canonicalJsonStringify,
  effectOutcomeArrival,
  readByReference,
} from "@acp/ledger";
import type {
  ArtifactEventIdentity,
  ArtifactEventRecord,
  ArtifactPublicationRequest,
  EffectReadModel,
  Ledger,
} from "@acp/ledger";

import type {
  ArtifactIdentities,
  EffectResultBlock,
  EffectResultReading,
  EffectResultRequest,
  EffectResultUnreadable,
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
  EffectResultBlock,
  EffectResultReading,
  EffectResultRequest,
  EffectResultUnreadable,
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

// ---------------------------------------------------------------------------
// Reading a result back (P-15 escalón F, ADR 0107)
// ---------------------------------------------------------------------------

/**
 * The reader's own words for a result it cannot give back, beside the plane's
 * sixteen and the root's two (ADR 0107 Two). Closed.
 *
 * - `DIGEST_MISMATCH` — the reference names content of another digest than the
 *   effect's row records.
 * - `DOCUMENT_INVALID` — the bytes are not UTF-8 JSON, or not a result document v1.
 * - `DOCUMENT_DISAGREES` — a valid document of another effect or another status
 *   than the row's. The ledger's door checks class, scope and digest, never the
 *   document's content, so this is the one line that catches a mis-planted pair.
 * - `BLOCK_DISAGREES` — a block's bytes are not the digest or the length the
 *   document declares for them.
 * - `CLASS_REFUSED` — the reference the row or a block names is not a `RESPONSE`.
 *   This read serves model output and nothing else (tests §8.1, decision 149):
 *   a document block naming the task's envelope, with the envelope's own digest
 *   and length, would otherwise hand the prompt out through the authorized read
 *   (Fable F post-audit C1).
 */
export const EFFECT_RESULT_LOCAL_REFUSALS = [
  "BLOCK_DISAGREES",
  "CLASS_REFUSED",
  "DIGEST_MISMATCH",
  "DOCUMENT_DISAGREES",
  "DOCUMENT_INVALID",
] as const;

/**
 * Every word a `RESULT_UNREADABLE` may carry, as a total record: a seventeenth
 * plane refusal, a third root word or a fifth local one fails to compile here
 * until it is admitted, so no word reaches a door's `detail` unexamined.
 */
const UNREADABLE_WORDS: Readonly<Record<EffectResultUnreadable, true>> = Object.freeze({
  LEASE_HELD: true,
  LEASE_SUPERSEDED: true,
  QUIESCENCE_UNPROVEN: true,
  QUIESCENCE_OF_ANOTHER_PROCESS: true,
  HELD_FOR_RECLAIM: true,
  PUBLICATION_IN_FLIGHT: true,
  PUBLICATION_ALREADY_ABANDONED: true,
  CONTENT_ABSENT: true,
  CONTENT_DOES_NOT_VERIFY: true,
  SYMLINK_REFUSED: true,
  NO_INTENDED_REFERENCE: true,
  REFERENCE_REFUSED_BY_DOOR: true,
  REFERENCE_NOT_READABLE: true,
  CONTENT_DELETED: true,
  BLOB_NOT_PUBLISHED: true,
  ENCRYPTED_AT_REST_NOT_DELIVERED: true,
  ROOT_ABSENT: true,
  ROOT_NOT_A_DIRECTORY: true,
  BLOCK_DISAGREES: true,
  CLASS_REFUSED: true,
  DIGEST_MISMATCH: true,
  DOCUMENT_DISAGREES: true,
  DOCUMENT_INVALID: true,
});

function unreadable(refusal: EffectResultUnreadable): EffectResultReading {
  if (!Object.hasOwn(UNREADABLE_WORDS, refusal)) {
    throw new LedgerIntegrityError(["a result read refused with a word outside its closed vocabulary"]);
  }
  return { kind: "RESULT_UNREADABLE", refusal };
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeStrict(bytes: Uint8Array): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The effect's result, read back by reference behind whatever authorized the
 * caller (P-15 escalón F, ADR 0107).
 *
 * The one reader the two private-read doors call -- the gateway's bearer-guarded
 * route and the CLI's `result` verb -- and the one place a result document is
 * parsed on the way out, because this concept is the one L-P07A-1 admits to the
 * full contract. It decides in this order, and never skips a step:
 *
 * 1. the effect, which must exist **under this task**: another task's effect is
 *    `NOT_FOUND`, the same answer as no effect at all;
 * 2. no outcome: `NO_OUTCOME`;
 * 3. the outcome's integrity, which the ledger's triggers already hold: an
 *    outcome without its instant or its contract version is the ledger
 *    disagreeing with itself, `LedgerIntegrityError` -- checked before the
 *    outcome's word is read, so an unresolved outcome missing its instant throws;
 * 4. `OUTCOME_UNKNOWN` and `CANCELLED`: their own answers, never a failure and
 *    never a result;
 * 5. the pair's integrity: half a pair, or a current-cohort `SUCCEEDED` without
 *    one, is `LedgerIntegrityError`; no pair is `NO_RESULT_RECORDED`, with the
 *    cohort that explains it;
 * 6. the pair: the bytes through `readByReference` under the task's scope; the
 *    reference must be a `RESPONSE` (`CLASS_REFUSED`), its digest the row's
 *    (`DIGEST_MISMATCH`), and the document, parsed whole, the row's effect and
 *    status -- any refusal is `RESULT_UNREADABLE` with its word, and no partial
 *    document is ever returned;
 * 7. a block, only when asked: it must be a block of this `RESULT` that names
 *    its own reference (`BLOCK_REFUSED` otherwise), that reference must be a
 *    `RESPONSE` (`CLASS_REFUSED`), and its bytes must be the digest and the
 *    length the document declares (`BLOCK_DISAGREES`).
 *
 * It reads; it appends nothing, writes nothing and reads no clock.
 */
export function readEffectResult(ledger: Ledger, request: EffectResultRequest): EffectResultReading {
  const effect = ledger.getEffect(request.effectId);
  if (effect === null || effect.taskId !== request.taskId) {
    return { kind: "NOT_FOUND" };
  }
  const status = effect.outcomeStatus;
  if (status === null) {
    return request.block === null ? { kind: "NO_OUTCOME" } : { kind: "BLOCK_REFUSED" };
  }
  const recordedAt = effect.outcomeRecordedAt;
  if (recordedAt === null || effect.outcomeContractVersion === null) {
    throw new LedgerIntegrityError(["an effect's outcome is recorded without its instant or its contract version"]);
  }
  if (status === "OUTCOME_UNKNOWN" || status === "CANCELLED") {
    return request.block === null ? { kind: status, outcomeRecordedAt: recordedAt } : { kind: "BLOCK_REFUSED" };
  }
  const reference = effect.resultArtifactReferenceId;
  const sha256 = effect.resultSha256;
  if ((reference === null) !== (sha256 === null)) {
    throw new LedgerIntegrityError(["an effect's result pair is recorded half: a reference without a digest, or the reverse"]);
  }
  if (reference === null || sha256 === null) {
    const preResult = PRE_RESULT_REFERENCE_CONTRACT_VERSIONS.includes(effect.outcomeContractVersion);
    if (status === "SUCCEEDED" && !preResult) {
      throw new LedgerIntegrityError(["a current-cohort SUCCEEDED names no result; the ledger's own triggers forbid it"]);
    }
    if (request.block !== null) return { kind: "BLOCK_REFUSED" };
    return {
      kind: "NO_RESULT_RECORDED",
      status,
      outcomeRecordedAt: recordedAt,
      cohort: preResult ? "PRE_RESULT" : "CURRENT",
    };
  }

  const read = readByReference(ledger, { artifactReferenceId: reference, scopeKind: "TASK", scopeId: request.taskId });
  if (read.verb !== "READ") return unreadable(read.refusal);
  // Before the digest and before a byte is decoded: this read serves model output
  // alone. The ledger's door already refuses a pair of another class at append,
  // so this line is the reader's own hold on the same rule, not its only guard.
  if (read.reference.artifactClass !== "RESPONSE") return unreadable("CLASS_REFUSED");
  if (read.reference.contentSha256 !== sha256) return unreadable("DIGEST_MISMATCH");
  const text = decodeStrict(read.content);
  if (text === null) return unreadable("DOCUMENT_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable("DOCUMENT_INVALID");
  }
  const admitted = ResultContractSchema.safeParse(parsed);
  if (!admitted.success) return unreadable("DOCUMENT_INVALID");
  const document: ResultContract = admitted.data;
  if (document.effectId !== request.effectId || document.status !== status) {
    return unreadable("DOCUMENT_DISAGREES");
  }

  let block: EffectResultBlock | null = null;
  if (request.block !== null) {
    const chosen = document.blocks[request.block];
    if (chosen?.artifactRefId === undefined || chosen.artifactRefId === null) {
      return { kind: "BLOCK_REFUSED" };
    }
    const bytes = readByReference(ledger, {
      artifactReferenceId: chosen.artifactRefId,
      scopeKind: "TASK",
      scopeId: request.taskId,
    });
    if (bytes.verb !== "READ") return unreadable(bytes.refusal);
    // The door checks the pair's class and never a document's content, so this is
    // the one place a block naming another class -- the task's own envelope, say --
    // is stopped before its bytes are served (C1).
    if (bytes.reference.artifactClass !== "RESPONSE") return unreadable("CLASS_REFUSED");
    // The plane verified the bytes against its reference's digest on the way out;
    // what is left is whether that reference is the one the document declares.
    if (bytes.reference.contentSha256 !== chosen.contentSha256 || bytes.content.byteLength !== chosen.byteLength) {
      return unreadable("BLOCK_DISAGREES");
    }
    const blockText = decodeStrict(bytes.content);
    if (blockText === null) return unreadable("BLOCK_DISAGREES");
    block = {
      index: request.block,
      artifactReferenceId: chosen.artifactRefId,
      contentSha256: chosen.contentSha256,
      byteLength: chosen.byteLength,
      mediaType: chosen.mediaType,
      text: blockText,
    };
  }

  return {
    kind: "RESULT",
    status,
    outcomeRecordedAt: recordedAt,
    resultSha256: sha256,
    artifactReferenceId: reference,
    document,
    block,
  };
}

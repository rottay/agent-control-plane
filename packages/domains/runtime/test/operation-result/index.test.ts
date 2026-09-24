import { createHash } from "node:crypto";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTENT_ARTIFACT_MAX_BYTES,
  CONTENT_INLINE_TEXT_MAX_CHARS,
  CONTRACT_VERSION,
  RESULT_BLOCK_LIST_MAX,
  ResultContractSchema,
} from "@acp/contracts";
import type { ExecutionEvent, ResolvedRoute, TaskState } from "@acp/contracts";
import * as ledgerModule from "@acp/ledger";
import {
  ARTIFACT_PLANE_REFUSALS,
  LedgerIntegrityError,
  LedgerValidationError,
  PRE_RESULT_REFERENCE_CONTRACT_VERSIONS,
  REFERENCE_READ_ROOT_REFUSALS,
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  canonicalJsonStringify,
  effectIdV1,
  effectIdempotencyKeyV1,
  logicalOperationSha256,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  requestSha256,
  sha256Hex,
} from "@acp/ledger";
import type { ArtifactPlane, ArtifactPlaneTestFaults, EffectReadModel, Ledger, ReferenceReadOutcome } from "@acp/ledger";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ATTEMPT_OPENING_STEP, buildPromptOccurrenceEvent, buildResponseOccurrenceEvent } from "../../src/core/events/index.js";
import { LIFECYCLE_PLAN, planStep } from "../../src/core/lifecycle/index.js";
import { appendPlanStep } from "../../src/core/step-executor/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import { deriveEventCoordinate, deterministicUuid } from "../../src/core/coordinates/index.js";
import type { DurableInvocation, InvocationRevision } from "../../src/contracts/index.js";
import { deriveInvocation } from "../../src/submission/index.js";
import { removeScenarioRoot, resolveScenarioRoot, scenarioLedgerPath } from "../../src/toy/repository/index.js";
import {
  OPERATION_DECISION_REASONS,
  OUTPUT_CONDITIONS,
  OperationResultError,
  assembleResult,
  chunkOutput,
  completeOverflow,
  decideOperationOutcome,
  operationFactsOf,
  publishResult,
  readEffectResult,
  resultIdempotencyKeys,
} from "../../src/operation-result/index.js";
import type {
  ArtifactIdentities,
  EffectResultReading,
  EffectResultUnreadable,
  OperationFacts,
  PublishedResult,
  ResultAssembly,
  ResultSample,
} from "../../src/operation-result/index.js";

// The ledger's own comparison, wrapped so one test can prove the publisher's verdict
// comes from it (N-P07D-19″). Every other test runs the real function through the
// wrapper.
vi.mock("@acp/ledger", async (importOriginal) => {
  const original = await importOriginal<typeof ledgerModule>();
  return {
    ...original,
    effectOutcomeArrival: vi.fn(original.effectOutcomeArrival),
    // P-15/F: the reader by reference, wrapped for the refusals no real plane can be
    // made to give on demand (N-F-17, N-F-18 and the invalid-document rows); every
    // other test runs the real function through it.
    readByReference: vi.fn(original.readByReference),
  };
});

/**
 * An operation's result (P-07 escalón D, ADR 0100).
 *
 * The decider and the assembler are pure and drilled by table. The publisher runs
 * against a real ledger and a real private plane, and every outcome the drills
 * append goes through the ledger's own door: nothing here stands in for the rule
 * it is testing.
 */

const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const V2_AT = "2026-09-23T12:00:00.000Z";
const SCOPE = "run";
const STEP_KEY = "compose-answer";
const NEUTRAL_REQUEST = { operation: "compose", inputs: ["a", "b"] };
const EFFECT = "e".repeat(64);

const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-09-23T11:00:00.000Z",
};

const scenarios: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      // already closed
    }
  }
  for (const id of scenarios.splice(0)) removeScenarioRoot(id);
  vi.mocked(ledgerModule.effectOutcomeArrival).mockClear();
  vi.mocked(ledgerModule.readByReference).mockReset();
  vi.mocked(ledgerModule.readByReference).mockImplementation(realReadByReference);
});

// ---------------------------------------------------------------------------
// Facts and samples
// ---------------------------------------------------------------------------

function facts(overrides: Partial<OperationFacts> = {}): OperationFacts {
  return { terminal: "completed", process: { kind: "EXITED", exitCode: 0, signal: null }, operation: "SUCCEEDED", ...overrides };
}

function sample(output: string, overrides: Partial<ResultSample> = {}): ResultSample {
  return { operationIndex: 0, facts: facts(), output, outputCondition: "HELD", ...overrides };
}

function documentOf(assembly: ResultAssembly): Extract<ResultAssembly, { kind: "DOCUMENT" }> {
  if (assembly.kind !== "DOCUMENT") throw new Error("expected a document, got " + assembly.kind);
  return assembly;
}

describe("the three facts are read by kind, and nothing is defaulted", () => {
  it("an absent process or operation fact is NOT_OBSERVABLE, never exit 0 or success", () => {
    expect(operationFactsOf([{ kind: "completed", stepIndex: 0 }])).toEqual({
      terminal: "completed",
      process: { kind: "NOT_OBSERVABLE" },
      operation: "NOT_OBSERVABLE",
    });
    expect(operationFactsOf([])).toEqual({ terminal: "none", process: { kind: "NOT_OBSERVABLE" }, operation: "NOT_OBSERVABLE" });
    // A state token is never a verdict: a failed operation reported "SUCCESS".
    expect(operationFactsOf([{ kind: "state", toState: "SUCCESS" }, { kind: "completed", stepIndex: 0 }]).operation).toBe("NOT_OBSERVABLE");
  });

  it("carries each fact as reported, a signal with its null exit code", () => {
    const trail: ExecutionEvent[] = [
      { kind: "processExited", exitCode: null, signal: "SIGKILL" },
      { kind: "operationResult", status: "FAILED" },
      { kind: "error", refusal: "TRANSPORT_UNAVAILABLE", detail: "x" },
    ];
    expect(operationFactsOf(trail)).toEqual({
      terminal: "error",
      process: { kind: "EXITED", exitCode: null, signal: "SIGKILL" },
      operation: "FAILED",
    });
  });

  it("N-P07D-17/18: a second terminal, exit or verdict is refused rather than overwritten", () => {
    const completed: ExecutionEvent = { kind: "completed", stepIndex: 0 };
    const exited: ExecutionEvent = { kind: "processExited", exitCode: 0, signal: null };
    const verdict: ExecutionEvent = { kind: "operationResult", status: "SUCCEEDED" };
    for (const trail of [[completed, completed], [exited, exited, completed], [verdict, verdict, completed]]) {
      expect(() => operationFactsOf(trail)).toThrow(OperationResultError);
    }
  });
});

describe("P-P07D-1: one decider, over every row", () => {
  it("decides only a completed terminal; error and none are not decided", () => {
    expect(decideOperationOutcome(facts({ terminal: "error" }))).toEqual({ decided: false });
    expect(decideOperationOutcome(facts({ terminal: "none" }))).toEqual({ decided: false });
  });

  it("the table: FAILED always fails; SUCCEEDED needs a clean or unobservable exit; no verdict fails", () => {
    const rows: readonly (readonly [OperationFacts, string, string])[] = [
      [facts({ operation: "FAILED" }), "FAILED", "OPERATION_FAILED"],
      [facts({ operation: "FAILED", process: { kind: "EXITED", exitCode: 1, signal: null } }), "FAILED", "OPERATION_FAILED"],
      [facts(), "SUCCEEDED", "OPERATION_SUCCEEDED"],
      [facts({ process: { kind: "NOT_OBSERVABLE" } }), "SUCCEEDED", "OPERATION_SUCCEEDED"],
      [facts({ process: { kind: "EXITED", exitCode: 1, signal: null } }), "FAILED", "PROCESS_ABNORMAL"],
      [facts({ process: { kind: "EXITED", exitCode: null, signal: "SIGTERM" } }), "FAILED", "PROCESS_ABNORMAL"],
      [facts({ operation: "NOT_OBSERVABLE" }), "FAILED", "OPERATION_NOT_OBSERVED"],
      [facts({ operation: "NOT_OBSERVABLE", process: { kind: "NOT_OBSERVABLE" } }), "FAILED", "OPERATION_NOT_OBSERVED"],
    ];
    for (const [input, status, reason] of rows) {
      expect(decideOperationOutcome(input), JSON.stringify(input)).toEqual({ decided: true, status, reason });
    }
  });

  it("the vocabularies are closed and sorted", () => {
    expect([...OPERATION_DECISION_REASONS]).toEqual([...OPERATION_DECISION_REASONS].sort());
    expect(OPERATION_DECISION_REASONS).toHaveLength(8);
    expect([...OUTPUT_CONDITIONS]).toEqual(["HELD", "OVER_PROFILE", "UNREADABLE"]);
  });
});

describe("P-P07D-2: the assembler under the C4 rule", () => {
  it("chunks at 4 000 UTF-16 units, and never splits a surrogate pair", () => {
    expect(chunkOutput("x")).toEqual(["x"]);
    expect(chunkOutput("x".repeat(CONTENT_INLINE_TEXT_MAX_CHARS))).toHaveLength(1);
    expect(chunkOutput("x".repeat(CONTENT_INLINE_TEXT_MAX_CHARS + 1)).map((chunk) => chunk.length)).toEqual([4_000, 1]);
    // An astral character whose high surrogate would sit at unit 4 000 moves whole.
    const astral = "x".repeat(CONTENT_INLINE_TEXT_MAX_CHARS - 1) + "\u{1F600}" + "y";
    const chunks = chunkOutput(astral);
    expect(chunks.map((chunk) => chunk.length)).toEqual([3_999, 3]);
    expect(chunks.join("")).toBe(astral);
    expect(chunks[1]?.startsWith("\u{1F600}")).toBe(true);
  });

  it("one text block per chunk, in order, each with all nine keys and null where the rule says", () => {
    const output = "a".repeat(CONTENT_INLINE_TEXT_MAX_CHARS) + "b";
    const assembled = documentOf(assembleResult(EFFECT, sample(output)));
    expect(assembled.status).toBe("SUCCEEDED");
    expect(assembled.document.usageReference).toBe(EFFECT);
    expect(assembled.document.effectId).toBe(EFFECT);
    expect(assembled.document.blocks.map((block) => block.blockId)).toEqual(["output-001", "output-002"]);
    expect(assembled.document.blocks.map((block) => block.text).join("")).toBe(output);
    for (const block of assembled.document.blocks) {
      expect(Object.keys(block).sort()).toEqual([
        "artifactRefId", "blockId", "byteLength", "contentSha256", "effectId", "kind", "mediaType", "text", "toolCallId",
      ]);
      expect([block.artifactRefId, block.toolCallId, block.effectId]).toEqual([null, null, null]);
      expect(block.byteLength).toBe(Buffer.byteLength(block.text ?? "", "utf8"));
      expect(block.contentSha256).toBe(createHash("sha256").update(block.text ?? "", "utf8").digest("hex"));
    }
    // The canonical bytes are the document, and the digest is theirs.
    expect(createHash("sha256").update(assembled.bytes).digest("hex")).toBe(assembled.sha256);
    expect(ResultContractSchema.safeParse(JSON.parse(assembled.bytes.toString("utf8"))).success).toBe(true);
  });

  it("a hundred chunks are text; a hundred and one become one markdown document by reference, never both", () => {
    const hundred = "z".repeat(CONTENT_INLINE_TEXT_MAX_CHARS * RESULT_BLOCK_LIST_MAX);
    expect(documentOf(assembleResult(EFFECT, sample(hundred))).document.blocks).toHaveLength(100);
    const overflow = assembleResult(EFFECT, sample(hundred + "!"));
    expect(overflow.kind).toBe("OVERFLOW");
    if (overflow.kind !== "OVERFLOW") return;
    const completed = documentOf(completeOverflow(overflow, "ref-overflow-1"));
    expect(completed.document.blocks).toEqual([
      {
        kind: "document",
        blockId: "output-001",
        mediaType: "text/markdown; charset=utf-8",
        byteLength: hundred.length + 1,
        contentSha256: overflow.overflowSha256,
        artifactRefId: "ref-overflow-1",
        text: null,
        toolCallId: null,
        effectId: null,
      },
    ]);
  });

  it("N-P07D-2: SUCCEEDED with no output is FAILED with no document, never a SUCCEEDED with zero blocks", () => {
    expect(assembleResult(EFFECT, sample(""))).toEqual({ kind: "NO_DOCUMENT", status: "FAILED", reason: "NO_OUTPUT" });
    // A FAILED operation that said nothing keeps its own reason.
    expect(assembleResult(EFFECT, sample("", { facts: facts({ operation: "FAILED" }) }))).toEqual({
      kind: "NO_DOCUMENT",
      status: "FAILED",
      reason: "OPERATION_FAILED",
    });
  });

  it("N-P07D-5, 27, 28: output that is not whole assembles nothing, and is never truncated", () => {
    expect(assembleResult(EFFECT, sample("", { outputCondition: "OVER_PROFILE" }))).toEqual({
      kind: "NO_DOCUMENT",
      status: "FAILED",
      reason: "OUTPUT_OVER_PROFILE",
    });
    expect(assembleResult(EFFECT, sample("partial", { outputCondition: "UNREADABLE" }))).toEqual({
      kind: "NO_DOCUMENT",
      status: "FAILED",
      reason: "OUTPUT_UNREADABLE",
    });
    // Held but over the profile — a caller that skipped the collector — is refused too.
    expect(assembleResult(EFFECT, sample("x".repeat(CONTENT_ARTIFACT_MAX_BYTES + 1)))).toEqual({
      kind: "NO_DOCUMENT",
      status: "FAILED",
      reason: "OUTPUT_OVER_PROFILE",
    });
  });

  it("N-P07D-6: credential-shaped output is refused whole, in text blocks and in an overflow", () => {
    const secret = "sk-ant-api03-" + "A".repeat(32);
    expect(assembleResult(EFFECT, sample("the key is " + secret))).toEqual({
      kind: "NO_DOCUMENT",
      status: "FAILED",
      reason: "OUTPUT_REFUSED",
    });
    const overflow = "z".repeat(CONTENT_INLINE_TEXT_MAX_CHARS * RESULT_BLOCK_LIST_MAX) + " " + secret;
    expect(assembleResult(EFFECT, sample(overflow))).toEqual({ kind: "NO_DOCUMENT", status: "FAILED", reason: "OUTPUT_REFUSED" });
    // A credential cut in two by a chunk boundary matches neither block alone; the
    // whole output is what the guard reads.
    const straddling = "z".repeat(CONTENT_INLINE_TEXT_MAX_CHARS - 20) + " " + secret;
    expect(chunkOutput(straddling).some((chunk) => chunk.includes(secret))).toBe(false);
    expect(assembleResult(EFFECT, sample(straddling))).toEqual({ kind: "NO_DOCUMENT", status: "FAILED", reason: "OUTPUT_REFUSED" });
  });

  it("Q-D9: a FAILED operation with output gets its document, status FAILED", () => {
    const assembled = documentOf(assembleResult(EFFECT, sample("boom", { facts: facts({ operation: "FAILED" }) })));
    expect(assembled.status).toBe("FAILED");
    expect(assembled.document.status).toBe("FAILED");
    expect(assembled.document.blocks.map((block) => block.text)).toEqual(["boom"]);
  });

  it("refuses to assemble an execution that did not complete", () => {
    expect(() => assembleResult(EFFECT, sample("x", { facts: facts({ terminal: "error" }) }))).toThrow(OperationResultError);
  });
});

// ---------------------------------------------------------------------------
// The publisher, against a real ledger and a real plane
// ---------------------------------------------------------------------------

function revisionFor(taskId: string): InvocationRevision {
  return {
    revisionId: deterministicUuid("revision/" + taskId + "/1"),
    revisionNumber: 1,
    attemptNumber: 1,
    envelopeSha256: "e".repeat(64),
    envelopeArtifactReferenceId: "ref-envelope-" + taskId,
  };
}

/** Register the task's envelope reference, as a fixture (the usage suite's, restated). */
/**
 * The fixture price catalog a delivery is pinned to (P-15 escalón C, ADR 0103).
 *
 * From 2.9.0 a `DISPATCH_INTENDED` names the catalog version in force at its
 * instant, and one that covers its segment, or the door refuses it: pre-2.9.0
 * fixtures had to gain a pin because the version in force now requires one. So the
 * fixture publishes one through the registry's own door — the segment's model
 * version registered under its provider, then version 1 of a `PRICE_TABLE` pricing
 * that model on the segment's transport from before any fixture instant, with no
 * end. The price is fixture data, and never zero.
 */
const FIXTURE_CATALOG = "catalog-fixture";
const FIXTURE_MODEL_VERSION = "claude-opus-5-20260101";
const FIXTURE_CATALOG_FROM = "2026-01-01T00:00:00.000Z";
const FIXTURE_PIN = { catalogDocumentId: FIXTURE_CATALOG, catalogVersion: 1 } as const;

function plantFixtureCatalog(ledger: Ledger): void {
  if (ledger.getVigentCatalogPin(FIXTURE_CATALOG, FIXTURE_CATALOG_FROM) !== null) return;
  const document = (
    eventId: string,
    documentKind: string,
    documentId: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId,
    idempotencyKey: documentId + "/1",
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    // The payload's own digest, which the registry door verifies (P-15/R, ADR 0104).
    contentDigest: sha256Hex(canonicalJsonStringify(payload)),
    recordedBy: "kimi/k3/coordinator/01",
    effectiveFrom: FIXTURE_CATALOG_FROM,
    occurredAt: FIXTURE_CATALOG_FROM,
    recordedAt: FIXTURE_CATALOG_FROM,
    payload,
  });
  ledger.appendRegistryEvent(
    document("c0c0c0c0-0000-4000-8000-00000000c001", "MODEL_VERSION", FIXTURE_MODEL_VERSION, {
      provider: "anthropic",
      model: "claude-opus-5",
      release: "2026-01-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["coordinator", "implementer", "reviewer", "consultant", "verifier"],
      transports: ["CLI_SUBSCRIPTION"],
    }),
  );
  ledger.appendRegistryEvent(
    document("c0c0c0c0-0000-4000-8000-00000000c002", "PRICE_TABLE", FIXTURE_CATALOG, {
      intervals: [
        {
          provider: "anthropic",
          modelVersionId: FIXTURE_MODEL_VERSION,
          transportKind: "CLI_SUBSCRIPTION",
          tokenClass: "input",
          currency: "USD",
          effectiveFrom: FIXTURE_CATALOG_FROM,
          effectiveTo: null,
          pricePerMillionNanos: 15_000_000_000,
        },
      ],
    }),
  );
}

function plantEnvelopeReference(ledger: Ledger, taskId: string): void {
  const reference = "ref-envelope-" + taskId;
  const content = "7".repeat(64);
  const envelope = (kind: string, ordinal: number, payload: Record<string, unknown>): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId: deterministicUuid("envelope/" + taskId + "/" + kind),
    idempotencyKey: "envelope/" + taskId + "/" + kind,
    subjectKind: "ARTIFACT",
    artifactEventKind: kind,
    subjectOrdinal: ordinal,
    parentSubjectOrdinal: ordinal === 1 ? null : ordinal - 1,
    recordedBy: EMITTED_BY,
    occurredAt: V2_AT,
    recordedAt: V2_AT,
    payload,
  });
  const common = { commandId: "cmd-envelope", contentSha256: content, blobGeneration: 1, artifactPinId: "pin-envelope" };
  ledger.appendArtifactEvent(
    envelope("PUBLICATION_INTENDED", 1, {
      ...common,
      mediaType: "application/json",
      sizeBytes: 128,
      encryptionStatus: "PLAINTEXT",
      keyReference: null,
      encryptionProfile: "local-plaintext-v1",
    }),
  );
  ledger.appendArtifactEvent(
    envelope("PUBLICATION_SUCCEEDED", 2, {
      ...common,
      reference: {
        artifactReferenceId: reference,
        artifactClass: "TASK_ENVELOPE",
        classification: "INTERNAL",
        scopeKind: "TASK",
        scopeId: taskId,
        producerIdentity: EMITTED_BY,
        accessPolicyId: "SCOPE_EQUALITY_V1",
        retentionClass: "STANDARD",
        expiresAt: "2026-12-31T00:00:00.000Z",
      },
    }),
  );
}

function segmentRecord(): Record<string, unknown> {
  return {
    routeSegmentId: "seg-1",
    segmentNumber: 1,
    provider: "anthropic",
    model: "claude-opus-5",
    modelResolutionStatus: "RESOLVED",
    modelVersionId: "claude-opus-5-20260101",
    accountId: "acct-1",
    transportKind: "CLI_SUBSCRIPTION",
    capabilityPolicyVersion: "policy-1",
  };
}

function executionEvent(
  ledger: Ledger,
  invocation: DurableInvocation,
  transitionId: string,
  type: "EFFECT_INTENDED" | "DISPATCH_INTENDED" | "DISPATCH_OUTCOME_RECORDED",
  record: Record<string, unknown>,
): Record<string, unknown> {
  const revision = invocation.revision;
  if (revision === undefined) throw new Error("an execution event needs the walk's revision");
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  const state = ledger.getTask(invocation.taskId)?.currentState ?? null;
  return {
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type,
    fromState: state,
    toState: state,
    emittedBy: EMITTED_BY,
    occurredAt: V2_AT,
    recordedAt: V2_AT,
    correlationId: invocation.invocationId,
    causationId: null,
    payload: { revisionNumber: revision.revisionNumber, attemptNumber: revision.attemptNumber, ...record },
  };
}

interface World {
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  readonly ledgerPath: string;
  readonly invocation: DurableInvocation;
  readonly effectId: string;
  readonly taskId: string;
}

/** A V2 attempt with its first effect intended and delivered, and a plane over the same ledger. */
function world(name: string, faults: ArtifactPlaneTestFaults = {}): World {
  scenarios.push(name);
  const root = resolveScenarioRoot(name);
  const ledgerPath = scenarioLedgerPath(root);
  const ledger = openLedger(ledgerPath);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledgerPath), {
    incarnationId: "11111111-1111-4111-8111-111111111111",
    createdAt: V2_AT,
  });
  closers.push(() => { ledger.close(); });
  closers.push(() => { leaseStore.close(); });
  const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath, __testFaults: faults });
  const taskId = deterministicUuid("operation-result/" + name);
  plantEnvelopeReference(ledger, taskId);
  plantFixtureCatalog(ledger);
  const invocation = deriveInvocation(taskId, 1, V2_AT, "c".repeat(64), revisionFor(taskId));
  const context: BeatContext = {
    ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("DONE") },
    invocation,
    emittedBy: EMITTED_BY,
    plan: LIFECYCLE_PLAN,
    route: TEST_ROUTE,
    initiativeId: INITIATIVE_ID,
  };
  appendPlanStep(context, ATTEMPT_OPENING_STEP);
  appendPlanStep(context, planStep(0));
  const coordinate = { taskId, revisionNumber: 1, attemptNumber: 1, segmentNumber: 1, operationOrdinal: 0 };
  const envelopeSha256 = invocation.revision?.envelopeSha256 ?? "";
  const effectId = effectIdV1(coordinate);
  ledger.append(
    executionEvent(ledger, invocation, "effect-1", "EFFECT_INTENDED", {
      segment: segmentRecord(),
      effect: {
        effectId,
        operationOrdinal: 0,
        effectKind: "model_execution",
        semanticScopeKey: SCOPE,
        localOperationKey: STEP_KEY,
        logicalOperationSha256: logicalOperationSha256({ invocationId: invocation.invocationId, semanticScopeKey: SCOPE, localOperationKey: STEP_KEY }),
        requestContractVersion: "1",
        requestSha256: requestSha256({ effectKind: "model_execution", requestContractVersion: "1", envelopeSha256, neutralRequest: NEUTRAL_REQUEST }),
        idempotencyKey: effectIdempotencyKeyV1({ ...coordinate, effectKind: "model_execution", envelopeSha256 }),
      },
    }),
  );
  ledger.append(
    executionEvent(ledger, invocation, "dispatch-1", "DISPATCH_INTENDED", {
      segment: segmentRecord(),
      dispatch: { dispatchAttemptId: "dsp-1", effectId, attemptOrdinal: 1, ...FIXTURE_PIN },
    }),
  );
  return { ledger, plane, ledgerPath, invocation, effectId, taskId };
}

function identities(role: string): ArtifactIdentities {
  return {
    artifactReferenceId: "ref-" + role,
    commandId: "cmd-" + role,
    artifactPinId: "pin-" + role,
    intentionEventId: deterministicUuid("intention/" + role),
    terminalEventId: deterministicUuid("terminal/" + role),
  };
}

function publish(w: World, assembly: ResultAssembly, suffix = ""): PublishedResult {
  return publishResult({
    ledger: w.ledger,
    plane: w.plane,
    effectId: w.effectId,
    taskId: w.taskId,
    recordedBy: EMITTED_BY,
    recordedAt: V2_AT,
    holderPid: process.pid,
    result: identities("result" + suffix),
    overflow: identities("overflow" + suffix),
    assembly,
  });
}

/** The outcome, appended through the ledger's own door with whatever pair the publisher returned. */
function outcomeEvent(w: World, transitionId: string, published: Pick<PublishedResult, "status" | "resultArtifactReferenceId" | "resultSha256">): Record<string, unknown> {
  return executionEvent(w.ledger, w.invocation, transitionId, "DISPATCH_OUTCOME_RECORDED", {
    outcome: {
      dispatchAttemptId: "dsp-1",
      dispatchState: "SETTLED",
      terminalAt: V2_AT,
      effectOutcomeStatus: published.status,
      ...(published.resultArtifactReferenceId === null
        ? {}
        : { resultArtifactReferenceId: published.resultArtifactReferenceId, resultSha256: published.resultSha256 }),
    },
  });
}

describe("P-P07D-3: the publisher puts the result on the private side before anything references it", () => {
  it("publishes a RESPONSE of this task whose bytes are the result document, and the door admits the pair", () => {
    const w = world("p07d-publish");
    const published = publish(w, assembleResult(w.effectId, sample("ok")));
    if (published.resultArtifactReferenceId === null) throw new Error("expected a pair");
    const reference = w.ledger.getArtifactReference(published.resultArtifactReferenceId);
    expect(reference).toMatchObject({ artifactClass: "RESPONSE", scopeKind: "TASK", scopeId: w.taskId, contentSha256: published.resultSha256 });
    const read = w.plane.read({ artifactReferenceId: published.resultArtifactReferenceId, scopeKind: "TASK", scopeId: w.taskId });
    if (read.verb !== "READ") throw new Error("expected the bytes");
    expect(createHash("sha256").update(read.content).digest("hex")).toBe(published.resultSha256);
    expect(read.content.byteLength).toBe(published.responseBytes);
    const parsed = ResultContractSchema.parse(JSON.parse(read.content.toString("utf8")));
    expect(parsed.blocks.map((block) => block.text)).toEqual(["ok"]);
    expect(parsed.status).toBe("SUCCEEDED");

    expect(w.ledger.append(outcomeEvent(w, "settle-1", published)).inserted).toBe(true);
    expect(w.ledger.getEffect(w.effectId)).toMatchObject({
      outcomeStatus: "SUCCEEDED",
      resultArtifactReferenceId: published.resultArtifactReferenceId,
      resultSha256: published.resultSha256,
    });
    expect(w.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-P07D-7: the same result again is a replay — the ledger's comparison says so, and nothing is published twice", () => {
    const w = world("p07d-replay");
    const assembly = assembleResult(w.effectId, sample("ok"));
    const first = publish(w, assembly);
    w.ledger.append(outcomeEvent(w, "settle-1", first));
    const before = w.ledger.listArtifactEvents(documentOf(assembly).sha256).length;
    vi.mocked(ledgerModule.effectOutcomeArrival).mockClear();
    const again = publish(w, assembly, "-again");
    expect(again).toEqual(first);
    expect(w.ledger.listArtifactEvents(documentOf(assembly).sha256)).toHaveLength(before);
    expect(vi.mocked(ledgerModule.effectOutcomeArrival).mock.results.map((result): unknown => result.value)).toEqual([{ kind: "replay" }]);
    // And the door agrees: the same outcome appended again is admitted as no change.
    expect(w.ledger.append(outcomeEvent(w, "settle-again", again)).inserted).toBe(true);
  });

  it("N-P07D-8, N-P07D-19′: a different result for an ended effect is refused in the door's own words, before a byte moves", () => {
    const w = world("p07d-conflict");
    const first = publish(w, assembleResult(w.effectId, sample("first answer")));
    w.ledger.append(outcomeEvent(w, "settle-1", first));
    const other = documentOf(assembleResult(w.effectId, sample("second answer")));
    let refusal: unknown = null;
    try {
      publish(w, other, "-other");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(OperationResultError);
    const runtime = refusal as OperationResultError;
    expect(runtime.code).toBe("CONFLICT");
    expect(runtime.path).toBe("payload.outcome.resultSha256");
    expect(w.ledger.listArtifactEvents(other.sha256)).toHaveLength(0);

    // The same arrival — stored reference X, digest Y — never reaches the door's
    // comparison: the door first asks that X hold Y's bytes, and refuses there.
    const literal = { status: "SUCCEEDED" as const, resultArtifactReferenceId: first.resultArtifactReferenceId, resultSha256: other.sha256 };
    expect(() => w.ledger.append(outcomeEvent(w, "settle-literal", literal))).toThrow(LedgerValidationError);

    // The nearest arrival the door can compare puts Y on the private side under its
    // own reference Z: the spy answers `write` once, and the publisher's own
    // publication runs. The door's comparison then refuses it at the first member
    // that differs, the reference, in the words the runtime used for the digest.
    vi.mocked(ledgerModule.effectOutcomeArrival).mockReturnValueOnce({ kind: "write" });
    const forced = publish(w, other, "-forced");
    expect(forced.resultSha256).toBe(other.sha256);
    let door: { path: string; message: string } | undefined;
    try {
      w.ledger.append(outcomeEvent(w, "settle-other", forced));
    } catch (error) {
      door = (error as LedgerValidationError).issues[0];
    }
    expect(door).toEqual({
      path: "payload.outcome.resultArtifactReferenceId",
      message: runtime.message.replace("another result digest", "another result reference"),
    });
  });

  it("N-P07D-19″: the publisher's verdict is the ledger's function's, not a copy of it", () => {
    const w = world("p07d-provenance");
    vi.mocked(ledgerModule.effectOutcomeArrival).mockReturnValueOnce({ kind: "refused", path: "payload.outcome.spy", message: "the spy refused" });
    const assembly = assembleResult(w.effectId, sample("ok"));
    expect(() => publish(w, assembly)).toThrow("the spy refused");
    expect(w.ledger.listArtifactEvents(documentOf(assembly).sha256)).toHaveLength(0);
  });

  it("refuses a result for an effect the ledger does not hold", () => {
    const w = world("p07d-unknown");
    let refusal: unknown = null;
    try {
      publishResult({
        ledger: w.ledger,
        plane: w.plane,
        effectId: "f".repeat(64),
        taskId: w.taskId,
        recordedBy: EMITTED_BY,
        recordedAt: V2_AT,
        holderPid: process.pid,
        result: identities("result"),
        overflow: identities("overflow"),
        assembly: assembleResult(w.effectId, sample("ok")),
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(OperationResultError);
    expect((refusal as OperationResultError).code).toBe("EFFECT_UNKNOWN");
  });

  it("N-P07D-22: no document means no pair — all three null together — and the door admits FAILED without one", () => {
    const w = world("p07d-no-pair");
    const published = publish(w, assembleResult(w.effectId, sample("")));
    expect(published).toEqual({ status: "FAILED", reason: "NO_OUTPUT", resultArtifactReferenceId: null, resultSha256: null, responseBytes: null });
    expect(w.ledger.append(outcomeEvent(w, "settle-1", published)).inserted).toBe(true);
    expect(w.ledger.getEffect(w.effectId)).toMatchObject({ outcomeStatus: "FAILED", resultArtifactReferenceId: null, resultSha256: null });
  });

  it("N-P07D-21 (Q-D9): a FAILED operation with output publishes its document and the door admits FAILED with the pair", () => {
    const w = world("p07d-failed-with-output");
    const published = publish(w, assembleResult(w.effectId, sample("boom", { facts: facts({ operation: "FAILED" }) })));
    expect(published.status).toBe("FAILED");
    expect(published.resultArtifactReferenceId).not.toBeNull();
    w.ledger.append(outcomeEvent(w, "settle-1", published));
    expect(w.ledger.getEffect(w.effectId)?.resultSha256).toBe(published.resultSha256);
  });

  it("N-P07D-25: no SUCCEEDED path of the publisher returns a SUCCEEDED without its pair", () => {
    const w = world("p07d-never-bare");
    for (const output of ["ok", "", "sk-ant-api03-" + "B".repeat(32)]) {
      const published = publish(w, assembleResult(w.effectId, sample(output)), "-" + String(output.length));
      if (published.status === "SUCCEEDED") {
        expect(published.resultArtifactReferenceId).not.toBeNull();
        expect(published.resultSha256).not.toBeNull();
      }
    }
  });

  it("an overflowing answer publishes its markdown artifact first, and the document names it", () => {
    const w = world("p07d-overflow");
    const output = "z".repeat(CONTENT_INLINE_TEXT_MAX_CHARS * RESULT_BLOCK_LIST_MAX) + "!";
    const assembly = assembleResult(w.effectId, sample(output));
    if (assembly.kind !== "OVERFLOW") throw new Error("expected an overflow");
    const published = publish(w, assembly);
    if (published.resultArtifactReferenceId === null) throw new Error("expected a pair");
    const document = w.plane.read({ artifactReferenceId: published.resultArtifactReferenceId, scopeKind: "TASK", scopeId: w.taskId });
    if (document.verb !== "READ") throw new Error("expected the document");
    const parsed = ResultContractSchema.parse(JSON.parse(document.content.toString("utf8")));
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.kind).toBe("document");
    const overflow = w.plane.read({ artifactReferenceId: parsed.blocks[0]?.artifactRefId ?? "", scopeKind: "TASK", scopeId: w.taskId });
    if (overflow.verb !== "READ") throw new Error("expected the overflow");
    expect(overflow.content.toString("utf8")).toBe(output);
    expect(overflow.reference.artifactClass).toBe("RESPONSE");
    w.ledger.append(outcomeEvent(w, "settle-1", published));
    expect(w.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("D-P07D-6: a crash after the intention resumes under the same keys, with one reference and no second generation", () => {
    const name = "p07d-resume";
    const crashing = world(name, {
      afterIntentionRecorded: () => {
        throw new Error("crash after the intention");
      },
    });
    const assembly = assembleResult(crashing.effectId, sample("ok"));
    expect(() => publish(crashing, assembly)).toThrow("crash after the intention");
    for (const close of closers.splice(0).reverse()) close();

    const ledger = openLedger(crashing.ledgerPath);
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(crashing.ledgerPath), {
      incarnationId: "22222222-2222-4222-8222-222222222222",
      createdAt: V2_AT,
    });
    closers.push(() => { ledger.close(); });
    closers.push(() => { leaseStore.close(); });
    const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: crashing.ledgerPath });
    const resumed = publishResult({
      ledger,
      plane,
      effectId: crashing.effectId,
      taskId: crashing.taskId,
      recordedBy: EMITTED_BY,
      recordedAt: V2_AT,
      holderPid: process.pid,
      result: identities("result-resumed"),
      overflow: identities("overflow-resumed"),
      assembly,
    });
    // The recorded intention's own reference, not the second call's.
    expect(resumed.resultArtifactReferenceId).toBe("ref-result");
    const keys = resultIdempotencyKeys(crashing.effectId, "result", documentOf(assembly).sha256);
    const events = ledger.listArtifactEvents(documentOf(assembly).sha256);
    expect(events.filter((record) => record.idempotencyKey === keys.intended)).toHaveLength(1);
    expect(events.filter((record) => record.idempotencyKey === keys.succeeded)).toHaveLength(1);
  });
});

function recordPrompt(w: World, state: TaskState): void {
  w.ledger.append(
    buildPromptOccurrenceEvent({
      invocation: w.invocation,
      state,
      emittedBy: EMITTED_BY,
      causedBy: null,
      occurrence: {
        occurrenceId: "po-1",
        dispatchAttemptId: "dsp-1",
        effectId: w.effectId,
        routeSegmentId: "seg-1",
        ordinal: 0,
        requestedModelId: "claude-opus-5",
        provider: "anthropic",
        modelResolutionStatus: "RESOLVED",
        modelVersionId: "claude-opus-5-20260101",
        accountId: "acct-1",
        promptSha256: "a".repeat(64),
        promptBytes: 12,
        contextSha256: null,
      },
    }),
  );
}

describe("the whole chain through the door: prompt, published result, outcome, response occurrence", () => {
  it("D-P07D-1 in the unit: the response occurrence records the published RESPONSE's digest and length", () => {
    const w = world("p07d-chain");
    const state = w.ledger.getTask(w.taskId)?.currentState ?? "RUNNING";
    recordPrompt(w, state);
    const published = publish(w, assembleResult(w.effectId, sample("ok")));
    if (published.resultArtifactReferenceId === null) throw new Error("expected a pair");
    w.ledger.append(outcomeEvent(w, "settle-1", published));
    w.ledger.append(
      buildResponseOccurrenceEvent({
        invocation: w.invocation,
        state,
        emittedBy: EMITTED_BY,
        causedBy: null,
        occurrence: {
          occurrenceId: "ro-1",
          promptOccurrenceId: "po-1",
          responseSha256: published.resultSha256,
          responseBytes: published.responseBytes,
          redactionVerdict: "CLEAN",
        },
      }),
    );
    expect(w.ledger.getResponseOccurrenceForPrompt("po-1")).toMatchObject({
      responseSha256: published.resultSha256,
      responseBytes: published.responseBytes,
      redactionVerdict: "CLEAN",
    });
    expect(w.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("N-P07D-14/15/16: the door refuses a response whose fields are present and wrong, never reading them as absent", () => {
    const w = world("p07d-response-fields");
    const state = w.ledger.getTask(w.taskId)?.currentState ?? "RUNNING";
    recordPrompt(w, state);
    const base = { occurrenceId: "ro-1", promptOccurrenceId: "po-1", responseSha256: "b".repeat(64), responseBytes: 10, redactionVerdict: "CLEAN" };
    const cases: readonly Record<string, unknown>[] = [
      { ...base, promptOccurrenceId: "po-unrecorded" },
      { ...base, responseSha256: "B".repeat(64) },
      { ...base, responseSha256: "b".repeat(63) },
      { ...base, responseBytes: -1 },
      { ...base, responseBytes: 1.5 },
      { ...base, redactionVerdict: "DIRTY" },
      { ...base, occurrenceId: "" },
      { ...base, promptOccurrenceId: null },
      { ...base, responseBytes: null },
    ];
    for (const occurrence of cases) {
      expect(() =>
        w.ledger.append(
          buildResponseOccurrenceEvent({
            invocation: w.invocation,
            state,
            emittedBy: EMITTED_BY,
            causedBy: null,
            occurrence: occurrence as unknown as Parameters<typeof buildResponseOccurrenceEvent>[0]["occurrence"],
          }),
        ),
        JSON.stringify(occurrence),
      ).toThrow();
    }
    // The control: the same record with every field well-formed is admitted.
    w.ledger.append(buildResponseOccurrenceEvent({ invocation: w.invocation, state, emittedBy: EMITTED_BY, causedBy: null, occurrence: { ...base, redactionVerdict: "CLEAN" } }));
    expect(w.ledger.getResponseOccurrenceForPrompt("po-1")?.occurrenceId).toBe("ro-1");
  });
});

// ---------------------------------------------------------------------------
// Reading a result back (P-15 escalón F, ADR 0107)
// ---------------------------------------------------------------------------

const realReadByReference: typeof ledgerModule.readByReference = (
  await vi.importActual<typeof ledgerModule>("@acp/ledger")
).readByReference;

/** A published result with its outcome appended through the ledger's own door. */
function settled(name: string, output: string, overrides: Partial<ResultSample> = {}): { readonly w: World; readonly published: PublishedResult } {
  const w = world(name);
  const published = publish(w, assembleResult(w.effectId, sample(output, overrides)));
  w.ledger.append(outcomeEvent(w, "settle-1", published));
  return { w, published };
}

/** The ledger, with one row answered differently; every other call reaches the real one. */
function withRow(ledger: Ledger, row: EffectReadModel | null): Ledger {
  return new Proxy(ledger, {
    get(target, key) {
      if (key === "getEffect") return () => row;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function objectPath(w: World, digest: string): string {
  return join(artifactPlaneRootFor(w.ledgerPath), digest.slice(0, 2), digest);
}

function unreadableWord(reading: EffectResultReading): string {
  if (reading.kind !== "RESULT_UNREADABLE") throw new Error("expected RESULT_UNREADABLE, got " + reading.kind);
  return reading.refusal;
}

const NINE_KEYS = ["artifactRefId", "blockId", "byteLength", "contentSha256", "effectId", "kind", "mediaType", "text", "toolCallId"];
const PADDED_ANSWER = "The answer, padded plainly. ".repeat(14_300);

describe("P-15/F: one effect's result is read back by reference, in the reader's order", () => {
  it("P-F-1: a published SUCCEEDED result is read back whole, with its digest, blocks in order and nine keys each", () => {
    const { w, published } = settled("p15f-read", "ok");
    const reading = readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null });
    if (reading.kind !== "RESULT") throw new Error("expected RESULT, got " + reading.kind);
    expect(reading.status).toBe("SUCCEEDED");
    expect(reading.outcomeRecordedAt).toBe(V2_AT);
    expect(reading.resultSha256).toBe(published.resultSha256);
    expect(reading.artifactReferenceId).toBe(published.resultArtifactReferenceId);
    expect(reading.block).toBeNull();
    const plane = w.plane.read({ artifactReferenceId: published.resultArtifactReferenceId ?? "", scopeKind: "TASK", scopeId: w.taskId });
    if (plane.verb !== "READ") throw new Error("expected the bytes");
    expect(reading.document).toEqual(ResultContractSchema.parse(JSON.parse(plane.content.toString("utf8"))));
    expect(reading.document.blocks.map((block) => block.text)).toEqual(["ok"]);
    for (const block of reading.document.blocks) expect(Object.keys(block).sort()).toEqual(NINE_KEYS);
  });

  it("P-F-2: FAILED with a document is a FAILED RESULT; FAILED with none is NO_RESULT_RECORDED of the current cohort", () => {
    const withDocument = settled("p15f-failed-doc", "boom", { facts: facts({ operation: "FAILED" }) });
    const read = readEffectResult(withDocument.w.ledger, { taskId: withDocument.w.taskId, effectId: withDocument.w.effectId, block: null });
    expect(read).toMatchObject({ kind: "RESULT", status: "FAILED" });

    const without = settled("p15f-failed-none", "");
    expect(without.published.resultArtifactReferenceId).toBeNull();
    expect(readEffectResult(without.w.ledger, { taskId: without.w.taskId, effectId: without.w.effectId, block: null })).toEqual({
      kind: "NO_RESULT_RECORDED",
      status: "FAILED",
      outcomeRecordedAt: V2_AT,
      cohort: "CURRENT",
    });
  });

  it("N-F-10: an effect with no outcome is NO_OUTCOME, never FAILED and never empty", () => {
    const w = world("p15f-no-outcome");
    expect(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null })).toEqual({ kind: "NO_OUTCOME" });
  });

  it("N-F-11: another task's effect is NOT_FOUND, exactly like an effect that does not exist", () => {
    const { w } = settled("p15f-other-task", "ok");
    const other = deterministicUuid("operation-result/another-task");
    expect(readEffectResult(w.ledger, { taskId: other, effectId: w.effectId, block: null })).toEqual({ kind: "NOT_FOUND" });
    expect(readEffectResult(w.ledger, { taskId: w.taskId, effectId: "f".repeat(64), block: null })).toEqual({ kind: "NOT_FOUND" });
  });

  it("N-F-9: OUTCOME_UNKNOWN and CANCELLED are their own words, with no result", () => {
    const w = world("p15f-unresolved");
    const row = w.ledger.getEffect(w.effectId);
    if (row === null) throw new Error("expected the effect");
    for (const status of ["OUTCOME_UNKNOWN", "CANCELLED"] as const) {
      const planted = withRow(w.ledger, { ...row, outcomeStatus: status, outcomeRecordedAt: V2_AT, outcomeContractVersion: CONTRACT_VERSION });
      expect(readEffectResult(planted, { taskId: w.taskId, effectId: w.effectId, block: null })).toEqual({ kind: status, outcomeRecordedAt: V2_AT });
    }
  });

  it("N-F-8: a pre-cohort outcome with no pair is NO_RESULT_RECORDED / PRE_RESULT, SUCCEEDED included, never a RESULT", () => {
    const w = world("p15f-pre-cohort");
    const row = w.ledger.getEffect(w.effectId);
    if (row === null) throw new Error("expected the effect");
    for (const version of PRE_RESULT_REFERENCE_CONTRACT_VERSIONS) {
      for (const status of ["SUCCEEDED", "FAILED"] as const) {
        const planted = withRow(w.ledger, { ...row, outcomeStatus: status, outcomeRecordedAt: V2_AT, outcomeContractVersion: version });
        expect(readEffectResult(planted, { taskId: w.taskId, effectId: w.effectId, block: null })).toEqual({
          kind: "NO_RESULT_RECORDED",
          status,
          outcomeRecordedAt: V2_AT,
          cohort: "PRE_RESULT",
        });
      }
    }
  });

  it("C-F5: the rows the ledger's triggers forbid are the ledger disagreeing with itself, never a cohort", () => {
    const { w, published } = settled("p15f-integrity", "ok");
    const row = w.ledger.getEffect(w.effectId);
    if (row === null) throw new Error("expected the effect");
    const read = (planted: EffectReadModel): EffectResultReading =>
      readEffectResult(withRow(w.ledger, planted), { taskId: w.taskId, effectId: w.effectId, block: null });
    expect(published.status).toBe("SUCCEEDED");
    // An outcome without its contract version, or without its instant.
    expect(() => read({ ...row, outcomeContractVersion: null })).toThrow(LedgerIntegrityError);
    expect(() => read({ ...row, outcomeRecordedAt: null })).toThrow(LedgerIntegrityError);
    // Half a pair, either half.
    expect(() => read({ ...row, resultSha256: null })).toThrow(LedgerIntegrityError);
    expect(() => read({ ...row, resultArtifactReferenceId: null })).toThrow(LedgerIntegrityError);
    // A current-cohort SUCCEEDED without a result.
    expect(() => read({ ...row, resultArtifactReferenceId: null, resultSha256: null })).toThrow(LedgerIntegrityError);
  });

  it("N-F-12: a result whose object is gone is RESULT_UNREADABLE / CONTENT_ABSENT, with nothing partial", () => {
    const { w, published } = settled("p15f-absent", "ok");
    rmSync(objectPath(w, published.resultSha256 ?? ""));
    expect(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null })).toEqual({
      kind: "RESULT_UNREADABLE",
      refusal: "CONTENT_ABSENT",
    });
  });

  it("N-F-13: a result whose bytes were changed is CONTENT_DOES_NOT_VERIFY", () => {
    const { w, published } = settled("p15f-tampered", "ok");
    const path = objectPath(w, published.resultSha256 ?? "");
    const bytes = readFileSync(path);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    writeFileSync(path, bytes);
    expect(unreadableWord(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null }))).toBe("CONTENT_DOES_NOT_VERIFY");
  });

  it("N-F-14: a symbolic link where the object should stand is SYMLINK_REFUSED", () => {
    const { w, published } = settled("p15f-symlink", "ok");
    const path = objectPath(w, published.resultSha256 ?? "");
    const copy = path + ".elsewhere";
    writeFileSync(copy, readFileSync(path));
    rmSync(path);
    symlinkSync(copy, path);
    expect(unreadableWord(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null }))).toBe("SYMLINK_REFUSED");
  });

  it("N-F-15 (a): a row that names reference A with B's digest is DIGEST_MISMATCH", () => {
    // (b) is the ledger's: its door admits a pair only with the reference's own digest,
    // which the P-07 escalón B suite pins, so no door path makes a real row disagree.
    const { w } = settled("p15f-digest", "ok");
    const row = w.ledger.getEffect(w.effectId);
    if (row === null) throw new Error("expected the effect");
    const planted = withRow(w.ledger, { ...row, resultSha256: "b".repeat(64) });
    expect(unreadableWord(readEffectResult(planted, { taskId: w.taskId, effectId: w.effectId, block: null }))).toBe("DIGEST_MISMATCH");
  });

  it("N-F-16: a document of another effect, or of another status than the row's, is DOCUMENT_DISAGREES; the door admitted both", () => {
    const otherEffect = world("p15f-disagree-effect");
    const foreign = publish(otherEffect, assembleResult("f".repeat(64), sample("ok")));
    expect(otherEffect.ledger.append(outcomeEvent(otherEffect, "settle-1", foreign)).inserted).toBe(true);
    expect(unreadableWord(readEffectResult(otherEffect.ledger, { taskId: otherEffect.taskId, effectId: otherEffect.effectId, block: null }))).toBe(
      "DOCUMENT_DISAGREES",
    );

    const otherStatus = world("p15f-disagree-status");
    const succeeded = publish(otherStatus, assembleResult(otherStatus.effectId, sample("ok")));
    expect(otherStatus.ledger.append(outcomeEvent(otherStatus, "settle-1", { ...succeeded, status: "FAILED" })).inserted).toBe(true);
    expect(unreadableWord(readEffectResult(otherStatus.ledger, { taskId: otherStatus.taskId, effectId: otherStatus.effectId, block: null }))).toBe(
      "DOCUMENT_DISAGREES",
    );
  });

  it("P0-4: bytes that are not UTF-8, not JSON, or not a result document v1 are DOCUMENT_INVALID, usageReference included", () => {
    const { w, published } = settled("p15f-invalid", "ok");
    const reference = w.ledger.getArtifactReference(published.resultArtifactReferenceId ?? "");
    if (reference === null) throw new Error("expected the reference");
    const answer = (content: Buffer): ReferenceReadOutcome => ({ verb: "READ", content, reference });
    const valid = ResultContractSchema.parse(JSON.parse(readFileSync(objectPath(w, published.resultSha256 ?? "")).toString("utf8")));
    const cases = [
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.from("not json", "utf8"),
      Buffer.from(JSON.stringify({ ...valid, usageReference: "f".repeat(64) }), "utf8"),
      Buffer.from(JSON.stringify({ ...valid, resultContractVersion: 2 }), "utf8"),
      Buffer.from(JSON.stringify({ ...valid, vendor: "x" }), "utf8"),
    ];
    for (const content of cases) {
      vi.mocked(ledgerModule.readByReference).mockImplementationOnce(() => answer(content));
      expect(unreadableWord(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null }))).toBe("DOCUMENT_INVALID");
    }
  });

  it("N-F-17 (a) and N-F-18: every plane word and both root words pass through as RESULT_UNREADABLE, unchanged", () => {
    const { w } = settled("p15f-words", "ok");
    const words = [...ARTIFACT_PLANE_REFUSALS, ...REFERENCE_READ_ROOT_REFUSALS];
    expect(words).toHaveLength(18);
    for (const word of words) {
      vi.mocked(ledgerModule.readByReference).mockImplementationOnce(() => ({ verb: "REFUSE", refusal: word }));
      expect(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null })).toEqual({ kind: "RESULT_UNREADABLE", refusal: word });
    }
    // The vocabulary is total at compile time: a twenty-fourth word fails to type-check here.
    const all: Record<EffectResultUnreadable, true> = {
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
    };
    expect(Object.keys(all)).toHaveLength(23);
  });

  it("?block: an overflowed answer's document block is read by its own reference and verified", () => {
    expect(PADDED_ANSWER.length).toBeGreaterThan(CONTENT_INLINE_TEXT_MAX_CHARS * RESULT_BLOCK_LIST_MAX);
    const { w } = settled("p15f-block", PADDED_ANSWER);
    const whole = readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null });
    if (whole.kind !== "RESULT") throw new Error("expected RESULT");
    expect(whole.document.blocks).toHaveLength(1);
    const declared = whole.document.blocks[0];
    expect(declared).toMatchObject({ kind: "document", text: null });
    const reading = readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: 0 });
    if (reading.kind !== "RESULT" || reading.block === null) throw new Error("expected a block");
    expect(reading.block.text).toBe(PADDED_ANSWER);
    expect(reading.block).toMatchObject({
      index: 0,
      artifactReferenceId: declared?.artifactRefId,
      contentSha256: declared?.contentSha256,
      byteLength: declared?.byteLength,
      mediaType: "text/markdown; charset=utf-8",
    });
    expect(createHash("sha256").update(reading.block.text, "utf8").digest("hex")).toBe(reading.block.contentSha256);
  });

  it("?block: a text block, an index past the list or a state other than RESULT is BLOCK_REFUSED", () => {
    const { w } = settled("p15f-block-refused", "ok");
    expect(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: 0 })).toEqual({ kind: "BLOCK_REFUSED" });
    expect(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: 7 })).toEqual({ kind: "BLOCK_REFUSED" });
    const open = world("p15f-block-no-outcome");
    expect(readEffectResult(open.ledger, { taskId: open.taskId, effectId: open.effectId, block: 0 })).toEqual({ kind: "BLOCK_REFUSED" });
    const none = settled("p15f-block-no-result", "");
    expect(readEffectResult(none.w.ledger, { taskId: none.w.taskId, effectId: none.w.effectId, block: 0 })).toEqual({ kind: "BLOCK_REFUSED" });
  });

  it("?block: a block whose reference is not the one its document declares is BLOCK_DISAGREES", () => {
    const { w } = settled("p15f-block-disagree", PADDED_ANSWER);
    let calls = 0;
    vi.mocked(ledgerModule.readByReference).mockImplementation((ledger, request) => {
      calls += 1;
      const outcome = realReadByReference(ledger, request);
      if (calls === 2 && outcome.verb === "READ") {
        return { ...outcome, reference: { ...outcome.reference, contentSha256: "a".repeat(64) } };
      }
      return outcome;
    });
    expect(unreadableWord(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: 0 }))).toBe("BLOCK_DISAGREES");
  });

  it("reads through the ledger's reader by reference under the task's own scope, and appends nothing", () => {
    const { w } = settled("p15f-scope", "ok");
    const before = JSON.stringify(w.ledger.listEvents({ limit: 1000 }));
    vi.mocked(ledgerModule.readByReference).mockClear();
    readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null });
    expect(vi.mocked(ledgerModule.readByReference).mock.calls.map(([, request]) => request.scopeKind + ":" + String(request.scopeId))).toEqual([
      "TASK:" + w.taskId,
    ]);
    expect(JSON.stringify(w.ledger.listEvents({ limit: 1000 }))).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// P-15/F v3 (Fable C1): the authorized read serves RESPONSE and nothing else
// ---------------------------------------------------------------------------

/** Publish raw bytes under the task's own scope, as `class`, through the world's plane. */
function publishAs(w: World, artifactClass: "RESPONSE" | "TASK_ENVELOPE", role: string, bytes: Buffer): { readonly reference: string; readonly sha256: string } {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ids = identities(role);
  const outcome = w.plane.publish({
    content: bytes,
    declaredContentSha256: sha256,
    mediaType: artifactClass === "RESPONSE" ? "application/json; charset=utf-8" : "application/json",
    encryptionStatus: "PLAINTEXT",
    encryptionProfile: "local-plaintext-v1",
    commandId: ids.commandId,
    artifactPinId: ids.artifactPinId,
    reference: {
      artifactReferenceId: ids.artifactReferenceId,
      artifactClass,
      classification: "INTERNAL",
      scopeKind: "TASK",
      scopeId: w.taskId,
      producerIdentity: EMITTED_BY,
      accessPolicyId: "SCOPE_EQUALITY_V1",
      retentionClass: "PERMANENT",
      expiresAt: null,
    },
    recordedBy: EMITTED_BY,
    intention: { eventId: ids.intentionEventId, idempotencyKey: "intended/" + role, occurredAt: V2_AT, recordedAt: V2_AT },
    terminal: { eventId: ids.terminalEventId, idempotencyKey: "succeeded/" + role, occurredAt: V2_AT, recordedAt: V2_AT },
    holding: { holder: EMITTED_BY, holderPid: process.pid, acquiredAt: V2_AT, expiresAt: "2026-09-23T12:05:00.000Z" },
  });
  if (outcome.verb !== "PUBLISHED") throw new Error("the fixture publication answered " + outcome.verb);
  return { reference: outcome.reference.artifactReferenceId, sha256 };
}

describe("P-15/F v3: a reference of another class is refused, in the block and in the document", () => {
  it("N-F-24: a RESPONSE whose document block names the task's envelope is admitted by the door and refused by the block read", () => {
    const w = world("p15f-class-block");
    // The prompt, published as the task's envelope under the task's own scope, with real bytes.
    const envelopeBytes = Buffer.from(JSON.stringify({ instruction: "the prompt this read must never serve" }), "utf8");
    const envelope = publishAs(w, "TASK_ENVELOPE", "envelope-probe", envelopeBytes);
    // A valid result document whose one block names that envelope, with its own digest and length.
    const document = {
      resultContractVersion: 1,
      effectId: w.effectId,
      status: "SUCCEEDED",
      blocks: [
        {
          kind: "document",
          blockId: "output-001",
          mediaType: "text/markdown; charset=utf-8",
          byteLength: envelopeBytes.byteLength,
          contentSha256: envelope.sha256,
          artifactRefId: envelope.reference,
          text: null,
          toolCallId: null,
          effectId: null,
        },
      ],
      usageReference: w.effectId,
    };
    expect(ResultContractSchema.safeParse(document).success).toBe(true);
    const response = publishAs(w, "RESPONSE", "response-probe", Buffer.from(canonicalJsonStringify(document), "utf8"));
    // The door checks the pair's class, scope and digest -- never the document's content.
    expect(
      w.ledger.append(
        outcomeEvent(w, "settle-1", { status: "SUCCEEDED", resultArtifactReferenceId: response.reference, resultSha256: response.sha256 }),
      ).inserted,
    ).toBe(true);

    // Positive control: the document itself reads, so the plant is a valid result.
    const whole = readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null });
    expect(whole).toMatchObject({ kind: "RESULT", status: "SUCCEEDED" });
    // The block read refuses by class, and carries no byte of the envelope.
    const block = readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: 0 });
    expect(block).toEqual({ kind: "RESULT_UNREADABLE", refusal: "CLASS_REFUSED" });
    expect(JSON.stringify(block)).not.toContain("the prompt this read must never serve");
  });

  it("N-F-24b: a top-level reference of another class is refused before its digest or its bytes (the door's rule, held again here)", () => {
    const { w, published } = settled("p15f-class-document", "ok");
    const reference = w.ledger.getArtifactReference(published.resultArtifactReferenceId ?? "");
    if (reference === null) throw new Error("expected the reference");
    vi.mocked(ledgerModule.readByReference).mockImplementationOnce(() => ({
      verb: "READ",
      content: Buffer.from("not a result", "utf8"),
      reference: { ...reference, artifactClass: "TASK_ENVELOPE" },
    }));
    expect(readEffectResult(w.ledger, { taskId: w.taskId, effectId: w.effectId, block: null })).toEqual({
      kind: "RESULT_UNREADABLE",
      refusal: "CLASS_REFUSED",
    });
    // No door path plants this: the ledger refuses a pair of another class at append.
  });
});

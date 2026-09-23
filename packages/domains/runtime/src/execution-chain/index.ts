import type { ControlPlaneEvent as ControlPlaneEventType } from "@acp/contracts";
import { effectIdV1, pinCovers, requestSha256 } from "@acp/ledger";

import type { DurableInvocation, InvocationRevision } from "../contracts/index.js";
import { deriveEventCoordinate, deterministicUuid } from "../core/coordinates/index.js";
import {
  buildDispatchIntentionEvent,
  buildDispatchTransitionEvent,
  buildEffectIntentionEvent,
  buildPromptOccurrenceEvent,
  buildResponseOccurrenceEvent,
  dispatchIntentionTransitionId,
  dispatchTransitionId,
} from "../core/events/index.js";
import type { DispatchTransition, ExecutionSegmentRecord } from "../core/events/index.js";
import { INTENT_STEP } from "../core/lifecycle/index.js";
import type { LedgerPort } from "../core/step-executor/index.js";
import { DispatchRefusedError, OperationFailedError, SupervisorError } from "../errors/index.js";
import type { DeliverySample, StreamSample, UsageSample } from "../execution-effects/index.js";
import { assembleResult, publishResult } from "../operation-result/index.js";
import type { ArtifactIdentities, ResultSample } from "../operation-result/index.js";
import { readUsageStreamLineage, recordUsageObservation, recordUsageStreamDeclaration } from "../usage/index.js";

import type { ExecutionChain, ExecutionChainInput } from "./types/index.js";

/**
 * The value types of this concept live in their own leaf, `./types/index.ts`, and
 * are re-exported here unchanged so every importer reads them from this module
 * (owner law §7).
 */
export type { ExecutionChain, ExecutionChainInput } from "./types/index.js";

/**
 * The execution chain of a recorded walk — P-15 escalón D3, ADR 0105 (decision 140;
 * adjudication v2 C1, C9, C10; C-D2, C-D3).
 *
 * The one behaviour authority for what a revision's walk records around its one
 * execution. The builders are C's and the recorders P-32's; this concept orders
 * them, derives every identity they need, and hands `createExecutionEffects` the
 * hooks it calls. The daemon only wires it (ND-D3-1 (b)).
 *
 * The order is the design:
 *
 * 1. **The pin, before anything.** The `PRICE_TABLE` version in force at the walk's
 *    instant, and one that covers the segment's provider, model version and
 *    transport, or `DispatchRefusedError` — before the effect is intended, so a
 *    refusal leaves no open intent and nothing is spent.
 * 2. **The effect, then its delivery** (`EFFECT_INTENDED`, `DISPATCH_INTENDED` with
 *    the pin), before the start. A delivery already on record is refused rather
 *    than started again: its session would answer under the same session id, and a
 *    second result under the same `sourceObservationId` is the resumed-run case
 *    P-15/D2 left to this escalón (Fable C2). Reconciling it is P-18's.
 * 3. **The start's answer.** Accepted: `INFLIGHT`, with the walk's instant as the
 *    accepted instant and the session id as the handle (ND-D3-3, ND-D3-4), then the
 *    prompt occurrence. Refused: `ABANDONED`, and no prompt, because nothing was
 *    sent.
 * 4. **The usage stream.** Declared once, at the lineage's latest generation or 0,
 *    then one observation per report whose four classes are known. A report with a
 *    class the source did not state is recorded as nothing — UNKNOWN, never 0 — and
 *    the settlement of that segment stays unknown. Never the legacy row (C1).
 * 5. **The result**, on a completed session: assembled, published before it is
 *    referenced, then `SETTLED` with the effect's status and the pair, then the
 *    response occurrence naming step 3's prompt. A session that failed settles with
 *    the effect `FAILED` and no result.
 * 6. **The coupling** (P-07 C10). An effect that did not succeed throws
 *    `OperationFailedError` after its appends, so no marker is written and the walk
 *    settles `TASK_FAILED`: never `CHECKPOINTED` on a failure.
 * 7. **The confirmation**, before the marker: the effect's outcome is `SUCCEEDED`
 *    and the response occurrence exists, or the marker is not written.
 *
 * **Every identity is derived, every instant is the invocation's.** The segment,
 * the delivery, the occurrences, the observations and the publication's
 * identities are version-5 names under the invocation; the instants are
 * `submittedAt`, the intake door's. So a replay rebuilds the same bytes, and no
 * clock is read. The cost is declared (ND-D3-3): the accepted instant records the
 * submission, not the provider's acceptance.
 *
 * **One execution per walk.** The plan has one effectful step, `INTENT_STEP`; a
 * hook called for another operation is refused by name.
 */

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/** The walk's one segment: the first, with no predecessor. */
const SEGMENT_NUMBER = 1;
/** The walk's one effect: the attempt's first operation. */
const OPERATION_ORDINAL = 0;
/** The walk's one delivery of it: the first. */
const ATTEMPT_ORDINAL = 1;
/** The one effect kind, at its one request contract version. */
const EFFECT_KIND = "model_execution";
const REQUEST_CONTRACT_VERSION = "1";
/** The effect's scope and step key: the run, and the plan step that performs it. */
const SEMANTIC_SCOPE_KEY = "run";

function revisionOf(invocation: DurableInvocation): InvocationRevision {
  const revision = invocation.revision;
  if (revision === undefined) {
    throw new SupervisorError(
      "refusing to build an execution chain for an invocation without a revision; the chain carries the V2" +
        " coordinate, and a V1 walk records its spend through the legacy sink instead",
    );
  }
  return revision;
}

/** A version-5 name under the invocation, for one part of its chain. */
function chainId(invocation: DurableInvocation, part: string): string {
  return deterministicUuid("execution-chain/" + invocation.invocationId + "/" + part);
}

/** The walk's one effect id, as the ledger derives it. */
function effectIdOf(invocation: DurableInvocation, revision: InvocationRevision): string {
  return effectIdV1({
    taskId: invocation.taskId,
    revisionNumber: revision.revisionNumber,
    attemptNumber: revision.attemptNumber,
    segmentNumber: SEGMENT_NUMBER,
    operationOrdinal: OPERATION_ORDINAL,
  });
}

/** The walk's one delivery id. */
function dispatchAttemptIdOf(invocation: DurableInvocation): string {
  return chainId(invocation, "dispatch/" + String(ATTEMPT_ORDINAL));
}

function publicationIdentities(invocation: DurableInvocation, role: "result" | "output"): ArtifactIdentities {
  return {
    artifactReferenceId: chainId(invocation, role + "/reference"),
    commandId: chainId(invocation, role + "/command"),
    artifactPinId: chainId(invocation, role + "/pin"),
    intentionEventId: chainId(invocation, role + "/intention"),
    terminalEventId: chainId(invocation, role + "/terminal"),
  };
}

function stateOf(ledger: LedgerPort, invocation: DurableInvocation): ControlPlaneEventType["fromState"] {
  const task = ledger.getTask(invocation.taskId);
  if (task === null) {
    throw new SupervisorError("refusing to record an execution chain for a task the ledger has never seen");
  }
  return task.currentState;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** Build one recorded walk's chain: the hooks `createExecutionEffects` calls. */
export function createExecutionChain(input: ExecutionChainInput): ExecutionChain {
  const { ledger, invocation, route, emittedBy } = input;
  const revision = revisionOf(invocation);
  const instant = invocation.submittedAt;
  const effectId = effectIdOf(invocation, revision);
  const dispatchAttemptId = dispatchAttemptIdOf(invocation);
  const promptOccurrenceId = chainId(invocation, "prompt/" + dispatchAttemptId);
  const responseOccurrenceId = chainId(invocation, "response/" + promptOccurrenceId);
  const accountId = route.accountId;

  const segment: ExecutionSegmentRecord = {
    routeSegmentId: chainId(invocation, "segment/" + String(SEGMENT_NUMBER)),
    segmentNumber: SEGMENT_NUMBER,
    provider: route.provider,
    model: route.model,
    modelResolutionStatus: "RESOLVED",
    modelVersionId: input.modelVersionId,
    accountId,
    transportKind: route.transportKind,
    capabilityPolicyVersion: route.capabilityPolicyVersion,
    routingAssignmentId: input.routingAssignmentId,
    reservationId: null,
    predecessorSegmentId: null,
    handoffReason: null,
    escalatedFromAttempt: null,
    escalationReason: null,
    resolvedAt: route.resolvedAt,
  };

  const requireOperation = (operationIndex: number, what: string): void => {
    if (operationIndex !== INTENT_STEP.index) {
      throw new SupervisorError(
        "refusing to record " +
          what +
          " for operation " +
          String(operationIndex) +
          "; a recorded walk performs one execution, at the plan's INTENT step",
      );
    }
  };

  const transition = (move: DispatchTransition): void => {
    ledger.append(
      buildDispatchTransitionEvent({
        invocation,
        state: stateOf(ledger, invocation),
        emittedBy,
        causedBy: null,
        transition: move,
      }),
    );
  };

  const recordIntentions = (operationIndex: number): void => {
    requireOperation(operationIndex, "the effect's intentions");

    // A delivery already on record is never started again: its session would
    // answer under the same session id, and a second result would carry the same
    // source observation id with a usage scope nobody has observed.
    if (ledger.listDispatchAttempts(effectId).length > 0) {
      throw new SupervisorError(
        "refusing to start the effect again: a delivery of it is already recorded, and a second start would" +
          " answer under the same session; an outstanding delivery is reconciled, never resent",
      );
    }

    // The pin first, before anything is intended, at the walk's instant.
    const pin = ledger.getVigentCatalogPin(input.catalogDocumentId, instant);
    if (pin === null) {
      throw new DispatchRefusedError(
        "catalogDocumentId",
        "no version of the named price catalog is in force at the walk's instant; nothing was intended and nothing sent",
      );
    }
    const intervals = ledger.readPriceIntervals(pin);
    const covered = pinCovers(
      intervals,
      pin,
      { provider: segment.provider, modelVersionId: segment.modelVersionId, transportKind: segment.transportKind },
      instant,
    );
    if (!covered) {
      throw new DispatchRefusedError(
        "catalogVersion",
        "the price catalog version in force does not cover this segment's provider, model version and transport;" +
          " nothing was intended and nothing sent",
      );
    }

    ledger.append(
      buildEffectIntentionEvent({
        invocation,
        state: stateOf(ledger, invocation),
        emittedBy,
        causedBy: null,
        segment,
        effect: {
          operationOrdinal: OPERATION_ORDINAL,
          effectKind: EFFECT_KIND,
          semanticScopeKey: SEMANTIC_SCOPE_KEY,
          localOperationKey: INTENT_STEP.transitionId,
          requestContractVersion: REQUEST_CONTRACT_VERSION,
          // Neutral: what was asked, by digest and length, and nothing resolved at
          // dispatch time — no segment, no account (execution §6.1).
          requestSha256: requestSha256({
            effectKind: EFFECT_KIND,
            requestContractVersion: REQUEST_CONTRACT_VERSION,
            envelopeSha256: revision.envelopeSha256,
            neutralRequest: { promptSha256: input.prompt.promptSha256, promptBytes: input.prompt.promptBytes },
          }),
        },
      }),
    );
    ledger.append(
      buildDispatchIntentionEvent({
        invocation,
        state: stateOf(ledger, invocation),
        emittedBy,
        causedBy: null,
        segment,
        dispatch: { dispatchAttemptId, effectId, attemptOrdinal: ATTEMPT_ORDINAL, pin },
      }),
    );
  };

  const recordPrompt = (): void => {
    // The ordinal is the segment's next, or the recorded one on a replay.
    const recorded = ledger.getPromptOccurrence(promptOccurrenceId);
    const held = ledger.listPromptOccurrences(segment.routeSegmentId);
    const ordinal =
      recorded?.ordinal ?? (held.length === 0 ? 0 : Math.max(...held.map((occurrence) => occurrence.ordinal)) + 1);
    ledger.append(
      buildPromptOccurrenceEvent({
        invocation,
        state: stateOf(ledger, invocation),
        emittedBy,
        causedBy: null,
        occurrence: {
          occurrenceId: promptOccurrenceId,
          dispatchAttemptId,
          effectId,
          routeSegmentId: segment.routeSegmentId,
          ordinal,
          requestedModelId: route.model,
          provider: route.provider,
          modelResolutionStatus: "RESOLVED",
          modelVersionId: input.modelVersionId,
          accountId,
          promptSha256: input.prompt.promptSha256,
          promptBytes: input.prompt.promptBytes,
          contextSha256: null,
        },
      }),
    );
  };

  const recordDelivery = (sample: DeliverySample): void => {
    requireOperation(sample.operationIndex, "a delivery");
    switch (sample.kind) {
      case "ACCEPTED":
        transition({ kind: "INFLIGHT", dispatchAttemptId, acceptedAt: instant, externalHandle: sample.sessionId });
        recordPrompt();
        return;
      case "REFUSED":
        transition({ kind: "ABANDONED", dispatchAttemptId, terminalAt: instant, effectOutcomeStatus: "FAILED" });
        return;
      case "FAILED":
        transition({ kind: "SETTLED", dispatchAttemptId, terminalAt: instant, effectOutcomeStatus: "FAILED", result: null });
        return;
      default: {
        const unreachable: never = sample;
        return unreachable;
      }
    }
  };

  const recordStream = (sample: StreamSample): void => {
    requireOperation(sample.operationIndex, "a usage stream");
    const lineage = readUsageStreamLineage(ledger, {
      source: input.usageSource.source,
      accountId,
      routeSegmentId: segment.routeSegmentId,
    });
    if (!lineage.ok) {
      throw new SupervisorError(
        "refusing to declare a usage stream whose lineage cannot be read whole: " + lineage.reason + " at " + lineage.at,
      );
    }
    // The latest declared generation restated, or 0 for a lineage never declared.
    // A one-shot process never reports a counter reset, so never + 1 here.
    const declared = recordUsageStreamDeclaration(ledger, {
      invocation,
      source: input.usageSource.source,
      accountId,
      routeSegmentId: segment.routeSegmentId,
      sourceEpoch: lineage.latest?.sourceEpoch ?? 0,
      sourceClass: input.usageSource.sourceClass,
      normalizationPolicySha256: input.usageSource.normalizationPolicySha256,
      emittedBy,
    });
    sample.reports.forEach((report, ordinal) => {
      const counts = knownCounts(report);
      // A class the source did not state: UNKNOWN, recorded as nothing, never 0.
      if (counts === null) return;
      if (report.reportKind === "CORRECTION") {
        throw new SupervisorError("refusing a CORRECTION from the port; no adapter makes one, and it names no target here");
      }
      recordUsageObservation(ledger, {
        invocation,
        measurementStreamId: declared.measurementStreamId,
        observationId: chainId(invocation, "observation/" + declared.measurementStreamId + "/" + String(ordinal)),
        ordinal,
        sourceObservationId: report.sourceObservationId,
        reportKind: report.reportKind,
        // The counter is the report's position in its stream, the only one a
        // one-shot process exposes: a DELTA covers its own position, a CUMULATIVE
        // everything from the stream's origin to it.
        rangeFromCounter: report.reportKind === "CUMULATIVE" ? 0 : ordinal,
        rangeToCounter: ordinal + 1,
        correctsObservationId: null,
        effectId,
        isFinal: report.isFinal ? 1 : 0,
        ...counts,
        occurredAt: instant,
        emittedBy,
      });
    });
  };

  const recordResult = (sample: ResultSample): void => {
    requireOperation(sample.operationIndex, "a result");
    const published = publishResult({
      ledger,
      plane: input.plane,
      effectId,
      taskId: invocation.taskId,
      recordedBy: emittedBy,
      recordedAt: instant,
      holderPid: input.holderPid,
      result: publicationIdentities(invocation, "result"),
      overflow: publicationIdentities(invocation, "output"),
      assembly: assembleResult(effectId, sample),
    });
    transition({
      kind: "SETTLED",
      dispatchAttemptId,
      terminalAt: instant,
      effectOutcomeStatus: published.status,
      result:
        published.resultArtifactReferenceId === null
          ? null
          : { artifactReferenceId: published.resultArtifactReferenceId, sha256: published.resultSha256 },
    });
    if (published.resultArtifactReferenceId !== null) {
      ledger.append(
        buildResponseOccurrenceEvent({
          invocation,
          state: stateOf(ledger, invocation),
          emittedBy,
          causedBy: null,
          occurrence: {
            occurrenceId: responseOccurrenceId,
            promptOccurrenceId,
            responseSha256: published.resultSha256,
            responseBytes: published.responseBytes,
            redactionVerdict: "CLEAN",
          },
        }),
      );
    }
    if (published.status !== "SUCCEEDED") {
      throw new OperationFailedError(
        published.reason,
        "the model's answer was a failure (" + published.reason + "); its outcome is recorded and the walk does not checkpoint",
      );
    }
  };

  const confirmChain = (operationIndex: number): void => {
    requireOperation(operationIndex, "the chain's confirmation");
    const effect = ledger.getEffect(effectId);
    if (effect?.outcomeStatus !== "SUCCEEDED") {
      throw new SupervisorError(
        "refusing to write the evidence marker: the effect's outcome is not recorded as SUCCEEDED, and a marker" +
          " over a gap would make the gap permanent",
      );
    }
    if (ledger.getResponseOccurrenceForPrompt(promptOccurrenceId) === null) {
      throw new SupervisorError(
        "refusing to write the evidence marker: the response occurrence is not recorded, and a marker over a gap" +
          " would make the gap permanent",
      );
    }
  };

  return Object.freeze({ recordIntentions, recordDelivery, recordStream, recordResult, confirmChain });
}

/** The four classes and their total, when every class is known; otherwise null. */
function knownCounts(report: UsageSample): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
} | null {
  const { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalTokens } = report;
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheWriteTokens === null ||
    cacheReadTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalTokens };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Whether the walk's delivery is still open, for a failure being settled (P-15
 * escalón D3, C-D3; decision 141).
 *
 * Read from the delivery's own events, by the keys the chain records them under,
 * so a beat context's narrow ledger port is enough. Open means intended and never
 * settled or abandoned — `INTENDED` as much as `INFLIGHT`. An intention found in
 * the ledger does not prove that nothing was sent: `INFLIGHT` is appended only
 * after `port.start` resolves, so a process may be running whose acceptance was
 * never recorded. Either way the outcome is unknown (execution §7.6), and the
 * settlement must not claim an end while an effect may still happen. The one sound
 * `ABANDONED` is the chain's own, recorded in the same process that saw the port
 * refuse the start. Nothing is appended here.
 */
export function deliveryIsOpen(ledger: LedgerPort, invocation: DurableInvocation): boolean {
  revisionOf(invocation);
  const dispatchAttemptId = dispatchAttemptIdOf(invocation);
  const recorded = (transitionId: string): boolean =>
    ledger.getEventByIdempotencyKey(deriveEventCoordinate(invocation, transitionId, 0).idempotencyKey) !== null;
  if (!recorded(dispatchIntentionTransitionId(dispatchAttemptId))) return false;
  return !(recorded(dispatchTransitionId("SETTLED", dispatchAttemptId)) || recorded(dispatchTransitionId("ABANDONED", dispatchAttemptId)));
}

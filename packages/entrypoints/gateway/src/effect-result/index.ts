import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  MAX_TASK_EFFECTS,
  TaskEffectResultResponse,
  TaskEffectsResponse,
  taskEffectResultPath,
} from "@acp/protocol";
import type { Ledger } from "@acp/ledger";
import { readEffectResult } from "@acp/runtime";

import { ApiRouteError } from "../errors/index.js";

/**
 * The two effect reads of the observation plane (P-15 escalón F, ADR 0107).
 *
 * `taskEffects` lists a task's effects and is a plain read. `effectResult` reads
 * one effect's result back by reference and is the plane's one **private** read:
 * the route that calls it is registered behind the bearer (`API_PRIVATE_READ_ROUTES`),
 * because what it answers is model output (tests §8.1, decision 149).
 *
 * Neither function logs, publishes to a stream or holds the bytes past its
 * return: the result's text leaves this module only inside the response it
 * builds (L-P15F-1). The runtime's `readEffectResult` decides; this module maps
 * its closed answer onto the wire and raises the one error envelope for the rest.
 */

/**
 * Validate an effect id through the protocol's own path builder, so the grammar
 * is stated once (the ledger's: 64 lowercase hex) and a refusal never echoes
 * the value.
 */
export function parseEffectIdParam(taskId: string, raw: string): string {
  try {
    taskEffectResultPath(taskId, raw);
  } catch {
    throw new ApiRouteError("BAD_REQUEST", "effectId must be an effect id: 64 lowercase hex");
  }
  return raw;
}

/** A task's effects, or null when the ledger holds no such task. */
export function taskEffects(ledger: Ledger, taskId: string): TaskEffectsResponse | null {
  if (ledger.getTask(taskId) === null) return null;
  const page = ledger.listTaskEffects(taskId, { limit: MAX_TASK_EFFECTS });
  const effects = page.effects.map((effect) => ({
    effectId: effect.effectId,
    revisionNumber: effect.revisionNumber,
    attemptNumber: effect.attemptNumber,
    operationOrdinal: effect.operationOrdinal,
    effectKind: effect.effectKind,
    intendedAt: effect.intendedAt,
    outcomeStatus: effect.outcomeStatus,
    outcomeRecordedAt: effect.outcomeRecordedAt,
    // The pair is whole or absent (the ledger's trigger), so its digest's presence
    // is the answer; the reference itself is never read here (L-P15F-1 (i)).
    hasResult: effect.resultSha256 !== null,
  }));
  return TaskEffectsResponse.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    taskId,
    effects,
    truncated: page.truncated,
  });
}

/**
 * One effect's result, or the classified refusal.
 *
 * `NOT_FOUND` covers an absent effect and another task's alike. A result the
 * plane cannot give back is `LEDGER_INTEGRITY` with the closed word as its only
 * detail — never a path, never a byte. A block selector that names nothing
 * readable by reference is `BAD_REQUEST` naming the parameter, not its value.
 */
export function effectResult(
  ledger: Ledger,
  taskId: string,
  effectId: string,
  block: number | null,
): TaskEffectResultResponse {
  const reading = readEffectResult(ledger, { taskId, effectId, block });
  const base = {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    taskId,
    effectId,
  };
  switch (reading.kind) {
    case "NOT_FOUND":
      throw new ApiRouteError("NOT_FOUND", "no effect with that id was found for that task");
    case "BLOCK_REFUSED":
      throw new ApiRouteError("BAD_REQUEST", "block names no block of this result that is read by reference", "block");
    case "RESULT_UNREADABLE":
      throw new ApiRouteError(
        "LEDGER_INTEGRITY",
        "the ledger names a result the private plane cannot give back",
        reading.refusal,
      );
    case "NO_OUTCOME":
      return TaskEffectResultResponse.parse({
        ...base,
        state: "NO_OUTCOME",
        outcomeStatus: null,
        outcomeRecordedAt: null,
        cohort: null,
        result: null,
        blockContent: null,
      });
    case "OUTCOME_UNKNOWN":
    case "CANCELLED":
      return TaskEffectResultResponse.parse({
        ...base,
        state: reading.kind,
        outcomeStatus: reading.kind,
        outcomeRecordedAt: reading.outcomeRecordedAt,
        cohort: null,
        result: null,
        blockContent: null,
      });
    case "NO_RESULT_RECORDED":
      return TaskEffectResultResponse.parse({
        ...base,
        state: "NO_RESULT_RECORDED",
        outcomeStatus: reading.status,
        outcomeRecordedAt: reading.outcomeRecordedAt,
        cohort: reading.cohort,
        result: null,
        blockContent: null,
      });
    case "RESULT":
      return TaskEffectResultResponse.parse({
        ...base,
        state: "RESULT",
        outcomeStatus: reading.status,
        outcomeRecordedAt: reading.outcomeRecordedAt,
        cohort: "CURRENT",
        result: {
          resultSha256: reading.resultSha256,
          artifactReferenceId: reading.artifactReferenceId,
          document: reading.document,
        },
        blockContent: reading.block,
      });
    default: {
      const unreachable: never = reading;
      return unreachable;
    }
  }
}

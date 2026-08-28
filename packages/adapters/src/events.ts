import type { ControlPlaneEventType } from "@acp/contracts";

import type { ProviderName, ProviderSignal } from "./contract.js";

/**
 * Normalized events, and their mapping onto the frozen 21.
 *
 * The frozen vocabulary in `@acp/contracts` has no adapter or provider type,
 * and P4 does not add one. Every provider signal is expressed with a type that
 * already exists, or it is a STOP: the packet halts and escalates to the DT.
 * It is never grounds to widen the contract, never grounds to press an
 * unrelated type into service, and never grounds for a mid-packet schema
 * change. That law is stated here because this is the file where the pressure
 * to break it would first appear.
 *
 * Adapters emit *normalized* events only. The caller constructs any full
 * `ControlPlaneEvent` — idempotency key, attempt, `fromState`/`toState` and
 * the change-of-state law the contract enforces — so no `superRefine` in
 * `@acp/contracts` is ever an adapter's to satisfy.
 */

export type NormalizedEventName =
  | "session.started"
  | "step.completed"
  | "checkpoint.emitted"
  | "auth.required"
  | "session.interrupted"
  | "session.failed"
  | "provider.state";

/** The one place the mapping is written down. */
export const FROZEN_TYPE_BY_EVENT: Readonly<Record<NormalizedEventName, ControlPlaneEventType>> =
  Object.freeze({
    "session.started": "RUN_STARTED",
    "step.completed": "ATOMIC_STEP_COMPLETED",
    "checkpoint.emitted": "CHECKPOINT_WRITTEN",
    "auth.required": "AUTH_REQUIRED_RAISED",
    "session.interrupted": "TASK_CANCELLED",
    "session.failed": "TASK_FAILED",
    "provider.state": "TASK_STATE_CHANGED",
  });

export const NORMALIZED_EVENT_NAMES: readonly NormalizedEventName[] = Object.freeze(
  Object.keys(FROZEN_TYPE_BY_EVENT).sort() as NormalizedEventName[],
);

export interface NormalizedEvent {
  readonly name: NormalizedEventName;
  readonly frozenType: ControlPlaneEventType;
  readonly provider: ProviderName;
  readonly taskId: string;
  /** Bounded and redacted before it gets here. Never a transcript. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export function normalizedEvent(
  name: NormalizedEventName,
  provider: ProviderName,
  taskId: string,
  payload: Readonly<Record<string, unknown>>,
): NormalizedEvent {
  return Object.freeze({
    name,
    frozenType: FROZEN_TYPE_BY_EVENT[name],
    provider,
    taskId,
    payload: Object.freeze({ ...payload }),
  });
}

/** Upper bound on a reported token count, matching the P3 baseline convention. */
export const TOKENS_USED_MAX = 10_000_000;

/**
 * Turn one provider signal into a normalized event.
 *
 * A `write` signal has no mapping on purpose: it is not an observation to
 * report, it is a violation to refuse, and `session.ts` fails the session on
 * it. Returning `null` here rather than inventing an event is what keeps that
 * decision in one place.
 */
export function toNormalized(
  signal: ProviderSignal,
  provider: ProviderName,
  taskId: string,
): NormalizedEvent | null {
  switch (signal.kind) {
    case "started":
      return normalizedEvent("session.started", provider, taskId, {
        provider,
        resolvedModel: signal.resolvedModel,
        protocolVersion: signal.protocolVersion,
      });
    case "step":
      return normalizedEvent("step.completed", provider, taskId, {
        tokensUsed: signal.tokensUsed,
        stepIndex: signal.stepIndex,
      });
    case "checkpoint":
      return normalizedEvent("checkpoint.emitted", provider, taskId, { digest: signal.digest });
    case "authRequired":
      // The reason is a classified token, never a prompt, a URL or a code.
      return normalizedEvent("auth.required", provider, taskId, {
        provider,
        reason: signal.reason,
      });
    case "state":
      return normalizedEvent("provider.state", provider, taskId, { toState: signal.toState });
    case "write":
      return null;
  }
}

/** Is this token bound-checked and safe to report as a token count? */
export function isReportableTokenCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= TOKENS_USED_MAX
  );
}

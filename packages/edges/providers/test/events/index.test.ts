import { CONTROL_PLANE_EVENT_TYPES } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import type { ProviderSignal } from "../../src/contract/index.js";
import {
  FROZEN_TYPE_BY_EVENT,
  NORMALIZED_EVENT_NAMES,
  TOKENS_USED_MAX,
  isReportableTokenCount,
  normalizedEvent,
  toNormalized,
} from "../../src/events/index.js";

const TASK = "00000000-0000-4000-8000-00000000000a";

describe("every normalized event maps onto the frozen vocabulary", () => {
  it("maps exactly eight names, each to a type the contract already declares", () => {
    expect(NORMALIZED_EVENT_NAMES).toHaveLength(8);
    for (const name of NORMALIZED_EVENT_NAMES) {
      const frozen = FROZEN_TYPE_BY_EVENT[name];
      expect({ name, known: CONTROL_PLANE_EVENT_TYPES.includes(frozen) }).toEqual({
        name,
        known: true,
      });
    }
  });

  it("claims no commit or lease type — those are P5 and P6", () => {
    const used = Object.values(FROZEN_TYPE_BY_EVENT);
    for (const type of used) {
      expect({ type, reserved: /^(COMMIT_|LEASE_)/.test(type) }).toEqual({
        type,
        reserved: false,
      });
    }
  });

  it("claims exactly one quota type, and it is the observation of pressure", () => {
    // The reservation this narrows was written when no adapter could claim a
    // quota type at all. The packet that records provider pressure is the one
    // that earns it, and it earns exactly one: `quota.pressure` maps to
    // QUOTA_WARNING, which is an observation of what a provider said and not
    // a switch decision — that judgement stays with `decideSwitch`. Asserted
    // by equality against the single expected value, so a *second* quota type
    // still fails here.
    const quota = Object.entries(FROZEN_TYPE_BY_EVENT).filter(([, type]) =>
      type.startsWith("QUOTA_"),
    );
    expect(quota).toEqual([["quota.pressure", "QUOTA_WARNING"]]);
  });

  it("translates each provider signal to its declared type", () => {
    const cases: { readonly signal: ProviderSignal; readonly frozen: string }[] = [
      { signal: { kind: "started", resolvedModel: "m", protocolVersion: "1" }, frozen: "RUN_STARTED" },
      { signal: { kind: "step", tokensUsed: 5, stepIndex: 0 }, frozen: "ATOMIC_STEP_COMPLETED" },
      { signal: { kind: "checkpoint", digest: "abc" }, frozen: "CHECKPOINT_WRITTEN" },
      { signal: { kind: "authRequired", reason: "LOGIN_REQUIRED" }, frozen: "AUTH_REQUIRED_RAISED" },
      { signal: { kind: "state", toState: "DISCOVERED" }, frozen: "TASK_STATE_CHANGED" },
      { signal: { kind: "pressure", pressure: "QUOTA_EXHAUSTED" }, frozen: "QUOTA_WARNING" },
    ];
    for (const { signal, frozen } of cases) {
      const event = toNormalized(signal, "claude", TASK);
      expect({ kind: signal.kind, frozen: event?.frozenType }).toEqual({ kind: signal.kind, frozen });
    }
  });

  it("carries the classifying adapter's provider and the classification, and no quantity", () => {
    // Both quota members reach the same frozen type: an exhaustion is a
    // QUOTA_WARNING row with the classified kind in the payload, because the
    // frozen vocabulary is 24 names and a 25th moves the protocol.
    for (const pressure of ["QUOTA_EXHAUSTED", "QUOTA_WARNING"] as const) {
      const event = toNormalized({ kind: "pressure", pressure }, "codex", TASK);
      expect(event?.frozenType).toBe("QUOTA_WARNING");
      expect(event?.provider).toBe("codex");
      expect(event?.payload).toEqual({ provider: "codex", pressure });
    }
  });

  it("gives a write signal no event at all", () => {
    // A write is not an observation to report; it is a violation for the
    // session to refuse. Inventing an event for it here would move that
    // decision away from the one place that can act on it.
    expect(toNormalized({ kind: "write", target: "file.ts" }, "claude", TASK)).toBeNull();
  });

  it("is deterministic: the same signal yields the same event every time", () => {
    const signal: ProviderSignal = { kind: "step", tokensUsed: 1200, stepIndex: 3 };
    const first = JSON.stringify(toNormalized(signal, "kimi", TASK));
    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(toNormalized(signal, "kimi", TASK))).toBe(first);
    }
  });

  it("freezes what it emits", () => {
    const event = normalizedEvent("session.started", "codex", TASK, { provider: "codex" });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });
});

describe("token counts are bounded, not trusted", () => {
  it("accepts the exact bounds", () => {
    expect(isReportableTokenCount(0)).toBe(true);
    expect(isReportableTokenCount(TOKENS_USED_MAX)).toBe(true);
  });

  it("refuses everything outside them", () => {
    for (const value of [-1, 1.5, TOKENS_USED_MAX + 1, "900", null, undefined, NaN]) {
      expect({ value, ok: isReportableTokenCount(value) }).toEqual({ value, ok: false });
    }
  });
});

describe("the private signals never become events (P-07 escalón C, ADR 0099)", () => {
  it("maps output text and an operation verdict to nothing at all", () => {
    const privateSignals: readonly ProviderSignal[] = [
      { kind: "output", text: "private output" },
      { kind: "operation", status: "SUCCEEDED" },
      { kind: "operation", status: "FAILED" },
    ];
    for (const signal of privateSignals) {
      expect(toNormalized(signal, "claude", TASK), signal.kind).toBeNull();
    }
    // Positive control: a signal with a mapping still maps.
    expect(toNormalized({ kind: "state", toState: "SUCCESS" }, "claude", TASK)).not.toBeNull();
  });
});

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
  it("maps exactly seven names, each to a type the contract already declares", () => {
    expect(NORMALIZED_EVENT_NAMES).toHaveLength(7);
    for (const name of NORMALIZED_EVENT_NAMES) {
      const frozen = FROZEN_TYPE_BY_EVENT[name];
      expect({ name, known: CONTROL_PLANE_EVENT_TYPES.includes(frozen) }).toEqual({
        name,
        known: true,
      });
    }
  });

  it("claims no commit, lease or quota type — those are P5 and P6", () => {
    const used = Object.values(FROZEN_TYPE_BY_EVENT);
    for (const type of used) {
      expect({ type, reserved: /^(COMMIT_|LEASE_|QUOTA_)/.test(type) }).toEqual({
        type,
        reserved: false,
      });
    }
  });

  it("translates each provider signal to its declared type", () => {
    const cases: { readonly signal: ProviderSignal; readonly frozen: string }[] = [
      { signal: { kind: "started", resolvedModel: "m", protocolVersion: "1" }, frozen: "RUN_STARTED" },
      { signal: { kind: "step", tokensUsed: 5, stepIndex: 0 }, frozen: "ATOMIC_STEP_COMPLETED" },
      { signal: { kind: "checkpoint", digest: "abc" }, frozen: "CHECKPOINT_WRITTEN" },
      { signal: { kind: "authRequired", reason: "LOGIN_REQUIRED" }, frozen: "AUTH_REQUIRED_RAISED" },
      { signal: { kind: "state", toState: "DISCOVERED" }, frozen: "TASK_STATE_CHANGED" },
    ];
    for (const { signal, frozen } of cases) {
      const event = toNormalized(signal, "claude", TASK);
      expect({ kind: signal.kind, frozen: event?.frozenType }).toEqual({ kind: signal.kind, frozen });
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

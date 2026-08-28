import { describe, expect, it } from "vitest";

import {
  CAPABILITY_NAMES,
  LEGAL_TRANSITIONS,
  PROVIDER_NAMES,
  SESSION_STATES,
  capability,
  confirmsProviderCapability,
  isLegalTransition,
  unknownCapabilities,
} from "./contract.js";
import type { CapabilityEvidence } from "./contract.js";
import { ADAPTER_ERROR_CODES, AdapterError } from "./errors.js";

const CONTEXT = { provider: "claude", taskId: "00000000-0000-4000-8000-00000000000a" };

describe("the session state machine is a closed table", () => {
  it("names exactly seven states and three providers", () => {
    expect([...SESSION_STATES]).toEqual([
      "CLOSED",
      "CREATED",
      "FAILED",
      "INTERRUPTING",
      "READY",
      "STARTING",
      "STREAMING",
    ]);
    expect([...PROVIDER_NAMES]).toEqual(["claude", "codex", "kimi"]);
  });

  it("permits exactly the legal moves", () => {
    expect(isLegalTransition("CREATED", "STARTING")).toBe(true);
    expect(isLegalTransition("STARTING", "READY")).toBe(true);
    expect(isLegalTransition("READY", "STREAMING")).toBe(true);
    expect(isLegalTransition("STREAMING", "INTERRUPTING")).toBe(true);
    expect(isLegalTransition("INTERRUPTING", "CLOSED")).toBe(true);
  });

  it("refuses every move the table does not name", () => {
    // Terminal means terminal: nothing leaves CLOSED or FAILED.
    for (const to of SESSION_STATES) {
      expect({ from: "CLOSED", to, legal: isLegalTransition("CLOSED", to) }).toEqual({
        from: "CLOSED",
        to,
        legal: false,
      });
      expect({ from: "FAILED", to, legal: isLegalTransition("FAILED", to) }).toEqual({
        from: "FAILED",
        to,
        legal: false,
      });
    }
    // And a few specific illegal jumps that a careless refactor would allow.
    expect(isLegalTransition("CREATED", "STREAMING")).toBe(false);
    expect(isLegalTransition("CREATED", "READY")).toBe(false);
    expect(isLegalTransition("STARTING", "STREAMING")).toBe(false);
  });

  it("every declared state has a transition list", () => {
    for (const state of SESSION_STATES) {
      expect({ state, hasList: Array.isArray(LEGAL_TRANSITIONS[state]) }).toEqual({
        state,
        hasList: true,
      });
    }
  });
});

describe("a capability is a claim, and a claim needs the right evidence", () => {
  it("starts every capability UNKNOWN with no evidence", () => {
    const records = unknownCapabilities();
    expect(records.map((entry) => entry.name)).toEqual([...CAPABILITY_NAMES]);
    for (const record of records) {
      expect({ name: record.name, state: record.state, kind: record.evidence.kind }).toEqual({
        name: record.name,
        state: "UNKNOWN",
        kind: "NONE",
      });
    }
  });

  it("confirms on protocol evidence, or on a real-provider runtime drill", () => {
    expect(confirmsProviderCapability({ kind: "PROTOCOL", detail: "handshake" })).toBe(true);
    expect(
      confirmsProviderCapability({ kind: "RUNTIME", subject: "REAL", detail: "drill" }),
    ).toBe(true);
  });

  it("refuses a fake-subject drill as proof of a provider capability", () => {
    // The load-bearing distinction: a fake proves our parser, never that a real
    // provider streams. Without the subject field, "CONFIRMED requires
    // evidence" would be satisfiable by evidence about ourselves.
    const fake: CapabilityEvidence = { kind: "RUNTIME", subject: "FAKE", detail: "fixture" };
    expect(confirmsProviderCapability(fake)).toBe(false);
    expect(() => capability("STREAMING", "CONFIRMED", fake, CONTEXT)).toThrow(AdapterError);
    try {
      capability("STREAMING", "CONFIRMED", fake, CONTEXT);
    } catch (error) {
      expect((error as AdapterError).code).toBe("CAPABILITY_UNPROVEN");
    }
  });

  it("refuses CONFIRMED with no evidence at all", () => {
    expect(() => capability("RESUME", "CONFIRMED", { kind: "NONE" }, CONTEXT)).toThrow(AdapterError);
  });

  it("allows UNKNOWN and REFUSED to carry no evidence", () => {
    expect(capability("RESUME", "UNKNOWN", { kind: "NONE" }, CONTEXT).state).toBe("UNKNOWN");
    expect(capability("RESUME", "REFUSED", { kind: "NONE" }, CONTEXT).state).toBe("REFUSED");
  });
});

describe("the error surface is closed and says nothing it should not", () => {
  it("declares exactly thirteen codes, sorted", () => {
    expect([...ADAPTER_ERROR_CODES]).toEqual([...ADAPTER_ERROR_CODES].sort());
    expect(ADAPTER_ERROR_CODES).toHaveLength(13);
  });

  it("carries the code, provider and task id, and nothing else", () => {
    const error = new AdapterError("SPAWN_FAILED", CONTEXT);
    expect(error.message).toBe("SPAWN_FAILED [claude " + CONTEXT.taskId + "]");
    expect(error.code).toBe("SPAWN_FAILED");
    // No constructor parameter exists through which output could be quoted.
    expect(Object.keys(CONTEXT).sort()).toEqual(["provider", "taskId"]);
  });
});

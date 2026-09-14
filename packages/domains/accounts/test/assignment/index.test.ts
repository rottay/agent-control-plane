import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TRANSPORT_KINDS, WORKER_ROLES } from "@acp/contracts";
import { describe, expect, it } from "vitest";

import * as accounts from "../../src/index.js";
import { ASSIGNMENT_REFUSALS, resolveAssignment } from "../../src/assignment/index.js";
import type {
  AssignmentModelVersion,
  AssignmentOutcome,
  AssignmentReading,
  AssignmentRequest,
  AssignmentWatermark,
} from "../../src/assignment/index.js";

/**
 * Evidence for the GLOBAL assignment resolver (P-14 escalón A, ADR 0085).
 *
 * The reading is built by hand in the shape the ledger's
 * `getGlobalRoutingAssignment` returns — this package may not import the ledger,
 * so the caller maps it, and these fixtures stand where that mapping will. What is
 * proved: a role resolves only from the reading (N-P14-2), a version retired after
 * its assignment is refused with the proposal to migrate (N-P14A-13), transport
 * admission is decided here because the door cannot see it (N-P14A-12), the vector
 * travels on every outcome (N-P14-3), and the function is pure (N-P14A-14).
 *
 * Nothing here reads a clock; every value is a literal.
 */

const MODEL_ONE = "claude-opus-5@2026-06-01";
const MODEL_TWO = "claude-sonnet-5@2026-06-01";
const HEAD = "a".repeat(64);

const WATERMARKS: readonly AssignmentWatermark[] = [
  { projectionName: "model_version_read_model", sourceStream: "registry_events", appliedThroughSequence: 3, eventCount: 3, sourceHeadSha256: HEAD },
  { projectionName: "routing_assignment_read_model", sourceStream: "initiative_events", appliedThroughSequence: 0, eventCount: 0, sourceHeadSha256: "0".repeat(64) },
  { projectionName: "routing_assignment_read_model", sourceStream: "registry_events", appliedThroughSequence: 3, eventCount: 3, sourceHeadSha256: HEAD },
];

function version(overrides: Partial<AssignmentModelVersion> = {}): AssignmentModelVersion {
  return {
    modelVersionId: MODEL_ONE,
    provider: "claude",
    model: "claude-opus-5",
    release: "2026-06-01",
    status: "ACTIVE",
    eligibleRoles: ["implementer", "reviewer"],
    transports: ["CLI_SUBSCRIPTION"],
    ...overrides,
  };
}

function reading(overrides: Partial<AssignmentReading> = {}): AssignmentReading {
  return {
    assignment: {
      assignmentId: "routing:GLOBAL:implementer:0#1",
      version: 1,
      role: "implementer",
      slot: 0,
      provider: "claude",
      modelVersionId: MODEL_ONE,
    },
    fallbacks: [MODEL_TWO],
    modelVersion: version(),
    watermarks: WATERMARKS,
    ...overrides,
  };
}

const REQUEST: AssignmentRequest = { role: "implementer", slot: 0, transportKind: "CLI_SUBSCRIPTION" };

function refusal(outcome: AssignmentOutcome): [string, string, string | null] {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("resolved");
  return [outcome.reason, outcome.at, outcome.proposal];
}

describe("a role resolves from the registry alone, or not at all", () => {
  it("resolves an ACTIVE, eligible, admitted version, carrying the fallbacks and the vector it was read at", () => {
    const outcome = resolveAssignment(REQUEST, reading());
    expect(outcome).toEqual({
      ok: true,
      role: "implementer",
      slot: 0,
      transportKind: "CLI_SUBSCRIPTION",
      assignmentId: "routing:GLOBAL:implementer:0#1",
      assignmentVersion: 1,
      provider: "claude",
      modelVersionId: MODEL_ONE,
      model: "claude-opus-5",
      release: "2026-06-01",
      fallbacks: [MODEL_TWO],
      watermarks: WATERMARKS,
    });
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it("N-P14-2 / N-P14A-10: no assignment in force is refused, with no default and the vector kept", () => {
    const outcome = resolveAssignment(REQUEST, reading({ assignment: null, fallbacks: [], modelVersion: null }));
    expect(refusal(outcome)).toEqual(["ASSIGNMENT_ABSENT", "request.role", null]);
    if (!outcome.ok) expect(outcome.watermarks).toEqual(WATERMARKS);
  });

  it("N-P14A-13: a version retired after its assignment was admitted is refused, and proposes migration", () => {
    expect(refusal(resolveAssignment(REQUEST, reading({ modelVersion: version({ status: "RETIRED" }) })))).toEqual([
      "MODEL_VERSION_RETIRED",
      "reading.modelVersion.status",
      "MIGRATE_TO_ACTIVE_MODEL_VERSION",
    ]);
    // Never degraded to a fallback in silence: the fallbacks are ACTIVE, and the answer is still a refusal.
    expect(refusal(resolveAssignment(REQUEST, reading({ modelVersion: version({ status: "DEPRECATED" }) })))).toEqual([
      "MODEL_VERSION_DEPRECATED",
      "reading.modelVersion.status",
      null,
    ]);
  });

  it("refuses a version the registry does not hold, a role it does not declare eligible, and a provider that disagrees", () => {
    expect(refusal(resolveAssignment(REQUEST, reading({ modelVersion: null })))).toEqual([
      "MODEL_VERSION_UNKNOWN",
      "reading.assignment.modelVersionId",
      null,
    ]);
    expect(refusal(resolveAssignment(REQUEST, reading({ modelVersion: version({ eligibleRoles: ["reviewer"] }) })))).toEqual([
      "ROLE_NOT_ELIGIBLE",
      "request.role",
      null,
    ]);
    expect(refusal(resolveAssignment(REQUEST, reading({ modelVersion: version({ provider: "codex" }) })))).toEqual([
      "ASSIGNMENT_PROVIDER_MISMATCH",
      "reading.assignment.provider",
      null,
    ]);
  });

  it("N-P14A-12: refuses a transport the version does not admit, for every transport outside its list", () => {
    for (const transportKind of TRANSPORT_KINDS) {
      const outcome = resolveAssignment({ ...REQUEST, transportKind }, reading());
      if (transportKind === "CLI_SUBSCRIPTION") {
        expect(outcome.ok, transportKind).toBe(true);
      } else {
        expect(refusal(outcome), transportKind).toEqual(["TRANSPORT_NOT_ADMITTED", "request.transportKind", null]);
      }
    }
  });

  it("refuses a reading that does not describe the question, or carries no vector", () => {
    expect(refusal(resolveAssignment(REQUEST, reading({ watermarks: [] })))).toEqual([
      "ASSIGNMENT_READING_INVALID",
      "reading.watermarks",
      null,
    ]);
    expect(
      refusal(resolveAssignment(REQUEST, reading({ watermarks: [{ ...WATERMARKS[0], sourceHeadSha256: "head" } as AssignmentWatermark] }))),
    ).toEqual(["ASSIGNMENT_READING_INVALID", "reading.watermarks", null]);
    expect(refusal(resolveAssignment({ ...REQUEST, role: "reviewer" }, reading()))).toEqual([
      "ASSIGNMENT_READING_INVALID",
      "reading.assignment.role",
      null,
    ]);
    expect(refusal(resolveAssignment({ ...REQUEST, slot: 1 }, reading()))).toEqual([
      "ASSIGNMENT_READING_INVALID",
      "reading.assignment.slot",
      null,
    ]);
    expect(refusal(resolveAssignment(REQUEST, reading({ modelVersion: version({ modelVersionId: MODEL_TWO }) })))).toEqual([
      "ASSIGNMENT_READING_INVALID",
      "reading.modelVersion.modelVersionId",
      null,
    ]);
    expect(refusal(resolveAssignment(REQUEST, reading({ modelVersion: version({ status: "SUNSET" }) })))).toEqual([
      "ASSIGNMENT_READING_INVALID",
      "reading.modelVersion.status",
      null,
    ]);
  });

  it("refuses a request outside the vocabularies, by path and never by value", () => {
    const cases: readonly [AssignmentRequest, string][] = [
      [{ ...REQUEST, role: "wizard" as AssignmentRequest["role"] }, "request.role"],
      [{ ...REQUEST, slot: -1 }, "request.slot"],
      [{ ...REQUEST, slot: 0.5 }, "request.slot"],
      [{ ...REQUEST, transportKind: "PIGEON" as AssignmentRequest["transportKind"] }, "request.transportKind"],
    ];
    for (const [request, at] of cases) {
      const outcome = resolveAssignment(request, reading());
      expect(refusal(outcome), at).toEqual(["ASSIGNMENT_REQUEST_INVALID", at, null]);
      expect(JSON.stringify(outcome), at).not.toContain("wizard");
      expect(JSON.stringify(outcome), at).not.toContain("PIGEON");
    }
    expect(WORKER_ROLES).toContain(REQUEST.role);
  });

  it("names a closed set of refusals, each one reachable", () => {
    expect(ASSIGNMENT_REFUSALS).toEqual([
      "ASSIGNMENT_REQUEST_INVALID",
      "ASSIGNMENT_READING_INVALID",
      "ASSIGNMENT_ABSENT",
      "MODEL_VERSION_UNKNOWN",
      "MODEL_VERSION_RETIRED",
      "MODEL_VERSION_DEPRECATED",
      "ROLE_NOT_ELIGIBLE",
      "TRANSPORT_NOT_ADMITTED",
      "ASSIGNMENT_PROVIDER_MISMATCH",
    ]);
    expect(Object.isFrozen(ASSIGNMENT_REFUSALS)).toBe(true);
  });
});

describe("the resolver is pure and reads the registry alone (N-P14A-14)", () => {
  const HERE = fileURLToPath(new URL(".", import.meta.url));
  const read = (relativePath: string): string =>
    readFileSync(resolve(HERE, relativePath), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  const SOURCE = readFileSync(resolve(HERE, "../../src/assignment/index.ts"), "utf8");
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  /**
   * The whole **concept**: the module and its type leaf.
   *
   * The isolation law below is a fact about the concept, not about one of its
   * files, so it is read off both (owner law §7.1: a concept's declarations live
   * in its `types/` leaf, and §7.2: the mirror respects the same division;
   * C-3 / P-37 seam 1, adjudication v2). The type separation moved declarations
   * *within* the concept, so a pin that reads only `index.ts` measures the wrong
   * container.
   */
  const CONCEPT = CODE + "\n" + read("../../src/assignment/types/index.ts");

  it("imports the kernel's vocabularies and nothing else, across the whole concept: no ledger, no policy, no filesystem", () => {
    const specifiers = [...CONCEPT.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    // The allowlist this law always carried, plus the sibling leaf — the one
    // addition a type seam can make. Nothing foreign is newly permitted.
    expect(new Set(specifiers)).toEqual(new Set(["@acp/contracts", "./types/index.js"]));
  });

  it("reads no clock and no environment", () => {
    for (const token of ["Date", "performance.now", "process.", "hrtime", "Math.random"]) {
      expect(CODE, token).not.toContain(token);
    }
  });

  it("gives the same outcome for the same input, and does not mutate it", () => {
    const input = reading();
    const snapshot = JSON.stringify(input);
    expect(resolveAssignment(REQUEST, input)).toEqual(resolveAssignment(REQUEST, input));
    resolveAssignment({ ...REQUEST, transportKind: "API_KEY" }, input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("is exported from the package root, beside the legacy path it does not use", () => {
    expect(accounts.resolveAssignment).toBe(resolveAssignment);
    expect(accounts.ASSIGNMENT_REFUSALS).toBe(ASSIGNMENT_REFUSALS);
    expect(typeof accounts.resolveRoute).toBe("function");
  });
});

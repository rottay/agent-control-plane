import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildIdempotencyKey } from "@acp/contracts";

import { OBSERVATION_KINDS, observationRootPath } from "../../../src/roots/index.js";
import { SCENARIO_MAX_EVENTS, collectScenario } from "../../../src/collect/scenario/index.js";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

function makeRoots(): void {
  for (const kind of OBSERVATION_KINDS) {
    mkdirSync(observationRootPath(kind), { recursive: true, mode: 0o700 });
  }
}

function removeRoots(): void {
  rmSync(join(REPO_ROOT, ".acp-local", "shadow"), { recursive: true, force: true });
}

afterEach(() => {
  removeRoots();
});

/** One step of a synthetic, frozen-vocabulary task lifecycle. */
function makeEventRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const taskId = (overrides["taskId"] as string | undefined) ?? randomUUID();
  const attempt = 1;
  const transitionId = (overrides["transitionId"] as string | undefined) ?? "discover";
  return {
    contractVersion: "1.0.0",
    eventId: randomUUID(),
    taskId,
    attempt,
    transitionId,
    idempotencyKey: buildIdempotencyKey({ taskId, attempt, transitionId }),
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "kimi/k3/coordinator/01",
    occurredAt: "2026-08-27T12:00:00.000Z",
    recordedAt: "2026-08-27T12:00:00.000Z",
    correlationId: null,
    causationId: null,
    payload: {},
    ...overrides,
  };
}

/** A short two-step synthetic chain: discovered, then classified. */
function makeChain(taskId: string): Record<string, unknown>[] {
  return [
    makeEventRecord({ taskId, transitionId: "discover", type: "TASK_DISCOVERED", toState: "DISCOVERED" }),
    makeEventRecord({
      taskId,
      transitionId: "classify",
      type: "TASK_CLASSIFIED",
      fromState: "DISCOVERED",
      toState: "DT_CLASSIFIED",
    }),
  ];
}

function writeScenario(name: string, content: string): void {
  const path = join(observationRootPath("scenarios"), name);
  writeFileSync(path, content);
  chmodSync(path, 0o600);
}

describe("collecting one synthetic scenario", () => {
  it("admits, reads and validates a synthetic task-lifecycle chain", () => {
    makeRoots();
    const taskId = randomUUID();
    writeScenario("chain.json", JSON.stringify(makeChain(taskId)));

    const collected = collectScenario("chain.json");
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(collected.scenario.events).toHaveLength(2);
    expect(collected.scenario.events[0]).toMatchObject({ type: "TASK_DISCOVERED", taskId });
    expect(collected.scenario.events[1]).toMatchObject({ type: "TASK_CLASSIFIED", taskId });
  });

  it("refuses malformed JSON", () => {
    makeRoots();
    writeScenario("broken.json", "[ not json");
    expect(collectScenario("broken.json")).toMatchObject({ ok: false, reason: "MALFORMED_JSON" });
  });

  it("propagates admission refusals unchanged", () => {
    removeRoots();
    expect(collectScenario("chain.json")).toMatchObject({ ok: false, reason: "ROOT_ABSENT" });

    makeRoots();
    expect(collectScenario("missing.json")).toMatchObject({ ok: false, reason: "NOT_OWNED_FILE" });
  });

  it("refuses an oversized scenario on admission", () => {
    makeRoots();
    writeScenario("big.json", "[" + "1,".repeat(3_000_000) + "1]");
    expect(collectScenario("big.json")).toMatchObject({ ok: false, reason: "TOO_LARGE" });
  });

  it("refuses a payload that carries credential or transcript material anywhere in the chain", () => {
    makeRoots();
    const taskId = randomUUID();
    const chain = makeChain(taskId);
    chain[1] = { ...chain[1], payload: { sessionToken: "placeholder" } };
    writeScenario("tainted.json", JSON.stringify(chain));

    const result = collectScenario("tainted.json");
    expect(result).toMatchObject({ ok: false, reason: "CONTRACT_INVALID" });
    if (!result.ok) {
      expect(result.detail).toContain("scenario event at index 1");
      expect(result.detail).toContain("credential material is forbidden");
    }
  });

  it("refuses a JSON document that is not an array of events", () => {
    makeRoots();
    writeScenario("object.json", JSON.stringify(makeEventRecord()));
    expect(collectScenario("object.json")).toMatchObject({ ok: false, reason: "WRONG_SHAPE" });

    writeScenario("empty.json", "[]");
    expect(collectScenario("empty.json")).toMatchObject({ ok: false, reason: "WRONG_SHAPE" });

    writeScenario("mixed.json", JSON.stringify([makeEventRecord(), "not an event"]));
    const mixedResult = collectScenario("mixed.json");
    expect(mixedResult).toMatchObject({ ok: false, reason: "WRONG_SHAPE" });
    if (!mixedResult.ok) expect(mixedResult.detail).toContain("scenario event at index 1");
  });

  it("refuses a chain event whose type is outside the frozen vocabulary", () => {
    makeRoots();
    const taskId = randomUUID();
    const chain = makeChain(taskId);
    chain[1] = { ...chain[1], type: "NOT_ONE_OF_THE_TWENTY_ONE" };
    writeScenario("bad-type.json", JSON.stringify(chain));

    const result = collectScenario("bad-type.json");
    expect(result).toMatchObject({ ok: false, reason: "CONTRACT_INVALID" });
  });

  it("refuses a scenario past the event count bound", () => {
    makeRoots();
    const taskId = randomUUID();
    const events = Array.from({ length: SCENARIO_MAX_EVENTS + 1 }, (_, index) =>
      makeEventRecord({ taskId, transitionId: "step-" + String(index) }),
    );
    writeScenario("too-many.json", JSON.stringify(events));

    expect(collectScenario("too-many.json")).toMatchObject({ ok: false, reason: "TOO_LARGE" });
  });
});

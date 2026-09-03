import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExecutionEvent,
  ExecutionRefused,
  ExecutionRequest,
  ExecutionSession,
  ModelExecutionPort,
  ResolvedRoute,
} from "@acp/contracts";
import { canonicalJsonStringify, openLedger } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import type { DurableInvocation } from "../../src/contracts/index.js";
import { deterministicUuid, operationDigest } from "../../src/core/coordinates/index.js";
import { operationForStep } from "../../src/core/events/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN } from "../../src/core/lifecycle/index.js";
import { appendPlanStep, closeIntent } from "../../src/core/step-executor/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import { PostconditionUnknownError } from "../../src/errors/index.js";
import { ExecutionEffectError, createExecutionEffects } from "../../src/execution-effects/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";

/**
 * Evidence for the execution-backed effect port (V2-B1b, stage 2).
 *
 * The port under the effects is a structural fake: no provider, no process, no
 * providers package anywhere in this file. What is proved is the effect
 * module's own law -- evidence only after a completed terminal, the toy's
 * three verdicts preserved, refusals classified and never recorded as done,
 * idempotence by evidence, and `closeIntent` unchanged in meaning over it.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const MODULE = resolve(HERE, "../../src/execution-effects/index.ts");
const BARREL = resolve(HERE, "../../src/index.ts");
const SRC = resolve(HERE, "../../src");

const AT = "2026-08-30T15:00:00.000Z";
const EMITTED_BY = "claude/opus/implementer/01";
const INITIATIVE_ID = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";
const TOKENS = 1_234;

const ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-effects",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "test.1",
  resolvedAt: AT,
};

function invocationFor(taskId: string): DurableInvocation {
  return {
    taskId,
    attempt: 1,
    invocationId: deterministicUuid("inv/" + taskId),
    submittedAt: "2026-08-27T12:00:00.000Z",
    submissionDigest: "e".repeat(64),
  };
}

function requestFor(invocation: DurableInvocation): ExecutionRequest {
  return { taskId: invocation.taskId, attempt: invocation.attempt, identity: EMITTED_BY, reattach: null };
}

/** The intersection trail every transport can produce, terminal included. */
const COMPLETED_TRAIL: readonly ExecutionEvent[] = [
  { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
  { kind: "usage", stepIndex: 1, tokensUsed: TOKENS },
  { kind: "state", toState: "TURN_COMPLETED" },
  { kind: "completed", stepIndex: 1 },
];

interface FakeScript {
  /** A refusal returned by `start`, instead of a session. */
  readonly refuse?: ExecutionRefused;
  readonly events?: readonly ExecutionEvent[];
}

/** A port that records how often it was asked to start, and speaks a script. */
function fakePort(script: FakeScript, calls: { starts: number }): ModelExecutionPort {
  return {
    start: (route, request) => {
      calls.starts += 1;
      if (script.refuse !== undefined) return Promise.resolve(script.refuse);
      const events = script.events ?? COMPLETED_TRAIL;
      const session: ExecutionSession = {
        ok: true,
        sessionId: request.taskId + "/" + String(request.attempt) + "/" + route.accountId,
        route,
        // eslint-disable-next-line @typescript-eslint/require-await
        events: async function* (): AsyncIterable<ExecutionEvent> {
          for (const event of events) yield event;
        },
      };
      return Promise.resolve(session);
    },
    interrupt: () => Promise.resolve(),
    healthProbe: () =>
      Promise.resolve({ status: "UNKNOWN" as const, checkedAt: AT, latencyMs: null, classifiedError: null }),
  };
}

const scenarios: string[] = [];
const ledgers: Ledger[] = [];

function scenario(name: string): ScenarioRoot {
  scenarios.push(name);
  return resolveScenarioRoot(name);
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // already closed
    }
  }
  for (const name of scenarios.splice(0)) removeScenarioRoot(name);
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function markerFiles(root: ScenarioRoot): string[] {
  const home = join(root, "executions");
  return existsSync(home) ? readdirSync(home).sort() : [];
}

function effectsFor(name: string, taskId: string, script: FakeScript = {}) {
  const root = scenario(name);
  const invocation = invocationFor(taskId);
  const calls = { starts: 0 };
  const effects = createExecutionEffects({
    port: fakePort(script, calls),
    route: ROUTE,
    request: requestFor(invocation),
    scenarioRoot: root,
  });
  const operation = operationForStep(invocation, INTENT_STEP);
  return { root, invocation, calls, effects, operation };
}

/** Comment-stripped source, for the assertions about what a module names. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("the execution-backed effect port", () => {
  it("records evidence only after a completed terminal, and the probe then says DONE", async () => {
    const { root, calls, effects, operation } = effectsFor("exec-effects-done", "10101010-1010-4101-8101-202020202001");

    // Before anything ran: no marker, and the probe created nothing to say so.
    expect(await effects.probe(operation)).toBe("NOT_DONE");
    expect(existsSync(join(root, "executions"))).toBe(false);
    expect(calls.starts).toBe(0);

    await effects.apply(operation);
    expect(calls.starts).toBe(1);
    expect(markerFiles(root)).toEqual([operation.operationId + ".json"]);

    // The marker carries the operation's digest and the digest of the canonical
    // trail, terminal included, and nothing else this module did not write.
    const marker: unknown = JSON.parse(readFileSync(join(root, "executions", operation.operationId + ".json"), "utf8"));
    expect(marker).toEqual({
      eventCount: COMPLETED_TRAIL.length,
      operationDigest: operationDigest(operation),
      operationId: operation.operationId,
      trailSha256: sha256(canonicalJsonStringify(COMPLETED_TRAIL)),
    });
    expect(await effects.probe(operation)).toBe("DONE");
  });

  it("is idempotent by evidence: a verified marker starts no second execution", async () => {
    const { root, calls, effects, operation } = effectsFor("exec-effects-idempotent", "10101010-1010-4101-8101-202020202002");
    await effects.apply(operation);
    const before = readFileSync(join(root, "executions", operation.operationId + ".json"), "utf8");

    await effects.apply(operation);
    await effects.apply(operation);
    expect(calls.starts).toBe(1);
    expect(readFileSync(join(root, "executions", operation.operationId + ".json"), "utf8")).toBe(before);
    expect(await effects.probe(operation)).toBe("DONE");
  });

  it("writes under the scenario's own executions/ home and never under the toy's effects/", async () => {
    const { root, effects, operation } = effectsFor("exec-effects-home", "10101010-1010-4101-8101-202020202003");
    await effects.apply(operation);
    expect(existsSync(join(root, "effects"))).toBe(false);
    expect(markerFiles(root)).toHaveLength(1);
  });

  it("refuses a refused start, records nothing, and never says DONE", async () => {
    const { root, calls, effects, operation } = effectsFor("exec-effects-refused", "10101010-1010-4101-8101-202020202004", {
      refuse: { ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" },
    });

    await expect(effects.apply(operation)).rejects.toMatchObject({
      name: "ExecutionEffectError",
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "route.accountId",
    });
    await expect(effects.apply(operation)).rejects.toBeInstanceOf(ExecutionEffectError);
    expect(calls.starts).toBe(2);
    expect(existsSync(join(root, "executions"))).toBe(false);
    expect(await effects.probe(operation)).toBe("NOT_DONE");
  });

  it("refuses a stream that ends in error, carrying the event's own refusal", async () => {
    const { root, effects, operation } = effectsFor("exec-effects-error", "10101010-1010-4101-8101-202020202005", {
      events: [
        COMPLETED_TRAIL[0]!,
        { kind: "error", refusal: "CAPABILITY_UNSUPPORTED", detail: "the fake ended in error" },
      ],
    });
    await expect(effects.apply(operation)).rejects.toMatchObject({
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "events.error",
    });
    expect(markerFiles(root)).toEqual([]);
    expect(await effects.probe(operation)).toBe("NOT_DONE");
  });

  it("refuses a stream that ends without a terminal, as a transport failure", async () => {
    const { root, effects, operation } = effectsFor("exec-effects-no-terminal", "10101010-1010-4101-8101-202020202006", {
      events: [COMPLETED_TRAIL[0]!, COMPLETED_TRAIL[1]!],
    });
    await expect(effects.apply(operation)).rejects.toMatchObject({
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "events.terminal",
    });
    expect(markerFiles(root)).toEqual([]);
  });

  it("reports UNKNOWN for evidence it did not write, and refuses to overwrite it", async () => {
    const { root, calls, effects, operation } = effectsFor("exec-effects-foreign", "10101010-1010-4101-8101-202020202007");
    const home = join(root, "executions");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const target = join(home, operation.operationId + ".json");

    // A well-formed marker that some other operation wrote.
    const foreign = canonicalJsonStringify({
      eventCount: 4,
      operationDigest: "f".repeat(64),
      operationId: operation.operationId,
      trailSha256: "a".repeat(64),
    });
    writeFileSync(target, foreign, "utf8");
    expect(await effects.probe(operation)).toBe("UNKNOWN");
    await expect(effects.apply(operation)).rejects.toBeInstanceOf(PostconditionUnknownError);
    expect(calls.starts).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(foreign);

    // Bytes that are not a marker at all are UNKNOWN too, never absent.
    writeFileSync(target, "not a marker", "utf8");
    expect(await effects.probe(operation)).toBe("UNKNOWN");
    await expect(effects.apply(operation)).rejects.toBeInstanceOf(PostconditionUnknownError);
    expect(calls.starts).toBe(0);
  });

  it("preserves closeIntent's law end to end over a ledger", async () => {
    const { root, invocation, calls, effects, operation } = effectsFor(
      "exec-effects-close-intent",
      "10101010-1010-4101-8101-202020202008",
    );
    const ledger = openLedger(scenarioLedgerPath(root));
    ledgers.push(ledger);
    const context: BeatContext = {
      ledger,
      effects,
      invocation,
      emittedBy: EMITTED_BY,
      plan: LIFECYCLE_PLAN,
      initiativeId: INITIATIVE_ID,
    };
    for (const step of LIFECYCLE_PLAN.slice(0, INTENT_STEP.index + 1)) appendPlanStep(context, step);

    // Probe NOT_DONE -> apply (one execution) -> probe DONE -> append.
    const closed = await closeIntent(context);
    expect(closed.inserted).toBe(true);
    expect(calls.starts).toBe(1);
    expect(await effects.probe(operation)).toBe("DONE");
    expect(ledger.getEventByIdempotencyKey(invocation.taskId + "/1/run.outcome")).not.toBeNull();

    // A replay of the outcome beat appends nothing and executes nothing.
    const replayed = await closeIntent(context);
    expect(replayed.inserted).toBe(false);
    expect(calls.starts).toBe(1);
  });
});

describe("the module keeps its own laws", () => {
  it("imports nothing from the providers edge, reads no clock and spawns nothing", () => {
    const code = codeOf(MODULE);
    for (const forbidden of ["@acp/providers", "createExecutionPort", "Date.now", "new Date(", "Math.random", "node:child_process", "process.env"]) {
      expect({ forbidden, present: code.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
    // The runtime source tree as a whole names the providers edge nowhere: the
    // port is injected, and the factory never enters this stratum.
    for (const file of sourceFiles(SRC)) {
      expect({ file, present: codeOf(file).includes("@acp/providers") }).toEqual({ file, present: false });
    }
  });

  it("is exported from the barrel as exactly three names", () => {
    const barrel = codeOf(BARREL);
    expect(barrel).toContain("ExecutionEffectError");
    expect(barrel).toContain("createExecutionEffects");
    expect(barrel).toContain("ExecutionEffectsInput");
    const exported = [...barrel.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"\.\/execution-effects\/index\.js"/g)]
      .flatMap((match) => (match[1] ?? "").split(",").map((piece) => piece.trim()).filter((piece) => piece !== ""))
      .sort();
    expect(exported).toEqual(["ExecutionEffectError", "ExecutionEffectsInput", "createExecutionEffects"]);
  });
});

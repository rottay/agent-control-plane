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
import { PostconditionUnknownError, SupervisorError } from "../../src/errors/index.js";
import {
  ExecutionEffectError,
  createEvidenceProbe,
  createExecutionEffects,
} from "../../src/execution-effects/index.js";
import type {
  PressureSample,
  PressureSink,
  UsageSample,
  UsageSink,
} from "../../src/execution-effects/index.js";
import {
  removeScenarioRoot,
  resolveScenarioRoot,
  scenarioLedgerPath,
} from "../../src/toy/repository/index.js";
import type { ScenarioRoot } from "../../src/toy/repository/index.js";


/**
 * One admitted route for every fixture in this file (V2-B1c).
 *
 * A route is required, never defaulted, so every construction site states one.
 * It satisfies the contract's own refinement: a CLI_SUBSCRIPTION route names a
 * provider the kernel lists as one.
 */
const TEST_ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "opus",
  accountId: "acct-fixture",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: "2026-08-27T12:00:00.000Z",
};

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
  return {
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    identity: EMITTED_BY,
    instructions: "run the effects the test asked for",
    reattach: null,
  };
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

function effectsFor(name: string, taskId: string, script: FakeScript = {}, recordUsage?: UsageSink) {
  const root = scenario(name);
  const invocation = invocationFor(taskId);
  const calls = { starts: 0 };
  const effects = createExecutionEffects({
    port: fakePort(script, calls),
    route: ROUTE,
    request: requestFor(invocation),
    scenarioRoot: root,
    ...(recordUsage === undefined ? {} : { recordUsage }),
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
      route: TEST_ROUTE,
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

  it("is exported from the barrel as exactly eight names", () => {
    // Three until V2-B7T; the usage sink added exactly two, both types, V2 L2
    // added the reader half of the port, and V2-B1f's pressure sink added its
    // own pair for the symmetry the usage pair set. Pinned by equality in both
    // directions, so a name that arrives in the barrel without arriving here
    // fails, and so does the reverse.
    const barrel = codeOf(BARREL);
    expect(barrel).toContain("ExecutionEffectError");
    expect(barrel).toContain("createExecutionEffects");
    expect(barrel).toContain("ExecutionEffectsInput");
    const exported = [...barrel.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"\.\/execution-effects\/index\.js"/g)]
      .flatMap((match) => (match[1] ?? "").split(",").map((piece) => piece.trim()).filter((piece) => piece !== ""))
      .sort();
    expect(exported).toEqual([
      "ExecutionEffectError",
      "ExecutionEffectsInput",
      "PressureSample",
      "PressureSink",
      "UsageSample",
      "UsageSink",
      "createEvidenceProbe",
      "createExecutionEffects",
    ]);
  });
});

// ---------------------------------------------------------------------------
// V2-B7T: the usage sink, and the ordering that makes it crash-safe
// ---------------------------------------------------------------------------

/**
 * The sink runs between the execution and the marker, and that is the whole
 * crash-safety argument rather than a preference.
 *
 * `closeIntent` probes first and, on `DONE`, appends the outcome **without**
 * re-entering `apply`. So a resumed walk that finds a verified marker never
 * calls `apply` again — and a sink placed after the marker write would be
 * permanently unreachable on exactly the window it exists to cover. Placed
 * before it, and called synchronously, a throwing sink leaves no marker, the
 * probe answers `NOT_DONE`, and the effect re-executes.
 *
 * The invariant: a verified evidence marker implies a recorded usage event.
 */
const B7T_TASKS = [
  "b7700000-0000-4000-8000-000000000001",
  "b7700000-0000-4000-8000-000000000002",
  "b7700000-0000-4000-8000-000000000003",
  "b7700000-0000-4000-8000-000000000004",
  "b7700000-0000-4000-8000-000000000005",
] as const;

const MULTI_USAGE_TRAIL: readonly ExecutionEvent[] = [
  { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
  { kind: "usage", stepIndex: 1, tokensUsed: 11 },
  { kind: "usage", stepIndex: 2, tokensUsed: 22 },
  { kind: "state", toState: "TURN_COMPLETED" },
  { kind: "completed", stepIndex: 2 },
];

describe("the usage sink (V2-B7T)", () => {
  it("is called once per trail usage entry, carrying the step's own index (D-B7T-1)", async () => {
    const seen: UsageSample[] = [];
    const staged = effectsFor("b7t-sink-per-entry", B7T_TASKS[0], { events: MULTI_USAGE_TRAIL }, (sample) => {
      seen.push(sample);
    });

    await staged.effects.apply(staged.operation);

    // One per `usage` entry — not summed, not collapsed.
    expect(seen).toHaveLength(2);
    expect(seen.map((sample) => sample.stepIndex)).toEqual([1, 2]);
    expect(seen.map((sample) => sample.tokensUsed)).toEqual([11, 22]);
    // Every sample carries the operation's own plan index, so the identity the
    // recorder derives is unique within the attempt without a counter.
    expect(new Set(seen.map((sample) => sample.operationIndex))).toEqual(new Set([staged.operation.operationIndex]));
    // Non-usage entries are not offered to the sink.
    expect(seen).toHaveLength(MULTI_USAGE_TRAIL.filter((event) => event.kind === "usage").length);
  });

  it("runs before the marker is written", async () => {
    // Observed rather than read off the source: at the instant the sink runs,
    // the evidence home must still be empty.
    const order: string[] = [];
    const staged = effectsFor("b7t-sink-order", B7T_TASKS[1], {}, () => {
      order.push("sink:" + String(markerFiles(staged.root).length));
    });

    await staged.effects.apply(staged.operation);

    expect(order).toEqual(["sink:0"]);
    expect(markerFiles(staged.root)).toHaveLength(1);
  });

  it("N3: a throwing sink fails the apply closed, and no marker is written", async () => {
    const staged = effectsFor("b7t-sink-throws", B7T_TASKS[2], {}, () => {
      throw new Error("the recorder refused");
    });

    await expect(staged.effects.apply(staged.operation)).rejects.toThrow(/the recorder refused/);

    // No marker, so nothing claims the effect happened...
    expect(markerFiles(staged.root)).toHaveLength(0);
    // ...and the probe agrees.
    await expect(staged.effects.probe(staged.operation)).resolves.toBe("NOT_DONE");
  });

  it("re-executes after a failed sink, and records once when the sink recovers", async () => {
    // The K1 window in miniature: the first apply left no marker, so the walk
    // performs the effect again — and the ledger ends up with one observation
    // for the operation, not two.
    let failNext = true;
    const seen: UsageSample[] = [];
    const staged = effectsFor("b7t-sink-recovers", B7T_TASKS[3], {}, (sample) => {
      if (failNext) {
        failNext = false;
        throw new Error("transient");
      }
      seen.push(sample);
    });

    await expect(staged.effects.apply(staged.operation)).rejects.toThrow(/transient/);
    expect(markerFiles(staged.root)).toHaveLength(0);
    expect(seen).toHaveLength(0);

    await staged.effects.apply(staged.operation);
    expect(staged.calls.starts).toBe(2);
    expect(seen).toHaveLength(1);
    expect(markerFiles(staged.root)).toHaveLength(1);

    // A third apply finds the verified marker and does nothing at all.
    await staged.effects.apply(staged.operation);
    expect(staged.calls.starts).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it("stays optional, so the drill children keep building this port unchanged", async () => {
    const staged = effectsFor("b7t-sink-absent", B7T_TASKS[4]);
    await expect(staged.effects.apply(staged.operation)).resolves.toBeUndefined();
    expect(markerFiles(staged.root)).toHaveLength(1);
    await expect(staged.effects.probe(staged.operation)).resolves.toBe("DONE");
  });

  it("still opens no ledger and appends nothing", () => {
    // The precise claim, and not a wider one: this module has imported
    // `canonicalJsonStringify` from `@acp/ledger` since B1b, to digest its own
    // marker. What it must never gain is ledger ACCESS — it records spend by
    // calling an injected function, and the append happens in the daemon.
    const code = codeOf(MODULE);
    expect(code).toContain("canonicalJsonStringify");
    for (const forbidden of [
      "openLedger",
      "recordTokenObservation",
      "recordProviderPressure",
      "LedgerPort",
      ".append(",
    ]) {
      expect({ forbidden, present: code.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});

// ---------------------------------------------------------------------------
// V2-B1f: the pressure sink, and where each sample's provider comes from
// ---------------------------------------------------------------------------

/**
 * The sink runs in the same window as the spend sink and before the marker,
 * for the identical reason: what the provider said about the account is
 * evidence, and evidence written after the marker is evidence a resumed walk
 * never writes.
 *
 * Two trail kinds reach it and only one of them carries a provider. A
 * `pressure` event carries the adapter's own, filled by the port from the
 * normalized event; an `authRequired` event carries none, and the module
 * supplies the route's — which the port's own guard makes the same value for
 * any session that opened.
 */
const B1F_TASKS = [
  "b1f00000-0000-4000-8000-000000000001",
  "b1f00000-0000-4000-8000-000000000002",
  "b1f00000-0000-4000-8000-000000000003",
  "b1f00000-0000-4000-8000-000000000004",
  "b1f00000-0000-4000-8000-000000000005",
  "b1f00000-0000-4000-8000-000000000006",
  "b1f00000-0000-4000-8000-000000000007",
] as const;

/** A route the API leg serves: an opaque provider, outside the CLI list. */
const API_ROUTE: ResolvedRoute = {
  provider: "anthropic-api",
  model: "claude-opus-5",
  accountId: "acct-api",
  transportKind: "API_KEY",
  capabilityPolicyVersion: "policy-fixture-1",
  resolvedAt: AT,
};

const PRESSURE_TRAIL: readonly ExecutionEvent[] = [
  { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
  { kind: "authRequired", reason: "LOGIN_REQUIRED" },
  { kind: "usage", stepIndex: 1, tokensUsed: TOKENS },
  { kind: "pressure", provider: "codex", pressure: "QUOTA_EXHAUSTED" },
  { kind: "state", toState: "TURN_COMPLETED" },
  { kind: "completed", stepIndex: 1 },
];

function pressureEffectsFor(
  name: string,
  taskId: string,
  script: FakeScript,
  recordPressure?: PressureSink,
  route: ResolvedRoute = ROUTE,
) {
  const root = scenario(name);
  const invocation = invocationFor(taskId);
  const calls = { starts: 0 };
  const effects = createExecutionEffects({
    port: fakePort(script, calls),
    route,
    request: requestFor(invocation),
    scenarioRoot: root,
    ...(recordPressure === undefined ? {} : { recordPressure }),
  });
  const operation = operationForStep(invocation, INTENT_STEP);
  return { root, invocation, calls, effects, operation };
}

describe("the pressure sink (V2-B1f)", () => {
  it("is called once per observed frame, at the frame's own trail position", async () => {
    const seen: PressureSample[] = [];
    const staged = pressureEffectsFor(
      "b1f-sink-per-frame",
      B1F_TASKS[0],
      { events: PRESSURE_TRAIL },
      (sample) => {
        seen.push(sample);
      },
    );

    await staged.effects.apply(staged.operation);

    expect(seen).toHaveLength(2);
    // The trail position, never a provider-reported ordinal: two frames in one
    // stream are two facts and must not collide on one durable name.
    expect(seen.map((sample) => sample.trailIndex)).toEqual([1, 3]);
    expect(seen.map((sample) => sample.pressure)).toEqual(["AUTH_REQUIRED", "QUOTA_EXHAUSTED"]);
    expect(new Set(seen.map((sample) => sample.operationIndex))).toEqual(
      new Set([staged.operation.operationIndex]),
    );
  });

  it("takes a pressure event's provider from the event and an auth event's from the route", async () => {
    const seen: PressureSample[] = [];
    const staged = pressureEffectsFor(
      "b1f-sink-providers",
      B1F_TASKS[1],
      { events: PRESSURE_TRAIL },
      (sample) => {
        seen.push(sample);
      },
    );

    await staged.effects.apply(staged.operation);

    // The route is claude's and the pressure event names codex: the fixture is
    // built so the two sources are distinguishable, and each sample takes the
    // one its kind actually carries. In production they cannot differ — the
    // port refuses ROUTE_INVALID before the session starts — but which value
    // is the source is exactly what this pins.
    expect(seen.map((sample) => sample.provider)).toEqual([ROUTE.provider, "codex"]);
  });

  it("records a non-CLI auth requirement under the route's own opaque provider", async () => {
    // Both non-CLI transports already put `authRequired` on the trail, and the
    // route's provider there is a bounded string outside the CLI list.
    // Dropping those samples would be a fail-open on evidence.
    const seen: PressureSample[] = [];
    const staged = pressureEffectsFor(
      "b1f-sink-api-leg",
      B1F_TASKS[2],
      {
        events: [
          { kind: "started", route: API_ROUTE, resolvedModel: "claude-opus-5", protocolVersion: "messages/1" },
          { kind: "authRequired", reason: "credentials rejected" },
          { kind: "completed", stepIndex: 0 },
        ],
      },
      (sample) => {
        seen.push(sample);
      },
      API_ROUTE,
    );

    await staged.effects.apply(staged.operation);

    expect(seen).toEqual([
      {
        operationIndex: staged.operation.operationIndex,
        trailIndex: 1,
        provider: "anthropic-api",
        pressure: "AUTH_REQUIRED",
      },
    ]);
  });

  it("offers nothing at all when the trail carries no pressure", async () => {
    const seen: PressureSample[] = [];
    const staged = pressureEffectsFor("b1f-sink-quiet", B1F_TASKS[3], {}, (sample) => {
      seen.push(sample);
    });
    await staged.effects.apply(staged.operation);
    expect(seen).toEqual([]);
    expect(markerFiles(staged.root)).toHaveLength(1);
  });

  it("runs before the marker is written", async () => {
    const order: string[] = [];
    const staged = pressureEffectsFor(
      "b1f-sink-order",
      B1F_TASKS[4],
      { events: PRESSURE_TRAIL },
      () => {
        order.push("sink:" + String(markerFiles(staged.root).length));
      },
    );

    await staged.effects.apply(staged.operation);

    expect(order).toEqual(["sink:0", "sink:0"]);
    expect(markerFiles(staged.root)).toHaveLength(1);
  });

  it("fails the apply closed when it throws, and the effect re-executes", async () => {
    const staged = pressureEffectsFor(
      "b1f-sink-throws",
      B1F_TASKS[5],
      { events: PRESSURE_TRAIL },
      () => {
        throw new Error("the pressure recorder refused");
      },
    );

    await expect(staged.effects.apply(staged.operation)).rejects.toThrow(
      /the pressure recorder refused/,
    );
    expect(markerFiles(staged.root)).toHaveLength(0);
    await expect(staged.effects.probe(staged.operation)).resolves.toBe("NOT_DONE");
  });

  it("stays optional, so the drill children keep building this port unchanged", async () => {
    const staged = pressureEffectsFor("b1f-sink-absent", B1F_TASKS[6], { events: PRESSURE_TRAIL });
    await expect(staged.effects.apply(staged.operation)).resolves.toBeUndefined();
    expect(markerFiles(staged.root)).toHaveLength(1);
    await expect(staged.effects.probe(staged.operation)).resolves.toBe("DONE");
  });
});

describe("the evidence probe", () => {
  it("reads the same evidence the full port writes, and agrees with it verdict for verdict", async () => {
    const staged = effectsFor("evidence-probe-agrees", "10101010-1010-4101-8101-202020202091");
    const probe = createEvidenceProbe(staged.root);

    // Absent: both say NOT_DONE, and neither creates anything to say it.
    expect(await probe.probe(staged.operation)).toBe("NOT_DONE");
    expect(await staged.effects.probe(staged.operation)).toBe("NOT_DONE");
    expect(existsSync(join(staged.root, "executions"))).toBe(false);

    // Written by the full port, read by this one. One evidence format, one
    // reader: the probe is not a second opinion about what a marker means.
    await staged.effects.apply(staged.operation);
    expect(await probe.probe(staged.operation)).toBe("DONE");
    expect(await staged.effects.probe(staged.operation)).toBe("DONE");
  });

  it("says UNKNOWN for somebody else's marker rather than ABSENT", async () => {
    const staged = effectsFor("evidence-probe-foreign", "10101010-1010-4101-8101-202020202092");
    const probe = createEvidenceProbe(staged.root);

    mkdirSync(join(staged.root, "executions"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(staged.root, "executions", staged.operation.operationId + ".json"),
      canonicalJsonStringify({
        operationId: staged.operation.operationId,
        operationDigest: "b".repeat(64),
        trailSha256: "c".repeat(64),
        eventCount: 1,
      }),
      "utf8",
    );

    // Not ABSENT, because absence would invite the caller to perform the effect
    // a second time; the cancellation path turns this into "append nothing".
    expect(await probe.probe(staged.operation)).toBe("UNKNOWN");
    expect(await staged.effects.probe(staged.operation)).toBe("UNKNOWN");
  });

  it("refuses to perform an effect, loudly and without recording one", async () => {
    const staged = effectsFor("evidence-probe-apply", "10101010-1010-4101-8101-202020202093");
    const probe = createEvidenceProbe(staged.root);

    await expect(probe.apply(staged.operation)).rejects.toThrow(SupervisorError);

    // A no-op `apply` would have been a port that reports success for work it
    // never did. Nothing was started and nothing was written.
    expect(staged.calls.starts).toBe(0);
    expect(existsSync(join(staged.root, "executions"))).toBe(false);
    expect(await probe.probe(staged.operation)).toBe("NOT_DONE");
  });

  it("needs no provider binding, no request and no route to be built", () => {
    // The measurement behind the CLI's whole claim to hold this port: its only
    // argument is the branded scenario root. A door that had to assemble a
    // `ModelExecutionPort` in order to ask a read-only question would be
    // assembling a provider binding to cancel a task.
    const probe = createEvidenceProbe(scenario("evidence-probe-arity"));
    expect(createEvidenceProbe.length).toBe(1);
    expect(Object.keys(probe).sort()).toEqual(["apply", "probe"]);
  });
});

// ---------------------------------------------------------------------------
// V2-B1f/F4a errata — a failed execution records what its trail already said
// ---------------------------------------------------------------------------

/**
 * Until this errata `execute` threw at each of its three refusal points, so a
 * fully built, contract-validated trail was discarded before `apply` reached
 * either drain. An execution ending in `error` — or with no terminal — recorded
 * neither the pressure nor the spend it had just observed, while an execution
 * that reported the same pressure and exited cleanly recorded both.
 *
 * These cases assert the new order and, just as importantly, that **nothing
 * else moved**: the same refusal at the same `at`, no conformance gate, no
 * marker, `probe → NOT_DONE`.
 */

const F4E_TASKS = [
  "f4e00000-0000-4000-8000-000000000001",
  "f4e00000-0000-4000-8000-000000000002",
  "f4e00000-0000-4000-8000-000000000003",
  "f4e00000-0000-4000-8000-000000000004",
  "f4e00000-0000-4000-8000-000000000005",
  "f4e00000-0000-4000-8000-000000000006",
  "f4e00000-0000-4000-8000-000000000007",
  "f4e00000-0000-4000-8000-000000000008",
  "f4e00000-0000-4000-8000-000000000009",
  "f4e00000-0000-4000-8000-00000000000a",
] as const;

/** A trail that observed pressure, spend and an auth requirement, then failed. */
const FAILED_TRAIL: readonly ExecutionEvent[] = [
  { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
  { kind: "pressure", provider: "codex", pressure: "QUOTA_EXHAUSTED" },
  { kind: "usage", stepIndex: 3, tokensUsed: TOKENS },
  { kind: "authRequired", reason: "LOGIN_REQUIRED" },
  { kind: "error", refusal: "CAPABILITY_UNSUPPORTED", detail: "the fake ended in error" },
];

/** The same observations, with the stream simply stopping. */
const NO_TERMINAL_TRAIL: readonly ExecutionEvent[] = [
  { kind: "started", route: ROUTE, resolvedModel: "claude-opus-5-20260115", protocolVersion: "stream-json/1" },
  { kind: "pressure", provider: "codex", pressure: "QUOTA_EXHAUSTED" },
  { kind: "usage", stepIndex: 3, tokensUsed: TOKENS },
];

/** A port with every sink and the gate, so one case can watch all of them. */
function erratumEffectsFor(
  name: string,
  taskId: string,
  script: FakeScript,
  sinks: {
    readonly recordUsage?: UsageSink;
    readonly recordPressure?: PressureSink;
    readonly checkConformance?: (operationIndex: number) => void;
  } = {},
) {
  const root = scenario(name);
  const invocation = invocationFor(taskId);
  const calls = { starts: 0 };
  const effects = createExecutionEffects({
    port: fakePort(script, calls),
    route: ROUTE,
    request: requestFor(invocation),
    scenarioRoot: root,
    ...(sinks.recordUsage === undefined ? {} : { recordUsage: sinks.recordUsage }),
    ...(sinks.recordPressure === undefined ? {} : { recordPressure: sinks.recordPressure }),
    ...(sinks.checkConformance === undefined ? {} : { checkConformance: sinks.checkConformance }),
  });
  const operation = operationForStep(invocation, INTENT_STEP);
  return { root, invocation, calls, effects, operation };
}

describe("F4a-E P1/P2: a failed execution records what its trail already said", () => {
  it("records the pressure and the spend, and still refuses identically", async () => {
    const pressure: PressureSample[] = [];
    const usage: UsageSample[] = [];
    const staged = erratumEffectsFor(
      "f4e-error-records",
      F4E_TASKS[0],
      { events: FAILED_TRAIL },
      {
        recordPressure: (sample) => {
          pressure.push(sample);
        },
        recordUsage: (sample) => {
          usage.push(sample);
        },
      },
    );

    // The refusal is unchanged: same name, same `at`, same class.
    await expect(staged.effects.apply(staged.operation)).rejects.toMatchObject({
      name: "ExecutionEffectError",
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "events.error",
    });

    // P1: the pressure the trail already carried is now recorded — one row per
    // observed frame, the exhaustion and the auth requirement alike.
    expect(pressure.map((sample) => sample.pressure)).toEqual([
      "QUOTA_EXHAUSTED",
      "AUTH_REQUIRED",
    ]);
    // P2: and the spend, on the ruling that the tokens were reported and the
    // ledger may under-report but never over-report.
    expect(usage.map((sample) => sample.tokensUsed)).toEqual([TOKENS]);

    // And nothing else moved.
    expect(markerFiles(staged.root)).toEqual([]);
    await expect(staged.effects.probe(staged.operation)).resolves.toBe("NOT_DONE");
  });

  it("P3: a stream that ends with no terminal records, then refuses as a transport failure", async () => {
    const pressure: PressureSample[] = [];
    const usage: UsageSample[] = [];
    const staged = erratumEffectsFor(
      "f4e-no-terminal-records",
      F4E_TASKS[1],
      { events: NO_TERMINAL_TRAIL },
      {
        recordPressure: (sample) => {
          pressure.push(sample);
        },
        recordUsage: (sample) => {
          usage.push(sample);
        },
      },
    );

    await expect(staged.effects.apply(staged.operation)).rejects.toMatchObject({
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "events.terminal",
    });
    expect(pressure.map((sample) => sample.pressure)).toEqual(["QUOTA_EXHAUSTED"]);
    expect(usage).toHaveLength(1);
    expect(markerFiles(staged.root)).toEqual([]);
  });

  it("P4: the durable names are the success path's, position for position", async () => {
    // The trail index and the reported step index are carried exactly as they
    // are on the success path, so a resumed attempt rebuilds the same durable
    // names and replays rather than double-recording.
    const pressure: PressureSample[] = [];
    const usage: UsageSample[] = [];
    const staged = erratumEffectsFor(
      "f4e-names",
      F4E_TASKS[2],
      { events: FAILED_TRAIL },
      {
        recordPressure: (sample) => {
          pressure.push(sample);
        },
        recordUsage: (sample) => {
          usage.push(sample);
        },
      },
    );

    await expect(staged.effects.apply(staged.operation)).rejects.toThrow(ExecutionEffectError);

    // The exhaustion sits at trail index 1 and the auth requirement at 3.
    expect(pressure.map((sample) => sample.trailIndex)).toEqual([1, 3]);
    expect(new Set(pressure.map((sample) => sample.operationIndex))).toEqual(
      new Set([staged.operation.operationIndex]),
    );
    // The spend carries the provider's own reported ordinal, not its position.
    expect(usage[0]?.stepIndex).toBe(3);
    expect(usage[0]?.operationIndex).toBe(staged.operation.operationIndex);
  });

  it("P5: an auth requirement on the error path resolves its provider from the route", async () => {
    const pressure: PressureSample[] = [];
    const staged = erratumEffectsFor(
      "f4e-auth-provider",
      F4E_TASKS[3],
      { events: FAILED_TRAIL },
      {
        recordPressure: (sample) => {
          pressure.push(sample);
        },
      },
    );

    await expect(staged.effects.apply(staged.operation)).rejects.toThrow(ExecutionEffectError);

    // Exactly the success path's rule: a pressure event carries its own
    // provider, an auth requirement carries none and takes the route's.
    expect(pressure.map((sample) => sample.provider)).toEqual(["codex", ROUTE.provider]);
  });
});

describe("F4a-E N1/N2: what the errata must not change", () => {
  it("N1: a refused start still records nothing at all", async () => {
    // The distinction that must survive: no stream existed, so there is no
    // observation to carry. An empty trail here is the absence of an
    // observation, never an observation of silence.
    const pressure: PressureSample[] = [];
    const usage: UsageSample[] = [];
    const staged = erratumEffectsFor(
      "f4e-refused-start",
      F4E_TASKS[4],
      { refuse: { ok: false, refusal: "TRANSPORT_UNAVAILABLE", at: "route.accountId" } },
      {
        recordPressure: (sample) => {
          pressure.push(sample);
        },
        recordUsage: (sample) => {
          usage.push(sample);
        },
      },
    );

    await expect(staged.effects.apply(staged.operation)).rejects.toMatchObject({
      refusal: "TRANSPORT_UNAVAILABLE",
      at: "route.accountId",
    });
    expect({ starts: staged.calls.starts, pressure: pressure.length, usage: usage.length }).toEqual({
      starts: 1,
      pressure: 0,
      usage: 0,
    });
    expect(markerFiles(staged.root)).toEqual([]);
  });

  it("N2: no conformance gate and no marker on the error path", async () => {
    // The gate deliberately still does not run: it records and revokes, and a
    // revocation here would confuse the settlement that is about to happen.
    let gateCalls = 0;
    const staged = erratumEffectsFor(
      "f4e-no-gate",
      F4E_TASKS[5],
      { events: FAILED_TRAIL },
      {
        recordPressure: () => undefined,
        checkConformance: () => {
          gateCalls += 1;
          throw new Error("the gate must not run on the error path");
        },
      },
    );

    await expect(staged.effects.apply(staged.operation)).rejects.toMatchObject({
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "events.error",
    });
    expect(gateCalls).toBe(0);
    expect(markerFiles(staged.root)).toEqual([]);
  });

  it("the sink runs before the refusal, observed rather than read off the source", async () => {
    // At the instant the sink runs, no marker exists and the refusal has not
    // been raised — which is the whole of the ordering this errata introduces.
    const order: string[] = [];
    const staged = erratumEffectsFor(
      "f4e-order",
      F4E_TASKS[6],
      { events: FAILED_TRAIL },
      {
        recordUsage: () => {
          order.push("usage");
        },
        recordPressure: () => {
          order.push("pressure:" + String(markerFiles(staged.root).length));
        },
      },
    );

    await expect(staged.effects.apply(staged.operation)).rejects.toThrow(ExecutionEffectError);
    expect(order).toEqual(["usage", "pressure:0", "pressure:0"]);
  });
});

describe("F4a-E N3: a throwing sink preempts the refusal, and leaves nothing behind", () => {
  it("propagates the sink's own error and writes no marker", async () => {
    // Stated honestly, because the objective's "the settlement stays exactly
    // as it is" is not quite true here: a recorder that throws on the error
    // path replaces the ExecutionEffectError with its own, and
    // `classifyFailure` refuses to settle a class it does not recognise — so
    // the walk propagates unsettled rather than settling FAILED.
    //
    // That is the rule the success path already follows and it is the
    // fail-closed direction: an unsettled walk is visible, where a silently
    // discarded observation was not.
    const staged = erratumEffectsFor(
      "f4e-sink-throws",
      F4E_TASKS[7],
      { events: FAILED_TRAIL },
      {
        recordPressure: () => {
          throw new SupervisorError("the recorder refused");
        },
      },
    );

    const raised = await staged.effects
      .apply(staged.operation)
      .then(() => null)
      .catch((error: unknown) => error);

    // The sink's error, not the execution's refusal.
    expect(raised).toBeInstanceOf(SupervisorError);
    expect(raised).not.toBeInstanceOf(ExecutionEffectError);
    // No marker, and the probe still says the effect has not happened.
    expect(markerFiles(staged.root)).toEqual([]);
    await expect(staged.effects.probe(staged.operation)).resolves.toBe("NOT_DONE");
  });
});

describe("F4a-E N4/N5/N6: the shapes this errata does not move", () => {
  it("N4: absent sinks are a no-op on the error path, exactly as before", async () => {
    // The drill children build this port with no sinks at all, which is what
    // keeps `packages/edges/durability/**` out of this packet's write-set.
    const staged = erratumEffectsFor("f4e-absent-sinks", F4E_TASKS[8], { events: FAILED_TRAIL });
    await expect(staged.effects.apply(staged.operation)).rejects.toMatchObject({
      refusal: "CAPABILITY_UNSUPPORTED",
      at: "events.error",
    });
    expect(markerFiles(staged.root)).toEqual([]);
    await expect(staged.effects.probe(staged.operation)).resolves.toBe("NOT_DONE");
  });

  it("N5: the error class still carries exactly a refusal and an `at`", async () => {
    // D1's guard. A trail on the error would be provider text one
    // `JSON.stringify` from a log line, and it would move twelve construction
    // sites; nothing downstream wants it, and nothing may take it.
    const staged = erratumEffectsFor("f4e-error-shape", F4E_TASKS[9], { events: FAILED_TRAIL });
    const raised = await staged.effects
      .apply(staged.operation)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(ExecutionEffectError);
    const error = raised as ExecutionEffectError & Record<string, unknown>;
    // `name` is the class's own identity, set in its constructor; `refusal`
    // and `at` are the whole of what it carries about the failure.
    expect(Object.keys(error).sort()).toEqual(["at", "name", "refusal"]);
    for (const forbidden of ["trail", "events", "detail", "outcome"]) {
      expect({ forbidden, present: forbidden in error }).toEqual({ forbidden, present: false });
    }
    // No provider text is reachable from the caught instance — the message
    // included, since that is what reaches a log line.
    const serialized = JSON.stringify({
      message: error.message,
      refusal: error.refusal,
      at: error.at,
      name: error.name,
    });
    for (const secret of ["the fake ended in error", "LOGIN_REQUIRED", "QUOTA_EXHAUSTED"]) {
      expect({ secret, leaked: serialized.includes(secret) }).toEqual({ secret, leaked: false });
    }

    // And the constructor is still two-argument everywhere it is built.
    const code = codeOf(MODULE);
    for (const match of code.matchAll(/new ExecutionEffectError\(([^)]*)\)/g)) {
      expect({ args: match[1], commas: (match[1] ?? "").split(",").length }).toEqual({
        args: match[1],
        commas: 2,
      });
    }
  });

  it("N6: no second classifier — no message parsed, no member re-derived", () => {
    // The request's own line. The classification is already on the trail as
    // events an adapter produced and the contract validated; this packet adds
    // no reader of `detail` and names no vocabulary member of its own.
    for (const file of sourceFiles(SRC)) {
      const code = codeOf(file);
      expect({ file, reads: code.includes(".detail") }).toEqual({ file, reads: false });
    }
    const effects = codeOf(MODULE);
    // The one pressure member this module may name is the auth constant the
    // sink supplies for an event that carries no provider of its own.
    const members = [...effects.matchAll(/"(QUOTA_EXHAUSTED|QUOTA_WARNING|TRANSIENT|UNCLASSIFIED)"/g)];
    expect(members.map((match) => match[1])).toEqual([]);
  });
});

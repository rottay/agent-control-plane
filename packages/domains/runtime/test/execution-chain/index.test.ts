import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT_VERSION, buildInitiativeIdempotencyKey } from "@acp/contracts";
import type {
  ExecutionEvent,
  ExecutionRequest,
  ExecutionSession,
  ModelExecutionPort,
  ResolvedRoute,
} from "@acp/contracts";
import {
  artifactBlobLeaseStorePath,
  canonicalJsonStringify,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
} from "@acp/ledger";
import type { ArtifactPlane, Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { INTAKE_ATTEMPT_OPENING_STEP, operationForStep } from "../../src/core/events/index.js";
import { INTENT_STEP, LIFECYCLE_PLAN, planStep } from "../../src/core/lifecycle/index.js";
import { appendPlanStep } from "../../src/core/step-executor/index.js";
import type { BeatContext } from "../../src/core/step-executor/index.js";
import { DispatchRefusedError, OperationFailedError, SupervisorError } from "../../src/errors/index.js";
import { evidenceRootFor } from "../../src/evidence-root/index.js";
import { createExecutionChain, deliveryIsOpen } from "../../src/execution-chain/index.js";
import type { ExecutionChain, ExecutionChainInput } from "../../src/execution-chain/index.js";
import { ExecutionEffectError, createExecutionEffects } from "../../src/execution-effects/index.js";
import { classifyFailure, settleFailure } from "../../src/failure/index.js";
import type { ScenarioRoot } from "../../src/index.js";
import { intakeTask } from "../../src/intake/index.js";
import { readRecordedTask } from "../../src/recorded-task/index.js";
import type { RecordedTask } from "../../src/recorded-task/index.js";
import { deriveInvocation } from "../../src/submission/index.js";

/**
 * Evidence for the execution chain (P-15 escalón D3, ADR 0105; decision 140).
 *
 * A task is entered through the real intake, read back by the recorded-task reader,
 * opened and walked to its INTENT step on a real ledger; then the effect port is
 * built with the chain's hooks over a structural fake port and applied once. What
 * is read back is the ledger itself: the chain's events in their order, the usage
 * stream and its one observation, the published result and the response, and no
 * legacy usage row. The negatives drive each refusal and assert what was — and was
 * not — appended.
 */

const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const TASK = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";
const CREATED_AT = "2026-09-01T00:00:00.000Z";
const REGISTRY_AT = "2026-09-03T12:00:00.000Z";
const AT = "2026-09-13T12:00:00.000Z";
const COORDINATOR = "kimi/k3/coordinator/01";
const OPERATOR = "claude/opus/implementer/01";
const MODEL = "claude-opus-5@2026-06-01";
const OTHER_MODEL = "claude-opus-5@2026-01-01";
const CATALOG = "catalog-d3";
const OBJECTIVE = "Echo this instruction back.";
const SESSION = "5e551011-0000-4000-8000-000000000001";

const ROUTE: ResolvedRoute = {
  provider: "claude",
  model: "claude-opus-5",
  accountId: "acct-chain",
  transportKind: "CLI_SUBSCRIPTION",
  capabilityPolicyVersion: "policy-1",
  resolvedAt: AT,
};

const USAGE_SOURCE: ExecutionChainInput["usageSource"] = {
  source: "claude-cli",
  sourceClass: "PROVIDER_AUTHORITATIVE",
  normalizationPolicySha256: "14cbb2a397762bfc4cfec2d00073bc26402d7c81123a2a8683fc007fa808fb0d",
};

const temporaryDirectories: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) {
    try {
      close();
    } catch {
      /* closed by the test */
    }
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface World {
  readonly ledger: Ledger;
  readonly plane: ArtifactPlane;
  readonly root: ScenarioRoot;
}

/** A real ledger in a canonical temporary root, its registry seeded, one catalog priced for `pricedModel`. */
function world(pricedModel: string | null = MODEL): World {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "acp-execution-chain-"));
  temporaryDirectories.push(directory);
  const ledgerPath = join(directory, "control-plane.sqlite");
  const ledger = openLedger(ledgerPath);
  const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(ledgerPath), {
    incarnationId: "11111111-1111-4111-8111-111111111111",
    createdAt: CREATED_AT,
  });
  const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath });
  closers.push(() => {
    leaseStore.close();
    ledger.close();
  });
  ledger.appendInitiativeEvent({
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    initiativeId: INITIATIVE,
    transitionId: "initiative.registered",
    idempotencyKey: buildInitiativeIdempotencyKey({ initiativeId: INITIATIVE, transitionId: "initiative.registered" }),
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: COORDINATOR,
    occurredAt: CREATED_AT,
    recordedAt: CREATED_AT,
    payload: {},
  });
  const document = (documentKind: string, documentId: string, payload: Record<string, unknown>): Record<string, unknown> => ({
    contractVersion: CONTRACT_VERSION,
    eventId: randomUUID(),
    idempotencyKey: documentId + "/1",
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    contentDigest: sha256(canonicalJsonStringify(payload)),
    recordedBy: COORDINATOR,
    effectiveFrom: REGISTRY_AT,
    occurredAt: REGISTRY_AT,
    recordedAt: REGISTRY_AT,
    payload,
  });
  for (const modelVersionId of [MODEL, OTHER_MODEL]) {
    ledger.appendRegistryEvent(
      document("MODEL_VERSION", modelVersionId, {
        provider: "claude",
        model: "claude-opus-5",
        release: modelVersionId.slice(modelVersionId.indexOf("@") + 1),
        status: "ACTIVE",
        contextTokens: 200000,
        policyVersion: "2026.09.0",
        deprecatedAt: null,
        eligibleRoles: ["implementer"],
        transports: ["CLI_SUBSCRIPTION"],
      }),
    );
  }
  ledger.appendRegistryEvent(
    document("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", {
      role: "implementer",
      slot: 0,
      provider: "claude",
      modelVersionId: MODEL,
      fallbacks: [],
    }),
  );
  if (pricedModel !== null) {
    ledger.appendRegistryEvent(
      document("PRICE_TABLE", CATALOG, {
        intervals: [
          {
            provider: "claude",
            modelVersionId: pricedModel,
            transportKind: "CLI_SUBSCRIPTION",
            tokenClass: "input",
            currency: "USD",
            effectiveFrom: REGISTRY_AT,
            effectiveTo: null,
            pricePerMillionNanos: 15_000_000_000,
          },
        ],
      }),
    );
  }
  const evidence = join(directory, "executions");
  mkdirSync(evidence, { mode: 0o700 });
  const admitted = evidenceRootFor(ledgerPath);
  if (!admitted.ok) throw new Error("the fixture's evidence root was refused: " + admitted.refusal);
  return { ledger, plane, root: admitted.root };
}

function envelope(): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    taskId: TASK,
    initiativeId: INITIATIVE,
    title: "Echo a task",
    objective: OBJECTIVE,
    content: {
      contentContractVersion: 1,
      blocks: [
        {
          kind: "text",
          blockId: "b1",
          mediaType: "text/plain; charset=utf-8",
          byteLength: new TextEncoder().encode(OBJECTIVE).byteLength,
          contentSha256: "0".repeat(64),
          artifactRefId: null,
          text: OBJECTIVE,
          toolCallId: null,
          effectId: null,
        },
      ],
    },
    classification: "MECHANICAL",
    issuedBy: COORDINATOR,
    issuedAt: CREATED_AT,
    authority: [],
    readSet: ["docs/chain.md"],
    writeSet: ["docs/chain.md"],
    conflictKeys: ["docs"],
    allowedCommands: [],
    forbiddenActions: [],
    output: { kind: "DIFF", description: "" },
    validation: { commands: [], independentVerifierRequired: false },
    eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
    budget: { maxTokens: 1000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 100 },
    visualEvidenceRequired: false,
    commitPolicy: "NO_COMMIT",
    checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 1 },
  };
}

/** Enter the task through the real intake, read it back, and walk it to its INTENT step. */
function walked(on: World): { readonly task: RecordedTask; readonly context: BeatContext } {
  const outcome = intakeTask({
    ledger: on.ledger,
    plane: on.plane,
    request: {
      envelope: envelope(),
      clientScope: OPERATOR,
      clientRequestKey: "chain-0001",
      roadmapVersionId: null,
      stepId: null,
      role: "implementer",
      slot: 0,
      transportKind: "CLI_SUBSCRIPTION",
      recordedBy: OPERATOR,
    },
    recordedAt: AT,
    holderPid: 5151,
    identities: {
      eventId: randomUUID(),
      revisionId: randomUUID(),
      commandId: randomUUID(),
      artifactPinId: randomUUID(),
      artifactReferenceId: randomUUID(),
      intentionEventId: randomUUID(),
      terminalEventId: randomUUID(),
    },
  });
  if (!outcome.ok) throw new Error("expected an intake, got " + outcome.reason);
  const read = readRecordedTask({ ledger: on.ledger, plane: on.plane, taskId: TASK, route: ROUTE });
  if (!read.ok) throw new Error("expected a recorded task, got " + read.refusal);
  const context: BeatContext = {
    ledger: on.ledger,
    effects: { apply: () => Promise.resolve(), probe: () => Promise.resolve("NOT_DONE" as const) },
    invocation: read.task.invocation,
    emittedBy: OPERATOR,
    plan: LIFECYCLE_PLAN,
    route: ROUTE,
    initiativeId: read.task.initiativeId,
  };
  appendPlanStep(context, INTAKE_ATTEMPT_OPENING_STEP);
  for (let index = 0; index <= INTENT_STEP.index; index += 1) appendPlanStep(context, planStep(index));
  return { task: read.task, context };
}

function chainFor(on: World, task: RecordedTask, overrides: Partial<ExecutionChainInput> = {}): ExecutionChain {
  return createExecutionChain({
    ledger: on.ledger,
    plane: on.plane,
    invocation: task.invocation,
    route: ROUTE,
    modelVersionId: task.resolution.modelVersionId,
    routingAssignmentId: task.resolution.assignmentId,
    catalogDocumentId: CATALOG,
    usageSource: USAGE_SOURCE,
    prompt: { promptSha256: sha256(OBJECTIVE), promptBytes: Buffer.byteLength(OBJECTIVE, "utf8") },
    emittedBy: OPERATOR,
    holderPid: 5151,
    ...overrides,
  });
}

/** One Claude-shaped usage report, its four classes as given. */
function usage(classes: readonly [number | null, number | null, number | null, number | null]): ExecutionEvent {
  const [inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens] = classes;
  const known = classes.every((count) => count !== null);
  return {
    kind: "usage",
    stepIndex: 1,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    totalTokens: known ? classes.reduce<number>((total, count) => total + (count ?? 0), 0) : null,
    reportKind: "CUMULATIVE",
    isFinal: true,
    sourceObservationId: SESSION + "/result",
  };
}

const STARTED: ExecutionEvent = {
  kind: "started",
  route: ROUTE,
  resolvedModel: "claude-opus-5-20260601",
  protocolVersion: "stream-json/1",
};

/** The completed trail of an echo: the usage report, the process's exit and the operation's verdict. */
function trail(status: "SUCCEEDED" | "FAILED", report: ExecutionEvent = usage([3, 5, 7, 11])): readonly ExecutionEvent[] {
  return [
    STARTED,
    report,
    { kind: "processExited", exitCode: status === "SUCCEEDED" ? 0 : 1, signal: null },
    { kind: "operationResult", status },
    { kind: "completed", stepIndex: 1 },
  ];
}

interface PortScript {
  readonly refuse?: boolean;
  readonly deltas?: readonly string[];
  readonly events?: readonly ExecutionEvent[];
}

/** A port that echoes its output through the private sink, then speaks its trail. */
function echoPort(script: PortScript, calls: { starts: number; interrupts: number }): ModelExecutionPort {
  return {
    start: (...args: unknown[]) => {
      calls.starts += 1;
      const [route, , sink] = args as [ResolvedRoute, ExecutionRequest, ((delta: string) => void) | undefined];
      if (script.refuse === true) {
        return Promise.resolve({ ok: false as const, refusal: "CAPABILITY_UNSUPPORTED" as const, at: "request.modalities" });
      }
      const session: ExecutionSession = {
        ok: true,
        sessionId: SESSION,
        route,
        // eslint-disable-next-line @typescript-eslint/require-await
        events: async function* (): AsyncIterable<ExecutionEvent> {
          for (const delta of script.deltas ?? [OBJECTIVE]) sink?.(delta);
          for (const event of script.events ?? trail("SUCCEEDED")) yield event;
        },
      };
      return Promise.resolve(session);
    },
    interrupt: () => {
      calls.interrupts += 1;
      return Promise.resolve();
    },
    healthProbe: () =>
      Promise.resolve({ status: "UNKNOWN" as const, checkedAt: AT, latencyMs: null, classifiedError: null }),
  };
}

function effectsOver(on: World, task: RecordedTask, chain: ExecutionChain, script: PortScript = {}) {
  const calls = { starts: 0, interrupts: 0 };
  const gates: number[] = [];
  const pressures: number[] = [];
  const effects = createExecutionEffects({
    port: echoPort(script, calls),
    route: ROUTE,
    request: {
      taskId: task.taskId,
      attempt: task.attempt,
      identity: OPERATOR,
      instructions: OBJECTIVE,
      modalities: ["text"],
      reattach: null,
    },
    scenarioRoot: on.root,
    recordIntentions: chain.recordIntentions,
    recordDelivery: chain.recordDelivery,
    recordStream: chain.recordStream,
    recordResult: chain.recordResult,
    confirmChain: chain.confirmChain,
    recordPressure: (sample) => {
      pressures.push(sample.trailIndex);
    },
    checkConformance: (operationIndex) => {
      gates.push(operationIndex);
    },
  });
  return { effects, calls, gates, pressures, operation: operationForStep(task.invocation, INTENT_STEP) };
}

/** Every event after `after`, as the ledger recorded it. */
function eventsAfter(ledger: Ledger, after: number): readonly {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}[] {
  return ledger
    .listEvents({ afterSequence: after, limit: 200 })
    .events.map((record) => ({ type: record.event.type, payload: record.event.payload }));
}

function outcomeOf(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return payload["outcome"] as Readonly<Record<string, unknown>>;
}

function markers(root: ScenarioRoot): readonly string[] {
  const home = join(root, "executions");
  return existsSync(home) ? readdirSync(home) : [];
}

async function caught(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error: unknown) {
    return error;
  }
  return null;
}

describe("the execution chain records one execution whole (PC-D1, runtime half)", () => {
  it("appends pin, effect, delivery, INFLIGHT, prompt, stream, one observation, SETTLED with the pair, and the response, in that order", async () => {
    const on = world();
    const { task } = walked(on);
    const before = on.ledger.status().headSequence;
    const { effects, calls, gates, operation } = effectsOver(on, task, chainFor(on, task));

    await effects.apply(operation);

    expect(calls.starts).toBe(1);
    const appended = eventsAfter(on.ledger, before);
    expect(appended.map((event) => event.type)).toEqual([
      "EFFECT_INTENDED",
      "DISPATCH_INTENDED",
      "DISPATCH_OUTCOME_RECORDED",
      "PROMPT_OCCURRENCE_RECORDED",
      "USAGE_STREAM_DECLARED",
      "USAGE_OBSERVATION_RECORDED",
      "DISPATCH_OUTCOME_RECORDED",
      "RESPONSE_OCCURRENCE_RECORDED",
    ]);
    expect(appended.some((event) => event.type === "TOKEN_USAGE_RECORDED")).toBe(false);

    // The pin is the version in force, the delivery was accepted under the session.
    const dispatch = appended[1]?.payload["dispatch"] as Readonly<Record<string, unknown>>;
    expect(dispatch).toMatchObject({ catalogDocumentId: CATALOG, catalogVersion: 1, attemptOrdinal: 1 });
    expect(outcomeOf(appended[2]?.payload ?? {})).toMatchObject({
      dispatchState: "INFLIGHT",
      acceptedAt: task.submittedAt,
      externalHandle: SESSION,
    });
    // The prompt's digest is the instruction's, computed here only.
    const prompt = appended[3]?.payload["promptOccurrence"] as Readonly<Record<string, unknown>>;
    expect(prompt).toMatchObject({ promptSha256: sha256(OBJECTIVE), promptBytes: Buffer.byteLength(OBJECTIVE), ordinal: 0 });
    // One stream, one observation, the report's classes and total, final.
    expect(appended[4]?.payload["usageStream"]).toMatchObject({
      source: "claude-cli",
      accountId: ROUTE.accountId,
      sourceEpoch: 0,
      sourceClass: "PROVIDER_AUTHORITATIVE",
      normalizationPolicySha256: USAGE_SOURCE.normalizationPolicySha256,
    });
    expect(appended[5]?.payload["usageObservation"]).toMatchObject({
      reportKind: "CUMULATIVE",
      isFinal: 1,
      inputTokens: 3,
      outputTokens: 5,
      cacheWriteTokens: 7,
      cacheReadTokens: 11,
      totalTokens: 26,
      sourceObservationId: SESSION + "/result",
      rangeFromCounter: 0,
      rangeToCounter: 1,
    });
    const settled = outcomeOf(appended[6]?.payload ?? {});
    expect(settled).toMatchObject({ dispatchState: "SETTLED", effectOutcomeStatus: "SUCCEEDED", terminalAt: task.submittedAt });
    const response = appended[7]?.payload["responseOccurrence"] as Readonly<Record<string, unknown>>;
    expect(response).toMatchObject({ promptOccurrenceId: prompt["occurrenceId"], responseSha256: settled["resultSha256"] });

    // The RESPONSE artifact's bytes are the result document, and its text is the echo.
    const read = on.plane.read({
      artifactReferenceId: String(settled["resultArtifactReferenceId"]),
      scopeKind: "TASK",
      scopeId: TASK,
    });
    expect(read.verb).toBe("READ");
    if (read.verb === "READ") {
      const document = JSON.parse(read.content.toString("utf8")) as { readonly blocks: readonly { readonly text: string }[] };
      expect(document.blocks.map((block) => block.text).join("")).toBe(OBJECTIVE);
    }

    // The confirmation passed, the gate ran, and the marker is written.
    expect(gates).toEqual([INTENT_STEP.index]);
    expect(markers(on.root)).toHaveLength(1);
    expect(on.ledger.verifyIntegrity().problems).toEqual([]);

    // A second apply finds the marker and appends nothing.
    const head = on.ledger.status().headSequence;
    await effects.apply(operation);
    expect(on.ledger.status().headSequence).toBe(head);
    expect(calls.starts).toBe(1);
  });

  it("records a report with a class the source did not state as nothing, never as 0, and still declares the stream", async () => {
    const on = world();
    const { task } = walked(on);
    const before = on.ledger.status().headSequence;
    const { effects, operation } = effectsOver(on, task, chainFor(on, task), {
      events: trail("SUCCEEDED", usage([3, 5, null, 11])),
    });
    await effects.apply(operation);
    const types = eventsAfter(on.ledger, before).map((event) => event.type);
    expect(types).toContain("USAGE_STREAM_DECLARED");
    expect(types).not.toContain("USAGE_OBSERVATION_RECORDED");
    expect(types).not.toContain("TOKEN_USAGE_RECORDED");
  });
});

describe("the chain refuses before any spend (N-D10, C-D3)", () => {
  it("a catalog with no version in force: DispatchRefusedError, nothing intended, nothing started", async () => {
    const on = world(null);
    const { task } = walked(on);
    const before = on.ledger.status();
    const { effects, calls, operation } = effectsOver(on, task, chainFor(on, task));
    const error = await caught(() => effects.apply(operation));
    expect(error).toBeInstanceOf(DispatchRefusedError);
    expect((error as DispatchRefusedError).at).toBe("catalogDocumentId");
    expect(calls.starts).toBe(0);
    expect(on.ledger.status()).toEqual(before);
    expect(markers(on.root)).toHaveLength(0);
  });

  it("a version in force that does not cover the segment's model version: DispatchRefusedError, zero delta", async () => {
    const on = world(OTHER_MODEL);
    const { task } = walked(on);
    const before = on.ledger.status();
    const { effects, calls, operation } = effectsOver(on, task, chainFor(on, task));
    const error = await caught(() => effects.apply(operation));
    expect(error).toBeInstanceOf(DispatchRefusedError);
    expect((error as DispatchRefusedError).at).toBe("catalogVersion");
    expect(calls.starts).toBe(0);
    expect(on.ledger.status()).toEqual(before);
  });

  it("a delivery already on record is never started again: a second result would share its source id (D2 Fable C2)", async () => {
    const on = world();
    const { task } = walked(on);
    const chain = chainFor(on, task);
    // A crash after the delivery was intended and before any marker: the intentions
    // are on record, and the walk comes back to them.
    chain.recordIntentions(INTENT_STEP.index);
    const before = on.ledger.status();
    const { effects, calls, operation } = effectsOver(on, task, chainFor(on, task));
    const error = await caught(() => effects.apply(operation));
    expect(error).toBeInstanceOf(SupervisorError);
    expect(String(error)).toContain("a delivery of it is already recorded");
    expect(calls.starts).toBe(0);
    expect(on.ledger.status()).toEqual(before);
  });
});

describe("the chain records what the start and the session answered (N-D11, N-D12, N-D13)", () => {
  it("a refused start is ABANDONED with the effect FAILED, and no prompt is recorded", async () => {
    const on = world();
    const { task } = walked(on);
    const before = on.ledger.status().headSequence;
    const { effects, operation } = effectsOver(on, task, chainFor(on, task), { refuse: true });
    const error = await caught(() => effects.apply(operation));
    expect(error).toBeInstanceOf(ExecutionEffectError);
    const appended = eventsAfter(on.ledger, before);
    expect(appended.map((event) => event.type)).toEqual(["EFFECT_INTENDED", "DISPATCH_INTENDED", "DISPATCH_OUTCOME_RECORDED"]);
    expect(outcomeOf(appended[2]?.payload ?? {})).toMatchObject({ dispatchState: "ABANDONED", effectOutcomeStatus: "FAILED" });
    expect(markers(on.root)).toHaveLength(0);
  });

  it("a session that ends in error settles the delivery with the effect FAILED and no result, after the stream", async () => {
    const on = world();
    const { task } = walked(on);
    const before = on.ledger.status().headSequence;
    const { effects, operation } = effectsOver(on, task, chainFor(on, task), {
      events: [STARTED, usage([1, 1, 1, 1]), { kind: "error", refusal: "TRANSPORT_UNAVAILABLE", detail: "the fixture's transport ended" }],
    });
    const error = await caught(() => effects.apply(operation));
    expect(error).toBeInstanceOf(ExecutionEffectError);
    const appended = eventsAfter(on.ledger, before);
    expect(appended.map((event) => event.type)).toEqual([
      "EFFECT_INTENDED",
      "DISPATCH_INTENDED",
      "DISPATCH_OUTCOME_RECORDED",
      "PROMPT_OCCURRENCE_RECORDED",
      "USAGE_STREAM_DECLARED",
      "USAGE_OBSERVATION_RECORDED",
      "DISPATCH_OUTCOME_RECORDED",
    ]);
    const settled = outcomeOf(appended[6]?.payload ?? {});
    expect(settled).toMatchObject({ dispatchState: "SETTLED", effectOutcomeStatus: "FAILED" });
    expect(settled["resultArtifactReferenceId"]).toBeUndefined();
    expect(markers(on.root)).toHaveLength(0);
  });

  it("N-D12: a failed operation with its answer records the outcome and the response, then refuses the marker", async () => {
    const on = world();
    const { task } = walked(on);
    const before = on.ledger.status().headSequence;
    const { effects, gates, operation } = effectsOver(on, task, chainFor(on, task), { events: trail("FAILED") });
    const error = await caught(() => effects.apply(operation));
    expect(error).toBeInstanceOf(OperationFailedError);
    const appended = eventsAfter(on.ledger, before);
    expect(appended.map((event) => event.type).slice(-2)).toEqual(["DISPATCH_OUTCOME_RECORDED", "RESPONSE_OCCURRENCE_RECORDED"]);
    expect(outcomeOf(appended[appended.length - 2]?.payload ?? {})).toMatchObject({
      dispatchState: "SETTLED",
      effectOutcomeStatus: "FAILED",
    });
    expect(gates).toEqual([]);
    expect(markers(on.root)).toHaveLength(0);
  });

  it("N-D13: a success with no text is a result with no document, the effect FAILED, no response, no marker", async () => {
    const on = world();
    const { task } = walked(on);
    const before = on.ledger.status().headSequence;
    const { effects, operation } = effectsOver(on, task, chainFor(on, task), { deltas: [] });
    const error = await caught(() => effects.apply(operation));
    expect(error).toBeInstanceOf(OperationFailedError);
    expect((error as OperationFailedError).reason).toBe("NO_OUTPUT");
    const appended = eventsAfter(on.ledger, before);
    expect(appended.map((event) => event.type)).not.toContain("RESPONSE_OCCURRENCE_RECORDED");
    const settled = outcomeOf(appended[appended.length - 1]?.payload ?? {});
    expect(settled).toMatchObject({ dispatchState: "SETTLED", effectOutcomeStatus: "FAILED" });
    expect(markers(on.root)).toHaveLength(0);
  });
});

describe("never emits, refused at runtime (N-D15)", () => {
  it("a result hook that records nothing leaves the confirmation to refuse the marker", async () => {
    const on = world();
    const { task } = walked(on);
    const chain = chainFor(on, task);
    const { effects, operation } = effectsOver(on, task, { ...chain, recordResult: () => undefined });
    const error = await caught(() => effects.apply(operation));
    expect(error).toBeInstanceOf(SupervisorError);
    expect(String(error)).toContain("refusing to write the evidence marker");
    expect(markers(on.root)).toHaveLength(0);
  });

  it("a V1 invocation has no chain, and a hook for another operation is refused by name", () => {
    const on = world();
    const { task } = walked(on);
    const v1 = deriveInvocation(TASK, 1, AT, task.submissionDigest);
    expect(() => chainFor(on, task, { invocation: v1 })).toThrow(SupervisorError);
    const chain = chainFor(on, task);
    expect(() => {
      chain.recordIntentions(INTENT_STEP.index + 1);
    }).toThrow(/performs one execution/);
  });
});

describe("an open delivery is read, never closed, by a settlement (C-D3, Fable C2)", () => {
  it("nothing intended is not open; INTENDED and INFLIGHT are both open; a settled or abandoned one is not", () => {
    const on = world();
    const { task } = walked(on);
    expect(deliveryIsOpen(on.ledger, task.invocation)).toBe(false);

    const chain = chainFor(on, task);
    chain.recordIntentions(INTENT_STEP.index);
    const before = on.ledger.status();
    // An intention on record does not prove nothing was sent: INFLIGHT is appended
    // only after the start resolves. Open, and nothing is appended by asking.
    expect(deliveryIsOpen(on.ledger, task.invocation)).toBe(true);
    expect(on.ledger.status()).toEqual(before);

    chain.recordDelivery({ operationIndex: INTENT_STEP.index, kind: "ACCEPTED", sessionId: SESSION });
    expect(deliveryIsOpen(on.ledger, task.invocation)).toBe(true);
    chain.recordDelivery({ operationIndex: INTENT_STEP.index, kind: "FAILED" });
    expect(deliveryIsOpen(on.ledger, task.invocation)).toBe(false);

    const refused = world();
    const second = walked(refused);
    const other = chainFor(refused, second.task);
    other.recordIntentions(INTENT_STEP.index);
    other.recordDelivery({ operationIndex: INTENT_STEP.index, kind: "REFUSED" });
    expect(deliveryIsOpen(refused.ledger, second.task.invocation)).toBe(false);
  });
});

describe("the settlement under a revision reads the chain's delivery (C-D3, decision 141)", () => {
  it("a delivery left INTENDED or INFLIGHT settles nothing: its outcome is unknown, and nothing is appended", async () => {
    for (const accepted of [false, true]) {
      const on = world();
      const { task, context } = walked(on);
      const chain = chainFor(on, task);
      chain.recordIntentions(INTENT_STEP.index);
      if (accepted) chain.recordDelivery({ operationIndex: INTENT_STEP.index, kind: "ACCEPTED", sessionId: SESSION });
      const before = on.ledger.status();
      const settled = await settleFailure(context, "EXECUTION_FAILED");
      expect(settled, String(accepted)).toMatchObject({ verdict: "POSTCONDITION_UNKNOWN", failed: null });
      expect(on.ledger.status(), String(accepted)).toEqual(before);
    }
  });

  it("a refused start, recorded ABANDONED in process, settles FAILED", async () => {
    const on = world();
    const { task, context } = walked(on);
    const { effects, operation } = effectsOver(on, task, chainFor(on, task), { refuse: true });
    const error = await caught(() => effects.apply(operation));
    expect(classifyFailure(error)).toEqual({ settle: true, reason: "EXECUTION_FAILED" });
    expect((await settleFailure(context, "EXECUTION_FAILED")).verdict).toBe("FAILED");
  });

  it("a pin refused before any intention settles FAILED with no execution record at all", async () => {
    const on = world(null);
    const { task, context } = walked(on);
    const { effects, operation } = effectsOver(on, task, chainFor(on, task));
    const error = await caught(() => effects.apply(operation));
    expect(classifyFailure(error)).toEqual({ settle: true, reason: "EXECUTION_FAILED" });
    const before = on.ledger.status().headSequence;
    expect((await settleFailure(context, "EXECUTION_FAILED")).verdict).toBe("FAILED");
    expect(eventsAfter(on.ledger, before).map((event) => event.type)).toEqual(["TASK_FAILED"]);
  });
});

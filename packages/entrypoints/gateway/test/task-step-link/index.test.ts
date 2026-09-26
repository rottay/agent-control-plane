import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  API_CONTRACT_VERSION,
  ApiError,
  InitiativeTimelineResponse,
  LEDGER_CONTRACT_VERSION,
  RoadmapVersionWriteResponse,
  TaskGraphResponse,
  TaskIntakeResponse,
  TaskStepLinkResponse,
  TaskStepResponse,
  initiativeStepGraphPath,
  initiativeTaskStepPath,
} from "@acp/protocol";
import { canonicalJsonStringify, openLedger, sha256Hex } from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { readinessOf } from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";
import { recordTaskStepLink } from "../../src/task-step-link/index.js";

/**
 * Evidence for the plane's eighth write door: a task changes step only through a
 * recorded link (P-27 cut C, ADR 0116; requirement A3).
 *
 * Every case goes through the real gateway, a real ledger and the real private plane:
 * the roadmap versions declare their steps through the roadmap route, the tasks enter
 * through the intake door, the link is recorded and read through its own route, and the
 * graph door that reads the link is driven through its route. The seam decides nothing
 * -- `decideTaskStepLink` does, at the producer and at the single door -- so what this
 * file holds is the door, the row it lands, the graph door's changed read, the verdict
 * production reads for a moved node, and the history this build must still open.
 */

const dirs: string[] = [];

const TOKEN = "p27c-test-token-" + "x".repeat(24);
const AUTH = { authorization: "Bearer " + TOKEN };
const COORDINATOR = "kimi/k3/coordinator/01";
const OPERATOR = "claude/opus/implementer/01";
const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const INITIATIVE_2 = "55555555-5555-4555-8555-555555555555";
const MODEL = "claude-opus-5@2026-06-01";
const AT = "2026-09-25T12:00:00.000Z";
const NOW = "2026-09-25T13:00:00.000Z";
const GRAPH_ONE = "77777777-7777-4777-8777-777777777721";
const GRAPH_TWO = "77777777-7777-4777-8777-777777777722";
const OBJECTIVE = "Enter a task a link can move.";

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bearerFile(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-p27c-bearer-")));
  dirs.push(root);
  const path = join(root, "write-bearer.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

function registryDocument(documentKind: string, documentId: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    idempotencyKey: documentId + "/1",
    documentKind,
    documentId,
    documentVersion: 1,
    parentDocumentVersion: null,
    contentDigest: sha256Hex(canonicalJsonStringify(payload)),
    recordedBy: COORDINATOR,
    effectiveFrom: AT,
    occurredAt: AT,
    recordedAt: AT,
    payload,
  };
}

function registration(initiativeId: string): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    initiativeId,
    transitionId: "initiative.registered",
    idempotencyKey: initiativeId + "/1/initiative.registered",
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: COORDINATOR,
    occurredAt: AT,
    recordedAt: AT,
    payload: {},
  };
}

/** Two initiatives, one ACTIVE model version and the implementer's GLOBAL slot 0. */
function seededLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-p27c-link-"));
  dirs.push(dir);
  const path = join(dir, "control-plane.sqlite");
  const ledger = openLedger(path);
  ledger.appendInitiativeEvent(registration(INITIATIVE));
  ledger.appendInitiativeEvent(registration(INITIATIVE_2));
  ledger.appendRegistryEvent(
    registryDocument("MODEL_VERSION", MODEL, {
      provider: "claude",
      model: "claude-opus-5",
      release: "2026-06-01",
      status: "ACTIVE",
      contextTokens: 200000,
      policyVersion: "2026.09.0",
      deprecatedAt: null,
      eligibleRoles: ["implementer"],
      transports: ["CLI_SUBSCRIPTION"],
    }),
  );
  ledger.appendRegistryEvent(
    registryDocument("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", {
      role: "implementer",
      slot: 0,
      provider: "claude",
      modelVersionId: MODEL,
      fallbacks: [],
    }),
  );
  ledger.close();
  return path;
}

function manifestStep(stepId: string): Record<string, unknown> {
  return {
    stepId,
    title: "Step " + stepId,
    objective: "The private objective of " + stepId + ".",
    acceptance: "The private acceptance of " + stepId + ".",
    expectedWriteSet: ["packages/" + stepId + "/index.ts"],
    dependsOn: [],
  };
}

function envelope(taskId: string, initiativeId: string): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    taskId,
    initiativeId,
    title: "A task a link can move",
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
    issuedAt: AT,
    authority: [],
    readSet: [],
    writeSet: ["docs/" + taskId + ".md"],
    conflictKeys: [],
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

type App = ReturnType<typeof buildServer>;

interface World {
  readonly path: string;
  readonly bearer: string;
  readonly app: App;
  readonly v1: string;
  readonly v2: string;
  /** A task entered on V1's A, one on V1's B, and one on no step. */
  readonly onA: string;
  readonly onB: string;
  readonly unlinked: string;
}

/** Enter one task through the intake door, linked to `stepId` of the version, or to none. */
async function enter(app: App, roadmapVersionId: string | null, stepId: string | null, initiativeId = INITIATIVE): Promise<string> {
  const taskId = randomUUID();
  const intake = await app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    headers: AUTH,
    payload: {
      envelope: envelope(taskId, initiativeId),
      clientScope: OPERATOR,
      clientRequestKey: "link-task-" + taskId,
      roadmapVersionId,
      stepId,
      role: "implementer",
      slot: 0,
      transportKind: "CLI_SUBSCRIPTION",
      recordedBy: OPERATOR,
    },
  });
  expect(intake.statusCode).toBe(200);
  TaskIntakeResponse.parse(intake.json());
  return taskId;
}

async function recordVersion(app: App, content: string, expectedHeadDigest: string | null): Promise<{ readonly id: string; readonly digest: string }> {
  const roadmap = await app.inject({
    method: "POST",
    url: "/api/v1/initiatives/" + INITIATIVE + "/roadmap",
    headers: AUTH,
    payload: {
      content,
      expectedHeadDigest,
      kind: "EDIT",
      restoresVersionId: null,
      recordedBy: COORDINATOR,
      steps: { manifestContractVersion: 1, steps: [manifestStep("A"), manifestStep("B")] },
    },
  });
  expect(roadmap.statusCode).toBe(200);
  const { roadmapVersionId, contentDigest } = RoadmapVersionWriteResponse.parse(roadmap.json()).version;
  return { id: roadmapVersionId, digest: contentDigest };
}

/** Versions 1 and 2, each declaring A and B, and three tasks entered on version 1. */
async function world(): Promise<World> {
  const path = seededLedger();
  const bearer = bearerFile();
  const app = buildServer({ ledgerPath: path, writeBearerPath: bearer, now: () => NOW });
  const v1 = await recordVersion(app, "# Roadmap\n", null);
  const onA = await enter(app, v1.id, "A");
  const onB = await enter(app, v1.id, "B");
  const unlinked = await enter(app, null, null);
  const v2 = await recordVersion(app, "# Roadmap, version 2\n", v1.digest);
  return { path, bearer, app, v1: v1.id, v2: v2.id, onA, onB, unlinked };
}

function stepUrl(taskId: string, initiativeId = INITIATIVE): string {
  return initiativeTaskStepPath(initiativeId, taskId);
}

function linkBody(version: number, stepId: string, from: { readonly version: number; readonly stepId: string } | null): Record<string, unknown> {
  return { version, stepId, from, linkedBy: COORDINATOR };
}

function graphUrl(stepId: string, version: number): string {
  return initiativeStepGraphPath(INITIATIVE) + "?version=" + String(version) + "&stepId=" + stepId;
}

function graphBody(graphRevisionId: string, taskIds: readonly string[], supersedes: string | null = null): Record<string, unknown> {
  return {
    graphRevisionId,
    supersedesGraphRevisionId: supersedes,
    declaredBy: COORDINATOR,
    nodes: taskIds.map((taskId) => ({ taskId, taskRevisionNumber: 1, dependsOn: [] })),
  };
}

function initiativeEventCount(path: string): number {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return (raw.prepare("SELECT COUNT(*) AS n FROM initiative_events").get() as { n: number }).n;
  } finally {
    raw.close();
  }
}

function withReader<T>(path: string, read: (ledger: Ledger) => T): T {
  const ledger = openLedger(path, { readOnly: true });
  try {
    return read(ledger);
  } finally {
    ledger.close();
  }
}

describe("L1: a task is adopted, re-linked, and read back, through the real door", () => {
  it("adopts a task that entered on no step, and GET shows it entered on none, one link, and its current step", async () => {
    const { path, app, unlinked } = await world();
    const before = initiativeEventCount(path);
    const response = await app.inject({ method: "POST", url: stepUrl(unlinked), headers: AUTH, payload: linkBody(1, "B", null) });
    expect(response.statusCode).toBe(200);
    const linked = TaskStepLinkResponse.parse(response.json());
    expect(linked).toMatchObject({
      apiContractVersion: API_CONTRACT_VERSION,
      initiativeId: INITIATIVE,
      taskId: unlinked,
      stepId: "B",
      from: null,
      replayed: false,
    });
    expect(linked.version.version).toBe(1);
    // Ids, numbers and the echo only: no content, no digest.
    expect(Object.keys(linked).sort()).toEqual(
      ["apiContractVersion", "from", "initiativeId", "ledgerContractVersion", "replayed", "sequence", "stepId", "taskId", "version"].sort(),
    );
    expect(initiativeEventCount(path)).toBe(before + 1);

    const read = TaskStepResponse.parse((await app.inject({ method: "GET", url: stepUrl(unlinked) })).json());
    expect(read).toEqual({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId: INITIATIVE,
      taskId: unlinked,
      enteredOn: null,
      links: [{ version: 1, stepId: "B", from: null, sequence: linked.sequence, linkedAt: NOW }],
      current: { version: 1, stepId: "B" },
    });
    // The task row's step stays the intake's fact; the task read names no step at all.
    expect(withReader(path, (ledger) => ledger.getTask(unlinked)?.stepId)).toBeNull();
    const task: { readonly task: Record<string, unknown> } = (await app.inject({ method: "GET", url: "/api/v1/tasks/" + unlinked })).json();
    expect("stepId" in task.task).toBe(false);
    expect(withReader(path, (ledger) => ledger.verifyIntegrity().problems)).toEqual([]);
    await app.close();
  });

  it("re-links a task of V1's A to V2's A; the graph door grants it on V2's A and refuses it on V1's A", async () => {
    const { path, app, onA } = await world();
    const read = TaskStepResponse.parse((await app.inject({ method: "GET", url: stepUrl(onA) })).json());
    expect([read.enteredOn, read.links, read.current]).toEqual([{ version: 1, stepId: "A" }, [], { version: 1, stepId: "A" }]);

    const relink = await app.inject({ method: "POST", url: stepUrl(onA), headers: AUTH, payload: linkBody(2, "A", { version: 1, stepId: "A" }) });
    expect(relink.statusCode).toBe(200);
    const linked = TaskStepLinkResponse.parse(relink.json());
    expect([linked.version.version, linked.from]).toEqual([2, { version: 1, stepId: "A" }]);

    const onTwo = await app.inject({ method: "POST", url: graphUrl("A", 2), headers: AUTH, payload: graphBody(GRAPH_ONE, [onA]) });
    expect(onTwo.statusCode).toBe(200);
    const onOne = await app.inject({ method: "POST", url: graphUrl("A", 1), headers: AUTH, payload: graphBody(GRAPH_TWO, [onA]) });
    expect(onOne.statusCode).toBe(409);
    const error = ApiError.parse(onOne.json()).error;
    expect([error.code, error.message.includes("GRAPH_TASK_OUT_OF_SCOPE"), error.detail]).toEqual(["WRITE_REFUSED", true, "nodes[0]"]);

    const chain = TaskStepResponse.parse((await app.inject({ method: "GET", url: stepUrl(onA) })).json());
    expect([chain.enteredOn, chain.current]).toEqual([{ version: 1, stepId: "A" }, { version: 2, stepId: "A" }]);
    expect(chain.links.map((entry) => [entry.version, entry.stepId, entry.from])).toEqual([[2, "A", { version: 1, stepId: "A" }]]);
    expect(withReader(path, (ledger) => ledger.verifyIntegrity().problems)).toEqual([]);
    await app.close();
  });

  it("answers a retried POST from the recorded row, replayed, with no new event", async () => {
    const { path, app, onA } = await world();
    const body = linkBody(2, "A", { version: 1, stepId: "A" });
    const first = TaskStepLinkResponse.parse((await app.inject({ method: "POST", url: stepUrl(onA), headers: AUTH, payload: body })).json());
    const count = initiativeEventCount(path);
    const again = await app.inject({ method: "POST", url: stepUrl(onA), headers: AUTH, payload: body });
    expect(again.statusCode).toBe(200);
    expect(TaskStepLinkResponse.parse(again.json())).toEqual({ ...first, replayed: true });
    expect(initiativeEventCount(path)).toBe(count);
    await app.close();
  });

  it("the timeline reads the link type, widened by derivation", async () => {
    const { app, unlinked } = await world();
    await app.inject({ method: "POST", url: stepUrl(unlinked), headers: AUTH, payload: linkBody(1, "A", null) });
    const timeline = InitiativeTimelineResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + INITIATIVE + "/events" })).json(),
    );
    expect(timeline.items.filter((item) => item.type === "TASK_STEP_LINKED")).toHaveLength(1);
    await app.close();
  });
});

describe("L2: every refusal is 409 WRITE_REFUSED at its field, and the stream does not move", () => {
  it("names each of the six words, and a task with no revision as unknown", async () => {
    const { path, app, onA, onB } = await world();
    const foreign = await enter(app, null, null, INITIATIVE_2);
    await app.close();
    const legacy = randomUUID();
    const writer = openLedger(path);
    writer.append({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: randomUUID(),
      taskId: legacy,
      attempt: 1,
      transitionId: "discover",
      idempotencyKey: legacy + "/1/discover",
      type: "TASK_DISCOVERED",
      fromState: null,
      toState: "DISCOVERED",
      emittedBy: COORDINATOR,
      occurredAt: AT,
      recordedAt: AT,
      correlationId: null,
      causationId: null,
      payload: {},
    });
    writer.close();
    const reopened = buildServer({ ledgerPath: path, writeBearerPath: bearerFile(), now: () => NOW });
    // A recorded link, so a different `from` at its (task, version) is its own refusal.
    expect((await reopened.inject({ method: "POST", url: stepUrl(onB), headers: AUTH, payload: linkBody(2, "B", { version: 1, stepId: "B" }) })).statusCode).toBe(200);
    const before = initiativeEventCount(path);

    const cases: readonly (readonly [string, Record<string, unknown>, string, string])[] = [
      [onA, linkBody(1, "A", { version: 1, stepId: "A" }), "LINK_DECLARATION_INVALID", "link.roadmapVersionId"],
      [onB, linkBody(2, "B", { version: 1, stepId: "A" }), "LINK_DECLARATION_INVALID", "link.roadmapVersionId"],
      [onA, linkBody(2, "Z", { version: 1, stepId: "A" }), "LINK_STEP_UNKNOWN", "link.stepId"],
      [randomUUID(), linkBody(1, "A", null), "LINK_TASK_UNKNOWN", "link.taskId"],
      [foreign, linkBody(1, "A", null), "LINK_TASK_OUT_OF_SCOPE", "link.taskId"],
      // A task the stream holds with no revision row at all is unknown to the link law:
      // existence before scope. One with a revision and no intake is out of scope, the
      // ledger suite's case.
      [legacy, linkBody(1, "A", null), "LINK_TASK_UNKNOWN", "link.taskId"],
      [onA, linkBody(2, "A", null), "LINK_HEAD_MISMATCH", "link.fromRoadmapVersionId"],
      [onA, linkBody(2, "B", { version: 1, stepId: "B" }), "LINK_HEAD_MISMATCH", "link.fromStepId"],
      [onA, linkBody(1, "B", { version: 1, stepId: "A" }), "LINK_TARGET_NOT_LATER", "link.roadmapVersionId"],
      [onA, linkBody(2, "B", { version: 1, stepId: "A" }), "LINK_TARGET_NOT_LATER", "link.roadmapVersionId"],
    ];
    for (const [taskId, body, word, at] of cases) {
      const response = await reopened.inject({ method: "POST", url: stepUrl(taskId), headers: AUTH, payload: body });
      const error = ApiError.parse(response.json()).error;
      expect({ word, status: response.statusCode, code: error.code, named: error.message.includes(word), at: error.detail }).toEqual({
        word,
        status: 409,
        code: "WRITE_REFUSED",
        named: true,
        at,
      });
    }
    expect(initiativeEventCount(path)).toBe(before);
    await reopened.close();
  });

  it("a producer that decided over a stale reader loses at the door and hears WRITE_CONFLICT, never a 500", async () => {
    const { path, app, unlinked } = await world();
    await app.close();
    const reader = openLedger(path, { readOnly: true });
    const versions = reader.listRoadmapVersions(INITIATIVE);
    const [v1, v2] = [versions[0], versions[1]];
    if (v1 === undefined || v2 === undefined) throw new Error("the world has two versions");
    // Another producer adopts the task first.
    const other = openLedger(path);
    expect(
      recordTaskStepLink({ ledger: other, initiativeId: INITIATIVE, taskId: unlinked, version: v1, stepId: "A", from: null, linkedBy: COORDINATOR, recordedAt: AT, eventId: randomUUID() }).ok,
    ).toBe(true);
    other.close();
    const stale: Ledger = new Proxy(reader, {
      get(target, property) {
        if (property === "getTaskStepLinks") return () => [];
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const before = initiativeEventCount(path);
    const outcome = recordTaskStepLink({
      ledger: stale,
      initiativeId: INITIATIVE,
      taskId: unlinked,
      version: v2,
      stepId: "B",
      from: null,
      linkedBy: COORDINATOR,
      recordedAt: AT,
      eventId: randomUUID(),
    });
    reader.close();
    expect(outcome).toEqual({ ok: false, reason: "WRITE_CONFLICT", at: "taskStepLink" });
    expect(initiativeEventCount(path)).toBe(before);
  });
});

describe("L3: the door's surface", () => {
  it("inherits the bearer on POST, reads free on GET, refuses the other verbs, and parses the body at the field", async () => {
    const { app, onA } = await world();
    const unauthenticated = await app.inject({ method: "POST", url: stepUrl(onA), payload: linkBody(2, "A", { version: 1, stepId: "A" }) });
    expect(unauthenticated.statusCode).toBe(401);
    expect(ApiError.parse(unauthenticated.json()).error.code).toBe("AUTH_REQUIRED");
    expect((await app.inject({ method: "GET", url: stepUrl(onA) })).statusCode).toBe(200);
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method, url: stepUrl(onA) })).statusCode).toBe(405);
    }
    const malformed = await app.inject({ method: "POST", url: stepUrl(onA), headers: AUTH, payload: { ...linkBody(2, "A", null), version: 0 } });
    expect(malformed.statusCode).toBe(400);
    expect(ApiError.parse(malformed.json()).error.detail).toBe("version");
    expect((await app.inject({ method: "GET", url: stepUrl(onA) + "?version=1" })).statusCode).toBe(400);
    await app.close();
  });

  it("answers 404 for an unknown initiative, an unknown target or from version, and a task not of that initiative", async () => {
    const { app, onA, unlinked } = await world();
    const foreign = await enter(app, null, null, INITIATIVE_2);
    const unknownInitiative = stepUrl(onA, randomUUID());
    expect((await app.inject({ method: "GET", url: unknownInitiative })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: unknownInitiative, headers: AUTH, payload: linkBody(1, "A", null) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: stepUrl(unlinked), headers: AUTH, payload: linkBody(9, "A", null) })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: stepUrl(onA), headers: AUTH, payload: linkBody(2, "A", { version: 9, stepId: "A" }) })).statusCode,
    ).toBe(404);
    // A task of another initiative, and one the ledger does not hold, are not tasks of this one.
    expect((await app.inject({ method: "GET", url: stepUrl(foreign) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: stepUrl(randomUUID()) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: stepUrl(foreign, INITIATIVE_2) })).statusCode).toBe(200);
    await app.close();
  });
});

describe("L4: READY reads a moved node as a known block (ADR 0116 §Four)", () => {
  it("the old step's graph reads R1 UNSATISFIED(TASK_LINK_MOVED) for the moved node, and the new step's reads it as before", async () => {
    const { app, onA } = await world();
    expect((await app.inject({ method: "POST", url: graphUrl("A", 1), headers: AUTH, payload: graphBody(GRAPH_ONE, [onA]) })).statusCode).toBe(200);
    const before = TaskGraphResponse.parse((await app.inject({ method: "GET", url: graphUrl("A", 1) })).json());
    expect(before.nodes[0]?.conditions.R1).toEqual({ verdict: "UNKNOWN", reason: "TASK_COHORT_LEGACY" });

    await app.inject({ method: "POST", url: stepUrl(onA), headers: AUTH, payload: linkBody(2, "A", { version: 1, stepId: "A" }) });
    const old = TaskGraphResponse.parse((await app.inject({ method: "GET", url: graphUrl("A", 1) })).json());
    expect(old.nodes.map((node) => [node.taskId, node.ready, node.conditions.R1])).toEqual([
      [onA, false, { verdict: "UNSATISFIED", reason: "TASK_LINK_MOVED" }],
    ]);
    expect((await app.inject({ method: "POST", url: graphUrl("A", 2), headers: AUTH, payload: graphBody(GRAPH_TWO, [onA]) })).statusCode).toBe(200);
    const moved = TaskGraphResponse.parse((await app.inject({ method: "GET", url: graphUrl("A", 2) })).json());
    expect(moved.nodes[0]?.conditions.R1).toEqual({ verdict: "UNKNOWN", reason: "TASK_COHORT_LEGACY" });
    await app.close();
  });

  it("readinessOf reads a planted node whose task entered on no step and was never adopted as TASK_LINK_MOVED: no current link is a block", async () => {
    const { path, app, onA, unlinked } = await world();
    expect((await app.inject({ method: "POST", url: graphUrl("A", 1), headers: AUTH, payload: graphBody(GRAPH_ONE, [onA]) })).statusCode).toBe(200);
    await app.close();
    // Past the door, which refuses it by GRAPH_TASK_OUT_OF_SCOPE.
    const raw = new DatabaseSync(path);
    raw
      .prepare("INSERT INTO task_graph_node_read_model (graph_revision_id, task_id, task_revision_number, sequence) VALUES (?, ?, 1, ?)")
      .run(GRAPH_ONE, unlinked, 999);
    raw.close();
    withReader(path, (ledger) => {
      const reading = readinessOf(ledger, GRAPH_ONE, NOW);
      const planted = reading?.nodes.find((node) => node.taskId === unlinked);
      expect(planted?.evaluation.ready).toBe(false);
      expect(planted?.evaluation.conditions.R1).toEqual({ verdict: "UNSATISFIED", reason: "TASK_LINK_MOVED" });
      expect(reading?.nodes.find((node) => node.taskId === onA)?.evaluation.conditions.R1).toEqual({ verdict: "UNKNOWN", reason: "TASK_COHORT_LEGACY" });
    });
  });

  it("readinessOf reads a planted legacy node, with no intake, no link and no revision, as a known block: the earlier revision clause answers", async () => {
    // A task of the legacy cohort: no recorded intake, never linked, and no revision
    // row. Its link clause is the block by definition, and R1's earlier clause,
    // TASK_REVISION_SUPERSEDED, is the answer: a known block, never READY, never absent.
    const { path, app, onA } = await world();
    expect((await app.inject({ method: "POST", url: graphUrl("A", 1), headers: AUTH, payload: graphBody(GRAPH_ONE, [onA]) })).statusCode).toBe(200);
    await app.close();
    const legacy = randomUUID();
    const writer = openLedger(path);
    writer.append({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: randomUUID(),
      taskId: legacy,
      attempt: 1,
      transitionId: "discover",
      idempotencyKey: legacy + "/1/discover",
      type: "TASK_DISCOVERED",
      fromState: null,
      toState: "DISCOVERED",
      emittedBy: COORDINATOR,
      occurredAt: AT,
      recordedAt: AT,
      correlationId: null,
      causationId: null,
      payload: {},
    });
    writer.close();
    const raw = new DatabaseSync(path);
    raw
      .prepare("INSERT INTO task_graph_node_read_model (graph_revision_id, task_id, task_revision_number, sequence) VALUES (?, ?, 1, ?)")
      .run(GRAPH_ONE, legacy, 999);
    raw.close();
    withReader(path, (ledger) => {
      expect(ledger.getTaskStepLinks(legacy)).toEqual([]);
      const planted = readinessOf(ledger, GRAPH_ONE, NOW)?.nodes.find((node) => node.taskId === legacy);
      expect(planted?.evaluation.ready).toBe(false);
      expect(planted?.evaluation.conditions.R1).toEqual({ verdict: "UNSATISFIED", reason: "TASK_REVISION_SUPERSEDED" });
      expect(planted?.evaluation.conditions.R4).toEqual({ verdict: "UNSATISFIED", reason: "ASSIGNMENT_UNRESOLVED" });
    });
  });
});

describe("P-P18-2: this build opens the history the previous one wrote", () => {
  it("a 2.11.0 history rewound to 26 migrates under 2.11.0 at 27, verifies and rebuilds identically, and takes a link on top", async () => {
    const { path, bearer, app, onA } = await world();
    expect((await app.inject({ method: "POST", url: graphUrl("A", 1), headers: AUTH, payload: graphBody(GRAPH_ONE, [onA]) })).statusCode).toBe(200);
    await app.close();
    const before = withReader(path, (ledger) => ({
      versions: ledger.listRoadmapVersions(INITIATIVE),
      revisions: ledger.listTaskGraphRevisions(ledger.listRoadmapVersions(INITIATIVE)[0]?.roadmapVersionId ?? "", "A"),
    }));

    // Migration 27 undone: the ledger is at 26, as P-27 cut A left it.
    const raw = new DatabaseSync(path);
    raw.exec(
      "DROP TRIGGER tr_task_step_link_read_model__insert_only;" +
        "DROP INDEX ix_task_step_link_read_model__task_sequence;" +
        "DROP TABLE task_step_link_read_model;" +
        "DELETE FROM projection_watermark WHERE projection_name = 'task_step_link_read_model';" +
        "DELETE FROM schema_migrations WHERE version >= 27;",
    );
    raw.close();

    // The server's handle is read-only and may not migrate; a writable open does.
    const migrated = openLedger(path);
    expect(migrated.status().migrations.at(-1)?.version).toBe(27);
    expect(migrated.status().migrations.at(-1)?.name).toBe("task_step_link");
    expect(migrated.verifyIntegrity().problems).toEqual([]);
    migrated.rebuildReadModel();
    expect(migrated.listRoadmapVersions(INITIATIVE)).toEqual(before.versions);
    expect(migrated.listTaskGraphRevisions(before.versions[0]?.roadmapVersionId ?? "", "A")).toEqual(before.revisions);
    expect(migrated.getTaskStepLinks(onA)).toEqual([]);
    expect(migrated.verifyIntegrity().problems).toEqual([]);
    migrated.close();

    const reopened = buildServer({ ledgerPath: path, writeBearerPath: bearer, now: () => NOW });
    const onTop = await reopened.inject({ method: "POST", url: stepUrl(onA), headers: AUTH, payload: linkBody(2, "A", { version: 1, stepId: "A" }) });
    expect(onTop.statusCode).toBe(200);
    const chain = TaskStepResponse.parse((await reopened.inject({ method: "GET", url: stepUrl(onA) })).json());
    expect(chain.current).toEqual({ version: 2, stepId: "A" });
    await reopened.close();
    expect(withReader(path, (ledger) => ledger.verifyIntegrity().problems)).toEqual([]);
  });
});

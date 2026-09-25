import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  API_CONTRACT_VERSION,
  ApiError,
  LEDGER_CONTRACT_VERSION,
  RoadmapVersionWriteResponse,
  TaskDetailResponse,
  TaskIntakeResponse,
  TaskPageResponse,
} from "@acp/protocol";
import {
  GENESIS_SHA256,
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  canonicalJsonStringify,
  chainDigest,
  envelopeSha256,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  sha256Hex,
} from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { intakeTask } from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";
import { recordTaskIntake } from "../../src/task-intake/index.js";

/**
 * The instruction content for a fixture whose prose is `text` (P-06/B, ADR 0094).
 *
 * One text block, so the envelope's `objective` equals the first text block of its
 * content and the two spellings stay one fact. `contentSha256` is a placeholder:
 * escalón B admits and publishes, and escalón C is where a digest is checked
 * against the bytes it describes.
 */
function fixtureContent(text: string): Record<string, unknown> {
  return {
    contentContractVersion: 1,
    blocks: [
      {
        kind: "text",
        blockId: "b1",
        mediaType: "text/plain; charset=utf-8",
        byteLength: new TextEncoder().encode(text).byteLength,
        contentSha256: "0".repeat(64),
        artifactRefId: null,
        text,
        toolCallId: null,
        effectId: null,
      },
    ],
  };
}


/**
 * Evidence for the plane's sixth write door: `POST /api/v1/tasks` (P-14/C, ADR
 * 0087).
 *
 * Every case goes through the real endpoint, a real ledger and the real private
 * plane, over a registry seeded through the ledger's own doors. The seam decides
 * nothing — `intakeTask` does, and its own suite holds the laws — so what this
 * file holds is the door: the bearer it inherits, the two refusal statuses it
 * maps with the class, code and proposal they carry, the document it prints, and
 * that a task the other door's orchestration entered is the same answer here.
 */

const dirs: string[] = [];

const TOKEN = "p14c-test-token-" + "x".repeat(24);
const AUTH = { authorization: "Bearer " + TOKEN };
const URL = "/api/v1/tasks";

const COORDINATOR = "kimi/k3/coordinator/01";
const OPERATOR = "claude/opus/implementer/01";
const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const TASK = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const MODEL = "claude-opus-5@2026-06-01";
const AT = "2026-09-03T12:00:00.000Z";
const OBJECTIVE = "Enter one task by command and by API, and keep its envelope off the stream.";
const SENTINEL = "sk-ant-api03-SENTINELSENTINELSENTINEL";

function bearerFile(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-p14c-bearer-")));
  dirs.push(root);
  const path = join(root, "write-bearer.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function registryDocument(documentKind: string, documentId: string, payload: Record<string, unknown>, version = 1): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    idempotencyKey: documentId + "/" + String(version),
    documentKind,
    documentId,
    documentVersion: version,
    parentDocumentVersion: version === 1 ? null : version - 1,
    // The payload's own digest, which the registry door verifies (P-15/R, ADR 0104).
    contentDigest: sha256Hex(canonicalJsonStringify(payload)),
    recordedBy: COORDINATOR,
    effectiveFrom: AT,
    occurredAt: AT,
    recordedAt: AT,
    payload,
  };
}

function modelVersionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "claude",
    model: "claude-opus-5",
    release: "2026-06-01",
    status: "ACTIVE",
    contextTokens: 200000,
    policyVersion: "2026.09.0",
    deprecatedAt: null,
    eligibleRoles: ["implementer"],
    transports: ["CLI_SUBSCRIPTION"],
    ...overrides,
  };
}

/** An initiative, one ACTIVE model version and the implementer's GLOBAL slot 0. */
function seed(ledger: Ledger): void {
  ledger.appendInitiativeEvent({
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    initiativeId: INITIATIVE,
    transitionId: "initiative.registered",
    idempotencyKey: INITIATIVE + "/1/initiative.registered",
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: COORDINATOR,
    occurredAt: AT,
    recordedAt: AT,
    payload: {},
  });
  ledger.appendRegistryEvent(registryDocument("MODEL_VERSION", MODEL, modelVersionPayload()));
  ledger.appendRegistryEvent(
    registryDocument("ROUTING_ASSIGNMENT_GLOBAL", "routing:GLOBAL:implementer:0", {
      role: "implementer",
      slot: 0,
      provider: "claude",
      modelVersionId: MODEL,
      fallbacks: [],
    }),
  );
}

function temporaryDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-task-intake-"));
  dirs.push(dir);
  const path = join(dir, "control-plane.sqlite");
  const ledger = openLedger(path);
  seed(ledger);
  ledger.close();
  return path;
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    taskId: TASK,
    initiativeId: INITIATIVE,
    title: "Enter a task",
    objective: OBJECTIVE,
    content: fixtureContent(OBJECTIVE),
    classification: "MECHANICAL",
    issuedBy: COORDINATOR,
    issuedAt: AT,
    authority: [],
    readSet: [],
    writeSet: ["docs/intake.md"],
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
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envelope: envelope(),
    clientScope: OPERATOR,
    clientRequestKey: "intake-0001",
    roadmapVersionId: null,
    stepId: null,
    role: "implementer",
    slot: 0,
    transportKind: "CLI_SUBSCRIPTION",
    recordedBy: OPERATOR,
    ...overrides,
  };
}

function taskEventCount(path: string): number {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return (raw.prepare("SELECT COUNT(*) AS count FROM control_plane_events").get() as { readonly count: number }).count;
  } finally {
    raw.close();
  }
}

function eventJsons(path: string): readonly string[] {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return (raw.prepare("SELECT event_json FROM control_plane_events ORDER BY sequence").all() as { readonly event_json: string }[]).map(
      (row) => row.event_json,
    );
  } finally {
    raw.close();
  }
}

function intentionCount(path: string): number {
  const bytes = canonicalJsonStringify(envelope());
  const digest = createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex");
  const ledger = openLedger(path, { readOnly: true });
  try {
    return ledger.listArtifactEvents(digest).filter((record) => record.event.artifactEventKind === "PUBLICATION_INTENDED").length;
  } finally {
    ledger.close();
  }
}

describe("POST /api/v1/tasks inherits the bearer (N-P14C-15)", () => {
  it("answers 403 with no bearer configured and 401 with a wrong or missing one, and writes nothing", async () => {
    const path = temporaryDatabase();

    const unconfigured = buildServer({ ledgerPath: path });
    const shut = await unconfigured.inject({ method: "POST", url: URL, headers: AUTH, payload: body() });
    expect(shut.statusCode).toBe(403);
    expect(ApiError.parse(shut.json()).error.code).toBe("WRITE_BEARER_UNCONFIGURED");
    await unconfigured.close();

    const guarded = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const wrong = await guarded.inject({
      method: "POST",
      url: URL,
      headers: { authorization: "Bearer " + "y".repeat(40) },
      payload: body(),
    });
    expect(wrong.statusCode).toBe(401);
    expect(ApiError.parse(wrong.json()).error.code).toBe("AUTH_REQUIRED");
    const missing = await guarded.inject({ method: "POST", url: URL, payload: body() });
    expect(missing.statusCode).toBe(401);
    await guarded.close();

    expect(taskEventCount(path)).toBe(0);
    // The guard stands before the seam: no lease store, no private root.
    expect(existsSync(artifactBlobLeaseStorePath(path))).toBe(false);
    expect(existsSync(artifactPlaneRootFor(path))).toBe(false);
  });
});

describe("POST /api/v1/tasks enters one task", () => {
  it("answers the task by digest and reference, and the GETs read it DISCOVERED", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

    const posted = await app.inject({ method: "POST", url: URL, headers: AUTH, payload: body() });
    expect(posted.statusCode).toBe(200);
    const document = TaskIntakeResponse.parse(posted.json());
    expect(document).toMatchObject({
      apiContractVersion: API_CONTRACT_VERSION,
      replayed: false,
      sequence: 1,
      task: {
        taskId: TASK,
        revisionNumber: 1,
        envelopeSha256: envelopeSha256(envelope()),
        state: "DISCOVERED",
        resolution: { modelVersionId: MODEL, slot: 0, transportKind: "CLI_SUBSCRIPTION" },
      },
    });
    // N-P14C-16: neither the answer nor the stream carries the envelope.
    expect(posted.body).not.toContain(OBJECTIVE);
    const rows = eventJsons(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(envelopeSha256(envelope()));
    expect(rows[0]).not.toContain(OBJECTIVE);

    // Q3: an intake is observable by the reads that were already there, unchanged.
    const list = TaskPageResponse.parse((await app.inject({ method: "GET", url: URL })).json());
    expect(list.items.map((item) => [item.taskId, item.currentState])).toEqual([[TASK, "DISCOVERED"]]);
    const detail = await app.inject({ method: "GET", url: URL + "/" + TASK });
    expect(detail.statusCode).toBe(200);
    const read = TaskDetailResponse.parse(detail.json());
    expect([read.task.taskId, read.task.currentState, read.task.lastTransitionId]).toEqual([TASK, "DISCOVERED", "intake"]);
    await app.close();
  });

  it("N-P14C-2: the same body again answers the same task, replayed, and nothing is published twice", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const first = TaskIntakeResponse.parse((await app.inject({ method: "POST", url: URL, headers: AUTH, payload: body() })).json());
    const second = await app.inject({ method: "POST", url: URL, headers: AUTH, payload: body() });
    expect(second.statusCode).toBe(200);
    const replayed = TaskIntakeResponse.parse(second.json());
    expect(replayed).toEqual({ ...first, replayed: true });
    expect(taskEventCount(path)).toBe(1);
    expect(intentionCount(path)).toBe(1);
    await app.close();
  });

  it("N-P14C-2: a task the other door's orchestration entered first is the same answer here", async () => {
    // The CLI door is `intakeTask` over its own handles; this is that call, in
    // this process, with its own identities — and then the API.
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(path), {
      incarnationId: randomUUID(),
      createdAt: AT,
    });
    const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: path });
    const byCommand = intakeTask({
      ledger,
      plane,
      request: body() as never,
      recordedAt: "2026-09-13T12:00:00.000Z",
      holderPid: process.pid,
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
    leaseStore.close();
    ledger.close();
    expect(byCommand.ok).toBe(true);

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const byApi = await app.inject({ method: "POST", url: URL, headers: AUTH, payload: body() });
    expect(byApi.statusCode).toBe(200);
    const document = TaskIntakeResponse.parse(byApi.json());
    expect(document.replayed).toBe(true);
    if (byCommand.ok) {
      expect(document.sequence).toBe(byCommand.sequence);
      expect(document.task).toEqual(byCommand.task);
    }
    expect(taskEventCount(path)).toBe(1);
    await app.close();
  });

  it("N-P14C-13: an intake that died after publishing is completed by the API, with no second intention", async () => {
    const path = temporaryDatabase();
    const reader = openLedger(path, { readOnly: true });
    expect(() =>
      recordTaskIntake({
        ledger: reader,
        request: body() as never,
        recordedAt: "2026-09-13T12:00:00.000Z",
        holderPid: process.pid,
        leaseStoreIncarnationId: randomUUID(),
        eventId: randomUUID(),
        revisionId: randomUUID(),
        commandId: randomUUID(),
        artifactPinId: randomUUID(),
        artifactReferenceId: randomUUID(),
        intentionEventId: randomUUID(),
        terminalEventId: randomUUID(),
        __testFaults: {
          afterEnvelopePublished: () => {
            throw new Error("the door died after the publication");
          },
        },
      }),
    ).toThrow("died after the publication");
    reader.close();
    expect(taskEventCount(path)).toBe(0);

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const retried = await app.inject({ method: "POST", url: URL, headers: AUTH, payload: body() });
    expect(retried.statusCode).toBe(200);
    expect(TaskIntakeResponse.parse(retried.json()).replayed).toBe(false);
    expect(intentionCount(path)).toBe(1);
    await app.close();
  });
});

describe("POST /api/v1/tasks refuses by the door that refused", () => {
  it("N-P14C-1: the same key with another envelope is 409 CONFLICT at the envelope, and nothing moves", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    await app.inject({ method: "POST", url: URL, headers: AUTH, payload: body() });
    const conflict = await app.inject({
      method: "POST",
      url: URL,
      headers: AUTH,
      payload: body({ envelope: envelope({ title: "Another title" }) }),
    });
    expect(conflict.statusCode).toBe(409);
    const error = ApiError.parse(conflict.json()).error;
    expect(error.code).toBe("WRITE_REFUSED");
    expect(error.message).toContain("CONFLICT CLIENT_KEY_CONFLICT");
    expect(error.detail).toBe("envelope");
    expect(taskEventCount(path)).toBe(1);
    await app.close();
  });

  it("N-P14C-8: a retired model version is 409 AUTHORITY_REFUSED, and the proposal reaches the caller", async () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    ledger.appendRegistryEvent(
      registryDocument("MODEL_VERSION", MODEL, modelVersionPayload({ status: "RETIRED", deprecatedAt: AT }), 2),
    );
    ledger.close();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const refused = await app.inject({ method: "POST", url: URL, headers: AUTH, payload: body() });
    expect(refused.statusCode).toBe(409);
    const error = ApiError.parse(refused.json()).error;
    expect(error.code).toBe("WRITE_REFUSED");
    expect(error.message).toContain("AUTHORITY_REFUSED MODEL_VERSION_RETIRED");
    expect(error.message).toContain("proposal MIGRATE_TO_ACTIVE_MODEL_VERSION");
    expect(error.detail).toBe("reading.modelVersion.status");
    expect(taskEventCount(path)).toBe(0);
    await app.close();
  });

  it("N-P14C-5: an initiative with no row is 409 REQUEST_INVALID at the envelope's initiative", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const refused = await app.inject({
      method: "POST",
      url: URL,
      headers: AUTH,
      payload: body({ envelope: envelope({ initiativeId: "99999999-9999-4999-8999-999999999999" }) }),
    });
    expect(refused.statusCode).toBe(409);
    const error = ApiError.parse(refused.json()).error;
    expect(error.message).toContain("REQUEST_INVALID INITIATIVE_UNKNOWN");
    expect(error.detail).toBe("envelope.initiativeId");
    expect(taskEventCount(path)).toBe(0);
    await app.close();
  });

  it("a malformed body or a credential-shaped objective is 400 by field, before the plane sees a byte", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

    const planted = await app.inject({
      method: "POST",
      url: URL,
      headers: AUTH,
      payload: body({ envelope: envelope({ objective: "deploy with " + SENTINEL }) }),
    });
    expect(planted.statusCode).toBe(400);
    const plantedError = ApiError.parse(planted.json()).error;
    expect(plantedError.code).toBe("BAD_REQUEST");
    expect(plantedError.detail).toBe("envelope.objective");
    expect(planted.body).not.toContain(SENTINEL);

    const computed = await app.inject({
      method: "POST",
      url: URL,
      headers: AUTH,
      payload: body({ envelopeSha256: "f".repeat(64) }),
    });
    expect(computed.statusCode).toBe(400);

    expect(taskEventCount(path)).toBe(0);
    expect(existsSync(artifactPlaneRootFor(path))).toBe(false);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// P-27 cut A: an intake's step exists in the version it names (decision 193)
// ---------------------------------------------------------------------------

describe("POST /api/v1/tasks refuses a step the linked version does not declare (P-27 cut A)", () => {
  /** A version recorded through the roadmap route; `steps` declares them, none otherwise. */
  async function recordVersion(app: ReturnType<typeof buildServer>, stepIds: readonly string[]): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/initiatives/" + INITIATIVE + "/roadmap",
      headers: AUTH,
      payload: {
        content: "# Roadmap\n",
        expectedHeadDigest: null,
        kind: "EDIT",
        restoresVersionId: null,
        recordedBy: COORDINATOR,
        ...(stepIds.length === 0
          ? {}
          : {
              steps: {
                manifestContractVersion: 1,
                steps: stepIds.map((stepId) => ({
                  stepId,
                  title: "Step " + stepId,
                  objective: "The objective of " + stepId + ".",
                  acceptance: "The acceptance of " + stepId + ".",
                  expectedWriteSet: ["docs/" + stepId + ".md"],
                  dependsOn: [],
                })),
              },
            }),
      },
    });
    expect(response.statusCode).toBe(200);
    return RoadmapVersionWriteResponse.parse(response.json()).version.roadmapVersionId;
  }

  it("ROADMAP_STEP_UNKNOWN: 409 WRITE_REFUSED at stepId for a step the version does not declare, and for every step of a version that declares none", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const declaring = await recordVersion(app, ["A"]);

    const unknown = await app.inject({ method: "POST", url: URL, headers: AUTH, payload: body({ roadmapVersionId: declaring, stepId: "Z" }) });
    expect(unknown.statusCode).toBe(409);
    const error = ApiError.parse(unknown.json()).error;
    expect(error.code).toBe("WRITE_REFUSED");
    expect(error.message).toContain("REQUEST_INVALID ROADMAP_STEP_UNKNOWN");
    expect(error.detail).toBe("stepId");
    expect(taskEventCount(path)).toBe(0);

    const entered = await app.inject({ method: "POST", url: URL, headers: AUTH, payload: body({ roadmapVersionId: declaring, stepId: "A" }) });
    expect(entered.statusCode).toBe(200);
    expect(TaskIntakeResponse.parse(entered.json()).replayed).toBe(false);
    await app.close();

    // Zero declares none: every step of such a version is unknown, never undeclared.
    const emptyPath = temporaryDatabase();
    const emptyApp = buildServer({ ledgerPath: emptyPath, writeBearerPath: bearerFile() });
    const empty = await recordVersion(emptyApp, []);
    const refused = await emptyApp.inject({ method: "POST", url: URL, headers: AUTH, payload: body({ roadmapVersionId: empty, stepId: "A" }) });
    expect(refused.statusCode).toBe(409);
    expect(ApiError.parse(refused.json()).error.message).toContain("REQUEST_INVALID ROADMAP_STEP_UNKNOWN");
    expect(taskEventCount(emptyPath)).toBe(0);
    await emptyApp.close();
  });

  it("ROADMAP_STEPS_UNDECLARED: a version of the cohort before steps, reached by a real rewind, refuses by its own word (ND-P27-9)", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const version = await recordVersion(app, []);
    await app.close();

    // The history as a build before P-26 cut B wrote it: every initiative event and the
    // version's payload at 2.9.0, with no step field, the chain recomputed; then
    // migrations 26 and 25 undone, so this build meets a ledger at 24 and migrates it.
    const raw = new DatabaseSync(path);
    const triggers = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('initiative_events_deny_update', 'initiative_events_deny_delete')")
      .all() as { sql: string }[];
    raw.exec("DROP TRIGGER initiative_events_deny_update; DROP TRIGGER initiative_events_deny_delete;");
    let previous = GENESIS_SHA256;
    for (const row of raw.prepare("SELECT sequence, event_json FROM initiative_events ORDER BY sequence").all() as { sequence: number; event_json: string }[]) {
      const decoded = JSON.parse(row.event_json) as Record<string, unknown>;
      decoded["contractVersion"] = "2.9.0";
      if (decoded["type"] === "ROADMAP_VERSION_RECORDED") {
        const cohort = new Set(["stepCount", "stepManifestArtifactReferenceId", "stepManifestSha256"]);
        decoded["payload"] = {
          ...Object.fromEntries(Object.entries(decoded["payload"] as Record<string, unknown>).filter(([key]) => !cohort.has(key))),
          contractVersion: "2.9.0",
        };
      }
      const rewritten = canonicalJsonStringify(decoded);
      const digest = chainDigest(previous, rewritten);
      raw
        .prepare("UPDATE initiative_events SET event_json = ?, contract_version = ?, previous_sha256 = ?, event_sha256 = ? WHERE sequence = ?")
        .run(rewritten, "2.9.0", previous, digest, row.sequence);
      previous = digest;
    }
    raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = 'initiative_head_event_sha256'").run(previous);
    raw.prepare("UPDATE projection_watermark SET source_head_sha256 = ? WHERE source_stream = 'initiative_events'").run(previous);
    for (const trigger of triggers) raw.exec(trigger.sql);
    raw.exec(
      "DROP TRIGGER tr_task_step_link_read_model__insert_only;" +
        "DROP INDEX ix_task_step_link_read_model__task_sequence;" +
        "DROP TABLE task_step_link_read_model;" +
        "DELETE FROM projection_watermark WHERE projection_name = 'task_step_link_read_model';" +
        "DROP TRIGGER tr_task_graph_revision_read_model__supersede_once;" +
        "DROP TABLE task_dependency_read_model;" +
        "DROP TABLE task_graph_node_read_model;" +
        "DROP TABLE task_graph_revision_read_model;" +
        "DELETE FROM projection_watermark WHERE projection_name IN " +
        "('task_graph_revision_read_model', 'task_graph_node_read_model', 'task_dependency_read_model');" +
        "DROP TRIGGER tr_roadmap_version_read_model__validate_steps_on_update;" +
        "DROP TRIGGER tr_roadmap_version_read_model__validate_steps_on_insert;" +
        "ALTER TABLE roadmap_version_read_model DROP COLUMN step_manifest_sha256;" +
        "ALTER TABLE roadmap_version_read_model DROP COLUMN step_manifest_artifact_reference_id;" +
        "ALTER TABLE roadmap_version_read_model DROP COLUMN step_count;" +
        "ALTER TABLE roadmap_version_read_model DROP COLUMN recording_contract_version;" +
        "DROP TABLE roadmap_step_dependency;" +
        "DROP TABLE roadmap_step_read_model;" +
        "DELETE FROM projection_watermark WHERE projection_name IN ('roadmap_step_read_model', 'roadmap_step_dependency');" +
        "DELETE FROM schema_migrations WHERE version >= 25;",
    );
    raw.close();
    const migrated = openLedger(path);
    expect(migrated.listRoadmapVersions(INITIATIVE).map((row) => [row.recordingContractVersion, row.stepCount])).toEqual([["2.9.0", null]]);
    expect(migrated.verifyIntegrity().problems).toEqual([]);
    migrated.close();

    const reopened = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const refused = await reopened.inject({ method: "POST", url: URL, headers: AUTH, payload: body({ roadmapVersionId: version, stepId: "A" }) });
    expect(refused.statusCode).toBe(409);
    const error = ApiError.parse(refused.json()).error;
    expect(error.code).toBe("WRITE_REFUSED");
    expect(error.message).toContain("REQUEST_INVALID ROADMAP_STEPS_UNDECLARED");
    expect(error.detail).toBe("stepId");
    expect(taskEventCount(path)).toBe(0);
    // With no link at all the task still enters: the dictionary's one case.
    const outside = await reopened.inject({ method: "POST", url: URL, headers: AUTH, payload: body() });
    expect(outside.statusCode).toBe(200);
    await reopened.close();
  });
});

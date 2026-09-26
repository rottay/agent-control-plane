import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  GENESIS_SHA256,
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  canonicalJsonStringify,
  chainDigest,
  envelopeIdentityPreimageV1,
  envelopeSha256,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  recordRoadmapRevision,
  sha256Hex,
} from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { API_CONTRACT_VERSION, LEDGER_CONTRACT_VERSION, TaskIntakeResponse } from "@acp/protocol";
import { intakeTask } from "@acp/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_INTEGRITY, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE, run } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/index.js";
import { runIntakeVerb } from "../../src/intake/index.js";

/**
 * The instruction content for a fixture whose prose is `text` (P-06/B, ADR 0094).
 *
 * One text block, the envelope's whole instruction: from 2.11.0 `content` states it
 * once (P-16/A1, ADR 0120). `contentSha256` is a placeholder:
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
 * Evidence for the CLI's task intake door (P-14/C, ADR 0087).
 *
 * The laws of an intake are `intakeTask`'s and its own suite holds them. What
 * this file holds is the door: the document it reads through the uid ladder, the
 * writable open it shares with the tool call, the exit code each refusal earns
 * with the class, code and proposal it carries, and that a task the API's path
 * entered first is the same answer when the command enters it again.
 */

const FIXED_NOW = "2026-09-13T12:00:00.000Z";
const AT = "2026-09-03T12:00:00.000Z";
const COORDINATOR = "kimi/k3/coordinator/01";
const OPERATOR = "claude/opus/implementer/01";
const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const TASK = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const MODEL = "claude-opus-5@2026-06-01";
const OBJECTIVE = "Enter one task by command and by API, and keep its envelope off the stream.";
const SENTINEL = "sk-ant-api03-SENTINELSENTINELSENTINEL";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const created = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "acp-cli-intake-")));
  roots.push(created);
  return created;
}

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

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    taskId: TASK,
    initiativeId: INITIATIVE,
    title: "Enter a task",
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

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

interface Fixture {
  readonly database: string;
  readonly request: (overrides?: Record<string, unknown>) => string;
}

function fixture(): Fixture {
  const dir = root();
  const database = join(dir, "control-plane.sqlite");
  const ledger = openLedger(database);
  seed(ledger);
  ledger.close();
  let written = 0;
  return {
    database,
    request: (overrides = {}) => {
      written += 1;
      const path = join(dir, "request-" + String(written) + ".json");
      writeFileSync(path, JSON.stringify(requestBody(overrides)), "utf8");
      return path;
    },
  };
}

interface Invocation {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(argv: readonly string[]): Promise<Invocation> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    now: () => FIXED_NOW,
  };
  const exitCode = await run(argv, io);
  return { exitCode, stdout, stderr };
}

function errorOf(result: Invocation): { readonly code: string; readonly message: string; readonly detail: string | null } {
  return (JSON.parse(result.stderr) as { readonly error: { readonly code: string; readonly message: string; readonly detail: string | null } })
    .error;
}

function taskRows(database: string): readonly string[] {
  const raw = new DatabaseSync(database, { readOnly: true });
  try {
    return (raw.prepare("SELECT event_json FROM control_plane_events ORDER BY sequence").all() as { readonly event_json: string }[]).map(
      (row) => row.event_json,
    );
  } finally {
    raw.close();
  }
}

/** Every artifact event of the registry stream: the documents the seed wrote are not counted. */
function artifactRows(database: string): number {
  const raw = new DatabaseSync(database, { readOnly: true });
  try {
    return (raw.prepare("SELECT COUNT(*) AS count FROM registry_events WHERE subject_kind <> 'DOCUMENT'").get() as { readonly count: number }).count;
  } finally {
    raw.close();
  }
}

describe("acp intake enters one task from a request document", () => {
  it("prints the intake by digest and reference, exits zero, and keeps the envelope off the stream", async () => {
    const f = fixture();
    const result = await invoke(["intake", "--database", f.database, "--request", f.request()]);
    expect(result.exitCode).toBe(EXIT_OK);
    const document = TaskIntakeResponse.parse(JSON.parse(result.stdout));
    expect(document).toMatchObject({
      apiContractVersion: API_CONTRACT_VERSION,
      replayed: false,
      sequence: 1,
      task: {
        taskId: TASK,
        revisionNumber: 1,
        envelopeSha256: envelopeSha256(envelope()),
        state: "DISCOVERED",
        resolution: { modelVersionId: MODEL, slot: 0 },
      },
    });
    // N-P14C-16.
    expect(result.stdout).not.toContain(OBJECTIVE);
    const rows = taskRows(f.database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain(OBJECTIVE);
    expect(rows[0]).toContain(envelopeSha256(envelope()));
  });

  it("N-P14C-2: the same document again is a replay of the same task", async () => {
    const f = fixture();
    const first = await invoke(["intake", "--database", f.database, "--request", f.request()]);
    const second = await invoke(["intake", "--database", f.database, "--request", f.request()]);
    expect(second.exitCode).toBe(EXIT_OK);
    const [a, b] = [first, second].map((result) => TaskIntakeResponse.parse(JSON.parse(result.stdout)));
    expect(b).toEqual({ ...a, replayed: true });
    expect(taskRows(f.database)).toHaveLength(1);
  });

  it("N-P14C-2: a task the API's path entered first is the same task when the command enters it", async () => {
    // The API door is `intakeTask` over the gateway's own handles; this is that
    // call, with its own identities, and then the command.
    const f = fixture();
    const ledger = openLedger(f.database);
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(f.database), {
      incarnationId: randomUUID(),
      createdAt: FIXED_NOW,
    });
    const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: f.database });
    const byApi = intakeTask({
      ledger,
      plane,
      request: requestBody() as never,
      recordedAt: FIXED_NOW,
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
    if (!byApi.ok) throw new Error("expected the API's intake");

    const byCommand = await invoke(["intake", "--database", f.database, "--request", f.request({ recordedBy: COORDINATOR })]);
    expect(byCommand.exitCode).toBe(EXIT_OK);
    const document = TaskIntakeResponse.parse(JSON.parse(byCommand.stdout));
    expect(document.replayed).toBe(true);
    expect(document.sequence).toBe(byApi.sequence);
    expect(document.task).toEqual(byApi.task);
    expect(taskRows(f.database)).toHaveLength(1);
  });

  it("N-P14C-13: completes an intake that died after publishing, with no second publication", async () => {
    const f = fixture();
    expect(() =>
      runIntakeVerb({
        databasePath: f.database,
        requestPath: f.request(),
        __testFaults: {
          afterEnvelopePublished: () => {
            throw new Error("the command died after the publication");
          },
        },
      }),
    ).toThrow("died after the publication");
    expect(taskRows(f.database)).toHaveLength(0);

    const retried = await invoke(["intake", "--database", f.database, "--request", f.request()]);
    expect(retried.exitCode).toBe(EXIT_OK);
    const document = TaskIntakeResponse.parse(JSON.parse(retried.stdout));
    const ledger = openLedger(f.database, { readOnly: true });
    const reference = ledger.getArtifactReference(document.task.envelopeArtifactReferenceId);
    const kinds = reference === null ? [] : ledger.listArtifactEvents(reference.contentSha256).map((record) => record.event.artifactEventKind);
    ledger.close();
    expect(kinds).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_SUCCEEDED"]);
  });
});

describe("acp intake refuses by the exit code the refusal earns", () => {
  it("N-P14C-1: the same key with another envelope is WRITE_REFUSED, EXIT_INTEGRITY, naming the envelope", async () => {
    const f = fixture();
    await invoke(["intake", "--database", f.database, "--request", f.request()]);
    const result = await invoke([
      "intake",
      "--database",
      f.database,
      "--format",
      "json",
      "--request",
      f.request({ envelope: envelope({ title: "Another title" }) }),
    ]);
    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    expect(errorOf(result)).toMatchObject({ code: "WRITE_REFUSED", detail: "envelope" });
    expect(errorOf(result).message).toContain("CONFLICT CLIENT_KEY_CONFLICT");
    expect(taskRows(f.database)).toHaveLength(1);
  });

  it("N-P14C-8: a retired model version is WRITE_REFUSED with AUTHORITY_REFUSED, and the proposal is printed", async () => {
    const f = fixture();
    const ledger = openLedger(f.database);
    ledger.appendRegistryEvent(
      registryDocument("MODEL_VERSION", MODEL, modelVersionPayload({ status: "RETIRED", deprecatedAt: AT }), 2),
    );
    ledger.close();
    const result = await invoke(["intake", "--database", f.database, "--format", "json", "--request", f.request()]);
    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    expect(errorOf(result)).toMatchObject({ code: "WRITE_REFUSED", detail: "reading.modelVersion.status" });
    expect(errorOf(result).message).toContain("AUTHORITY_REFUSED MODEL_VERSION_RETIRED");
    expect(errorOf(result).message).toContain("proposal MIGRATE_TO_ACTIVE_MODEL_VERSION");
    expect(taskRows(f.database)).toHaveLength(0);
  });

  it("a credential-shaped instruction is BAD_REQUEST by field, never echoed, and nothing is published", async () => {
    // The instruction is stated once, in `content`, since P-16/A1 (ADR 0120).
    const f = fixture();
    const result = await invoke([
      "intake",
      "--database",
      f.database,
      "--format",
      "json",
      "--request",
      f.request({ envelope: envelope({ content: fixtureContent("deploy with " + SENTINEL) }) }),
    ]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail: "request.envelope.content.blocks.0.text" });
    expect(result.stderr).not.toContain(SENTINEL);
    expect(taskRows(f.database)).toHaveLength(0);
    expect(existsSync(artifactPlaneRootFor(f.database))).toBe(false);
  });

  it("refuses a missing or relative request document through the tool call's ladder", async () => {
    const f = fixture();
    const missing = await invoke(["intake", "--database", f.database, "--format", "json"]);
    expect(missing.exitCode).toBe(EXIT_USAGE);
    expect(errorOf(missing)).toMatchObject({ code: "BAD_REQUEST", detail: "request" });
    const relative = await invoke(["intake", "--database", f.database, "--format", "json", "--request", "request.json"]);
    expect(relative.exitCode).toBe(EXIT_USAGE);
    expect(errorOf(relative).detail).toBe("request");
    const stray = await invoke(["intake", "--database", f.database, "--request", f.request(), "--task", TASK]);
    expect(stray.exitCode).toBe(EXIT_USAGE);
  });

  it("probes the ledger before it opens it writable: an absent path is created by nobody", async () => {
    const f = fixture();
    const absent = join(root(), "typo.sqlite");
    const result = await invoke(["intake", "--database", absent, "--format", "json", "--request", f.request()]);
    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(errorOf(result).code).toBe("LEDGER_UNAVAILABLE");
    expect(existsSync(absent)).toBe(false);
  });
});

/**
 * The CLI is the second producer of the intake's refusal text (P-27 cut B, decision 199;
 * Fable P-26/ACCEPT v3 N1): `acp intake` names both step words the way the gateway does,
 * through the real door, and appends nothing when it refuses.
 */
describe("acp intake under 0.25.0: the envelope states its instruction once (P-16/A1, ADR 0120)", () => {
  it("E1: an envelope without `objective` enters, DISCOVERED at revision 1, and its digest is the two-method value", async () => {
    const f = fixture();
    expect(Object.keys(envelope())).not.toContain("objective");
    const result = await invoke(["intake", "--database", f.database, "--request", f.request()]);
    expect(result.exitCode).toBe(EXIT_OK);
    const document = TaskIntakeResponse.parse(JSON.parse(result.stdout));
    expect(document.apiContractVersion).toBe("0.25.0");
    expect(document.task).toMatchObject({ taskId: TASK, revisionNumber: 1, state: "DISCOVERED" });
    expect(document.task.envelopeSha256).toBe(envelopeSha256(envelope()));
    expect(document.task.envelopeSha256).toBe(createHash("sha256").update(envelopeIdentityPreimageV1(envelope()), "utf8").digest("hex"));
    expect(existsSync(artifactPlaneRootFor(f.database))).toBe(true);
  });

  it("E2: an envelope that still carries `objective` is BAD_REQUEST at the envelope, EXIT_USAGE, with no event, no publication and no artifact row", async () => {
    for (const objective of [OBJECTIVE, "Something the content does not say."]) {
      const f = fixture();
      const result = await invoke([
        "intake",
        "--database",
        f.database,
        "--format",
        "json",
        "--request",
        f.request({ envelope: envelope({ objective }) }),
      ]);
      expect(result.exitCode, objective).toBe(EXIT_USAGE);
      expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail: "request.envelope" });
      expect(result.stderr).not.toContain(objective);
      expect(taskRows(f.database)).toHaveLength(0);
      expect(artifactRows(f.database)).toBe(0);
      expect(existsSync(artifactPlaneRootFor(f.database))).toBe(false);
    }
  });
});

describe("acp intake names a step its version does not declare, and a version that declares none knowably (P-27 cut B)", () => {
  const VERSION = "66666666-6666-4666-8666-666666666601";

  /** A version declaring `stepIds`, through the ledger's one producer and a plane over the fixture's lease store. */
  function recordVersionWithSteps(database: string, stepIds: readonly string[]): void {
    const ledger = openLedger(database);
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(database), {
      incarnationId: randomUUID(),
      createdAt: FIXED_NOW,
    });
    try {
      const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: database });
      const outcome = recordRoadmapRevision({
        reader: ledger,
        writable: ledger,
        plane,
        initiativeId: INITIATIVE,
        request: {
          content: "# Roadmap\n",
          expectedHeadDigest: null,
          kind: "EDIT",
          restoresVersionId: null,
          recordedBy: COORDINATOR,
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
        },
        recordedAt: AT,
        roadmapVersionId: VERSION,
        eventId: randomUUID(),
        holderPid: process.pid,
        stepIdentities: {
          stepEventIds: stepIds.map(() => randomUUID()),
          commandId: randomUUID(),
          artifactPinId: randomUUID(),
          artifactReferenceId: randomUUID(),
          intentionEventId: randomUUID(),
          terminalEventId: randomUUID(),
        },
      });
      if (!outcome.ok) throw new Error("the fixture's roadmap version was refused: " + outcome.reason + " at " + outcome.at);
    } finally {
      leaseStore.close();
      ledger.close();
    }
  }

  /** A version of the step cohort (2.10.0 on) declaring no step, through the single door, in this suite's own mould. */
  function recordVersionWithNoStep(database: string): void {
    const transitionId = "roadmap." + VERSION;
    const ledger = openLedger(database);
    try {
      ledger.appendInitiativeEvent({
        contractVersion: LEDGER_CONTRACT_VERSION,
        eventId: randomUUID(),
        initiativeId: INITIATIVE,
        transitionId,
        idempotencyKey: INITIATIVE + "/1/" + transitionId,
        type: "ROADMAP_VERSION_RECORDED",
        fromStatus: "ACTIVE",
        toStatus: "ACTIVE",
        emittedBy: COORDINATOR,
        occurredAt: AT,
        recordedAt: AT,
        payload: {
          contractVersion: LEDGER_CONTRACT_VERSION,
          roadmapVersionId: VERSION,
          initiativeId: INITIATIVE,
          version: 1,
          contentDigest: "a".repeat(64),
          parentVersionId: null,
          expectedHeadDigest: null,
          kind: "EDIT",
          restoresVersionId: null,
          recordedBy: COORDINATOR,
          recordedAt: AT,
          stepCount: 0,
          stepManifestArtifactReferenceId: null,
          stepManifestSha256: null,
        },
      });
    } finally {
      ledger.close();
    }
  }

  /**
   * The history as a build before P-26 cut B wrote it (ND-6 (b)): every initiative event,
   * and the version's payload, at 2.9.0 with no step field, the chain, the head and the
   * stream's watermarks recomputed; then this build's own rebuild at migration 26. No
   * migration is undone and no table dropped.
   */
  function rewriteToCohortBeforeSteps(database: string): void {
    const raw = new DatabaseSync(database);
    try {
      const triggers = raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('initiative_events_deny_update', 'initiative_events_deny_delete')")
        .all() as { readonly sql: string }[];
      expect(triggers).toHaveLength(2);
      raw.exec("DROP TRIGGER initiative_events_deny_update; DROP TRIGGER initiative_events_deny_delete;");
      let previous = GENESIS_SHA256;
      for (const row of raw.prepare("SELECT sequence, event_json FROM initiative_events ORDER BY sequence").all() as {
        readonly sequence: number;
        readonly event_json: string;
      }[]) {
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
    } finally {
      raw.close();
    }
    const ledger = openLedger(database);
    try {
      ledger.rebuildReadModel();
      expect(ledger.listRoadmapVersions(INITIATIVE).map((row) => [row.recordingContractVersion, row.stepCount])).toEqual([["2.9.0", null]]);
      expect(ledger.verifyIntegrity().problems).toEqual([]);
    } finally {
      ledger.close();
    }
  }

  /**
   * The files the private plane holds. The command opens the plane before it decides,
   * so a refusal may leave its root; what it must not leave is a published file.
   */
  function planeFiles(database: string): readonly string[] {
    const plane = artifactPlaneRootFor(database);
    if (!existsSync(plane)) return [];
    return readdirSync(plane, { recursive: true, encoding: "utf8" })
      .filter((entry) => lstatSync(join(plane, entry)).isFile())
      .sort();
  }

  /** Invoke `acp intake` on `link` and hold that a refusal appended nothing and published nothing. */
  async function refusedIntake(f: Fixture, link: Record<string, unknown>): Promise<{ readonly code: string; readonly message: string; readonly detail: string | null }> {
    const rows = taskRows(f.database);
    const files = planeFiles(f.database);
    const result = await invoke(["intake", "--database", f.database, "--format", "json", "--request", f.request(link)]);
    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    expect(taskRows(f.database)).toEqual(rows);
    expect(planeFiles(f.database)).toEqual(files);
    return errorOf(result);
  }

  it("T-C1: a step the version does not declare is WRITE_REFUSED naming ROADMAP_STEP_UNKNOWN, and a declared step enters", async () => {
    const f = fixture();
    recordVersionWithSteps(f.database, ["A"]);
    expect(planeFiles(f.database)).not.toEqual([]);
    const error = await refusedIntake(f, { roadmapVersionId: VERSION, stepId: "Z" });
    expect(error).toMatchObject({ code: "WRITE_REFUSED", detail: "stepId" });
    expect(error.message).toContain("REQUEST_INVALID ROADMAP_STEP_UNKNOWN");

    const before = taskRows(f.database).length;
    const entered = await invoke(["intake", "--database", f.database, "--request", f.request({ roadmapVersionId: VERSION, stepId: "A" })]);
    expect(entered.exitCode).toBe(EXIT_OK);
    const document = TaskIntakeResponse.parse(JSON.parse(entered.stdout));
    expect(document.replayed).toBe(false);
    expect(taskRows(f.database)).toHaveLength(before + 1);
  });

  it("T-C2: a version that declares zero steps refuses every step as unknown, never as undeclared", async () => {
    const f = fixture();
    recordVersionWithNoStep(f.database);
    const error = await refusedIntake(f, { roadmapVersionId: VERSION, stepId: "A" });
    expect(error).toMatchObject({ code: "WRITE_REFUSED", detail: "stepId" });
    expect(error.message).toContain("REQUEST_INVALID ROADMAP_STEP_UNKNOWN");
    expect(error.message).not.toContain("ROADMAP_STEPS_UNDECLARED");
    expect(taskRows(f.database)).toHaveLength(0);
    expect(planeFiles(f.database)).toEqual([]);
  });

  it("T-C3: a version of the cohort before steps, reached by a real rewrite and rebuild, is ROADMAP_STEPS_UNDECLARED, and an unlinked task still enters", async () => {
    const f = fixture();
    recordVersionWithNoStep(f.database);
    rewriteToCohortBeforeSteps(f.database);
    const error = await refusedIntake(f, { roadmapVersionId: VERSION, stepId: "A" });
    expect(error).toMatchObject({ code: "WRITE_REFUSED", detail: "stepId" });
    expect(error.message).toContain("REQUEST_INVALID ROADMAP_STEPS_UNDECLARED");
    expect(taskRows(f.database)).toHaveLength(0);
    expect(planeFiles(f.database)).toEqual([]);

    const outside = await invoke(["intake", "--database", f.database, "--request", f.request()]);
    expect(outside.exitCode).toBe(EXIT_OK);
    expect(taskRows(f.database)).toHaveLength(1);
  });
});

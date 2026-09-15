import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  envelopeSha256,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
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
    contentDigest: String(version).repeat(64),
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

  it("a credential-shaped objective is BAD_REQUEST by field, never echoed, and nothing is published", async () => {
    const f = fixture();
    const result = await invoke([
      "intake",
      "--database",
      f.database,
      "--format",
      "json",
      "--request",
      f.request({ envelope: envelope({ objective: "deploy with " + SENTINEL }) }),
    ]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail: "request.envelope.objective" });
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

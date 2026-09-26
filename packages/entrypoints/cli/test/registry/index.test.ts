import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PUBLISHABLE_DOCUMENT_KINDS, canonicalJsonStringify, openLedger } from "@acp/ledger";
import { LEDGER_CONTRACT_VERSION, RegistryPublicationResponse, SURFACE_MAP, TaskIntakeResponse } from "@acp/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_INTEGRITY, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE, REGISTRY_COMMAND, run } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/index.js";

/**
 * Evidence for the CLI's registry publication door (P-15 escalón R, ADR 0104).
 *
 * The laws of a publication are `publishRegistryDocument`'s and the ledger's, and
 * their suites hold them. What this file holds is the door, driven in process
 * through the real `run(argv)`: the document it reads through the uid ladder, the
 * writable open it shares with the tool call, the exit code each refusal earns with
 * the word it carries — and the bootstrap it exists for: a model version, its GLOBAL
 * slot and a covering catalog published through this verb, after which a real
 * `acp intake` resolves the role.
 */

const FIXED_NOW = "2026-09-20T10:00:00.000Z";
const AT = "2026-09-03T12:00:00.000Z";
const RULES_FROM = "2026-09-01T00:00:00.000Z";
const OWNER = "claude/opus/coordinator/01";
const OPERATOR = "claude/opus/implementer/01";
const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const TASK = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const MODEL = "claude-opus-5@2026-06-01";
const CATALOG = "catalog-claude";
const OBJECTIVE = "Bootstrap the registry through its door, then enter a task.";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const created = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "acp-cli-registry-")));
  roots.push(created);
  return created;
}

function modelVersionPayload(): Record<string, unknown> {
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
  };
}

function catalogPayload(): Record<string, unknown> {
  const interval = (tokenClass: string, pricePerMillionNanos: number): Record<string, unknown> => ({
    provider: "claude",
    modelVersionId: MODEL,
    transportKind: "CLI_SUBSCRIPTION",
    tokenClass,
    currency: "USD",
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveTo: null,
    pricePerMillionNanos,
  });
  return {
    intervals: [
      interval("input", 15_000_000_000),
      interval("output", 75_000_000_000),
      interval("cache_read", 1_500_000_000),
      interval("cache_write", 18_750_000_000),
    ],
  };
}

const MODEL_DOCUMENT = {
  documentKind: "MODEL_VERSION",
  documentId: MODEL,
  documentVersion: 1,
  parentDocumentVersion: null,
  effectiveFrom: RULES_FROM,
  recordedBy: OWNER,
  payload: modelVersionPayload(),
};

const ROUTING_DOCUMENT = {
  documentKind: "ROUTING_ASSIGNMENT_GLOBAL",
  documentId: "routing:GLOBAL:implementer:0",
  documentVersion: 1,
  parentDocumentVersion: null,
  effectiveFrom: RULES_FROM,
  recordedBy: OWNER,
  payload: { role: "implementer", slot: 0, provider: "claude", modelVersionId: MODEL, fallbacks: [] },
};

const CATALOG_DOCUMENT = {
  documentKind: "PRICE_TABLE",
  documentId: CATALOG,
  documentVersion: 1,
  parentDocumentVersion: null,
  effectiveFrom: RULES_FROM,
  recordedBy: OWNER,
  payload: catalogPayload(),
};

interface Fixture {
  readonly dir: string;
  readonly database: string;
  readonly write: (document: unknown) => string;
}

function fixture(): Fixture {
  const dir = root();
  const database = join(dir, "control-plane.sqlite");
  openLedger(database).close();
  let written = 0;
  return {
    dir,
    database,
    write: (document) => {
      written += 1;
      const path = join(dir, "document-" + String(written) + ".json");
      writeFileSync(path, typeof document === "string" ? document : JSON.stringify(document), "utf8");
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

async function publish(f: Fixture, document: unknown): Promise<Invocation> {
  return invoke(["registry", "--database", f.database, "--format", "json", "--request", f.write(document)]);
}

function errorOf(result: Invocation): { readonly code: string; readonly message: string; readonly detail: string | null } {
  return (JSON.parse(result.stderr) as { readonly error: { readonly code: string; readonly message: string; readonly detail: string | null } })
    .error;
}

/** Everything a publication could move, read raw: the registry rows and its head. */
function registryFootprint(database: string): unknown {
  const raw = new DatabaseSync(database, { readOnly: true });
  try {
    return {
      rows: raw.prepare("SELECT sequence, event_sha256 FROM registry_events ORDER BY sequence").all(),
      meta: raw.prepare("SELECT key, value FROM ledger_meta WHERE key LIKE 'registry_%' ORDER BY key").all(),
      prices: raw.prepare("SELECT COUNT(*) AS n FROM price_interval_read_model").all(),
      models: raw.prepare("SELECT COUNT(*) AS n FROM model_version_read_model").all(),
      routing: raw.prepare("SELECT COUNT(*) AS n FROM routing_assignment_read_model").all(),
    };
  } finally {
    raw.close();
  }
}

function envelope(): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    taskId: TASK,
    initiativeId: INITIATIVE,
    title: "Enter a task",
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
    issuedBy: OWNER,
    issuedAt: AT,
    authority: [],
    readSet: [],
    writeSet: ["docs/registry.md"],
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

describe("acp registry publishes one registry version from a request document", () => {
  it("PC-R1: a first task's registry through this door, and then a real acp intake resolves the role", async () => {
    const f = fixture();
    const initiative = await invoke([
      "initiative",
      "--database",
      f.database,
      "--request",
      f.write({ initiativeId: INITIATIVE, slug: "registry-bootstrap", title: "Registry bootstrap", objective: OBJECTIVE, recordedBy: OWNER }),
    ]);
    expect(initiative.exitCode).toBe(EXIT_OK);

    const sequences: number[] = [];
    for (const document of [MODEL_DOCUMENT, ROUTING_DOCUMENT, CATALOG_DOCUMENT]) {
      const result = await publish(f, document);
      expect({ kind: document.documentKind, exit: result.exitCode }).toEqual({ kind: document.documentKind, exit: EXIT_OK });
      const printed = RegistryPublicationResponse.parse(JSON.parse(result.stdout));
      expect(printed.replayed).toBe(false);
      expect(printed.document).toMatchObject({ documentKind: document.documentKind, documentId: document.documentId, documentVersion: 1 });
      // PC-R4, through the door: the digest is the payload's, recomputed here.
      expect(printed.document.contentDigest).toBe(createHash("sha256").update(canonicalJsonStringify(document.payload), "utf8").digest("hex"));
      // The payload is configuration and is not echoed.
      expect(result.stdout).not.toContain("pricePerMillionNanos");
      sequences.push(printed.sequence);
    }
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));

    const ledger = openLedger(f.database, { readOnly: true });
    try {
      expect(ledger.getModelVersion(MODEL).modelVersion?.row.status).toBe("ACTIVE");
      expect(ledger.getGlobalRoutingAssignment({ role: "implementer", slot: 0 }).assignment?.modelVersionId).toBe(MODEL);
      expect(ledger.readPriceIntervals({ catalogDocumentId: CATALOG, catalogVersion: 1 })).toHaveLength(4);
      expect(ledger.getVigentCatalogPin(CATALOG, FIXED_NOW)).toEqual({ catalogDocumentId: CATALOG, catalogVersion: 1 });
      expect(ledger.verifyIntegrity().problems).toEqual([]);
    } finally {
      ledger.close();
    }

    const intake = await invoke([
      "intake",
      "--database",
      f.database,
      "--request",
      f.write({
        envelope: envelope(),
        clientScope: OPERATOR,
        clientRequestKey: "registry-bootstrap-0001",
        roadmapVersionId: null,
        stepId: null,
        role: "implementer",
        slot: 0,
        transportKind: "CLI_SUBSCRIPTION",
        recordedBy: OPERATOR,
      }),
    ]);
    expect(intake.exitCode).toBe(EXIT_OK);
    const entered = TaskIntakeResponse.parse(JSON.parse(intake.stdout));
    expect(entered.task.resolution).toMatchObject({ modelVersionId: MODEL, provider: "claude", slot: 0, transportKind: "CLI_SUBSCRIPTION" });
  });

  it("PC-R2: the same document again is a replay of the same version, and nothing is appended", async () => {
    const f = fixture();
    const first = await publish(f, MODEL_DOCUMENT);
    const before = registryFootprint(f.database);
    const second = await publish(f, { ...MODEL_DOCUMENT, recordedBy: OPERATOR });
    expect(second.exitCode).toBe(EXIT_OK);
    const [a, b] = [first, second].map((result) => RegistryPublicationResponse.parse(JSON.parse(result.stdout)));
    expect(b).toEqual({ ...a, replayed: true });
    expect(registryFootprint(f.database)).toEqual(before);
  });

  it("N-R2: the same version with another payload is WRITE_REFUSED, EXIT_INTEGRITY, naming the field", async () => {
    const f = fixture();
    await publish(f, MODEL_DOCUMENT);
    const before = registryFootprint(f.database);
    const result = await publish(f, { ...MODEL_DOCUMENT, payload: { ...modelVersionPayload(), contextTokens: 100000 } });
    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    expect(errorOf(result)).toMatchObject({ code: "WRITE_REFUSED", detail: "contentDigest" });
    expect(errorOf(result).message).toContain("REGISTRY_VERSION_CONFLICT");
    expect(registryFootprint(f.database)).toEqual(before);
  });

  it("N-R1, N-R3 and N-R5: a kind outside the three, an instant taken and a door refusal carry their words", async () => {
    const f = fixture();
    await publish(f, MODEL_DOCUMENT);
    await publish(f, CATALOG_DOCUMENT);
    const before = registryFootprint(f.database);

    const kind = await publish(f, { ...MODEL_DOCUMENT, documentKind: "CAPABILITY_POLICY", documentId: "capability-policy" });
    expect(kind.exitCode).toBe(EXIT_INTEGRITY);
    expect(errorOf(kind)).toMatchObject({ code: "WRITE_REFUSED", detail: "documentKind" });
    expect(errorOf(kind).message).toContain("REGISTRY_KIND_NOT_PUBLISHABLE");

    const tie = await publish(f, { ...CATALOG_DOCUMENT, documentVersion: 2, parentDocumentVersion: 1 });
    expect(tie.exitCode).toBe(EXIT_INTEGRITY);
    expect(errorOf(tie)).toMatchObject({ code: "WRITE_REFUSED", detail: "effectiveFrom" });
    expect(errorOf(tie).message).toContain("REGISTRY_DOCUMENT_REFUSED REGISTRY_EFFECTIVE_FROM_TAKEN");

    const ghost = await publish(f, {
      ...CATALOG_DOCUMENT,
      documentId: "catalog-ghost",
      payload: { intervals: [{ ...(catalogPayload()["intervals"] as Record<string, unknown>[])[0], modelVersionId: "ghost@1" }] },
    });
    expect(ghost.exitCode).toBe(EXIT_INTEGRITY);
    expect(errorOf(ghost)).toMatchObject({ code: "WRITE_REFUSED", detail: "payload.intervals[0].modelVersionId" });
    expect(errorOf(ghost).message).toContain("MODEL_VERSION_UNKNOWN");
    expect(registryFootprint(f.database)).toEqual(before);
  });

  it("N-R14 and the canonical instant: a derived field or an offset instant is BAD_REQUEST, before any ledger is opened", async () => {
    const f = fixture();
    const before = registryFootprint(f.database);
    for (const [document, detail] of [
      [{ ...MODEL_DOCUMENT, contentDigest: "a".repeat(64) }, "request"],
      [{ ...MODEL_DOCUMENT, eventId: "7c4a701f-2d9c-50bc-bcc8-a9456ee22dfd" }, "request"],
      [{ ...MODEL_DOCUMENT, idempotencyKey: "registry/x/1" }, "request"],
      [{ ...MODEL_DOCUMENT, effectiveFrom: "2026-09-01T02:00:00.000+02:00" }, "request.effectiveFrom"],
      [{ ...MODEL_DOCUMENT, documentVersion: 2 }, "request.parentDocumentVersion"],
    ] as const) {
      const result = await publish(f, document);
      expect(result.exitCode).toBe(EXIT_USAGE);
      expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail });
    }
    expect(registryFootprint(f.database)).toEqual(before);
  });

  it("N-R11: the request document is read through the uid ladder, naming the field and never the path", async () => {
    const f = fixture();
    const before = registryFootprint(f.database);
    const oversized = f.write(JSON.stringify({ ...MODEL_DOCUMENT, payload: { ...modelVersionPayload(), padding: "x".repeat(70_000) } }));
    const notJson = f.write("{ not json");
    const linked = join(f.dir, "linked.json");
    symlinkSync(f.write(MODEL_DOCUMENT), linked);
    for (const path of [oversized, notJson, linked, join(f.dir, "absent.json"), "request.json"]) {
      const result = await invoke(["registry", "--database", f.database, "--format", "json", "--request", path]);
      expect(result.exitCode).toBe(EXIT_USAGE);
      expect(errorOf(result)).toMatchObject({ code: "BAD_REQUEST", detail: "request" });
      expect(result.stderr).not.toContain(f.dir);
    }
    const missing = await invoke(["registry", "--database", f.database, "--format", "json"]);
    expect(missing.exitCode).toBe(EXIT_USAGE);
    expect(errorOf(missing)).toMatchObject({ code: "BAD_REQUEST", detail: "request" });
    expect(registryFootprint(f.database)).toEqual(before);
  });

  it("N-R12: a missing, absent or non-ledger database is refused, and nothing is created or opened writable", async () => {
    const f = fixture();
    const request = f.write(MODEL_DOCUMENT);
    const noDatabase = await invoke(["registry", "--format", "json", "--request", request]);
    expect(noDatabase.exitCode).toBe(EXIT_USAGE);

    const absent = join(f.dir, "typo.sqlite");
    const typo = await invoke(["registry", "--database", absent, "--format", "json", "--request", request]);
    expect(typo.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(errorOf(typo).code).toBe("LEDGER_UNAVAILABLE");
    expect(existsSync(absent)).toBe(false);

    const text = join(f.dir, "notes.txt");
    writeFileSync(text, "not a ledger", "utf8");
    const notLedger = await invoke(["registry", "--database", text, "--format", "json", "--request", request]);
    expect(notLedger.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(errorOf(notLedger).code).toBe("LEDGER_UNAVAILABLE");
  });

  it("is named once, declared CLI_ONLY, and answers with the ledger's three kinds", () => {
    expect(REGISTRY_COMMAND).toBe("registry");
    expect(SURFACE_MAP.filter((entry) => entry.command === REGISTRY_COMMAND).map((entry) => entry.equivalence)).toEqual(["CLI_ONLY"]);
    const printed = RegistryPublicationResponse.shape.document.shape.documentKind.options;
    expect([...printed].sort()).toEqual([...PUBLISHABLE_DOCUMENT_KINDS].sort());
  });
});

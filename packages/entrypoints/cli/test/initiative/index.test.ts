import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  registerInitiative,
} from "@acp/ledger";
import { API_CONTRACT_VERSION, InitiativeRegistrationResponse } from "@acp/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_INTEGRITY, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE, run } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/index.js";
import { runInitiativeVerb } from "../../src/initiative/index.js";

/**
 * Evidence for the CLI's initiative registration door (P-14/B, ADR 0086).
 *
 * The laws of a registration are `registerInitiative`'s and its own suite holds
 * them. What this file holds is the door: the document it reads through the
 * uid ladder, the writable open it shares with the tool call, the exit code
 * each refusal earns, and that a registration the API's path recorded first is
 * the same row when the command registers it again.
 */

const FIXED_NOW = "2026-09-13T12:00:00.000Z";
const COORDINATOR = "kimi/k3/coordinator/01";
const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const OBJECTIVE = "Register an initiative by command and by API, and keep its objective off the stream.";
const SENTINEL = "sk-ant-api03-SENTINELSENTINELSENTINEL";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const created = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "acp-cli-initiative-")));
  roots.push(created);
  return created;
}

interface Fixture {
  readonly database: string;
  readonly request: (overrides?: Record<string, unknown>) => string;
}

function fixture(): Fixture {
  const dir = root();
  const database = join(dir, "control-plane.sqlite");
  openLedger(database).close();
  let written = 0;
  return {
    database,
    request: (overrides = {}) => {
      written += 1;
      const path = join(dir, "request-" + String(written) + ".json");
      writeFileSync(
        path,
        JSON.stringify({
          initiativeId: INITIATIVE,
          slug: "acp-p14",
          title: "The P-14 bootstrap",
          objective: OBJECTIVE,
          recordedBy: COORDINATOR,
          ...overrides,
        }),
        "utf8",
      );
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

function envelope(result: Invocation): { readonly error: { readonly code: string; readonly message: string; readonly detail: string | null } } {
  return JSON.parse(result.stderr) as { readonly error: { readonly code: string; readonly message: string; readonly detail: string | null } };
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function initiativeRows(database: string): readonly string[] {
  const raw = new DatabaseSync(database, { readOnly: true });
  try {
    return (raw.prepare("SELECT event_json FROM initiative_events ORDER BY sequence").all() as { readonly event_json: string }[]).map(
      (row) => row.event_json,
    );
  } finally {
    raw.close();
  }
}

describe("acp initiative registers one initiative from a request document", () => {
  it("N-P14B-4: prints the registration by digest, exits zero, and keeps the objective off the stream", async () => {
    const f = fixture();
    const result = await invoke(["initiative", "--database", f.database, "--request", f.request()]);
    expect(result.exitCode).toBe(EXIT_OK);
    const document = InitiativeRegistrationResponse.parse(JSON.parse(result.stdout));
    expect(document).toMatchObject({
      apiContractVersion: API_CONTRACT_VERSION,
      replayed: false,
      sequence: 1,
      registration: { initiativeId: INITIATIVE, slug: "acp-p14", objectiveSha256: sha256(OBJECTIVE), eventCount: 1 },
    });
    expect(result.stdout).not.toContain(OBJECTIVE);
    const rows = initiativeRows(f.database);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain(OBJECTIVE);
    expect(rows[0]).toContain(sha256(OBJECTIVE));
  });

  it("N-P14B-1: the same document again is a replay of the same row", async () => {
    const f = fixture();
    const first = await invoke(["initiative", "--database", f.database, "--request", f.request()]);
    const second = await invoke(["initiative", "--database", f.database, "--request", f.request()]);
    expect(second.exitCode).toBe(EXIT_OK);
    const [a, b] = [first, second].map((result) => InitiativeRegistrationResponse.parse(JSON.parse(result.stdout)));
    expect(b?.replayed).toBe(true);
    expect(b?.sequence).toBe(a?.sequence);
    expect(b?.registration).toEqual(a?.registration);
    expect(initiativeRows(f.database)).toHaveLength(1);
  });

  it("N-P14B-1: a registration the API's path recorded first is the same row when the command registers it", async () => {
    // The API door is `registerInitiative` over the gateway's own handles; this
    // is that call, with its own identities, and then the command.
    const f = fixture();
    const ledger = openLedger(f.database);
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(f.database), {
      incarnationId: randomUUID(),
      createdAt: FIXED_NOW,
    });
    const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: f.database });
    const byApi = registerInitiative({
      ledger,
      plane,
      request: { initiativeId: INITIATIVE, slug: "acp-p14", title: "The P-14 bootstrap", objective: OBJECTIVE, recordedBy: COORDINATOR },
      recordedAt: FIXED_NOW,
      holderPid: process.pid,
      identities: {
        eventId: randomUUID(),
        commandId: randomUUID(),
        artifactPinId: randomUUID(),
        artifactReferenceId: randomUUID(),
        intentionEventId: randomUUID(),
        terminalEventId: randomUUID(),
      },
    });
    leaseStore.close();
    ledger.close();
    if (!byApi.ok) throw new Error("expected the API's registration");

    const byCommand = await invoke(["initiative", "--database", f.database, "--request", f.request({ recordedBy: "claude/opus/implementer/01" })]);
    expect(byCommand.exitCode).toBe(EXIT_OK);
    const document = InitiativeRegistrationResponse.parse(JSON.parse(byCommand.stdout));
    expect(document.replayed).toBe(true);
    expect(document.sequence).toBe(byApi.sequence);
    expect(document.registration).toEqual(byApi.registration);
    expect(initiativeRows(f.database)).toHaveLength(1);
  });

  it("N-P14B-13: completes a registration that died after publishing, with no second intention", async () => {
    const f = fixture();
    expect(() =>
      runInitiativeVerb({
        databasePath: f.database,
        requestPath: f.request(),
        __testFaults: {
          afterObjectivePublished: () => {
            throw new Error("the command died after the publication");
          },
        },
      }),
    ).toThrow("died after the publication");
    expect(initiativeRows(f.database)).toHaveLength(0);

    const retried = await invoke(["initiative", "--database", f.database, "--request", f.request()]);
    expect(retried.exitCode).toBe(EXIT_OK);
    const ledger = openLedger(f.database, { readOnly: true });
    const kinds = ledger.listArtifactEvents(sha256(OBJECTIVE)).map((record) => record.event.artifactEventKind);
    ledger.close();
    expect(kinds).toEqual(["PUBLICATION_INTENDED", "PUBLICATION_SUCCEEDED"]);
  });
});

describe("acp initiative refuses by the exit code the refusal earns", () => {
  it("N-P14B-2: the same id with another title is WRITE_REFUSED, EXIT_INTEGRITY, naming the field", async () => {
    const f = fixture();
    await invoke(["initiative", "--database", f.database, "--request", f.request()]);
    const result = await invoke([
      "initiative",
      "--database",
      f.database,
      "--format",
      "json",
      "--request",
      f.request({ title: "Another title" }),
    ]);
    expect(result.exitCode).toBe(EXIT_INTEGRITY);
    expect(envelope(result).error).toMatchObject({ code: "WRITE_REFUSED", detail: "candidate.title" });
    expect(envelope(result).error.message).toContain("CONFLICT");
    expect(initiativeRows(f.database)).toHaveLength(1);
  });

  it("N-P14B-4: a credential-shaped objective is BAD_REQUEST by field, never echoed, and nothing is published", async () => {
    const f = fixture();
    const result = await invoke([
      "initiative",
      "--database",
      f.database,
      "--format",
      "json",
      "--request",
      f.request({ objective: "deploy with " + SENTINEL }),
    ]);
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(envelope(result).error).toMatchObject({ code: "BAD_REQUEST", detail: "request.objective" });
    expect(result.stderr).not.toContain(SENTINEL);
    expect(initiativeRows(f.database)).toHaveLength(0);
    expect(existsSync(artifactPlaneRootFor(f.database))).toBe(false);
  });

  it("refuses a missing or relative request document through the tool call's ladder", async () => {
    const f = fixture();
    const missing = await invoke(["initiative", "--database", f.database, "--format", "json"]);
    expect(missing.exitCode).toBe(EXIT_USAGE);
    expect(envelope(missing).error).toMatchObject({ code: "BAD_REQUEST", detail: "request" });
    const relative = await invoke(["initiative", "--database", f.database, "--format", "json", "--request", "request.json"]);
    expect(relative.exitCode).toBe(EXIT_USAGE);
    expect(envelope(relative).error.detail).toBe("request");
    const stray = await invoke(["initiative", "--database", f.database, "--request", f.request(), "--task", INITIATIVE]);
    expect(stray.exitCode).toBe(EXIT_USAGE);
  });

  it("probes the ledger before it opens it writable: an absent path is created by nobody", async () => {
    const f = fixture();
    const absent = join(root(), "typo.sqlite");
    const result = await invoke(["initiative", "--database", absent, "--format", "json", "--request", f.request()]);
    expect(result.exitCode).toBe(EXIT_UNAVAILABLE);
    expect(envelope(result).error.code).toBe("LEDGER_UNAVAILABLE");
    expect(existsSync(absent)).toBe(false);
  });
});

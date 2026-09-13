import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  API_CONTRACT_VERSION,
  ApiError,
  InitiativeDetailResponse,
  InitiativePortfolioResponse,
  InitiativeRegistrationResponse,
} from "@acp/protocol";
import {
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  registerInitiative,
} from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";
import { recordInitiativeRegistration } from "../../src/initiative-write/index.js";

/**
 * Evidence for the plane's fifth write door: `POST /api/v1/initiatives`
 * (P-14/B, ADR 0086).
 *
 * Every case goes through the real endpoint, a real ledger and the real private
 * plane. The seam decides nothing — `registerInitiative` does, and its own
 * suite holds the laws — so what this file holds is the door: the bearer it
 * inherits, the two refusal statuses it maps, the document it prints, and that
 * a registration recorded by the other door's path is the same row here.
 */

const dirs: string[] = [];

const TOKEN = "p14b-test-token-" + "x".repeat(24);
const AUTH = { authorization: "Bearer " + TOKEN };

function bearerFile(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-p14b-bearer-")));
  dirs.push(root);
  const path = join(root, "write-bearer.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

function temporaryDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-initiative-write-"));
  dirs.push(dir);
  const path = join(dir, "control-plane.sqlite");
  openLedger(path).close();
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const COORDINATOR = "kimi/k3/coordinator/01";
const INITIATIVE = "44444444-4444-4444-8444-444444444444";
const OBJECTIVE = "Register an initiative by command and by API, and keep its objective off the stream.";
const SENTINEL = "sk-ant-api03-SENTINELSENTINELSENTINEL";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    initiativeId: INITIATIVE,
    slug: "acp-p14",
    title: "The P-14 bootstrap",
    objective: OBJECTIVE,
    recordedBy: COORDINATOR,
    ...overrides,
  };
}

function initiativeEventCount(path: string): number {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return (raw.prepare("SELECT COUNT(*) AS count FROM initiative_events").get() as { readonly count: number }).count;
  } finally {
    raw.close();
  }
}

function eventJsons(path: string): readonly string[] {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    return (raw.prepare("SELECT event_json FROM initiative_events ORDER BY sequence").all() as { readonly event_json: string }[]).map(
      (row) => row.event_json,
    );
  } finally {
    raw.close();
  }
}

function intentionCount(path: string, digest: string): number {
  const ledger = openLedger(path, { readOnly: true });
  try {
    return ledger.listArtifactEvents(digest).filter((record) => record.event.artifactEventKind === "PUBLICATION_INTENDED").length;
  } finally {
    ledger.close();
  }
}

describe("POST /api/v1/initiatives inherits the bearer (N-P14B-7)", () => {
  it("answers 403 with no bearer configured and 401 with a wrong one, and writes nothing either way", async () => {
    const path = temporaryDatabase();

    const unconfigured = buildServer({ ledgerPath: path });
    const shut = await unconfigured.inject({ method: "POST", url: "/api/v1/initiatives", headers: AUTH, payload: body() });
    expect(shut.statusCode).toBe(403);
    expect(ApiError.parse(shut.json()).error.code).toBe("WRITE_BEARER_UNCONFIGURED");
    await unconfigured.close();

    const guarded = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const wrong = await guarded.inject({
      method: "POST",
      url: "/api/v1/initiatives",
      headers: { authorization: "Bearer " + "y".repeat(40) },
      payload: body(),
    });
    expect(wrong.statusCode).toBe(401);
    expect(ApiError.parse(wrong.json()).error.code).toBe("AUTH_REQUIRED");
    const missing = await guarded.inject({ method: "POST", url: "/api/v1/initiatives", payload: body() });
    expect(missing.statusCode).toBe(401);
    await guarded.close();

    expect(initiativeEventCount(path)).toBe(0);
    // The guard stands before the seam: no lease store, no private root.
    expect(existsSync(artifactBlobLeaseStorePath(path))).toBe(false);
    expect(existsSync(artifactPlaneRootFor(path))).toBe(false);
  });
});

describe("POST /api/v1/initiatives registers one initiative", () => {
  it("N-P14B-4: answers the registration by digest, and the GET reads the objective back from the plane", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

    const posted = await app.inject({ method: "POST", url: "/api/v1/initiatives", headers: AUTH, payload: body() });
    expect(posted.statusCode).toBe(200);
    const document = InitiativeRegistrationResponse.parse(posted.json());
    expect(document).toMatchObject({
      apiContractVersion: API_CONTRACT_VERSION,
      replayed: false,
      sequence: 1,
      registration: {
        initiativeId: INITIATIVE,
        slug: "acp-p14",
        title: "The P-14 bootstrap",
        objectiveSha256: sha256(OBJECTIVE),
        status: "ACTIVE",
        eventCount: 1,
      },
    });
    expect(posted.body).not.toContain(OBJECTIVE);

    const rows = eventJsons(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(sha256(OBJECTIVE));
    expect(rows[0]).not.toContain(OBJECTIVE);

    const portfolio = InitiativePortfolioResponse.parse((await app.inject({ method: "GET", url: "/api/v1/initiatives" })).json());
    expect(portfolio.items.map((item) => [item.initiativeId, item.slug, item.title, item.objective])).toEqual([
      [INITIATIVE, "acp-p14", "The P-14 bootstrap", OBJECTIVE],
    ]);
    const detail = InitiativeDetailResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + INITIATIVE })).json(),
    );
    expect(detail.initiative.initiative.objective).toBe(OBJECTIVE);
    await app.close();
  });

  it("N-P14B-1: the same body again answers the same row, replayed, and nothing is published twice", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const first = InitiativeRegistrationResponse.parse(
      (await app.inject({ method: "POST", url: "/api/v1/initiatives", headers: AUTH, payload: body() })).json(),
    );
    const second = await app.inject({ method: "POST", url: "/api/v1/initiatives", headers: AUTH, payload: body() });
    expect(second.statusCode).toBe(200);
    const replayed = InitiativeRegistrationResponse.parse(second.json());
    expect(replayed.replayed).toBe(true);
    expect(replayed.sequence).toBe(first.sequence);
    expect(replayed.registration).toEqual(first.registration);
    expect(initiativeEventCount(path)).toBe(1);
    expect(intentionCount(path, sha256(OBJECTIVE))).toBe(1);
    await app.close();
  });

  it("N-P14B-1: a registration the other door's orchestration recorded first is the same row here", async () => {
    // The CLI door is `registerInitiative` over its own handles; this is that
    // call, in this process, with its own identities — and then the API.
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(path), {
      incarnationId: randomUUID(),
      createdAt: "2026-09-13T12:00:00.000Z",
    });
    const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: path });
    const byCommand = registerInitiative({
      ledger,
      plane,
      request: {
        initiativeId: INITIATIVE,
        slug: "acp-p14",
        title: "The P-14 bootstrap",
        objective: OBJECTIVE,
        recordedBy: "claude/opus/implementer/01",
      },
      recordedAt: "2026-09-13T12:00:00.000Z",
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
    expect(byCommand.ok).toBe(true);

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const byApi = await app.inject({ method: "POST", url: "/api/v1/initiatives", headers: AUTH, payload: body() });
    expect(byApi.statusCode).toBe(200);
    const document = InitiativeRegistrationResponse.parse(byApi.json());
    expect(document.replayed).toBe(true);
    if (byCommand.ok) {
      expect(document.sequence).toBe(byCommand.sequence);
      expect(document.registration).toEqual(byCommand.registration);
    }
    expect(initiativeEventCount(path)).toBe(1);
    await app.close();
  });

  it("N-P14B-13: a registration that died after publishing is completed by the API, with no second intention", async () => {
    const path = temporaryDatabase();
    const reader = openLedger(path, { readOnly: true });
    expect(() =>
      recordInitiativeRegistration({
        ledger: reader,
        request: body() as never,
        recordedAt: "2026-09-13T12:00:00.000Z",
        holderPid: process.pid,
        leaseStoreIncarnationId: randomUUID(),
        eventId: randomUUID(),
        commandId: randomUUID(),
        artifactPinId: randomUUID(),
        artifactReferenceId: randomUUID(),
        intentionEventId: randomUUID(),
        terminalEventId: randomUUID(),
        __testFaults: {
          afterObjectivePublished: () => {
            throw new Error("the door died after the publication");
          },
        },
      }),
    ).toThrow("died after the publication");
    reader.close();
    expect(initiativeEventCount(path)).toBe(0);

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const retried = await app.inject({ method: "POST", url: "/api/v1/initiatives", headers: AUTH, payload: body() });
    expect(retried.statusCode).toBe(200);
    expect(InitiativeRegistrationResponse.parse(retried.json()).replayed).toBe(false);
    expect(intentionCount(path, sha256(OBJECTIVE))).toBe(1);
    await app.close();
  });
});

describe("POST /api/v1/initiatives refuses by the door that refused", () => {
  it("N-P14B-2: the same id with another title is 409 CONFLICT at the field, and nothing moves", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    await app.inject({ method: "POST", url: "/api/v1/initiatives", headers: AUTH, payload: body() });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/initiatives",
      headers: AUTH,
      payload: body({ title: "Another title" }),
    });
    expect(conflict.statusCode).toBe(409);
    const error = ApiError.parse(conflict.json()).error;
    expect(error.code).toBe("WRITE_REFUSED");
    expect(error.message).toContain("CONFLICT");
    expect(error.detail).toBe("candidate.title");
    expect(initiativeEventCount(path)).toBe(1);
    await app.close();
  });

  it("a slug outside the contract's grammar is the decision's refusal — 409 REQUEST_INVALID", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/initiatives",
      headers: AUTH,
      payload: body({ slug: "Not-A-Slug" }),
    });
    expect(refused.statusCode).toBe(409);
    const error = ApiError.parse(refused.json()).error;
    expect(error.message).toContain("REQUEST_INVALID");
    expect(error.detail).toBe("candidate.slug");
    expect(initiativeEventCount(path)).toBe(0);
    await app.close();
  });

  it("N-P14B-4: a malformed body or a credential-shaped objective is 400 by field, before the plane sees a byte", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

    const planted = await app.inject({
      method: "POST",
      url: "/api/v1/initiatives",
      headers: AUTH,
      payload: body({ objective: "deploy with " + SENTINEL }),
    });
    expect(planted.statusCode).toBe(400);
    const plantedError = ApiError.parse(planted.json()).error;
    expect(plantedError.code).toBe("BAD_REQUEST");
    expect(plantedError.detail).toBe("objective");
    expect(planted.body).not.toContain(SENTINEL);

    const unnamed = await app.inject({
      method: "POST",
      url: "/api/v1/initiatives",
      headers: AUTH,
      payload: { slug: "acp-p14", title: "t", objective: "o", recordedBy: COORDINATOR },
    });
    expect(unnamed.statusCode).toBe(400);
    expect(ApiError.parse(unnamed.json()).error.detail).toBe("initiativeId");

    expect(initiativeEventCount(path)).toBe(0);
    expect(existsSync(artifactPlaneRootFor(path))).toBe(false);
    await app.close();
  });

  it("answers LEDGER_INTEGRITY on the read when the plane cannot produce a registered objective, never a null", async () => {
    const path = temporaryDatabase();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    await app.inject({ method: "POST", url: "/api/v1/initiatives", headers: AUTH, payload: body() });
    const digest = sha256(OBJECTIVE);
    unlinkSync(join(artifactPlaneRootFor(path), digest.slice(0, 2), digest));

    const read = await app.inject({ method: "GET", url: "/api/v1/initiatives" });
    expect(read.statusCode).toBe(500);
    expect(ApiError.parse(read.json()).error.code).toBe("LEDGER_INTEGRITY");
    await app.close();
  });
});

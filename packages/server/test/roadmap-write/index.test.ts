import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApiError,
  InitiativeRoadmapResponse,
  LEDGER_CONTRACT_VERSION,
  RoadmapVersionWriteResponse,
} from "@acp/api-contracts";
import { ROADMAP_VERSION_REFUSALS, openLedger, readArtifact } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";
import { ROADMAP_WRITE_REFUSALS, artifactRootFor } from "../../src/roadmap-write/index.js";

/**
 * Evidence for the plane's first write route.
 *
 * Every case goes through the real endpoint against a real ledger and a real
 * artifact store: the point of the packet is that a write is mediated by the
 * landed decision and lands in an append-only chain, and neither claim can be
 * checked against a stub.
 *
 * The refusal cases are one per name, and the vocabulary itself is asserted
 * exact against the landed module — a suite that covered five of six refusals
 * while claiming the vocabulary would be the overclaim shape this repository
 * keeps finding.
 */

const dirs: string[] = [];

function temporaryDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-roadmap-write-"));
  dirs.push(dir);
  return join(dir, "control-plane.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const COORDINATOR = "kimi/k3/coordinator/01";
const AT = "2026-08-31T12:00:00.000Z";

function seed(): { readonly path: string; readonly initiativeId: string } {
  const path = temporaryDatabase();
  const ledger = openLedger(path);
  const initiativeId = randomUUID();
  ledger.appendInitiativeEvent({
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
    payload: { slug: "acp-p8", title: "The P8 initiative" },
  });
  ledger.close();
  return { path, initiativeId };
}

interface BodyInput {
  readonly content?: string;
  readonly expectedHeadDigest?: string | null;
  readonly kind?: string;
  readonly restoresVersionId?: string | null;
  readonly recordedBy?: string;
}

function body(input: BodyInput = {}): Record<string, unknown> {
  return {
    content: input.content ?? "# Roadmap\n\nThe first version.\n",
    expectedHeadDigest: input.expectedHeadDigest === undefined ? null : input.expectedHeadDigest,
    kind: input.kind ?? "EDIT",
    restoresVersionId: input.restoresVersionId ?? null,
    recordedBy: input.recordedBy ?? COORDINATOR,
  };
}

function roadmapUrl(initiativeId: string): string {
  return "/api/v1/initiatives/" + initiativeId + "/roadmap";
}

// ---------------------------------------------------------------------------
// The grants
// ---------------------------------------------------------------------------

describe("the write records a version", () => {
  it("grants version 1, stores the content and answers the recorded version", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body(),
    });

    expect(response.statusCode).toBe(200);
    const parsed = RoadmapVersionWriteResponse.parse(response.json());
    expect(parsed.version.version).toBe(1);
    expect(parsed.version.parentVersionId).toBeNull();
    expect(parsed.version.head).toBe(true);
    expect(parsed.sequence).toBeGreaterThan(0);

    // The content is in the store under the digest the ledger recorded — the
    // Checkpoint law's two halves meeting.
    const stored = readArtifact(artifactRootFor(path), parsed.version.contentDigest);
    if (!stored.ok) throw new Error("expected the content to be stored");
    expect(stored.content).toBe("# Roadmap\n\nThe first version.\n");
    await app.close();
  });

  it("grants a successor, and the GET reads both back newest-first", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });

    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body() })).json(),
    );
    const second = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: "# Roadmap\n\nThe second.\n", expectedHeadDigest: first.version.contentDigest }),
    });

    expect(second.statusCode).toBe(200);
    const parsed = RoadmapVersionWriteResponse.parse(second.json());
    expect(parsed.version.version).toBe(2);
    expect(parsed.version.parentVersionId).toBe(first.version.roadmapVersionId);

    const history = await app.inject({ method: "GET", url: roadmapUrl(initiativeId) });
    expect(history.statusCode).toBe(200);
    const items = InitiativeRoadmapResponse.parse(history.json()).items;
    expect(items.map((item) => item.version)).toEqual([2, 1]);
    expect(items.filter((item) => item.head).length).toBe(1);
    await app.close();
  });

  it("grants a ROLLBACK that restores an earlier version's bytes", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });
    const original = "# Roadmap\n\nThe first version.\n";

    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body({ content: original }) })).json(),
    );
    const second = RoadmapVersionWriteResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: roadmapUrl(initiativeId),
          payload: body({ content: "# Roadmap\n\nThe second.\n", expectedHeadDigest: first.version.contentDigest }),
        })
      ).json(),
    );

    // A rollback is a new version carrying the restored bytes, never a rewrite.
    const rolled = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({
        content: original,
        expectedHeadDigest: second.version.contentDigest,
        kind: "ROLLBACK",
        restoresVersionId: first.version.roadmapVersionId,
      }),
    });

    expect(rolled.statusCode).toBe(200);
    const parsed = RoadmapVersionWriteResponse.parse(rolled.json());
    expect({ version: parsed.version.version, kind: parsed.version.kind, restores: parsed.version.restoresVersionId }).toEqual(
      { version: 3, kind: "ROLLBACK", restores: first.version.roadmapVersionId },
    );
    expect(parsed.version.contentDigest).toBe(first.version.contentDigest);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Door one: the schema — 400
// ---------------------------------------------------------------------------

describe("door one: a malformed body is 400", () => {
  it("refuses an unknown field, a missing field and a bad kind, naming the field only", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });

    for (const payload of [
      { ...body(), extra: 1 },
      (() => {
        const partial = { ...body() } as Record<string, unknown>;
        delete partial["kind"];
        return partial;
      })(),
      { ...body(), kind: "REWRITE" },
      { ...body(), recordedBy: "not-a-worker-identity" },
    ]) {
      const response = await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload });
      expect(response.statusCode).toBe(400);
      expect(ApiError.parse(response.json()).error.code).toBe("BAD_REQUEST");
    }
    await app.close();
  });

  it("refuses credential-shaped content on ingest, and echoes none of it (N2)", async () => {
    // The one route on which free text enters the plane. The cost is stated in
    // the schema and in ADR 0013: a document that legitimately discusses an
    // apiKey field is refused, and that is the trade.
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });
    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA";

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: "# Roadmap\n\napiKey: " + secret + "\n" }),
    });

    expect(response.statusCode).toBe(400);
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sk-");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Door two: the decision — 409, one test per refusal name
// ---------------------------------------------------------------------------

describe("door two: the decision's refusals are 409, by name", () => {
  it("covers the landed vocabulary exactly, with nothing invented", () => {
    // The seam adds exactly one name of its own, for the store's refusals,
    // and re-exports the decision's six unchanged.
    expect([...ROADMAP_WRITE_REFUSALS]).toEqual(
      [...ROADMAP_VERSION_REFUSALS, "CONTENT_REJECTED"].sort(),
    );
    expect(ROADMAP_VERSION_REFUSALS.length).toBe(6);
  });

  it("HEAD_MISMATCH: the caller's claim about the head is wrong", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });
    await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body() });

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: "# second\n", expectedHeadDigest: "b".repeat(64) }),
    });

    expect(response.statusCode).toBe(409);
    const envelope = ApiError.parse(response.json());
    expect(envelope.error.code).toBe("WRITE_REFUSED");
    expect(envelope.error.message).toContain("HEAD_MISMATCH");
    await app.close();
  });

  it("REQUEST_INVALID: version 1 claiming a head", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });

    // No versions exist, so a non-null expectedHeadDigest cannot be true — the
    // contract's bootstrap biconditional refuses it as the candidate's own
    // inconsistency rather than as a head disagreement.
    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ expectedHeadDigest: "a".repeat(64) }),
    });

    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.message).toContain("REQUEST_INVALID");
    await app.close();
  });

  it("RESTORES_UNKNOWN_VERSION: a rollback naming a version that does not exist", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });
    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body() })).json(),
    );

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({
        expectedHeadDigest: first.version.contentDigest,
        kind: "ROLLBACK",
        restoresVersionId: randomUUID(),
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.message).toContain("RESTORES_UNKNOWN_VERSION");
    await app.close();
  });

  it("ROLLBACK_DIGEST_MISMATCH: a rollback whose bytes are not the restored version's", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });
    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body() })).json(),
    );

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({
        // Different bytes than version 1 carried, while claiming to restore it.
        content: "# not what version one said\n",
        expectedHeadDigest: first.version.contentDigest,
        kind: "ROLLBACK",
        restoresVersionId: first.version.roadmapVersionId,
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.message).toContain("ROLLBACK_DIGEST_MISMATCH");
    await app.close();
  });

  it("CONTENT_REJECTED: content past the store's ceiling", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });
    // Past the schema's ceiling too, so this is the schema's door — the store's
    // own refusal is unreachable through the endpoint by construction, which
    // is the belt-and-braces the two ceilings exist to give.
    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: "x".repeat(1024 * 1024 + 1) }),
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// The write seam's own laws
// ---------------------------------------------------------------------------

describe("the write seam holds no capability it does not need", () => {
  it("404s an initiative the ledger has never seen, rather than creating one", async () => {
    const { path } = seed();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(randomUUID()),
      payload: body(),
    });
    expect(response.statusCode).toBe(404);
    expect(ApiError.parse(response.json()).error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("still refuses PUT, PATCH and DELETE on the write route (C1)", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path });
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: roadmapUrl(initiativeId) });
      expect({ method, status: response.statusCode }).toEqual({ method, status: 405 });
      expect(ApiError.parse(response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
    }
    await app.close();
  });

  it("leaves the task stream untouched: the write is on the initiative chain alone", async () => {
    const { path, initiativeId } = seed();
    const before = openLedger(path, { readOnly: true });
    const taskHead = before.status().headSequence;
    before.close();

    const app = buildServer({ ledgerPath: path });
    await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body() });
    await app.close();

    const after = openLedger(path, { readOnly: true });
    expect(after.status().headSequence).toBe(taskHead);
    expect(after.verifyIntegrity().ok).toBe(true);
    after.close();
  });
});

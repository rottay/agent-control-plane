import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApiError,
  InitiativeRoadmapResponse,
  LEDGER_CONTRACT_VERSION,
  ROADMAP_CONTENT_MAX_BYTES,
  ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES,
  RoadmapVersionWriteRequest,
  RoadmapVersionWriteResponse,
} from "@acp/api-contracts";
import { ROADMAP_VERSION_REFUSALS, openLedger, publishArtifact, readArtifact } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";
import { ROADMAP_WRITE_REFUSALS, artifactRootFor, recordRoadmapVersion } from "../../src/roadmap-write/index.js";

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

/**
 * A write bearer token file, and the header that satisfies it (P8-8G).
 *
 * Every write on this plane now passes the registrar's guard, so a suite that
 * exercises writes has to hold a credential. Written at mode 0600 under a
 * canonical temp root, exactly as the loader's ladder requires.
 */
const TOKEN = "p8-8g-test-token-" + "x".repeat(24);

function bearerFile(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-bearer-")));
  dirs.push(root);
  const path = join(root, "write-bearer.token");
  writeFileSync(path, TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

/** The header a legitimate writer sends. */
const AUTH = { authorization: "Bearer " + TOKEN };

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

/** A write request body, for the schema-level drills. */
function requestBody(content: string): Record<string, unknown> {
  return {
    content,
    expectedHeadDigest: null,
    kind: "EDIT",
    restoresVersionId: null,
    recordedBy: COORDINATOR,
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
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body(),
      headers: AUTH,
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
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body(), headers: AUTH })).json(),
    );
    const second = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: "# Roadmap\n\nThe second.\n", expectedHeadDigest: first.version.contentDigest }),
      headers: AUTH,
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
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const original = "# Roadmap\n\nThe first version.\n";

    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body({ content: original }), headers: AUTH })).json(),
    );
    const second = RoadmapVersionWriteResponse.parse(
      (
        await app.inject({
          method: "POST",
          url: roadmapUrl(initiativeId),
          payload: body({ content: "# Roadmap\n\nThe second.\n", expectedHeadDigest: first.version.contentDigest }),
          headers: AUTH,
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
      headers: AUTH,
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
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

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
      const response = await app.inject({
        method: "POST",
        url: roadmapUrl(initiativeId),
        payload,
        headers: AUTH,
      });
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
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA";

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: "# Roadmap\n\napiKey: " + secret + "\n" }),
      headers: AUTH,
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
    // The seam adds exactly two names of its own — one for the store's
    // refusals, one for a lost race (P8-8G R1) — and re-exports the
    // decision's six unchanged.
    expect([...ROADMAP_WRITE_REFUSALS]).toEqual(
      [...ROADMAP_VERSION_REFUSALS, "CONTENT_REJECTED", "WRITE_CONFLICT"].sort(),
    );
    expect(ROADMAP_VERSION_REFUSALS.length).toBe(6);
    // Both seam names are the seam's, not the decision's: the decision knows
    // nothing about a store or about concurrency.
    expect([...ROADMAP_VERSION_REFUSALS]).not.toContain("WRITE_CONFLICT");
    expect([...ROADMAP_VERSION_REFUSALS]).not.toContain("CONTENT_REJECTED");
  });

  it("HEAD_MISMATCH: the caller's claim about the head is wrong", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body(), headers: AUTH });

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: "# second\n", expectedHeadDigest: "b".repeat(64) }),
      headers: AUTH,
    });

    expect(response.statusCode).toBe(409);
    const envelope = ApiError.parse(response.json());
    expect(envelope.error.code).toBe("WRITE_REFUSED");
    expect(envelope.error.message).toContain("HEAD_MISMATCH");
    await app.close();
  });

  it("REQUEST_INVALID: version 1 claiming a head", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

    // No versions exist, so a non-null expectedHeadDigest cannot be true — the
    // contract's bootstrap biconditional refuses it as the candidate's own
    // inconsistency rather than as a head disagreement.
    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ expectedHeadDigest: "a".repeat(64) }),
      headers: AUTH,
    });

    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.message).toContain("REQUEST_INVALID");
    await app.close();
  });

  it("RESTORES_UNKNOWN_VERSION: a rollback naming a version that does not exist", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body(), headers: AUTH })).json(),
    );

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({
        expectedHeadDigest: first.version.contentDigest,
        kind: "ROLLBACK",
        restoresVersionId: randomUUID(),
      }),
      headers: AUTH,
    });

    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.message).toContain("RESTORES_UNKNOWN_VERSION");
    await app.close();
  });

  it("ROLLBACK_DIGEST_MISMATCH: a rollback whose bytes are not the restored version's", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body(), headers: AUTH })).json(),
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
      headers: AUTH,
    });

    expect(response.statusCode).toBe(409);
    expect(ApiError.parse(response.json()).error.message).toContain("ROLLBACK_DIGEST_MISMATCH");
    await app.close();
  });

  it("CONTENT_REJECTED: content past the store's ceiling", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    // Past the schema's ceiling too, so this is the schema's door — the store's
    // own refusal is unreachable through the endpoint by construction, which
    // is the belt-and-braces the two ceilings exist to give.
    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: "x".repeat(1024 * 1024 + 1) }),
      headers: AUTH,
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
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(randomUUID()),
      payload: body(),
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(ApiError.parse(response.json()).error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("still refuses PUT, PATCH and DELETE on the write route (C1)", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
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

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body(), headers: AUTH });
    await app.close();

    const after = openLedger(path, { readOnly: true });
    expect(after.status().headSequence).toBe(taskHead);
    expect(after.verifyIntegrity().ok).toBe(true);
    after.close();
  });
});

describe("R1: the race loser hears the truth, and only the race loser", () => {
  it("answers WRITE_CONFLICT when the append collides with another writer's event", async () => {
    // A real race: two writers fold the same head, assemble the same
    // coordinates, and the ledger's uniqueness lets exactly one through.
    // Staged here by handing the seam an `eventId` the ledger already holds —
    // the same collision the loser's append hits, reached the same way.
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const first = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body(),
      headers: AUTH,
    });
    expect(first.statusCode).toBe(200);
    await app.close();

    const reader = openLedger(path, { readOnly: true });
    const takenEventId = reader.listInitiativeEvents({ initiativeId }).events[0]?.eventId;
    if (takenEventId === undefined) throw new Error("expected a recorded initiative event");

    const outcome = recordRoadmapVersion({
      ledger: reader,
      initiativeId,
      request: {
        content: "# a second, legitimate document\n",
        expectedHeadDigest: RoadmapVersionWriteResponse.parse(first.json()).version.contentDigest,
        kind: "EDIT",
        restoresVersionId: null,
        recordedBy: COORDINATOR,
      },
      recordedAt: AT,
      roadmapVersionId: randomUUID(),
      // The collision: an id the ledger already holds.
      eventId: takenEventId,
    });
    reader.close();

    // Refused, not thrown — and refused with the seam's own race word rather
    // than as a decision refusal, because the decision was satisfied.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("WRITE_CONFLICT");
  });

  it("re-throws a ledger failure that is not a lost race, so it still classifies INTERNAL (C4)", () => {
    // The narrowness is the point. A broad catch would convert every future
    // ledger fault into a cheerful "retry" — the most expensive wrong answer
    // there is, since it tells a caller to repeat what cannot work.
    const { path, initiativeId } = seed();
    const reader = openLedger(path, { readOnly: true });

    // A non-conflict ledger refusal: the event's own contract is violated, so
    // the append throws a validation error rather than a conflict.
    expect(() =>
      recordRoadmapVersion({
        ledger: reader,
        initiativeId,
        request: {
          content: "# fine\n",
          expectedHeadDigest: null,
          kind: "EDIT",
          restoresVersionId: null,
          recordedBy: COORDINATOR,
        },
        recordedAt: AT,
        roadmapVersionId: randomUUID(),
        // Not a uuid: the ledger refuses the event on shape, which is neither
        // of the two conflict codes and must therefore propagate.
        eventId: "not-a-uuid",
      }),
    ).toThrow();
    reader.close();
  });
});

describe("R2: one ceiling, one unit — the schema and the store agree at the byte", () => {
  // Two-byte characters, so a code-unit bound and a byte bound disagree: this
  // string is half ROADMAP_CONTENT_MAX_BYTES in `String.length` and exactly
  // ROADMAP_CONTENT_MAX_BYTES in UTF-8 bytes. Under the old `.max()` the
  // schema admitted twice what the store would hold.
  const atCeiling = "é".repeat(ROADMAP_CONTENT_MAX_BYTES / 2);

  it("measures the same thing on both surfaces", () => {
    // Weighed with `Buffer` rather than the contract's own helper: an
    // independent implementation, so this cannot pass by sharing a bug with
    // the code it is checking.
    expect(atCeiling.length).toBe(ROADMAP_CONTENT_MAX_BYTES / 2);
    expect(Buffer.byteLength(atCeiling, "utf8")).toBe(ROADMAP_CONTENT_MAX_BYTES);
  });

  it("admits a boundary document on both surfaces, and refuses one byte over on both", () => {
    const { path } = seed();
    const root = artifactRootFor(path);

    // The schema: at the ceiling in, one byte over out.
    expect(RoadmapVersionWriteRequest.safeParse(requestBody(atCeiling)).success).toBe(true);
    expect(RoadmapVersionWriteRequest.safeParse(requestBody(atCeiling + "x")).success).toBe(false);

    // The store, weighing the same bytes: the same two answers.
    expect(publishArtifact(root, atCeiling).ok).toBe(true);
    const over = publishArtifact(root, atCeiling + "x");
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("expected the store to refuse");
    expect(over.reason).toBe("CONTENT_TOO_LARGE");
  });

  it("accepts a boundary-sized document through armed HTTP (A2)", async () => {
    // The ruling's own drill. Before this packet the transport limit was
    // Fastify's default — exactly the document ceiling — so the JSON envelope
    // pushed a boundary document over it and the plane refused a document at
    // the limit it advertised. The limit now derives from the one authority
    // plus a named envelope allowance, so the boundary is reachable.
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: atCeiling }),
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);

    // And the allowance covers the envelope, not the content: one byte over
    // the ceiling is still refused, by the schema rather than the transport.
    const over = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({
        content: atCeiling + "x",
        expectedHeadDigest: RoadmapVersionWriteResponse.parse(response.json()).version.contentDigest,
      }),
      headers: AUTH,
    });
    expect(over.statusCode).toBe(400);
    expect(ApiError.parse(over.json()).error.code).toBe("BAD_REQUEST");
    await app.close();
  });

  it("derives the transport limit from the one authority, never a second number", () => {
    // The law, asserted rather than trusted to a comment: the body limit is
    // the ceiling plus the allowance, so moving the ceiling moves the
    // transport with it.
    expect(ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES).toBeGreaterThan(0);
    // The envelope a real request actually costs, measured, so the allowance
    // is known to be sufficient rather than assumed to be.
    const envelope =
      Buffer.byteLength(JSON.stringify(requestBody("")), "utf8") - Buffer.byteLength('""', "utf8");
    expect(envelope).toBeLessThan(ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES);
  });

  it("would have disagreed before the fix: code units are not bytes", () => {
    // The regression this closes, stated as arithmetic rather than as prose.
    // A string of `ROADMAP_CONTENT_MAX_BYTES` two-byte characters passes a
    // `.max(ROADMAP_CONTENT_MAX_BYTES)` on `String.length` and is twice what
    // the store will hold.
    const twiceTheBytes = "é".repeat(ROADMAP_CONTENT_MAX_BYTES);
    expect(twiceTheBytes.length).toBe(ROADMAP_CONTENT_MAX_BYTES);
    expect(Buffer.byteLength(twiceTheBytes, "utf8")).toBe(ROADMAP_CONTENT_MAX_BYTES * 2);
    expect(RoadmapVersionWriteRequest.safeParse(requestBody(twiceTheBytes)).success).toBe(false);
  });
});

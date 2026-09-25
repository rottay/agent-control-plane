import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ApiError,
  InitiativeRoadmapResponse,
  InitiativeTimelineResponse,
  LEDGER_CONTRACT_VERSION,
  ROADMAP_CONTENT_MAX_BYTES,
  ROADMAP_STEP_MANIFEST_MAX_BYTES,
  ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES,
  RoadmapVersionWriteRequest,
  RoadmapVersionWriteResponse,
} from "@acp/protocol";
// `artifactRootFor` now comes from the package that owns the store it governs
// (V2-B1f/F3): one home, and this suite reads the checkpoint side of the same
// rule in P9 below.
import {
  GENESIS_SHA256,
  LedgerIdempotencyConflictError,
  LedgerRoadmapVersionRefusedError,
  ROADMAP_VERSION_REFUSALS,
  canonicalJsonStringify,
  chainDigest,
  artifactBlobLeaseStorePath,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  recordRoadmapRevision,
  artifactRootFor,
  hasArtifact,
  openLedger,
  publishArtifact,
  readArtifact,
} from "@acp/ledger";
import type { Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";
import { ROADMAP_WRITE_REFUSALS, recordRoadmapVersion } from "../../src/roadmap-write/index.js";
// The whole seam, so P9 can ask what it actually exports.
import * as writeSeam from "../../src/roadmap-write/index.js";

/**
 * Evidence for the plane's first write route.
 *
 * Every case goes through the real endpoint against a real ledger and a real
 * artifact store: the point of the packet is that a write is mediated by the
 * landed decision and lands in an append-only chain, and neither claim can be
 * checked against a stub.
 *
 * The refusal cases are one per name, and the vocabulary itself is asserted
 * exact against the landed module — a suite that covered eleven of twelve refusals
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
    // decision's twelve unchanged. VERSION_ID_REUSED (P-26/A) is unreachable from
    // this route, which mints a fresh identity per request; the five step words
    // (P-26 cut B) reach it only from a request that carries `steps`.
    expect([...ROADMAP_WRITE_REFUSALS]).toEqual(
      [...ROADMAP_VERSION_REFUSALS, "CONTENT_REJECTED", "WRITE_CONFLICT"].sort(),
    );
    expect(ROADMAP_VERSION_REFUSALS.length).toBe(12);
    expect([...ROADMAP_VERSION_REFUSALS]).toContain("VERSION_ID_REUSED");
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
      steps: null,
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
        steps: null,
      }),
    ).toThrow();
    reader.close();
  });
});

// ---------------------------------------------------------------------------
// P-26/A: the door decides, and the route hears it (ADR 0110)
// ---------------------------------------------------------------------------

/** Every recorded initiative event's payload, in stream order. */
function recordedPayloads(path: string, initiativeId: string): readonly Record<string, unknown>[] {
  const reader = openLedger(path, { readOnly: true });
  try {
    return reader
      .listInitiativeEvents({ initiativeId })
      .events.filter((record) => record.event.type === "ROADMAP_VERSION_RECORDED")
      .map((record) => record.event.payload);
  } finally {
    reader.close();
  }
}

/** A raw roadmap event, as another producer would append it: no route, no seam. */
function rawRoadmapEvent(initiativeId: string, transitionId: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    initiativeId,
    transitionId,
    idempotencyKey: initiativeId + "/1/" + transitionId,
    type: "ROADMAP_VERSION_RECORDED",
    fromStatus: "ACTIVE",
    toStatus: "ACTIVE",
    emittedBy: COORDINATOR,
    occurredAt: AT,
    recordedAt: AT,
    payload,
  };
}

/** What the door throws, as the error it is. */
function doorError(path: string, event: Record<string, unknown>): unknown {
  const writable = openLedger(path);
  try {
    writable.appendInitiativeEvent(event);
    return undefined;
  } catch (error: unknown) {
    return error;
  } finally {
    writable.close();
  }
}

/** Two versions recorded through the route. */
async function twoVersions(): Promise<{
  readonly path: string;
  readonly initiativeId: string;
  readonly first: RoadmapVersionWriteResponse;
  readonly second: RoadmapVersionWriteResponse;
}> {
  const { path, initiativeId } = seed();
  const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
  const firstResponse = await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body(), headers: AUTH });
  expect(firstResponse.statusCode).toBe(200);
  const first = RoadmapVersionWriteResponse.parse(firstResponse.json());
  const secondResponse = await app.inject({
    method: "POST",
    url: roadmapUrl(initiativeId),
    payload: body({ content: "# Roadmap\n\nThe second.\n", expectedHeadDigest: first.version.contentDigest }),
    headers: AUTH,
  });
  expect(secondResponse.statusCode).toBe(200);
  const second = RoadmapVersionWriteResponse.parse(secondResponse.json());
  await app.close();
  return { path, initiativeId, first, second };
}

describe("P-26/A: the roadmap-version law runs inside the append, and the route hears the door", () => {
  it("G1: v1 then v2 through the route, and the door ran the decision: v2 again under a new key is refused", async () => {
    const { path, initiativeId, first, second } = await twoVersions();
    const payloads = recordedPayloads(path, initiativeId);
    expect(payloads.map((payload) => payload["version"])).toEqual([1, 2]);
    expect(payloads[1]?.["parentVersionId"]).toBe(first.version.roadmapVersionId);

    // Spy-free: no seam runs here, only the ledger's own door. If the door did
    // not decide, this event would be appended as a second version 2.
    const error = doorError(path, rawRoadmapEvent(initiativeId, "roadmap.v2.again", { ...payloads[1] }));
    expect(error).toBeInstanceOf(LedgerRoadmapVersionRefusedError);
    const refused = error as LedgerRoadmapVersionRefusedError;
    expect({ code: refused.code, reason: refused.reason, at: refused.at }).toEqual({
      code: "LEDGER_ROADMAP_VERSION_REFUSED",
      reason: "VERSION_NOT_MONOTONIC",
      at: "candidate.version",
    });
    expect(recordedPayloads(path, initiativeId).map((payload) => payload["roadmapVersionId"])).toEqual([
      first.version.roadmapVersionId,
      second.version.roadmapVersionId,
    ]);
  });

  it("G1b: the same raw append under the route's own key with other content is a key conflict, before any decision", async () => {
    const { path, initiativeId } = await twoVersions();
    const payloads = recordedPayloads(path, initiativeId);
    // The route's key for version 2, with content the decision would also refuse.
    // The order is the claim: the key conflict fires first, and the decision's
    // word never appears.
    const error = doorError(path, rawRoadmapEvent(initiativeId, "roadmap.v2", { ...payloads[1], contentDigest: "f".repeat(64) }));
    expect(error).toBeInstanceOf(LedgerIdempotencyConflictError);
    expect((error as LedgerIdempotencyConflictError).code).toBe("LEDGER_IDEMPOTENCY_CONFLICT");
    expect(error).not.toBeInstanceOf(LedgerRoadmapVersionRefusedError);
    for (const word of ROADMAP_VERSION_REFUSALS) expect(String(error)).not.toContain(word);
  });

  it("G2: a ROLLBACK to v1 is recorded, and the door's rollback-digest law agrees with the route's", async () => {
    const { path, initiativeId, first, second } = await twoVersions();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });

    // The route refuses a rollback carrying the wrong bytes ...
    const wrong = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({
        content: "# Roadmap\n\nThe second.\n",
        expectedHeadDigest: second.version.contentDigest,
        kind: "ROLLBACK",
        restoresVersionId: first.version.roadmapVersionId,
      }),
      headers: AUTH,
    });
    expect(wrong.statusCode).toBe(409);
    expect(ApiError.parse(wrong.json()).error.message).toContain("ROLLBACK_DIGEST_MISMATCH");

    // ... and so does the door, for the same claim offered past the route.
    const doorWrong = doorError(
      path,
      rawRoadmapEvent(initiativeId, "roadmap.v3.raw", {
        ...recordedPayloads(path, initiativeId)[1],
        roadmapVersionId: randomUUID(),
        version: 3,
        parentVersionId: second.version.roadmapVersionId,
        expectedHeadDigest: second.version.contentDigest,
        kind: "ROLLBACK",
        restoresVersionId: first.version.roadmapVersionId,
      }),
    );
    expect(doorWrong).toBeInstanceOf(LedgerRoadmapVersionRefusedError);
    expect((doorWrong as LedgerRoadmapVersionRefusedError).reason).toBe("ROLLBACK_DIGEST_MISMATCH");

    // The lawful rollback is recorded through the route, and the door let it by.
    const rolled = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({
        expectedHeadDigest: second.version.contentDigest,
        kind: "ROLLBACK",
        restoresVersionId: first.version.roadmapVersionId,
      }),
      headers: AUTH,
    });
    await app.close();
    expect(rolled.statusCode).toBe(200);
    const parsed = RoadmapVersionWriteResponse.parse(rolled.json());
    expect([parsed.version.version, parsed.version.kind, parsed.version.contentDigest]).toEqual([
      3,
      "ROLLBACK",
      first.version.contentDigest,
    ]);
    expect(recordedPayloads(path, initiativeId).map((payload) => payload["version"])).toEqual([1, 2, 3]);
  });

  it("G3 (C1): a stale fold reaches the door, which refuses it, and the seam answers WRITE_CONFLICT, never a throw", async () => {
    // Version 1 through the route.
    const staged = seed();
    const app = buildServer({ ledgerPath: staged.path, writeBearerPath: bearerFile() });
    const v1 = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(staged.initiativeId), payload: body(), headers: AUTH })).json(),
    );
    await app.close();

    // The gateway's reader snapshot, taken before the other producer writes.
    const reader = openLedger(staged.path, { readOnly: true });
    const stale = reader.listRoadmapVersions(staged.initiativeId);
    expect(stale.map((version) => version.version)).toEqual([1]);

    // Another producer records version 2 under a key the route never builds.
    const other = openLedger(staged.path);
    other.appendInitiativeEvent(
      rawRoadmapEvent(staged.initiativeId, "roadmap.other.v2", {
        contractVersion: LEDGER_CONTRACT_VERSION,
        roadmapVersionId: randomUUID(),
        initiativeId: staged.initiativeId,
        version: 2,
        contentDigest: "e".repeat(64),
        parentVersionId: v1.version.roadmapVersionId,
        expectedHeadDigest: v1.version.contentDigest,
        kind: "EDIT",
        restoresVersionId: null,
        recordedBy: COORDINATOR,
        recordedAt: AT,
        stepCount: 0,
        stepManifestArtifactReferenceId: null,
        stepManifestSha256: null,
      }),
    );
    other.close();

    // The seam's fold is the snapshot: it grants its own "version 2", under the
    // route's own key roadmap.v2, which nobody holds — so no key conflict, and
    // the candidate reaches the door's decision over the fold that moved.
    const staleReader: Ledger = new Proxy(reader, {
      get(target, property) {
        if (property === "listRoadmapVersions") return () => stale;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const outcome = recordRoadmapVersion({
      ledger: staleReader,
      initiativeId: staged.initiativeId,
      request: {
        content: "# the loser's second version\n",
        expectedHeadDigest: v1.version.contentDigest,
        kind: "EDIT",
        restoresVersionId: null,
        recordedBy: COORDINATOR,
      },
      recordedAt: AT,
      roadmapVersionId: randomUUID(),
      eventId: randomUUID(),
      steps: null,
    });
    reader.close();

    expect(outcome).toEqual({ ok: false, reason: "WRITE_CONFLICT", at: "roadmapVersion" });
    // The door refused it by name: the stream holds the other producer's v2 and
    // nothing of the loser's.
    const versions = recordedPayloads(staged.path, staged.initiativeId);
    expect(versions.map((payload) => payload["version"])).toEqual([1, 2]);
    expect(versions[1]?.["contentDigest"]).toBe("e".repeat(64));

    // And the route renders that seam word as it renders every refusal: 409,
    // WRITE_REFUSED, the word in the message. A retry re-folds and is told the truth.
    const retryApp = buildServer({ ledgerPath: staged.path, writeBearerPath: bearerFile() });
    const retry = await retryApp.inject({
      method: "POST",
      url: roadmapUrl(staged.initiativeId),
      payload: body({ content: "# the loser's second version\n", expectedHeadDigest: v1.version.contentDigest }),
      headers: AUTH,
    });
    await retryApp.close();
    expect(retry.statusCode).toBe(409);
    expect(ApiError.parse(retry.json()).error.message).toContain("HEAD_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// P-26 cut B: a version declares its steps (ADR 0111)
// ---------------------------------------------------------------------------

function manifestStep(stepId: string, dependsOn: readonly string[] = []): Record<string, unknown> {
  return {
    stepId,
    title: "Step " + stepId,
    objective: "The private objective of " + stepId + ".",
    acceptance: "The private acceptance of " + stepId + ".",
    expectedWriteSet: ["packages/" + stepId + "/index.ts"],
    dependsOn: [...dependsOn],
  };
}

/** A→B, A→C: the map's S1 manifest. */
function steps(entries: readonly Record<string, unknown>[] = [manifestStep("A"), manifestStep("B", ["A"]), manifestStep("C", ["A"])]) {
  return { manifestContractVersion: 1, steps: entries };
}

function readSteps(path: string, roadmapVersionId: string) {
  const reader = openLedger(path, { readOnly: true });
  try {
    return {
      steps: reader.listRoadmapSteps(roadmapVersionId),
      dependencies: reader.listRoadmapStepDependencies(roadmapVersionId),
      events: reader.listInitiativeEvents().events,
    };
  } finally {
    reader.close();
  }
}

describe("P-26/B: a roadmap version declares its steps through the real route", () => {
  it("S1: v1 with three steps is 200, one contiguous batch, ranks 0/1/1, a private PLAN_DOCUMENT, and a 0.20.0 timeline", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const response = await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: { ...body(), steps: steps() }, headers: AUTH });
    expect(response.statusCode).toBe(200);
    const parsed = RoadmapVersionWriteResponse.parse(response.json());
    expect(parsed.version.stepCount).toBe(3);
    expect(parsed.version.stepManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(response.json())).not.toContain("private objective");

    const { steps: rows, dependencies, events } = readSteps(path, parsed.version.roadmapVersionId);
    const batch = events.slice(-4);
    expect(batch.map((record) => record.event.type)).toEqual([
      "ROADMAP_VERSION_RECORDED",
      "ROADMAP_STEP_DECLARED",
      "ROADMAP_STEP_DECLARED",
      "ROADMAP_STEP_DECLARED",
    ]);
    expect(batch.map((record) => record.sequence - (batch[0]?.sequence ?? 0))).toEqual([0, 1, 2, 3]);
    expect(rows.map((row) => [row.stepId, row.dependencyRank])).toEqual([["A", 0], ["B", 1], ["C", 1]]);
    expect(dependencies).toHaveLength(2);
    for (const record of events) expect(record.canonicalJson).not.toContain("private objective");

    const timeline = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + initiativeId + "/events" });
    expect(timeline.statusCode).toBe(200);
    const items = InitiativeTimelineResponse.parse(timeline.json()).items;
    expect(items.filter((item) => item.type === "ROADMAP_STEP_DECLARED")).toHaveLength(3);
    expect(items.filter((item) => item.type === "ROADMAP_VERSION_RECORDED")).toHaveLength(1);
    await app.close();
  });

  it("S2: v2 without steps counts 0 and names no manifest, and v1's steps are untouched", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: { ...body(), steps: steps() }, headers: AUTH })).json(),
    );
    const second = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: body({ content: "# two\n", expectedHeadDigest: first.version.contentDigest }),
      headers: AUTH,
    });
    await app.close();
    expect(second.statusCode).toBe(200);
    const parsed = RoadmapVersionWriteResponse.parse(second.json());
    expect([parsed.version.stepCount, parsed.version.stepManifestSha256]).toEqual([0, null]);
    expect(readSteps(path, parsed.version.roadmapVersionId).steps).toEqual([]);
    expect(readSteps(path, first.version.roadmapVersionId).steps).toHaveLength(3);
  });

  it("S3: a cycle is 409 WRITE_REFUSED naming STEP_DEPENDENCY_CYCLE, and nothing is appended", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const before = readSteps(path, randomUUID()).events.length;
    const response = await app.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: { ...body(), steps: steps([manifestStep("A", ["B"]), manifestStep("B", ["A"])]) },
      headers: AUTH,
    });
    await app.close();
    expect(response.statusCode).toBe(409);
    const envelope = ApiError.parse(response.json());
    expect(envelope.error.code).toBe("WRITE_REFUSED");
    expect(envelope.error.message).toContain("STEP_DEPENDENCY_CYCLE");
    expect(readSteps(path, randomUUID()).events.length).toBe(before);
  });

  it("S4: a self-edge, an unknown dependency and a repeated stepId are refused at the schema, 400, at the field", async () => {
    // Measured, against the map's S4: the request parses the contract's manifest
    // whole, and the manifest refuses these three itself, so they never reach a
    // decision. STEP_DECLARATION_INVALID is the door's word for a raw batch.
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    for (const [manifest, field] of [
      [steps([manifestStep("A", ["A"])]), "steps.steps.0.dependsOn.0"],
      [steps([manifestStep("A", ["Z"])]), "steps.steps.0.dependsOn.0"],
      [steps([manifestStep("A"), manifestStep("A")]), "steps.steps.1"],
    ] as const) {
      const response = await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: { ...body(), steps: manifest }, headers: AUTH });
      expect(response.statusCode, field).toBe(400);
      const envelope = ApiError.parse(response.json());
      expect(envelope.error.code).toBe("BAD_REQUEST");
      expect(envelope.error.detail).toBe(field);
    }
    await app.close();
  });

  it("S5/S5b: a rollback re-declares the restored steps; another manifest, or steps onto a stepless version, is ROLLBACK_STEPS_MISMATCH", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const post = async (payload: Record<string, unknown>) => app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload, headers: AUTH });
    const first = RoadmapVersionWriteResponse.parse((await post({ ...body({ content: "# one\n" }), steps: steps() })).json());
    const second = RoadmapVersionWriteResponse.parse(
      (await post(body({ content: "# two\n", expectedHeadDigest: first.version.contentDigest }))).json(),
    );
    const rollbackTo = (target: RoadmapVersionWriteResponse, head: RoadmapVersionWriteResponse, content: string) =>
      body({ content, expectedHeadDigest: head.version.contentDigest, kind: "ROLLBACK", restoresVersionId: target.version.roadmapVersionId });

    const other = await post({ ...rollbackTo(first, second, "# one\n"), steps: steps([manifestStep("A")]) });
    expect(other.statusCode).toBe(409);
    expect(ApiError.parse(other.json()).error.message).toContain("ROLLBACK_STEPS_MISMATCH");

    const onto = await post({ ...rollbackTo(second, second, "# two\n"), steps: steps() });
    expect(onto.statusCode).toBe(409);
    expect(ApiError.parse(onto.json()).error.message).toContain("ROLLBACK_STEPS_MISMATCH");

    const plain = await post(rollbackTo(second, second, "# two\n"));
    expect(plain.statusCode).toBe(200);
    const third = RoadmapVersionWriteResponse.parse(plain.json());
    expect([third.version.stepCount, third.version.stepManifestSha256]).toEqual([0, null]);

    const restored = await post({ ...rollbackTo(first, third, "# one\n"), steps: steps() });
    expect(restored.statusCode).toBe(200);
    const fourth = RoadmapVersionWriteResponse.parse(restored.json());
    expect(fourth.version.stepManifestSha256).toBe(first.version.stepManifestSha256);
    const shape = (rows: ReturnType<typeof readSteps>["steps"]) => rows.map((row) => [row.stepId, row.objectiveSha256, row.dependencyRank]);
    expect(shape(readSteps(path, fourth.version.roadmapVersionId).steps)).toEqual(shape(readSteps(path, first.version.roadmapVersionId).steps));
    await app.close();
  });

  it("S6: the exact batch again is a whole-batch replay, one set of rows", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: { ...body(), steps: steps() }, headers: AUTH })).json(),
    );
    await app.close();
    const writable = openLedger(path);
    const batch = writable
      .listInitiativeEvents({ initiativeId })
      .events.filter((record) => record.event.transitionId.startsWith("roadmap.v1"))
      .map((record) => record.event);
    const replay = writable.appendInitiativeBatch(batch);
    writable.close();
    expect(replay.insertedCount).toBe(0);
    expect(readSteps(path, first.version.roadmapVersionId).steps).toHaveLength(3);
  });

  it("S7: a stale fold meets a batch that landed first, and the seam answers WRITE_CONFLICT, never a throw", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const v1 = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body(), headers: AUTH })).json(),
    );
    await app.close();

    const reader = openLedger(path, { readOnly: true });
    const stale = reader.listRoadmapVersions(initiativeId);

    // Another producer records v2 with steps first, through the same producer.
    const other = openLedger(path);
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(path), { incarnationId: randomUUID(), createdAt: AT });
    const landed = recordRoadmapRevision({
      reader: other,
      writable: other,
      plane: openArtifactPlane({ ledger: other, leaseStore, ledgerPath: path }),
      initiativeId,
      request: { content: "# theirs\n", expectedHeadDigest: v1.version.contentDigest, kind: "EDIT", restoresVersionId: null, recordedBy: COORDINATOR, steps: steps() },
      recordedAt: AT,
      roadmapVersionId: randomUUID(),
      eventId: randomUUID(),
      holderPid: process.pid,
      stepIdentities: {
        stepEventIds: [randomUUID(), randomUUID(), randomUUID()],
        commandId: randomUUID(),
        artifactPinId: randomUUID(),
        artifactReferenceId: randomUUID(),
        intentionEventId: randomUUID(),
        terminalEventId: randomUUID(),
      },
    });
    leaseStore.close();
    other.close();
    expect(landed.ok).toBe(true);

    const staleReader: Ledger = new Proxy(reader, {
      get(target, property) {
        if (property === "listRoadmapVersions") return () => stale;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const outcome = recordRoadmapVersion({
      ledger: staleReader,
      initiativeId,
      request: { content: "# mine\n", expectedHeadDigest: v1.version.contentDigest, kind: "EDIT", restoresVersionId: null, recordedBy: COORDINATOR, steps: steps([manifestStep("X")]) as never },
      recordedAt: AT,
      roadmapVersionId: randomUUID(),
      eventId: randomUUID(),
      steps: {
        identities: {
          stepEventIds: [randomUUID()],
          commandId: randomUUID(),
          artifactPinId: randomUUID(),
          artifactReferenceId: randomUUID(),
          intentionEventId: randomUUID(),
          terminalEventId: randomUUID(),
        },
        holderPid: process.pid,
        leaseStoreIncarnationId: randomUUID(),
      },
    });
    reader.close();
    expect(outcome).toEqual({ ok: false, reason: "WRITE_CONFLICT", at: "roadmapVersion" });
    expect(recordedPayloads(path, initiativeId).map((payload) => payload["version"])).toEqual([1, 2]);
  });

  it("S8 (P-P18-2): a 2.9.0 history rewound to 24 migrates under 2.10.0, verifies and rebuilds, and takes S1 on top", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const first = RoadmapVersionWriteResponse.parse(
      (await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: body(), headers: AUTH })).json(),
    );
    await app.close();

    // The history as the previous build wrote it: every initiative event and every
    // roadmap payload at 2.9.0, no step field, the chain recomputed; then migration
    // 25 undone, so this build meets a ledger at 24.
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
    // P-27 cut A: migration 26 goes first, children first, or the step table it names
    // cannot go and the re-applied 26 aborts on its own tables.
    raw.exec(
      "DROP TRIGGER tr_task_graph_revision_read_model__supersede_once;" +
        "DROP TABLE task_dependency_read_model;" +
        "DROP TABLE task_graph_node_read_model;" +
        "DROP TABLE task_graph_revision_read_model;" +
        "DELETE FROM projection_watermark WHERE projection_name IN " +
        "('task_graph_revision_read_model', 'task_graph_node_read_model', 'task_dependency_read_model');",
    );
    raw.exec(
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

    // The server's handle is read-only and may not migrate; a writable open does.
    const migrated = openLedger(path);
    expect(migrated.status().migrations.at(-1)?.version).toBe(26);
    expect(migrated.listRoadmapVersions(initiativeId).map((row) => [row.recordingContractVersion, row.stepCount])).toEqual([["2.9.0", null]]);
    expect(migrated.verifyIntegrity().problems).toEqual([]);
    const rows = migrated.listRoadmapVersions(initiativeId);
    migrated.rebuildReadModel();
    expect(migrated.listRoadmapVersions(initiativeId)).toEqual(rows);
    migrated.close();

    const reopened = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const history = InitiativeRoadmapResponse.parse((await reopened.inject({ method: "GET", url: roadmapUrl(initiativeId) })).json());
    expect(history.items.map((item) => [item.version, item.stepCount, item.stepManifestSha256])).toEqual([[1, null, null]]);
    const onTop = await reopened.inject({
      method: "POST",
      url: roadmapUrl(initiativeId),
      payload: { ...body({ content: "# two\n", expectedHeadDigest: first.version.contentDigest }), steps: steps() },
      headers: AUTH,
    });
    await reopened.close();
    expect(onTop.statusCode).toBe(200);
    expect(RoadmapVersionWriteResponse.parse(onTop.json()).version.stepCount).toBe(3);
  });

  it("S9: a body at the new transport limit is admitted, one byte over is the transport's refusal", async () => {
    const { path, initiativeId } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerFile() });
    const limit = ROADMAP_CONTENT_MAX_BYTES + ROADMAP_STEP_MANIFEST_MAX_BYTES + ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES;
    const payload = JSON.stringify({ ...body({ content: "x".repeat(ROADMAP_CONTENT_MAX_BYTES) }), steps: steps() });
    // JSON admits trailing whitespace, so the body is padded to the byte it tests.
    const at = payload + " ".repeat(limit - Buffer.byteLength(payload, "utf8"));
    const over = at + " ";
    expect(Buffer.byteLength(at, "utf8")).toBe(limit);
    const admitted = await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: at, headers: { ...AUTH, "content-type": "application/json" } });
    expect(admitted.statusCode).toBe(200);
    const refused = await app.inject({ method: "POST", url: roadmapUrl(initiativeId), payload: over, headers: { ...AUTH, "content-type": "application/json" } });
    // Measured, against the map's "413": the plane classifies every framework 4xx
    // as 400 BAD_REQUEST, naming the framework's code in `detail`.
    expect(refused.statusCode).toBe(400);
    expect(ApiError.parse(refused.json()).error.detail).toBe("FST_ERR_CTP_BODY_TOO_LARGE");
    await app.close();
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

// ---------------------------------------------------------------------------
// P9 — one artifact-root rule, read from the gateway's side (V2-B1f/F3)
// ---------------------------------------------------------------------------

describe("the artifact root this seam publishes through is the ledger's own", () => {
  it("comes from @acp/ledger, and this package declares no second one", () => {
    // The rule moved into the package that owns the store it governs, and the
    // copy that used to live in `roadmap-write` was deleted rather than
    // duplicated. What keeps that true is that this suite, the route and the
    // write seam now all reach the SAME helper: there is no gateway export to
    // import instead, so a second answer to "where does a digest in this
    // ledger resolve?" cannot be written without adding one back.
    const seam: Record<string, unknown> = writeSeam;
    expect(Object.keys(seam)).not.toContain("artifactRootFor");
    expect(Object.keys(seam)).not.toContain("ARTIFACT_DIRECTORY");
  });

  it("resolves a roadmap write and a checkpoint into one store, from one rule", () => {
    const { path } = seed();
    const root = artifactRootFor(path);

    // The roadmap document, published through the seam's own store call.
    const document = publishArtifact(root, "# Roadmap\n\nOne version.\n");
    expect(document.ok).toBe(true);

    // A checkpoint's canonical bytes, published through the same helper from
    // the same ledger path — which is what the daemon and the drill children
    // do on the other side of the plane. One home, both consumers.
    const checkpoint = publishArtifact(root, '{"contractVersion":"2.2.0"}');
    expect(checkpoint.ok).toBe(true);
    if (!document.ok || !checkpoint.ok) return;

    expect(hasArtifact(root, document.digest)).toBe(true);
    expect(hasArtifact(root, checkpoint.digest)).toBe(true);
    expect(document.digest).not.toBe(checkpoint.digest);
    // And both resolve from the ledger path alone, with nothing configured.
    expect(artifactRootFor(path)).toBe(root);
  });
});

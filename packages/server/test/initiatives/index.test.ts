import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  API_CONTRACT_VERSION,
  ApiError,
  InitiativeDetailResponse,
  InitiativePortfolioResponse,
  InitiativeRoadmapResponse,
  LEDGER_CONTRACT_VERSION,
} from "@acp/api-contracts";
import { openLedger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";

/**
 * Evidence for the initiative data plane.
 *
 * Every response here is assembled from three folds — the initiative
 * projection, the roadmap history and the observation plane's token rollups —
 * so the tests seed a real ledger and read the routes, rather than mocking the
 * assembly and asserting the mock. A read model that only agreed with a stub
 * would prove the stub.
 *
 * The plane is read-only, and the last describe holds that: every non-GET on
 * every new path is refused exactly as it is on the routes that came before.
 */

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-p88a-"));
  temporaryDirectories.push(directory);
  return join(directory, "control-plane.sqlite");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const COORDINATOR = "kimi/k3/coordinator/01";
const IMPLEMENTER = "anthropic/claude-sonnet-5/implementer/01";
const AT = "2026-08-30T12:00:00.000Z";
const DIGEST_ONE = "a".repeat(64);
const DIGEST_TWO = "b".repeat(64);

interface EventInput {
  readonly taskId: string;
  readonly transitionId: string;
  readonly type?: string;
  readonly fromState?: string | null;
  readonly toState?: string;
  readonly payload?: Record<string, unknown>;
}

function makeEvent(input: EventInput): Record<string, unknown> {
  const attempt = 1;
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId: input.taskId,
    attempt,
    transitionId: input.transitionId,
    // Mirrors `buildIdempotencyKey`, restated rather than imported: this
    // package's dependency surface does not include `@acp/contracts`.
    idempotencyKey: input.taskId + "/" + String(attempt) + "/" + input.transitionId,
    type: input.type ?? "TASK_DISCOVERED",
    fromState: input.fromState ?? null,
    toState: input.toState ?? "DISCOVERED",
    emittedBy: IMPLEMENTER,
    occurredAt: AT,
    recordedAt: AT,
    correlationId: null,
    causationId: null,
    payload: input.payload ?? {},
  };
}

function makeInitiativeEvent(
  initiativeId: string,
  transitionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    initiativeId,
    transitionId,
    idempotencyKey: initiativeId + "/1/" + transitionId,
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: COORDINATOR,
    occurredAt: AT,
    recordedAt: AT,
    payload: {},
    ...overrides,
  };
}

interface Seeded {
  readonly path: string;
  readonly alpha: string;
  readonly beta: string;
  readonly taskA: string;
  readonly taskB: string;
  readonly unscopedTask: string;
  readonly versionOne: string;
  readonly versionTwo: string;
  readonly versionThree: string;
}

/**
 * Two initiatives, three tasks and two roadmap versions.
 *
 * `alpha` carries registration detail, two tasks and both roadmap versions;
 * `beta` is registered bare — no slug, no title, no objective, no roadmap, no
 * tasks — because the empty shapes are the ones a projection is most likely to
 * get wrong. One task is deliberately left unscoped, so the fold has spend it
 * cannot place and the quota surface has something true to report.
 */
function seed(): Seeded {
  const path = temporaryDatabase();
  const ledger = openLedger(path);
  const alpha = randomUUID();
  const beta = randomUUID();
  const taskA = randomUUID();
  const taskB = randomUUID();
  const unscopedTask = randomUUID();
  const versionOne = randomUUID();
  const versionTwo = randomUUID();
  const versionThree = randomUUID();

  ledger.appendInitiativeEvent(
    makeInitiativeEvent(alpha, "initiative.registered", {
      payload: { slug: "acp-p8", title: "The P8 initiative", objective: "Land the execution boundary" },
    }),
  );
  // Registered after alpha, so the portfolio's creation ordering has something
  // to order. Bare on purpose.
  ledger.appendInitiativeEvent(
    makeInitiativeEvent(beta, "initiative.registered", { occurredAt: "2026-08-30T13:00:00.000Z", recordedAt: "2026-08-30T13:00:00.000Z" }),
  );

  // Two edits and a rollback. The third version restores version 1's bytes —
  // a rollback is a new version, never a rewrite of history — so the fixture
  // exercises both kinds and the `restoresVersionId` pairing the contract
  // enforces (null exactly when the kind is EDIT).
  const versions = [
    { id: versionOne, version: 1, digest: DIGEST_ONE, parent: null, expected: null, kind: "EDIT", restores: null },
    {
      id: versionTwo,
      version: 2,
      digest: DIGEST_TWO,
      parent: versionOne,
      expected: DIGEST_ONE,
      kind: "EDIT",
      restores: null,
    },
    {
      id: versionThree,
      version: 3,
      // The restored bytes are version 1's, which is what makes this a
      // rollback rather than a third edit that happens to look like one.
      digest: DIGEST_ONE,
      parent: versionTwo,
      expected: DIGEST_TWO,
      kind: "ROLLBACK",
      restores: versionOne,
    },
  ] as const;

  for (const entry of versions) {
    ledger.appendInitiativeEvent(
      makeInitiativeEvent(alpha, "roadmap.v" + String(entry.version), {
        type: "ROADMAP_VERSION_RECORDED",
        fromStatus: "ACTIVE",
        toStatus: "ACTIVE",
        payload: {
          // A full `RoadmapVersion`: the projection parses the payload and
          // skips anything that is not one, so a fixture missing a field would
          // silently produce no version rather than a failure.
          contractVersion: LEDGER_CONTRACT_VERSION,
          roadmapVersionId: entry.id,
          initiativeId: alpha,
          version: entry.version,
          contentDigest: entry.digest,
          parentVersionId: entry.parent,
          expectedHeadDigest: entry.expected,
          kind: entry.kind,
          restoresVersionId: entry.restores,
          recordedBy: COORDINATOR,
          recordedAt: AT,
        },
      }),
    );
  }

  for (const [taskId, initiativeId] of [
    [taskA, alpha],
    [taskB, alpha],
    [unscopedTask, null],
  ] as const) {
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "discover",
        payload: initiativeId === null ? {} : { initiativeId },
      }),
    );
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "usage.1",
        type: "TOKEN_USAGE_RECORDED",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        payload: { accountId: "acct-a", tokens: 100 },
      }),
    );
  }

  ledger.close();
  return { path, alpha, beta, taskA, taskB, unscopedTask, versionOne, versionTwo, versionThree };
}

// ---------------------------------------------------------------------------
// The portfolio
// ---------------------------------------------------------------------------

describe("GET /api/v1/initiatives", () => {
  it("lists every initiative with its rollup summary", async () => {
    const { path, alpha, beta } = seed();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives" });

    expect(response.statusCode).toBe(200);
    const body = InitiativePortfolioResponse.parse(response.json());
    expect(body.apiContractVersion).toBe(API_CONTRACT_VERSION);
    expect(body.count).toBe(2);
    expect(body.items.map((item) => item.initiativeId)).toEqual([alpha, beta]);

    const first = body.items[0];
    if (first === undefined) throw new Error("expected a row");
    expect({ slug: first.slug, title: first.title, objective: first.objective }).toEqual({
      slug: "acp-p8",
      title: "The P8 initiative",
      objective: "Land the execution boundary",
    });
    // Two scoped tasks, 100 tokens each, and the head digest is the newest
    // recorded version rather than the first.
    expect(first.taskCount).toBe(2);
    expect(first.rollup.tokensUsed).toBe(200);
    // The head is the newest recorded version — the rollback — and its digest
    // is the restored bytes', not the version it rolled back from.
    expect(first.headRoadmapDigest).toBe(DIGEST_ONE);
    expect(first.roadmapVersionCount).toBe(3);
    await app.close();
  });

  it("reports an initiative registered without detail as null, not as empty text", async () => {
    const { path, beta } = seed();
    const app = buildServer({ ledgerPath: path });
    const body = InitiativePortfolioResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives" })).json(),
    );
    const bare = body.items.find((item) => item.initiativeId === beta);
    if (bare === undefined) throw new Error("expected the bare initiative");

    // Null says the stream never carried one. An empty string would read as a
    // title nobody wrote.
    expect({ slug: bare.slug, title: bare.title, objective: bare.objective }).toEqual({
      slug: null,
      title: null,
      objective: null,
    });
    expect({ tasks: bare.taskCount, versions: bare.roadmapVersionCount, head: bare.headRoadmapDigest }).toEqual({
      tasks: 0,
      versions: 0,
      head: null,
    });
    expect(bare.rollup).toEqual({ tokensUsed: 0, tokensReserved: 0, skippedMalformed: 0 });
    await app.close();
  });

  it("answers an empty ledger with an empty portfolio rather than an error", async () => {
    const path = temporaryDatabase();
    openLedger(path).close();
    const app = buildServer({ ledgerPath: path });
    const body = InitiativePortfolioResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives" })).json(),
    );
    expect({ items: body.items.length, count: body.count }).toEqual({ items: 0, count: 0 });
    await app.close();
  });

  it("refuses an unexpected query parameter", async () => {
    const { path } = seed();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives?limit=5" });
    expect(response.statusCode).toBe(400);
    expect(ApiError.parse(response.json()).error.code).toBe("BAD_REQUEST");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

describe("GET /api/v1/initiatives/:initiativeId", () => {
  it("carries the roadmap newest-first with the head marked, and the scoped tasks", async () => {
    const { path, alpha, taskA, taskB, versionThree } = seed();
    const app = buildServer({ ledgerPath: path });
    const body = InitiativeDetailResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + alpha })).json(),
    );

    expect(body.initiative.initiative.initiativeId).toBe(alpha);
    expect(body.initiative.roadmap.map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(body.initiative.roadmap.map((entry) => entry.head)).toEqual([true, false, false]);
    expect(body.initiative.roadmap[0]?.roadmapVersionId).toBe(versionThree);

    expect(body.initiative.tasks.map((task) => task.taskId).sort()).toEqual([taskA, taskB].sort());
    for (const task of body.initiative.tasks) {
      expect(task.rollup.tokensUsed).toBe(100);
    }
    await app.close();
  });

  it("reports LOW confidence when spend exists the fold cannot place", async () => {
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path });
    const body = InitiativeDetailResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + alpha })).json(),
    );

    // The unscoped task spent 100 tokens against no initiative. Reporting it
    // is the point: a rollup that quietly lost spend would be worse than one
    // that admits it cannot place it.
    expect(body.initiative.quota.unscopedTokensUsed).toBe(100);
    expect(body.initiative.quota.confidence).toBe("LOW");
    expect(body.initiative.quota.skippedMalformed).toBe(0);
    await app.close();
  });

  it("reports HIGH confidence when everything folded and everything was placed", async () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    const taskId = randomUUID();
    ledger.appendInitiativeEvent(makeInitiativeEvent(initiativeId, "initiative.registered"));
    ledger.append(makeEvent({ taskId, transitionId: "discover", payload: { initiativeId } }));
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "usage.1",
        type: "TOKEN_USAGE_RECORDED",
        fromState: "DISCOVERED",
        toState: "DISCOVERED",
        payload: { accountId: "acct-a", tokens: 42 },
      }),
    );
    ledger.close();

    const app = buildServer({ ledgerPath: path });
    const body = InitiativeDetailResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + initiativeId })).json(),
    );
    expect(body.initiative.quota).toEqual({
      confidence: "HIGH",
      skippedMalformed: 0,
      unscopedTokensUsed: 0,
    });
    expect(body.initiative.initiative.rollup.tokensUsed).toBe(42);
    await app.close();
  });

  it("refuses a malformed id and 404s an unknown one", async () => {
    const { path } = seed();
    const app = buildServer({ ledgerPath: path });

    const malformed = await app.inject({ method: "GET", url: "/api/v1/initiatives/not-a-uuid" });
    expect(malformed.statusCode).toBe(400);
    expect(ApiError.parse(malformed.json()).error.code).toBe("BAD_REQUEST");

    const missing = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + randomUUID() });
    expect(missing.statusCode).toBe(404);
    expect(ApiError.parse(missing.json()).error.code).toBe("NOT_FOUND");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// The roadmap history
// ---------------------------------------------------------------------------

describe("GET /api/v1/initiatives/:initiativeId/roadmap", () => {
  it("returns the history newest-first with exactly one head", async () => {
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path });
    const body = InitiativeRoadmapResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + alpha + "/roadmap" })).json(),
    );

    expect(body.initiativeId).toBe(alpha);
    expect(body.count).toBe(3);
    expect(body.items.map((item) => item.version)).toEqual([3, 2, 1]);
    expect(body.items.filter((item) => item.head).length).toBe(1);
    expect(body.items[0]?.contentDigest).toBe(DIGEST_ONE);
    await app.close();
  });

  it("carries a rollback through the mapper and the schema, kind and restoresVersionId intact", async () => {
    // The rollback leg, end to end. `kind` and `restoresVersionId` are the two
    // fields only a rollback exercises: an EDIT-only fixture would leave the
    // mapper free to drop either of them and every assertion would still pass,
    // because null is what an EDIT carries anyway.
    const { path, alpha, versionOne, versionTwo, versionThree } = seed();
    const app = buildServer({ ledgerPath: path });
    const body = InitiativeRoadmapResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + alpha + "/roadmap" })).json(),
    );

    const rollback = body.items.find((item) => item.roadmapVersionId === versionThree);
    if (rollback === undefined) throw new Error("expected the rollback version");

    expect({
      kind: rollback.kind,
      restores: rollback.restoresVersionId,
      parent: rollback.parentVersionId,
      version: rollback.version,
      digest: rollback.contentDigest,
      head: rollback.head,
    }).toEqual({
      kind: "ROLLBACK",
      // The version whose bytes were restored, not the one rolled back from.
      restores: versionOne,
      parent: versionTwo,
      version: 3,
      digest: DIGEST_ONE,
      // A rollback is a new version and therefore the newest one: the head
      // moves onto it rather than back to what it restored.
      head: true,
    });

    // The edits keep the other half of the contract's pairing: null exactly
    // when the kind is EDIT. Asserted here too, so the round trip proves the
    // mapper distinguishes the kinds rather than passing one value through.
    for (const edit of body.items.filter((item) => item.roadmapVersionId !== versionThree)) {
      expect({ id: edit.roadmapVersionId, kind: edit.kind, restores: edit.restoresVersionId }).toEqual({
        id: edit.roadmapVersionId,
        kind: "EDIT",
        restores: null,
      });
    }
    await app.close();
  });

  it("shows the same rollback on the detail route, from the same fold", async () => {
    const { path, alpha, versionOne, versionThree } = seed();
    const app = buildServer({ ledgerPath: path });
    const body = InitiativeDetailResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + alpha })).json(),
    );

    const head = body.initiative.roadmap[0];
    expect({ id: head?.roadmapVersionId, kind: head?.kind, restores: head?.restoresVersionId }).toEqual({
      id: versionThree,
      kind: "ROLLBACK",
      restores: versionOne,
    });
    // And the summary's head digest agrees with the history's head row, which
    // is the one place the two folds could have disagreed.
    expect(body.initiative.initiative.headRoadmapDigest).toBe(head?.contentDigest);
    await app.close();
  });

  it("returns an empty history for a real initiative with no versions", async () => {
    const { path, beta } = seed();
    const app = buildServer({ ledgerPath: path });
    const body = InitiativeRoadmapResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + beta + "/roadmap" })).json(),
    );
    expect({ items: body.items.length, count: body.count }).toEqual({ items: 0, count: 0 });
    await app.close();
  });

  it("404s an initiative that does not exist rather than answering an empty history", async () => {
    // The distinction matters: a 200 with no versions would say "this
    // initiative has no roadmap" about something that does not exist.
    const { path } = seed();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/initiatives/" + randomUUID() + "/roadmap",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Still read-only
// ---------------------------------------------------------------------------

describe("the initiative plane mutates nothing", () => {
  it("answers every non-GET on the read-only initiative paths with 405", async () => {
    // The portfolio and the detail stay read-only: all four non-GET verbs
    // refuse, exactly as they did before the plane took a write route.
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path });
    const readOnlyPaths = ["/api/v1/initiatives", "/api/v1/initiatives/" + alpha];

    for (const url of readOnlyPaths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await app.inject({ method, url });
        expect({ url, method, status: response.statusCode }).toEqual({ url, method, status: 405 });
        expect(ApiError.parse(response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
      }
    }
    await app.close();
  });

  it("refuses PUT, PATCH and DELETE on the roadmap path, but no longer POST", async () => {
    // P8-8D-pre falsified one cell of this file's original twelve: POST on the
    // roadmap path is the plane's first write route. The split keeps the
    // assertion that matters — three verbs still refuse — and states the one
    // that changed as a fact rather than deleting it. A test that had simply
    // dropped the roadmap path would have stopped watching it entirely.
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path });
    const url = "/api/v1/initiatives/" + alpha + "/roadmap";

    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url });
      expect({ method, status: response.statusCode }).toEqual({ method, status: 405 });
      expect(ApiError.parse(response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
    }

    // POST is answered, not refused. Asserted as "not 405" rather than as a
    // specific success, because what this file owns is the method surface —
    // the write's own behaviour belongs to `test/roadmap-write`, and pinning
    // it here too would make one change fail in two places for one reason.
    const posted = await app.inject({ method: "POST", url, payload: {} });
    expect(posted.statusCode).not.toBe(405);
    await app.close();
  });

  it("leaves the ledger's head exactly where it found it", async () => {
    const { path, alpha } = seed();
    const before = openLedger(path, { readOnly: true });
    const head = before.status();
    before.close();

    const app = buildServer({ ledgerPath: path });
    await app.inject({ method: "GET", url: "/api/v1/initiatives" });
    await app.inject({ method: "GET", url: "/api/v1/initiatives/" + alpha });
    await app.inject({ method: "GET", url: "/api/v1/initiatives/" + alpha + "/roadmap" });
    await app.close();

    const after = openLedger(path, { readOnly: true });
    expect(after.status().headEventSha256).toBe(head.headEventSha256);
    expect(after.status().eventCount).toBe(head.eventCount);
    expect(after.status().initiativeHeadEventSha256).toBe(head.initiativeHeadEventSha256);
    after.close();
  });
});

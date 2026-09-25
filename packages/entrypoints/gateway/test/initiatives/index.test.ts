import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  API_CONTRACT_VERSION,
  ApiError,
  InitiativeDetailResponse,
  InitiativePortfolioResponse,
  InitiativeAgentsResponse,
  InitiativeRoadmapResponse,
  InitiativeTimelineResponse,
  LEDGER_CONTRACT_VERSION,
  RoadmapContentResponse,
  RoadmapDiffResponse,
  RoadmapStepsResponse,
  RoadmapVersionWriteResponse,
  initiativeRoadmapDiffPath,
  initiativeRoadmapStepsPath,
} from "@acp/protocol";
import {
  GENESIS_SHA256,
  LedgerIntegrityError,
  canonicalJsonStringify,
  chainDigest,
  artifactBlobLeaseStorePath,
  artifactPlaneRootFor,
  openArtifactBlobLeaseStore,
  openArtifactPlane,
  openLedger,
  publishArtifact,
  registerInitiative,
} from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../../src/build-server/index.js";
import { registrationDetail } from "../../src/initiatives/index.js";

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

/**
 * A write bearer token file (P8-8G A1).
 *
 * This suite's subject is the content-read surface, and it seeds that content
 * through the write route — which is now guarded. The credential is fixture
 * scaffolding, not the thing under test: no assertion here is about the door.
 */
const WRITE_TOKEN = "p8-8g-initiatives-" + "s".repeat(24);

function bearerTokenFile(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-init-bearer-")));
  temporaryDirectories.push(dir);
  const path = join(dir, "write.token");
  writeFileSync(path, WRITE_TOKEN + "\n", "utf8");
  chmodSync(path, 0o600);
  return path;
}

const WRITE_AUTH = { authorization: "Bearer " + WRITE_TOKEN };

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
  readonly emittedBy?: string;
  readonly recordedAt?: string;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
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
    emittedBy: input.emittedBy ?? IMPLEMENTER,
    occurredAt: input.recordedAt ?? AT,
    recordedAt: input.recordedAt ?? AT,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
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
          stepCount: 0,
          stepManifestArtifactReferenceId: null,
          stepManifestSha256: null,
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

// ---------------------------------------------------------------------------
// The content read (P8-8D-c2)
// ---------------------------------------------------------------------------

describe("GET /api/v1/initiatives/:initiativeId/roadmap/content", () => {
  /** Record one version through the write route, returning what it answered. */
  async function write(
    app: ReturnType<typeof buildServer>,
    initiativeId: string,
    content: string,
    expectedHeadDigest: string | null,
  ): Promise<{ readonly version: number; readonly contentDigest: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/initiatives/" + initiativeId + "/roadmap",
      payload: {
        content,
        expectedHeadDigest,
        kind: "EDIT",
        restoresVersionId: null,
        recordedBy: COORDINATOR,
      },
      headers: WRITE_AUTH,
    });
    if (response.statusCode !== 200) throw new Error("write failed: " + String(response.statusCode));
    return RoadmapVersionWriteResponse.parse(response.json()).version;
  }

  function contentUrl(initiativeId: string, version: number): string {
    return "/api/v1/initiatives/" + initiativeId + "/roadmap/content?version=" + String(version);
  }

  it("serves the stored bytes byte-exact, with the digest that names them", async () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    ledger.appendInitiativeEvent(makeInitiativeEvent(initiativeId, "initiative.registered"));
    ledger.close();

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const document = "# Roadmap\n\nUnicode survives: café — ✓\n\n- one\n- two\n";
    const written = await write(app, initiativeId, document, null);

    const response = await app.inject({ method: "GET", url: contentUrl(initiativeId, written.version) });
    expect(response.statusCode).toBe(200);
    // Parsed through the contract rather than cast: asserting against a shape
    // I wrote myself would prove only that I wrote it consistently.
    const body = RoadmapContentResponse.parse(response.json());

    // Byte-exact, not merely equal-looking: the digest the ledger recorded is
    // returned beside the content, so a reader can re-hash and check for
    // itself rather than trusting the transport.
    expect(body.content).toBe(document);
    expect(body.contentDigest).toBe(written.contentDigest);
    expect({ version: body.version, kind: body.kind }).toEqual({ version: 1, kind: "EDIT" });
    await app.close();
  });

  it("serves each version's own bytes, not the head's", async () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    ledger.appendInitiativeEvent(makeInitiativeEvent(initiativeId, "initiative.registered"));
    ledger.close();

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const first = await write(app, initiativeId, "# one\n", null);
    await write(app, initiativeId, "# two\n", first.contentDigest);

    const v1 = await app.inject({ method: "GET", url: contentUrl(initiativeId, 1) });
    const v2 = await app.inject({ method: "GET", url: contentUrl(initiativeId, 2) });
    expect(RoadmapContentResponse.parse(v1.json()).content).toBe("# one\n");
    expect(RoadmapContentResponse.parse(v2.json()).content).toBe("# two\n");
    await app.close();
  });

  it("404s a version this initiative never recorded", async () => {
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: contentUrl(alpha, 99) });
    expect(response.statusCode).toBe(404);
    expect(ApiError.parse(response.json()).error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("refuses as an integrity failure when the ledger names bytes the store lacks", async () => {
    // The P8-8A fixture records roadmap versions directly on the stream, so
    // their content was never published. That is exactly the ledger/store
    // disagreement this branch exists for — and the answer is a classified
    // refusal, never a 200 with an empty body.
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: contentUrl(alpha, 1) });
    expect(response.statusCode).toBe(500);
    expect(ApiError.parse(response.json()).error.code).toBe("LEDGER_INTEGRITY");
    await app.close();
  });

  it("404s an initiative that does not exist, and 400s a malformed selector", async () => {
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });

    expect((await app.inject({ method: "GET", url: contentUrl(randomUUID(), 1) })).statusCode).toBe(404);
    for (const query of ["", "?version=0", "?version=-1", "?version=abc", "?digest=" + "a".repeat(64)]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/initiatives/" + alpha + "/roadmap/content" + query,
      });
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
    }
    await app.close();
  });

  it("cannot be used to read another initiative's document (the version selector's point)", async () => {
    // Two initiatives, one version each. Asking the first for version 1 gives
    // the first's bytes; there is no way to ask it for the second's, because a
    // caller never names a digest — the fold resolves it inside the
    // initiative in the path.
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const one = randomUUID();
    const two = randomUUID();
    ledger.appendInitiativeEvent(makeInitiativeEvent(one, "initiative.registered"));
    ledger.appendInitiativeEvent(makeInitiativeEvent(two, "initiative.registered"));
    ledger.close();

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    await write(app, one, "# first initiative\n", null);
    await write(app, two, "# second initiative\n", null);

    expect((await app.inject({ method: "GET", url: contentUrl(one, 1) })).json()).toMatchObject({
      content: "# first initiative\n",
    });
    expect((await app.inject({ method: "GET", url: contentUrl(two, 1) })).json()).toMatchObject({
      content: "# second initiative\n",
    });
    await app.close();
  });

  it("the guards run on egress: a credential-shaped document does not leave", async () => {
    // The write route scans on ingest, so reaching this state needs the store
    // seeded behind it — which is precisely the case the egress guard exists
    // for. The response schema refuses, and the endpoint answers a classified
    // error rather than the document.
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    ledger.appendInitiativeEvent(makeInitiativeEvent(initiativeId, "initiative.registered"));

    const secret = "sk-ant-api03-BBBBBBBBBBBBBBBBBBBB";
    const planted = "# Roadmap\n\napiKey: " + secret + "\n";
    const published = publishArtifact(join(dirname(path), "artifacts"), planted);
    if (!published.ok) throw new Error("could not seed the store");

    const versionId = randomUUID();
    ledger.appendInitiativeEvent(
      makeInitiativeEvent(initiativeId, "roadmap.v1", {
        type: "ROADMAP_VERSION_RECORDED",
        fromStatus: "ACTIVE",
        toStatus: "ACTIVE",
        payload: {
          contractVersion: LEDGER_CONTRACT_VERSION,
          roadmapVersionId: versionId,
          initiativeId,
          version: 1,
          contentDigest: published.digest,
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
      }),
    );
    ledger.close();

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: contentUrl(initiativeId, 1) });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sk-");
    await app.close();
  });
});

describe("the initiative plane mutates nothing", () => {
  it("answers every non-GET on the read-only initiative paths with 405", async () => {
    // The detail stays read-only: all four non-GET verbs refuse, exactly as
    // they did before the plane took a write route. The portfolio left this
    // list at P-14/B, and the test below says what it answers instead.
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const readOnlyPaths = [
      "/api/v1/initiatives/" + alpha,
      // P-26 cut C: the steps and diff reads are reads like the content read.
      initiativeRoadmapStepsPath(alpha) + "?version=1",
      initiativeRoadmapDiffPath(alpha) + "?from=1&to=2",
    ];

    for (const url of readOnlyPaths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await app.inject({ method, url });
        expect({ url, method, status: response.statusCode }).toEqual({ url, method, status: 405 });
        expect(ApiError.parse(response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
      }
    }
    await app.close();
  });

  it("refuses PUT, PATCH and DELETE on the portfolio path, but no longer POST (P-14/B)", async () => {
    // The same split the roadmap path took at P8-8D-pre: three verbs still
    // refuse, and POST is answered. What POST does is `test/initiative-write`'s.
    const { path } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const url = "/api/v1/initiatives";
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url });
      expect({ method, status: response.statusCode }).toEqual({ method, status: 405 });
      expect(ApiError.parse(response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
    }
    const posted = await app.inject({ method: "POST", url, headers: WRITE_AUTH, payload: {} });
    expect(posted.statusCode).not.toBe(405);
    await app.close();
  });

  it("refuses PUT, PATCH and DELETE on the roadmap path, but no longer POST", async () => {
    // P8-8D-pre falsified one cell of this file's original twelve: POST on the
    // roadmap path is the plane's first write route. The split keeps the
    // assertion that matters — three verbs still refuse — and states the one
    // that changed as a fact rather than deleting it. A test that had simply
    // dropped the roadmap path would have stopped watching it entirely.
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
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

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
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

// ---------------------------------------------------------------------------
// The scoped reads (P8-8E-pre)
// ---------------------------------------------------------------------------

describe("GET /api/v1/initiatives/:id/events — the merged timeline (C2)", () => {
  it("merges both chains and tags every row with the chain it came from", async () => {
    const { path, alpha, taskA, taskB, unscopedTask } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + alpha + "/events" });

    expect(response.statusCode).toBe(200);
    const body = InitiativeTimelineResponse.parse(response.json());
    expect(body.initiativeId).toBe(alpha);
    expect(body.truncated).toBe(false);

    const streams = new Set(body.items.map((item) => item.stream));
    expect([...streams].sort()).toEqual(["INITIATIVE", "TASK"]);

    // Scoped both ways: alpha's own tasks are here, and the task belonging to
    // no initiative is not. A global page filtered by guesswork would have it.
    const taskIds = new Set(
      body.items.flatMap((item) => (item.stream === "TASK" ? [item.taskId] : [])),
    );
    expect(taskIds.has(taskA)).toBe(true);
    expect(taskIds.has(taskB)).toBe(true);
    expect(taskIds.has(unscopedTask)).toBe(false);

    // Every initiative row belongs to this initiative, by construction.
    for (const item of body.items) {
      if (item.stream === "INITIATIVE") expect(item.initiativeId).toBe(alpha);
    }
    expect(body.count).toBe(body.items.length);
  });

  it("surfaces the edge facts verbatim on task rows (C1)", async () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    const taskId = randomUUID();
    const cause = randomUUID();
    const correlation = randomUUID();
    ledger.appendInitiativeEvent(makeInitiativeEvent(initiativeId, "initiative.registered"));
    ledger.append(makeEvent({ taskId, transitionId: "discover", payload: { initiativeId } }));
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "caused",
        type: "TASK_CLASSIFIED",
        fromState: "DISCOVERED",
        toState: "DT_CLASSIFIED",
        causationId: cause,
        correlationId: correlation,
      }),
    );
    ledger.close();

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + initiativeId + "/events" });
    const body = InitiativeTimelineResponse.parse(response.json());

    const caused = body.items.find(
      (item) => item.stream === "TASK" && item.type === "TASK_CLASSIFIED",
    );
    expect(caused?.stream).toBe("TASK");
    if (caused?.stream !== "TASK") throw new Error("expected a task row");
    // Verbatim: the values the ledger recorded, not values derived from
    // adjacency. A graph drawn from these is drawn from what was written down.
    expect(caused.causationId).toBe(cause);
    expect(caused.correlationId).toBe(correlation);

    const discovered = body.items.find(
      (item) => item.stream === "TASK" && item.type === "TASK_DISCOVERED",
    );
    if (discovered?.stream !== "TASK") throw new Error("expected a task row");
    // Null is the common case and is carried as null, not omitted.
    expect(discovered.causationId).toBeNull();
    expect(discovered.correlationId).toBeNull();
  });

  it("orders by recordedAt, and breaks a tie with INITIATIVE before TASK", async () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    const taskId = randomUUID();
    const SAME = "2026-08-30T12:00:00.000Z";
    const LATER = "2026-08-30T12:00:01.000Z";

    // A task event and an initiative event sharing one millisecond: the tie
    // the two clocks make routine, and the case an implicit sort leaves to
    // chance.
    ledger.appendInitiativeEvent(
      makeInitiativeEvent(initiativeId, "initiative.registered", {
        occurredAt: SAME,
        recordedAt: SAME,
      }),
    );
    ledger.append(
      makeEvent({ taskId, transitionId: "discover", payload: { initiativeId }, recordedAt: SAME }),
    );
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "later",
        type: "TASK_CLASSIFIED",
        fromState: "DISCOVERED",
        toState: "DT_CLASSIFIED",
        recordedAt: LATER,
      }),
    );
    ledger.close();

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + initiativeId + "/events" });
    const body = InitiativeTimelineResponse.parse(response.json());

    expect(body.items.map((item) => item.stream + ":" + item.recordedAt)).toEqual([
      "INITIATIVE:" + SAME,
      "TASK:" + SAME,
      "TASK:" + LATER,
    ]);
  });

  it("answers 404 for an initiative the ledger has never seen", async () => {
    const { path } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/initiatives/" + randomUUID() + "/events",
    });
    expect(response.statusCode).toBe(404);
    expect(ApiError.parse(response.json()).error.code).toBe("NOT_FOUND");
  });

  it("gives a bare initiative an empty timeline rather than an error", async () => {
    const { path, beta } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + beta + "/events" });
    const body = InitiativeTimelineResponse.parse(response.json());
    // Registered, so one initiative row and no task rows: an initiative with
    // no work is a real state, not an absence.
    expect(body.items.every((item) => item.stream === "INITIATIVE")).toBe(true);
    expect(body.truncated).toBe(false);
  });
});

describe("GET /api/v1/initiatives/:id/agents — the scoped workers (C3)", () => {
  it("counts only what this initiative's tasks carry", async () => {
    const { path, alpha } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + alpha + "/agents" });

    expect(response.statusCode).toBe(200);
    const body = InitiativeAgentsResponse.parse(response.json());
    expect(body.initiativeId).toBe(alpha);
    expect(body.count).toBe(1);

    const agent = body.items[0];
    if (agent === undefined) throw new Error("expected one agent");
    expect(agent.identity).toBe(IMPLEMENTER);
    // alpha has two tasks and two events each; the unscoped task's two events
    // belong to no initiative and must not be counted here.
    expect(agent.taskCount).toBe(2);
    expect(agent.eventCount).toBe(4);
  });

  it("reports the task it acted on last *here*, not its last task anywhere", async () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    const other = randomUUID();
    const scopedTask = randomUUID();
    const elsewhere = randomUUID();

    ledger.appendInitiativeEvent(makeInitiativeEvent(initiativeId, "initiative.registered"));
    ledger.appendInitiativeEvent(makeInitiativeEvent(other, "initiative.registered"));
    ledger.append(
      makeEvent({
        taskId: scopedTask,
        transitionId: "discover",
        payload: { initiativeId },
        recordedAt: "2026-08-30T12:00:00.000Z",
      }),
    );
    // The same worker, later, on a different initiative's task. The global
    // worker projection's `lastTaskId` is now this one — which is exactly the
    // value a scoped surface must not publish.
    ledger.append(
      makeEvent({
        taskId: elsewhere,
        transitionId: "discover",
        payload: { initiativeId: other },
        recordedAt: "2026-08-30T18:00:00.000Z",
      }),
    );
    ledger.close();

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + initiativeId + "/agents" });
    const body = InitiativeAgentsResponse.parse(response.json());

    const agent = body.items[0];
    if (agent === undefined) throw new Error("expected one agent");
    expect(agent.currentTaskId).toBe(scopedTask);
    expect(agent.currentTaskId).not.toBe(elsewhere);
    expect(agent.taskCount).toBe(1);
    expect(agent.eventCount).toBe(1);
    expect(agent.lastSeenAt).toBe("2026-08-30T12:00:00.000Z");
  });

  it("orders by scoped last activity, newest first, with a stated tie-break", async () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    const taskId = randomUUID();
    const early = "anthropic/claude-sonnet-5/implementer/01";
    const late = "anthropic/claude-opus-5/implementer/02";

    ledger.appendInitiativeEvent(makeInitiativeEvent(initiativeId, "initiative.registered"));
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "discover",
        payload: { initiativeId },
        emittedBy: early,
        recordedAt: "2026-08-30T12:00:00.000Z",
      }),
    );
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "classify",
        type: "TASK_CLASSIFIED",
        fromState: "DISCOVERED",
        toState: "DT_CLASSIFIED",
        emittedBy: late,
        recordedAt: "2026-08-30T13:00:00.000Z",
      }),
    );
    ledger.close();

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + initiativeId + "/agents" });
    const body = InitiativeAgentsResponse.parse(response.json());

    expect(body.items.map((item) => item.identity)).toEqual([late, early]);
    expect(body.items[0]?.lastEventType).toBe("TASK_CLASSIFIED");
  });

  it("answers 404 for an initiative the ledger has never seen", async () => {
    const { path } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/initiatives/" + randomUUID() + "/agents",
    });
    expect(response.statusCode).toBe(404);
    expect(ApiError.parse(response.json()).error.code).toBe("NOT_FOUND");
  });

  it("gives an initiative with no task work an empty agent list", async () => {
    const { path, beta } = seed();
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const response = await app.inject({ method: "GET", url: "/api/v1/initiatives/" + beta + "/agents" });
    const body = InitiativeAgentsResponse.parse(response.json());
    expect(body.count).toBe(0);
    expect(body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The registration detail's two sources (P-14/B, ADR 0086)
// ---------------------------------------------------------------------------

describe("the registration detail reads the objective from where the registration put it", () => {
  const OBJECTIVE = "Keep the objective in the private plane and its digest in the stream.";

  function registeredByTheDoor(): { readonly path: string; readonly initiativeId: string } {
    const path = temporaryDatabase();
    const initiativeId = randomUUID();
    const ledger = openLedger(path);
    const leaseStore = openArtifactBlobLeaseStore(artifactBlobLeaseStorePath(path), { incarnationId: randomUUID(), createdAt: AT });
    const plane = openArtifactPlane({ ledger, leaseStore, ledgerPath: path });
    const outcome = registerInitiative({
      ledger,
      plane,
      request: { initiativeId, slug: "acp-p14", title: "The P-14 bootstrap", objective: OBJECTIVE, recordedBy: COORDINATOR },
      recordedAt: AT,
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
    expect(outcome.ok).toBe(true);
    return { path, initiativeId };
  }

  it("serves a legacy registration's objective from its payload, as before", () => {
    const { path, alpha, beta } = seed();
    const ledger = openLedger(path, { readOnly: true });
    expect(registrationDetail(ledger, alpha)).toEqual({
      slug: "acp-p8",
      title: "The P8 initiative",
      objective: "Land the execution boundary",
    });
    expect(registrationDetail(ledger, beta)).toEqual({ slug: null, title: null, objective: null });
    ledger.close();
    // A legacy read opens no plane, so it creates no private root.
    expect(existsSync(artifactPlaneRootFor(path))).toBe(false);
  });

  it("serves a door registration's objective from the plane, through a read-only handle", () => {
    const { path, initiativeId } = registeredByTheDoor();
    const ledger = openLedger(path, { readOnly: true });
    expect(registrationDetail(ledger, initiativeId)).toEqual({ slug: "acp-p14", title: "The P-14 bootstrap", objective: OBJECTIVE });
    ledger.close();
  });

  it("throws an integrity failure, never a null objective, when the private root is gone", () => {
    const { path, initiativeId } = registeredByTheDoor();
    rmSync(artifactPlaneRootFor(path), { recursive: true, force: true });
    const ledger = openLedger(path, { readOnly: true });
    let thrown: unknown;
    try {
      registrationDetail(ledger, initiativeId);
    } catch (error: unknown) {
      thrown = error;
    }
    ledger.close();
    expect(thrown).toBeInstanceOf(LedgerIntegrityError);
  });
});

// ---------------------------------------------------------------------------
// P-26 cut C: a version's steps, and the diff between two versions (ADR 0113)
// ---------------------------------------------------------------------------

describe("P-26/C: the steps read and the diff read, through the real routes over a real ledger", () => {
  /** A manifest step whose private texts carry a sentinel the sweeps look for. */
  function manifestStep(stepId: string, dependsOn: readonly string[] = [], objective?: string): Record<string, unknown> {
    return {
      stepId,
      title: "Step " + stepId,
      objective: objective ?? "SENTINEL-OBJECTIVE of " + stepId + ".",
      acceptance: "SENTINEL-ACCEPTANCE of " + stepId + ".",
      expectedWriteSet: ["sentinel-path/" + stepId + "/index.ts"],
      dependsOn: [...dependsOn],
    };
  }

  function manifest(entries: readonly Record<string, unknown>[]): Record<string, unknown> {
    return { manifestContractVersion: 1, steps: entries };
  }

  const V1_STEPS = [manifestStep("A"), manifestStep("B", ["A"]), manifestStep("C", ["A"])];
  const V2_STEPS = [manifestStep("A"), manifestStep("B", ["A"], "SENTINEL-OBJECTIVE of B, rewritten."), manifestStep("D", ["B"])];

  function registered(): string {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    ledger.appendInitiativeEvent(makeInitiativeEvent(initiativeId, "initiative.registered"));
    ledger.close();
    return path + "\n" + initiativeId;
  }

  async function post(
    app: ReturnType<typeof buildServer>,
    initiativeId: string,
    payload: Record<string, unknown>,
  ): Promise<RoadmapVersionWriteResponse> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/initiatives/" + initiativeId + "/roadmap",
      payload,
      headers: WRITE_AUTH,
    });
    if (response.statusCode !== 200) throw new Error("write failed: " + String(response.statusCode) + " " + response.body);
    return RoadmapVersionWriteResponse.parse(response.json());
  }

  function edit(content: string, head: RoadmapVersionWriteResponse | null, steps?: readonly Record<string, unknown>[]) {
    return {
      content,
      expectedHeadDigest: head === null ? null : head.version.contentDigest,
      kind: "EDIT",
      restoresVersionId: null,
      recordedBy: COORDINATOR,
      ...(steps === undefined ? {} : { steps: manifest(steps) }),
    };
  }

  /** v1 = A, B(A), C(A); v2 = A, B(A) re-objectived, D(B); v3 = ROLLBACK to v1. */
  async function history() {
    const [path = "", initiativeId = ""] = registered().split("\n");
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const v1 = await post(app, initiativeId, edit("# one\n", null, V1_STEPS));
    const v2 = await post(app, initiativeId, edit("# two\n", v1, V2_STEPS));
    const v3 = await post(app, initiativeId, {
      content: "# one\n",
      expectedHeadDigest: v2.version.contentDigest,
      kind: "ROLLBACK",
      restoresVersionId: v1.version.roadmapVersionId,
      recordedBy: COORDINATOR,
      steps: manifest(V1_STEPS),
    });
    return { path, app, initiativeId, v1, v2, v3 };
  }

  function diffUrl(initiativeId: string, from: number | string, to: number | string): string {
    return initiativeRoadmapDiffPath(initiativeId) + "?" + new URLSearchParams({ from: String(from), to: String(to) }).toString();
  }

  function stepsUrl(initiativeId: string, version: number | string): string {
    return initiativeRoadmapStepsPath(initiativeId) + "?" + new URLSearchParams({ version: String(version) }).toString();
  }

  async function getDiff(app: ReturnType<typeof buildServer>, initiativeId: string, from: number, to: number) {
    const response = await app.inject({ method: "GET", url: diffUrl(initiativeId, from, to) });
    expect(response.statusCode).toBe(200);
    return { body: RoadmapDiffResponse.parse(response.json()), raw: response.body };
  }

  /** §8.1's sentinel sweep: no private text, no digest value, no digest or reference key. */
  function sweep(raw: string): void {
    expect(raw).not.toContain("SENTINEL");
    expect(raw).not.toContain("sentinel-path");
    expect(raw).not.toMatch(/[0-9a-f]{64}/);
    expect(raw).not.toMatch(/"[A-Za-z]*(Sha256|Reference|ReferenceId)"\s*:/);
  }

  it("D1: added, removed, changed by field name, pairs, content and roles, with both sides echoed and nothing private", async () => {
    const { app, initiativeId, v1, v2 } = await history();
    const { body, raw } = await getDiff(app, initiativeId, 1, 2);
    expect(body).toEqual({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId,
      from: { version: 1, roadmapVersionId: v1.version.roadmapVersionId, kind: "EDIT", stepCount: 3 },
      to: { version: 2, roadmapVersionId: v2.version.roadmapVersionId, kind: "EDIT", stepCount: 3 },
      added: ["D"],
      removed: ["C"],
      changed: [{ stepId: "B", fields: ["objectiveSha256"] }],
      dependencies: {
        added: [{ stepId: "D", dependsOnStepId: "B" }],
        removed: [{ stepId: "C", dependsOnStepId: "A" }],
      },
      contentChanged: true,
      restores: null,
      roles: "STEP_ASSIGNMENTS_UNPRODUCED",
    });
    sweep(raw);
    expect(raw).not.toContain("Step ");
    await app.close();
  });

  it("D1b: a forward reference is order-free — a reorder moves positions and no pair", async () => {
    const { app, initiativeId, v3 } = await history();
    const v4 = await post(app, initiativeId, edit("# two\n", v3, [V2_STEPS[0] ?? {}, V2_STEPS[2] ?? {}, V2_STEPS[1] ?? {}]));
    expect(v4.version.version).toBe(4);
    const { body } = await getDiff(app, initiativeId, 2, 4);
    expect([body.added, body.removed, body.dependencies, body.contentChanged]).toEqual([
      [],
      [],
      { added: [], removed: [] },
      false,
    ]);
    expect(body.changed).toEqual([
      { stepId: "B", fields: ["stepIndex"] },
      { stepId: "D", fields: ["stepIndex"] },
    ]);
    await app.close();
  });

  it("D2: a rollback is a new, traceable revision — v2 -> v3 inverts D1 and names v1 by number and id; v1 -> v3 is empty", async () => {
    const { app, initiativeId, v1, v3 } = await history();
    const back = (await getDiff(app, initiativeId, 2, 3)).body;
    expect(back.to).toEqual({ version: 3, roadmapVersionId: v3.version.roadmapVersionId, kind: "ROLLBACK", stepCount: 3 });
    expect([back.added, back.removed, back.changed]).toEqual([["C"], ["D"], [{ stepId: "B", fields: ["objectiveSha256"] }]]);
    expect(back.dependencies).toEqual({
      added: [{ stepId: "C", dependsOnStepId: "A" }],
      removed: [{ stepId: "D", dependsOnStepId: "B" }],
    });
    expect([back.contentChanged, back.restores]).toEqual([true, { version: 1, roadmapVersionId: v1.version.roadmapVersionId }]);

    const same = (await getDiff(app, initiativeId, 1, 3)).body;
    expect([same.added, same.removed, same.changed, same.dependencies, same.contentChanged]).toEqual([
      [],
      [],
      [],
      { added: [], removed: [] },
      false,
    ]);
    expect(same.restores).toEqual({ version: 1, roadmapVersionId: v1.version.roadmapVersionId });
    await app.close();
  });

  it("D3: from == to is the empty diff, 200, content unchanged, restores null — a rollback included", async () => {
    const { app, initiativeId } = await history();
    for (const version of [2, 3]) {
      const { body } = await getDiff(app, initiativeId, version, version);
      expect(body).toMatchObject({
        added: [],
        removed: [],
        changed: [],
        dependencies: { added: [], removed: [] },
        contentChanged: false,
        restores: null,
        roles: "STEP_ASSIGNMENTS_UNPRODUCED",
      });
    }
    await app.close();
  });

  it("D4: an unknown number or initiative is 404 with the existing words; a malformed selector is 400 at the field, never echoed", async () => {
    const { app, initiativeId } = await history();
    for (const [url, message] of [
      [diffUrl(initiativeId, 99, 1), "no roadmap version with that number was found"],
      [diffUrl(initiativeId, 1, 99), "no roadmap version with that number was found"],
      [diffUrl(randomUUID(), 1, 2), "no initiative with that id was found"],
      [stepsUrl(initiativeId, 99), "no roadmap version with that number was found"],
      [stepsUrl(randomUUID(), 1), "no initiative with that id was found"],
    ] as const) {
      const response = await app.inject({ method: "GET", url });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 404 });
      const envelope = ApiError.parse(response.json());
      expect([envelope.error.code, envelope.error.message]).toEqual(["NOT_FOUND", message]);
    }
    for (const [query, detail] of [
      ["?from=abcSENTINEL&to=1", "invalid: from"],
      ["?from=1&to=0", "invalid: to"],
      ["?from=1", "invalid: to"],
      ["?from=1&to=2&version=1", "rejected parameters: 1"],
    ] as const) {
      const response = await app.inject({ method: "GET", url: initiativeRoadmapDiffPath(initiativeId) + query });
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
      const envelope = ApiError.parse(response.json());
      expect([envelope.error.code, envelope.error.detail]).toEqual(["BAD_REQUEST", detail]);
      expect(response.body).not.toContain("SENTINEL");
    }
    for (const query of ["", "?version=0", "?version=abcSENTINEL", "?digest=" + "a".repeat(64)]) {
      const response = await app.inject({ method: "GET", url: initiativeRoadmapStepsPath(initiativeId) + query });
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
      expect(response.body).not.toContain("SENTINEL");
      expect(response.body).not.toMatch(/[0-9a-f]{64}/);
    }
    await app.close();
  });

  it("D5: the steps of v1 in index order, ranks 0/1/1, dependencies, DECLARED; titles present and nothing private", async () => {
    const { app, initiativeId, v1 } = await history();
    const response = await app.inject({ method: "GET", url: stepsUrl(initiativeId, 1) });
    expect(response.statusCode).toBe(200);
    const body = RoadmapStepsResponse.parse(response.json());
    expect(body).toEqual({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId,
      version: { version: 1, roadmapVersionId: v1.version.roadmapVersionId, kind: "EDIT", stepCount: 3 },
      steps: [
        { stepId: "A", stepIndex: 0, title: "Step A", dependencyRank: 0, state: "DECLARED", dependsOn: [] },
        { stepId: "B", stepIndex: 1, title: "Step B", dependencyRank: 1, state: "DECLARED", dependsOn: ["A"] },
        { stepId: "C", stepIndex: 2, title: "Step C", dependencyRank: 1, state: "DECLARED", dependsOn: ["A"] },
      ],
    });
    sweep(response.body);
    for (const title of ["Step A", "Step B", "Step C"]) expect(response.body).toContain(title);
    expect(response.body).not.toContain("routingAssignment");
    await app.close();
  });

  it("D6a: a stepless version echoes stepCount 0 and no steps, and diffs as nothing against everything", async () => {
    const [path = "", initiativeId = ""] = registered().split("\n");
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const bare = await post(app, initiativeId, edit("# bare\n", null));
    await post(app, initiativeId, edit("# one\n", bare, V1_STEPS));
    const steps = RoadmapStepsResponse.parse((await app.inject({ method: "GET", url: stepsUrl(initiativeId, 1) })).json());
    expect([steps.version.stepCount, steps.steps]).toEqual([0, []]);
    const { body } = await getDiff(app, initiativeId, 1, 2);
    expect([body.from.stepCount, body.added, body.removed, body.dependencies.added.length]).toEqual([0, ["A", "B", "C"], [], 2]);
    await app.close();
  });

  it("D6b: a pre-cohort version echoes stepCount null, which the body tells apart from 0", async () => {
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    const initiativeId = randomUUID();
    ledger.appendInitiativeEvent(makeInitiativeEvent(initiativeId, "initiative.registered"));
    ledger.appendInitiativeEvent(
      makeInitiativeEvent(initiativeId, "roadmap.v1", {
        type: "ROADMAP_VERSION_RECORDED",
        fromStatus: "ACTIVE",
        toStatus: "ACTIVE",
        payload: {
          contractVersion: LEDGER_CONTRACT_VERSION,
          roadmapVersionId: randomUUID(),
          initiativeId,
          version: 1,
          contentDigest: DIGEST_ONE,
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
      }),
    );
    ledger.close();
    restampInitiativeHistory(path, "2.9.0");
    const rebuilt = openLedger(path);
    rebuilt.rebuildReadModel();
    expect(rebuilt.listRoadmapVersions(initiativeId).map((version) => version.stepCount)).toEqual([null]);
    rebuilt.close();

    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const history = InitiativeRoadmapResponse.parse(
      (await app.inject({ method: "GET", url: "/api/v1/initiatives/" + initiativeId + "/roadmap" })).json(),
    );
    const head = history.items[0];
    if (head === undefined) throw new Error("expected the pre-cohort version");
    await post(app, initiativeId, edit("# one\n", { version: head } as RoadmapVersionWriteResponse, V1_STEPS));

    const steps = RoadmapStepsResponse.parse((await app.inject({ method: "GET", url: stepsUrl(initiativeId, 1) })).json());
    expect([steps.version.stepCount, steps.steps]).toEqual([null, []]);
    const { body } = await getDiff(app, initiativeId, 1, 2);
    expect([body.from.stepCount, body.to.stepCount, body.added, body.removed]).toEqual([null, 3, ["A", "B", "C"], []]);
    const inverse = (await getDiff(app, initiativeId, 2, 1)).body;
    expect([inverse.to.stepCount, inverse.added, inverse.removed]).toEqual([null, [], ["A", "B", "C"]]);
    await app.close();
  });

  it("D7: a planted step assignment is refused as an integrity failure, 500 INTERNAL, naming no row — the word is measured", async () => {
    const { path, app, initiativeId, v2 } = await history();
    const control = await app.inject({ method: "GET", url: diffUrl(initiativeId, 1, 2) });
    expect(control.statusCode).toBe(200);
    await app.close();

    const raw = new DatabaseSync(path);
    const planted = raw
      .prepare("UPDATE roadmap_step_read_model SET routing_assignment_version = 1 WHERE roadmap_version_id = ? AND step_id = ?")
      .run(v2.version.roadmapVersionId, "D");
    raw.close();
    expect(planted.changes).toBe(1);

    const reopened = buildServer({ ledgerPath: path });
    for (const [from, to] of [
      [1, 2],
      [2, 3],
      [2, 2],
    ] as const) {
      const response = await reopened.inject({ method: "GET", url: diffUrl(initiativeId, from, to) });
      expect({ from, to, status: response.statusCode }).toEqual({ from, to, status: 500 });
      const envelope = ApiError.parse(response.json());
      expect([envelope.error.code, envelope.error.detail]).toEqual(["INTERNAL", "STEP_ASSIGNMENT_PRESENT"]);
      expect(response.body).not.toContain("Step D");
      expect(response.body).not.toContain('"D"');
      sweep(response.body);
    }
    // A diff that reads neither side of the planted row still answers.
    expect((await reopened.inject({ method: "GET", url: diffUrl(initiativeId, 1, 3) })).statusCode).toBe(200);
    await reopened.close();
  });

  it("D8: a version at ROADMAP_STEPS_MAX steps is one bounded steps body, ranks up to the bound", async () => {
    const [path = "", initiativeId = ""] = registered().split("\n");
    const app = buildServer({ ledgerPath: path, writeBearerPath: bearerTokenFile() });
    const chain = Array.from({ length: 200 }, (_, index) =>
      manifestStep("S" + String(index).padStart(3, "0"), index === 0 ? [] : ["S" + String(index - 1).padStart(3, "0")]),
    );
    await post(app, initiativeId, edit("# many\n", null, chain));
    const response = await app.inject({ method: "GET", url: stepsUrl(initiativeId, 1) });
    expect(response.statusCode).toBe(200);
    const body = RoadmapStepsResponse.parse(response.json());
    expect([body.version.stepCount, body.steps.length]).toEqual([200, 200]);
    expect(body.steps.at(-1)).toMatchObject({ stepId: "S199", stepIndex: 199, dependencyRank: 199, dependsOn: ["S198"] });
    const { body: empty } = await getDiff(app, initiativeId, 1, 1);
    expect(empty.changed).toEqual([]);
    await app.close();
  });
});

/**
 * Restamp an initiative history as a build before steps would have written it: B's
 * `restampInitiativeHistory` mould (ledger suite), for D6b. Every event's version,
 * every roadmap payload's version, and no step field on a version — chain, head and
 * watermark recomputed; the append-only triggers taken out and put back verbatim.
 */
function restampInitiativeHistory(path: string, version: string): void {
  const raw = new DatabaseSync(path);
  try {
    const triggers = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)")
      .all("initiative_events_deny_update", "initiative_events_deny_delete") as unknown as { readonly sql: string }[];
    expect(triggers).toHaveLength(2);
    raw.exec("DROP TRIGGER initiative_events_deny_update; DROP TRIGGER initiative_events_deny_delete;");
    const rows = raw
      .prepare("SELECT sequence, event_json FROM initiative_events ORDER BY sequence")
      .all() as unknown as { readonly sequence: number; readonly event_json: string }[];
    const rewrite = raw.prepare(
      "UPDATE initiative_events SET event_json = ?, contract_version = ?, previous_sha256 = ?, event_sha256 = ? WHERE sequence = ?",
    );
    let previous = GENESIS_SHA256;
    for (const row of rows) {
      const decoded = JSON.parse(row.event_json) as Record<string, unknown>;
      decoded["contractVersion"] = version;
      if (decoded["type"] === "ROADMAP_VERSION_RECORDED") {
        const payload = { ...(decoded["payload"] as Record<string, unknown>) };
        payload["contractVersion"] = version;
        delete payload["stepCount"];
        delete payload["stepManifestArtifactReferenceId"];
        delete payload["stepManifestSha256"];
        decoded["payload"] = payload;
      }
      const rewritten = canonicalJsonStringify(decoded);
      const digest = chainDigest(previous, rewritten);
      rewrite.run(rewritten, version, previous, digest, row.sequence);
      previous = digest;
    }
    raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = 'initiative_head_event_sha256'").run(previous);
    raw.prepare("UPDATE projection_watermark SET source_head_sha256 = ? WHERE source_stream = ?").run(previous, "initiative_events");
    for (const trigger of triggers) raw.exec(trigger.sql);
  } finally {
    raw.close();
  }
}

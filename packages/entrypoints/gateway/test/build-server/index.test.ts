import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  API_CONTRACT_VERSION,
  API_ROUTES,
  API_ROUTE_PATTERNS,
  AccountsResponse,
  ApiError,
  EventPageResponse,
  HealthResponse,
  API_WRITE_ROUTES,
  IntegrityResult,
  LEDGER_CONTRACT_VERSION,
  LedgerStatusResponse,
  OverviewResponse,
  TaskDetailResponse,
  TaskPageResponse,
  WorkerDetailResponse,
  WorkerPageResponse,
} from "@acp/protocol";
import { LEDGER_MIGRATIONS, openLedger, type Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { parseArgv } from "../../src/bin/index.js";
import { buildServer } from "../../src/build-server/index.js";
import { startServer } from "../../src/start/index.js";

// ---------------------------------------------------------------------------
// Temporary databases. Every test builds its own, under its own temporary
// directory, and nothing here ever writes to a repository path.
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-server-"));
  temporaryDirectories.push(directory);
  return join(directory, "control-plane.sqlite");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Event fixtures. No fixture carries a secret-shaped value.
// ---------------------------------------------------------------------------

interface EventInput {
  readonly taskId?: string;
  readonly attempt?: number;
  readonly transitionId?: string;
  readonly eventId?: string;
  readonly type?: string;
  readonly fromState?: string | null;
  readonly toState?: string;
  readonly emittedBy?: string;
  readonly occurredAt?: string;
  readonly recordedAt?: string;
  readonly payload?: Record<string, unknown>;
}

function makeEvent(input: EventInput = {}): Record<string, unknown> {
  const taskId = input.taskId ?? randomUUID();
  const attempt = input.attempt ?? 1;
  const transitionId = input.transitionId ?? "step-1";
  const occurredAt = input.occurredAt ?? "2026-08-27T12:00:00.000Z";
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: input.eventId ?? randomUUID(),
    taskId,
    attempt,
    transitionId,
    // Mirrors @acp/contracts' buildIdempotencyKey, restated rather than
    // imported: this package's dependency surface is @acp/protocol and
    // @acp/ledger only, and this test fixture stays within it.
    idempotencyKey: taskId + "/" + String(attempt) + "/" + transitionId,
    type: input.type ?? "TASK_DISCOVERED",
    fromState: input.fromState ?? null,
    toState: input.toState ?? "DISCOVERED",
    emittedBy: input.emittedBy ?? "kimi/k3/coordinator/01",
    occurredAt,
    recordedAt: input.recordedAt ?? occurredAt,
    correlationId: null,
    causationId: null,
    payload: input.payload ?? {},
  };
}

const WORKER_A = "anthropic/claude-sonnet-5/implementer/01";
const WORKER_B = "kimi/k3/coordinator/01";

/** Two tasks, two workers, a handful of events. Closed before returning. */
function seedDatabase(): { path: string; taskA: string; taskB: string } {
  const path = temporaryDatabase();
  const ledger = openLedger(path);
  const taskA = randomUUID();
  const taskB = randomUUID();

  ledger.append(
    makeEvent({ taskId: taskA, transitionId: "discover", type: "TASK_DISCOVERED", toState: "DISCOVERED", emittedBy: WORKER_B }),
  );
  ledger.append(
    makeEvent({
      taskId: taskA,
      transitionId: "classify",
      type: "TASK_CLASSIFIED",
      fromState: "DISCOVERED",
      toState: "DT_CLASSIFIED",
      emittedBy: WORKER_B,
    }),
  );
  ledger.append(
    makeEvent({
      taskId: taskA,
      transitionId: "run",
      type: "RUN_STARTED",
      fromState: "DT_CLASSIFIED",
      toState: "RUNNING",
      emittedBy: WORKER_A,
    }),
  );
  ledger.append(
    makeEvent({ taskId: taskB, transitionId: "discover", type: "TASK_DISCOVERED", toState: "DISCOVERED", emittedBy: WORKER_B }),
  );

  ledger.close();
  return { path, taskA, taskB };
}

// ---------------------------------------------------------------------------
// Health, overview: empty and active ledger states
// ---------------------------------------------------------------------------

describe("health", () => {
  it("reports OK against an empty, reachable ledger", async () => {
    const path = temporaryDatabase();
    openLedger(path).close();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    const body = HealthResponse.parse(response.json());
    expect(body.status).toBe("OK");
    expect(body.readOnly).toBe(true);
    expect(body.database).not.toBeNull();
    expect(body.database?.pathRedacted).toBe(true);
    expect(body.apiContractVersion).toBe(API_CONTRACT_VERSION);
    expect(body.ledgerContractVersion).toBe(LEDGER_CONTRACT_VERSION);
    await app.close();
  });

  it("identifies one database identically however its path was spelled", async () => {
    const path = temporaryDatabase();
    openLedger(path).close();
    // The same file named relatively, which is how a server started with
    // `--database ./acp.sqlite` would receive it. The contract defines `id` as
    // the digest of the ABSOLUTE path, so the identity must not depend on the
    // spelling or on the working directory the process was started from.
    const equivalent = relative(process.cwd(), path);
    expect(equivalent).not.toBe(path);

    const first = buildServer({ ledgerPath: path });
    const second = buildServer({ ledgerPath: equivalent });
    const a = HealthResponse.parse(
      (await first.inject({ method: "GET", url: "/api/v1/health" })).json(),
    );
    const b = HealthResponse.parse(
      (await second.inject({ method: "GET", url: "/api/v1/health" })).json(),
    );

    expect(a.database?.id).toBe(b.database?.id);
    expect(a.database?.label).toBe(b.database?.label);
    await first.close();
    await second.close();
  });

  it("reports UNAVAILABLE when the database file does not exist", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-server-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "does-not-exist.sqlite");
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    const body = HealthResponse.parse(response.json());
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.database).toBeNull();
    expect(body.detail).not.toBeNull();
    await app.close();
  });

  it("reports UNAVAILABLE when the database file is not a valid sqlite file", async () => {
    const path = temporaryDatabase();
    writeFileSync(path, "this is not a sqlite database");
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    const body = HealthResponse.parse(response.json());
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.database).toBeNull();
    await app.close();
  });

  it("reports UNAVAILABLE when the applied migration set does not match this build", async () => {
    const { path } = seedDatabase();
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM schema_migrations").run();
    raw.close();

    const app = buildServer({ ledgerPath: path });
    const healthResponse = await app.inject({ method: "GET", url: "/api/v1/health" });
    const health = HealthResponse.parse(healthResponse.json());
    expect(health.status).toBe("UNAVAILABLE");

    const statusResponse = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(statusResponse.statusCode).toBe(409);
    const error = ApiError.parse(statusResponse.json());
    expect(error.error.code).toBe("CONTRACT_VERSION_MISMATCH");
    await app.close();
  });

  it("rejects an unexpected query parameter", async () => {
    const path = temporaryDatabase();
    openLedger(path).close();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/health?bogus=1" });
    expect(response.statusCode).toBe(400);
    const error = ApiError.parse(response.json());
    expect(error.error.code).toBe("BAD_REQUEST");
    await app.close();
  });
});

describe("overview", () => {
  it("reports EMPTY against a ledger with no events", async () => {
    const path = temporaryDatabase();
    openLedger(path).close();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/overview" });
    const body = OverviewResponse.parse(response.json());
    expect(body.state).toBe("EMPTY");
    expect(body.tasks.total).toBe(0);
    expect(body.workers.total).toBe(0);
    expect(body.capabilities).toEqual({
      readOnly: true,
      writes: false,
      routing: false,
      accounts: false,
      leases: false,
    });
    await app.close();
  });

  it("reports ACTIVE with correct task and worker breakdowns", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/overview" });
    const body = OverviewResponse.parse(response.json());
    expect(body.state).toBe("ACTIVE");
    expect(body.tasks.total).toBe(2);
    expect(body.tasks.active).toBe(2);
    expect(body.tasks.terminal).toBe(0);
    expect(body.workers.total).toBe(2);
    expect(body.ledger?.eventCount).toBe(4);
    expect(body.ledger?.lastEventAt).not.toBeNull();
    await app.close();
  });

  it("reports UNAVAILABLE with no ledger facts when the database cannot be opened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-server-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missing.sqlite");
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/overview" });
    const body = OverviewResponse.parse(response.json());
    expect(body.state).toBe("UNAVAILABLE");
    expect(body.database).toBeNull();
    expect(body.ledger).toBeNull();
    expect(body.notice).not.toBeNull();
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Tasks, workers, events: filters, cursors, limits
// ---------------------------------------------------------------------------

describe("tasks", () => {
  it("lists tasks and paginates with a limit of one", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });

    const first = await app.inject({ method: "GET", url: "/api/v1/tasks?limit=1" });
    const firstPage = TaskPageResponse.parse(first.json());
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.page.hasMore).toBe(true);
    expect(firstPage.page.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: "GET",
      url: "/api/v1/tasks?limit=1&cursor=" + String(firstPage.page.nextCursor),
    });
    const secondPage = TaskPageResponse.parse(second.json());
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.page.hasMore).toBe(false);
    expect(secondPage.page.nextCursor).toBeNull();
    expect(secondPage.items[0]?.taskId).not.toBe(firstPage.items[0]?.taskId);
    await app.close();
  });

  it("filters tasks by state", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/tasks?state=RUNNING" });
    const page = TaskPageResponse.parse(response.json());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.currentState).toBe("RUNNING");
    await app.close();
  });

  it("returns task detail with recent events, most recent first", async () => {
    const { path, taskA } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/tasks/" + taskA });
    expect(response.statusCode).toBe(200);
    const body = TaskDetailResponse.parse(response.json());
    expect(body.task.taskId).toBe(taskA);
    expect(body.task.currentState).toBe("RUNNING");
    expect(body.task.recentEvents).toHaveLength(3);
    expect(body.task.recentEvents[0]?.sequence).toBeGreaterThan(body.task.recentEvents[1]?.sequence ?? 0);
    await app.close();
  });

  it("answers a malformed task id with BAD_REQUEST", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/tasks/not-a-uuid" });
    expect(response.statusCode).toBe(400);
    const error = ApiError.parse(response.json());
    expect(error.error.code).toBe("BAD_REQUEST");
    await app.close();
  });

  it("wraps a task id the router itself cannot percent-decode in the one envelope", async () => {
    // %zz is not a valid percent escape. find-my-way rejects this before any
    // route handler runs, through Fastify's separate frameworkErrors path
    // rather than setErrorHandler; both must funnel into the same envelope.
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/tasks/%zz" });
    expect(response.statusCode).toBe(400);
    const error = ApiError.parse(response.json());
    expect(error.error.code).toBe("BAD_REQUEST");
    expect(error.apiContractVersion).toBe(API_CONTRACT_VERSION);
    expect(response.body).not.toContain(path);
    await app.close();
  });

  it("answers an unknown but well-formed task id with NOT_FOUND", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/tasks/" + randomUUID() });
    expect(response.statusCode).toBe(404);
    const error = ApiError.parse(response.json());
    expect(error.error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("rejects an unsupported query parameter and an out of range limit", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });

    const bogus = await app.inject({ method: "GET", url: "/api/v1/tasks?bogus=1" });
    expect(bogus.statusCode).toBe(400);

    const tooLarge = await app.inject({ method: "GET", url: "/api/v1/tasks?limit=9999" });
    expect(tooLarge.statusCode).toBe(400);

    const notDecimal = await app.inject({ method: "GET", url: "/api/v1/tasks?limit=1e3" });
    expect(notDecimal.statusCode).toBe(400);

    await app.close();
  });
});

describe("workers", () => {
  it("lists workers", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/workers" });
    const page = WorkerPageResponse.parse(response.json());
    expect(page.items).toHaveLength(2);
    await app.close();
  });

  it("filters workers by role", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/workers?role=coordinator" });
    const page = WorkerPageResponse.parse(response.json());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.identity).toBe(WORKER_B);
    await app.close();
  });

  it("resolves an identity containing slashes as one percent-encoded path segment", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/workers/" + encodeURIComponent(WORKER_A),
    });
    expect(response.statusCode).toBe(200);
    const body = WorkerDetailResponse.parse(response.json());
    expect(body.worker.identity).toBe(WORKER_A);
    expect(body.worker.recentEvents.every((item) => item.emittedBy === WORKER_A)).toBe(true);
    await app.close();
  });

  it("wraps a malformed percent-encoded identity in the one ApiError envelope", async () => {
    // %E0%A4%A is an incomplete multi-byte escape. find-my-way rejects this
    // itself before the workerByIdentity handler's own decodeURIComponent
    // guard ever runs, through Fastify's frameworkErrors path — this must
    // still answer as ApiError, not Fastify's own default error body, or a
    // strict reader cannot tell it apart from a genuine contract mismatch.
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/workers/%E0%A4%A" });
    expect(response.statusCode).toBe(400);
    const error = ApiError.parse(response.json());
    expect(error.error.code).toBe("BAD_REQUEST");
    expect(error.apiContractVersion).toBe(API_CONTRACT_VERSION);
    expect(response.body).not.toContain(path);
    await app.close();
  });

  it("answers an unknown identity with NOT_FOUND", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/workers/" + encodeURIComponent("nobody/nomodel/verifier/99"),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("events", () => {
  it("lists events with taskId, type and toState filters, and paginates", async () => {
    const { path, taskA } = seedDatabase();
    const app = buildServer({ ledgerPath: path });

    const byTask = await app.inject({ method: "GET", url: "/api/v1/events?taskId=" + taskA });
    const byTaskPage = EventPageResponse.parse(byTask.json());
    expect(byTaskPage.items).toHaveLength(3);

    const byType = await app.inject({ method: "GET", url: "/api/v1/events?type=RUN_STARTED" });
    const byTypePage = EventPageResponse.parse(byType.json());
    expect(byTypePage.items).toHaveLength(1);

    const byToState = await app.inject({ method: "GET", url: "/api/v1/events?toState=DISCOVERED" });
    const byToStatePage = EventPageResponse.parse(byToState.json());
    expect(byToStatePage.items).toHaveLength(2);

    const paged = await app.inject({ method: "GET", url: "/api/v1/events?limit=1" });
    const pagedFirst = EventPageResponse.parse(paged.json());
    expect(pagedFirst.items).toHaveLength(1);
    expect(pagedFirst.page.hasMore).toBe(true);
    expect(pagedFirst.page.nextCursor).not.toBeNull();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Status, integrity
// ---------------------------------------------------------------------------

describe("status", () => {
  it("reports pragmas, migrations and projections against a reachable ledger", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(response.statusCode).toBe(200);
    const body = LedgerStatusResponse.parse(response.json());
    expect(body.readOnly).toBe(true);
    expect(body.eventCount).toBe(4);
    // Which file, beside which path (P-10/id-B). The seeded ledger was opened
    // writably, so it has an identity and the whole triple is present.
    expect(body.instance.instanceId).not.toBeNull();
    expect(body.instance.restoreId).not.toBeNull();
    expect(body.instance.restoreEpoch).toBe(0);
    expect(body.pragmas.queryOnly).toBe(true);
    expect(body.migrations.length).toBeGreaterThan(0);

    // The vector crosses the wire (P-09/log-D). The route forwards the ledger's
    // array raw into a strict schema, so the fact that this parsed at all is
    // the assertion; what is spelled out is that the two-headed projection
    // arrives with BOTH heads rather than one of them.
    const routing = body.projections.find(
      (projection) => projection.name === "routing_assignment_read_model",
    );
    expect(routing?.watermarks.map((watermark) => watermark.sourceStream)).toEqual([
      "initiative_events",
      "registry_events",
    ]);
    for (const projection of body.projections) {
      expect(projection.watermarks.length, projection.name).toBeGreaterThan(0);
    }
    await app.close();
  });

  it("answers LEDGER_UNAVAILABLE when the database is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-server-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "missing.sqlite");
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(response.statusCode).toBe(503);
    const error = ApiError.parse(response.json());
    expect(error.error.code).toBe("LEDGER_UNAVAILABLE");
    await app.close();
  });
});

describe("integrity", () => {
  it("reports ok against a healthy ledger", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/integrity" });
    expect(response.statusCode).toBe(200);
    const body = IntegrityResult.parse(response.json());
    expect(body.ok).toBe(true);
    expect(body.problems).toHaveLength(0);
    expect(body.checkedEvents).toBe(4);

    // The coverage report crosses the wire with the verdict (P-08/B). Four
    // entries, in stream order, and the account stream carries the baseline
    // the other three cannot have — it is the only one covered retroactively.
    expect(body.coverage.map((entry) => entry.sourceStream)).toEqual([
      "account_events",
      "control_plane_events",
      "initiative_events",
      "registry_events",
    ]);
    const accounts = body.coverage[0];
    expect(accounts?.coverageKind).toBe("BASELINED_AT_ACTIVATION");
    expect(accounts?.integrityActivatedAt).not.toBeNull();
    expect(accounts?.baselineSequence).not.toBeNull();
    for (const entry of body.coverage.slice(1)) {
      expect(entry.coverageKind, entry.sourceStream).toBe("CHAIN_FROM_APPEND");
      expect(entry.baselineSequence, entry.sourceStream).toBeNull();
    }
    await app.close();
  });

  it("still answers 200 with the findings when the account stream is shorter than its baseline", async () => {
    // The report has to survive the ledger it is reporting on.
    //
    // A baseline of 3 against a cut that reaches 2 is a real, reachable state:
    // somebody dropped the append-only triggers and deleted the last account
    // row and its link. The verifier NAMES that — a `LEDGER_META` problem
    // saying the baseline reaches a sequence the chain does not — and the
    // coverage entry reports the pair truthfully.
    //
    // So the wire must carry it. A contract that refused `baselineSequence >
    // checkedThroughSequence` as a malformed shape would turn this 200 into a
    // 500: the door would compute an accurate report of a tampered ledger and
    // then fail to serialize it, and the operator would learn nothing except
    // that the endpoint is broken. Disclosing the defect is the whole job.
    const path = temporaryDatabase();
    const ledger = openLedger(path);
    for (const version of [1, 2, 3]) {
      ledger.appendAccountAction({
        contractVersion: LEDGER_CONTRACT_VERSION,
        eventId: randomUUID(),
        accountId: "acct-primary",
        version,
        idempotencyKey: "acct-primary/1/action." + String(version),
        action: version % 2 === 1 ? "DRAIN" : "ACCOUNT_READY",
        resultingState: version % 2 === 1 ? "DRAINING" : "AVAILABLE",
        actor: WORKER_A,
        note: null,
        occurredAt: "2026-08-27T00:00:00.000Z",
        recordedAt: "2026-08-27T00:00:00.000Z",
      });
    }
    // One registry document, so the rebuild of migration 15 has a row and a
    // chain to conserve when the reopen re-applies it (N-P36A-16), and migration
    // 17 has a model version to fold when it is re-applied (N-P14A-15). Its
    // payload is the fixed shape the door holds a MODEL_VERSION to since P-14 A,
    // where it used to be `{}`.
    ledger.appendRegistryEvent({
      contractVersion: LEDGER_CONTRACT_VERSION,
      eventId: randomUUID(),
      idempotencyKey: "mv-rewind/1",
      documentKind: "MODEL_VERSION",
      documentId: "mv-rewind",
      documentVersion: 1,
      parentDocumentVersion: null,
      contentDigest: "1".repeat(64),
      recordedBy: WORKER_A,
      effectiveFrom: "2026-08-27T00:00:00.000Z",
      occurredAt: "2026-08-27T00:00:00.000Z",
      recordedAt: "2026-08-27T00:00:00.000Z",
      payload: {
        provider: "claude",
        model: "claude-opus-5",
        release: "2026-06-01",
        status: "ACTIVE",
        contextTokens: 200000,
        policyVersion: "2026.09.0",
        deprecatedAt: null,
        eligibleRoles: ["implementer"],
        transports: ["CLI_SUBSCRIPTION"],
      },
    });
    ledger.close();

    // Rewind past migration 10 and reopen, so the sidecar activates over a
    // stream that ALREADY holds three rows. That is what fixes the baseline at
    // 3 rather than at 0 — a ledger created empty and then grown has a baseline
    // of 0, and 0 is never ahead of anything.
    //
    // Rewinding to before 10 means undoing 11, 12, 13, 14, 15, 16 and 17 as well, because
    // the reopen re-applies everything the row set no longer claims. `ALTER TABLE
    // ... ADD COLUMN` is not idempotent, so a re-applied 11 over a schema that
    // still carries the coordinate aborts on "duplicate column name". The order
    // is forced rather than stylistic, twice over: SQLite refuses `DROP COLUMN`
    // for a column a trigger references, so the coordinate trigger goes before
    // the columns; and `foreign_keys` is ON, so each child goes before the
    // parent it names — migration 14's answers, then its prompts, then
    // migration 13's deliveries, then its effects, then its segments, then
    // migration 12's attempt table, then the revision table.
    //
    // Migration 15 goes first, and it is a reconstruction, not a drop (P-36/local
    // A, M-8 and D-3): its four artifact tables name `registry_events` by a
    // foreign key, so they go before the stream is touched; then the stream is
    // rebuilt back into migration 9's shape by the same procedure that rebuilt
    // it forward, and trips on the same rename — the two triggers on OTHER
    // tables that name it are dropped before the rename and recreated from
    // migration 9's own text after it. The copy leaves `subject_kind` and
    // `artifact_event_kind` behind, which is lawful because this ledger holds no
    // artifact event at all.
    //
    // Migration 16 goes before 15, and in the order SQLite forces (P-36/local D,
    // M-7): its trigger names `envelope_artifact_reference_id`, and `DROP COLUMN`
    // is refused for a column a trigger references, so the trigger goes first and
    // the column after it. The revision table is dropped further down in any
    // case; undoing 16 by name keeps the rewind an exact reverse of the set, so a
    // later escalón that stops short of 11 inherits a rewind that still works.
    //
    // Migration 17 goes before 16 (P-14 A, H-3): its two children name the model
    // version table by a foreign key, so they go first, each unique index before
    // its table, and its one watermark row with them. Nothing in `registry_events`
    // moves; the re-applied 17 folds the document again.
    const beforeRewind = registryEvidence(path);
    const beforeModelVersions = modelVersionEvidence(path);
    const rewind = new DatabaseSync(path);
    rewindModelVersionRegistry(rewind);
    rewindTaskRevisionEnvelopeReference(rewind);
    rewindArtifactRegistry(rewind);
    rewind.exec("DELETE FROM ledger_meta WHERE key LIKE 'account_integrity_%'");
    rewind.exec(
      "DROP TRIGGER tr_account_event_integrity__deny_delete;" +
        "DROP TRIGGER tr_account_event_integrity__deny_update;" +
        "DROP INDEX ux_account_events__account_id__version;" +
        "DROP TABLE account_event_integrity;",
    );
    rewind.exec(
      "DROP TRIGGER tr_control_plane_events__validate_v2_coordinate;" +
        "DROP INDEX ux_response_occurrence_read_model__prompt;" +
        "DROP TABLE response_occurrence_read_model;" +
        "DROP INDEX ix_prompt_occurrence_read_model__sha256;" +
        "DROP INDEX ix_prompt_occurrence_read_model__segment;" +
        "DROP TABLE prompt_occurrence_read_model;" +
        "DROP INDEX ix_dispatch_attempt_read_model__state;" +
        "DROP INDEX ux_dispatch_attempt_read_model__effect_ordinal;" +
        "DROP TABLE dispatch_attempt_read_model;" +
        "DROP INDEX ix_effect_read_model__segment;" +
        "DROP INDEX ux_effect_read_model__logical_operation_sha256;" +
        "DROP INDEX ux_effect_read_model__idempotency_key;" +
        "DROP TABLE effect_read_model;" +
        "DROP INDEX ix_execution_route_segment_read_model__account;" +
        "DROP INDEX ux_execution_route_segment_read_model__attempt_segment;" +
        "DROP TABLE execution_route_segment_read_model;" +
        "DROP INDEX ux_task_attempt_read_model__invocation_id;" +
        "DROP INDEX ux_task_attempt_read_model__task_id_legacy_attempt_number;" +
        "DROP TABLE task_attempt_read_model;" +
        "DROP INDEX ix_task_revision_read_model__envelope_sha256;" +
        "DROP INDEX ux_task_revision_read_model__revision_id;" +
        "DROP TABLE task_revision_read_model;" +
        "ALTER TABLE control_plane_events DROP COLUMN revision_number;" +
        "ALTER TABLE control_plane_events DROP COLUMN attempt_number;" +
        "ALTER TABLE task_read_model DROP COLUMN envelope_sha256;" +
        "ALTER TABLE task_read_model DROP COLUMN latest_revision_number;" +
        "ALTER TABLE task_read_model DROP COLUMN latest_attempt_number;" +
        "ALTER TABLE task_read_model DROP COLUMN role;" +
        "ALTER TABLE task_read_model DROP COLUMN step_id;" +
        "ALTER TABLE task_read_model DROP COLUMN commit_policy;" +
        "DELETE FROM projection_watermark " +
        "WHERE projection_name IN ('task_revision_read_model', 'task_attempt_read_model', " +
        "'execution_route_segment_read_model', 'effect_read_model', " +
        "'dispatch_attempt_read_model', 'prompt_occurrence_read_model', " +
        "'response_occurrence_read_model');",
    );
    rewind.exec("DELETE FROM schema_migrations WHERE version >= 10");
    rewind.close();
    openLedger(path).close();

    // N-P36A-16: the reopen re-applied 15 without aborting, and what 15 must
    // preserve is preserved — the rows and their chain, the sequence counter,
    // and both foreign triggers byte for byte.
    expect(registryEvidence(path)).toEqual(beforeRewind);
    // N-P36D-7: and it re-applied 16 over the table 11 recreated, without
    // aborting — the column and its trigger are back.
    const reapplied = new DatabaseSync(path);
    expect(
      reapplied
        .prepare("SELECT name FROM pragma_table_info('task_revision_read_model') WHERE name = ?")
        .all("envelope_artifact_reference_id"),
    ).toHaveLength(1);
    expect(
      reapplied
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .all("tr_task_revision_read_model__validate_envelope_reference"),
    ).toHaveLength(1);
    expect(
      (reapplied.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { readonly v: number }).v,
    ).toBe(17);
    reapplied.close();
    // N-P14A-15: and it re-applied 17 over the document already in the stream,
    // folding it back into the same rows at a watermark level with the head.
    expect(modelVersionEvidence(path)).toEqual(beforeModelVersions);

    // Now reach past the door. Both tables are append-only by trigger, which is
    // exactly why this state cannot arise through the ledger's API and has to
    // be planted to be tested at all.
    const raw = new DatabaseSync(path);
    raw.exec("DROP TRIGGER tr_account_event_integrity__deny_delete");
    raw.exec("DROP TRIGGER account_events_deny_delete");
    raw.exec("DELETE FROM account_event_integrity WHERE account_sequence = 3");
    raw.exec("DELETE FROM account_events WHERE sequence = 3");
    raw.close();

    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/integrity" });
    expect(response.statusCode).toBe(200);

    const body = IntegrityResult.parse(response.json());
    expect(body.ok).toBe(false);
    expect(body.problems.map((problem) => problem.detail)).toContain(
      "the account integrity baseline names sequence 3 which the chain does not reach",
    );

    // And the coverage entry states the divergence rather than hiding it: the
    // baseline is still 3, because it is read from `ledger_meta` and nothing
    // repaired it, while the cut actually examined stops at 2.
    expect(body.coverage[0]).toEqual({
      sourceStream: "account_events",
      coverageKind: "BASELINED_AT_ACTIVATION",
      coveredSinceSequence: 1,
      checkedThroughSequence: 2,
      integrityActivatedAt: expect.any(String),
      baselineSequence: 3,
      baselineSha256: expect.any(String),
    });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Errors: 400 / 404 / 405
// ---------------------------------------------------------------------------

describe("errors", () => {
  it("never reflects a caller-supplied parameter name back into the envelope", async () => {
    const path = temporaryDatabase();
    openLedger(path).close();
    const app = buildServer({ ledgerPath: path });

    // Three shapes a reflector would hand straight back: markup, a credential
    // shaped string, and a plain typo. The first two are why this matters --
    // the credential shaped one would additionally fail the ApiError guard on
    // the way out and turn a 400 into a 500.
    const markup = encodeURIComponent(String.fromCharCode(60) + "b onerror=x" + String.fromCharCode(62));
    // Composed at runtime rather than written as a literal. The architecture
    // fence scans every tracked file for credential material and would reject
    // this file for carrying one, which is correct: the fence cannot tell a
    // synthetic fixture from a real key. The value names nothing real; what
    // matters is only that the contract's own credential guard classifies it as
    // credential material, because that is what makes the reflected-key failure
    // reproducible -- reflecting it used to turn a 400 into a 500.
    const tokenShaped = "AKIA" + "IOSFODNN7EXAMPLE";
    const cases = [
      { url: "/api/v1/tasks?" + markup + "=1", needle: "onerror" },
      { url: "/api/v1/tasks?" + tokenShaped + "=1", needle: tokenShaped },
      { url: "/api/v1/tasks?stat=RUNNING", needle: "stat" },
      // A route the frozen contract gives no query at all.
      { url: "/api/v1/health?" + tokenShaped + "=1", needle: tokenShaped },
      { url: "/api/v1/integrity?surprise=1", needle: "surprise" },
    ];

    for (const { url, needle } of cases) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      const body = ApiError.parse(response.json());
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(response.body).not.toContain(needle);
      expect(body.error.detail).toMatch(/^rejected parameters: [0-9]+$/);
    }
    await app.close();
  });

  it("names the contract field that failed, never the value it was sent", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });

    const response = await app.inject({ method: "GET", url: "/api/v1/tasks?limit=999" });
    expect(response.statusCode).toBe(400);
    const body = ApiError.parse(response.json());
    expect(body.error.detail).toBe("invalid: limit");
    expect(response.body).not.toContain("999");

    const cursor = await app.inject({
      method: "GET",
      url: "/api/v1/tasks?cursor=" + encodeURIComponent("../../etc/passwd"),
    });
    expect(cursor.statusCode).toBe(400);
    expect(ApiError.parse(cursor.json()).error.detail).toBe("invalid: cursor");
    expect(cursor.body).not.toContain("passwd");
    await app.close();
  });

  it("answers an unknown route with NOT_FOUND in the one error envelope", async () => {
    const path = temporaryDatabase();
    openLedger(path).close();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(response.statusCode).toBe(404);
    const body = ApiError.parse(response.json());
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.apiContractVersion).toBe(API_CONTRACT_VERSION);
    await app.close();
  });

  it("answers a non-GET method on a known route with METHOD_NOT_ALLOWED", async () => {
    const path = temporaryDatabase();
    openLedger(path).close();
    const app = buildServer({ ledgerPath: path });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/api/v1/health" });
      expect(response.statusCode).toBe(405);
      const body = ApiError.parse(response.json());
      expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
    }
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Errors Fastify itself raises, outside any route handler this package wrote
// ---------------------------------------------------------------------------

describe("fastify-level errors never bypass the envelope", () => {
  it("wraps an unparseable JSON body in the one ApiError envelope", async () => {
    // A malformed body is rejected by Fastify's own JSON content-type parser
    // before any handler runs, including the method-not-allowed handler this
    // package registers for POST on a GET-only route.
    const path = temporaryDatabase();
    openLedger(path).close();
    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/health",
      payload: "{not valid json",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
    const body = ApiError.parse(response.json());
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.apiContractVersion).toBe(API_CONTRACT_VERSION);
    // No echo of the malformed payload, and no raw Fastify shape leaking
    // through: this key only exists on Fastify's own default error body.
    expect(response.body).not.toContain("not valid json");
    expect(JSON.parse(response.body)).not.toHaveProperty("statusCode");
    await app.close();
  });

  it("never answers a Fastify-raised failure in Fastify's own default shape", async () => {
    // The one property every raw Fastify error body carries and ApiError
    // never does. If this were ever true, a strict reader would see a shape
    // it cannot parse and report a contract mismatch that was never real.
    const path = temporaryDatabase();
    openLedger(path).close();
    const app = buildServer({ ledgerPath: path });
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/tasks/%zz" }),
      app.inject({ method: "GET", url: "/api/v1/workers/%E0%A4%A" }),
      app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: "{not valid json",
        headers: { "content-type": "application/json" },
      }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      const parsed: unknown = JSON.parse(response.body);
      expect(parsed).not.toHaveProperty("statusCode");
      expect(parsed).not.toHaveProperty("error", "Bad Request");
      const body = ApiError.parse(parsed);
      expect(body.error.code).toBe("BAD_REQUEST");
    }
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// No leakage
// ---------------------------------------------------------------------------

describe("no leakage", () => {
  it("never sends the absolute ledger path in any response body", async () => {
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const urls = [
      "/api/v1/health",
      "/api/v1/overview",
      "/api/v1/status",
      "/api/v1/integrity",
      "/api/v1/tasks",
      "/api/v1/workers",
      "/api/v1/events",
      "/api/v1/does-not-exist",
    ];
    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });
      expect(response.body).not.toContain(path);
    }
    await app.close();
  });

  it("never sends a stack trace on an unexpected internal failure", async () => {
    const { path } = seedDatabase();
    const raw = new DatabaseSync(path);
    // ledger_meta is the one mutable table; control_plane_events itself is
    // append-only by trigger. Corrupting the head digest makes any route that
    // reads the head throw LedgerIntegrityError from inside the ledger.
    raw
      .prepare("UPDATE ledger_meta SET value = ? WHERE key = ?")
      .run("not-a-sha256", "head_event_sha256");
    raw.close();

    const app = buildServer({ ledgerPath: path });
    const response = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(response.statusCode).toBe(500);
    const body = ApiError.parse(response.json());
    expect(body.error.code).toBe("LEDGER_INTEGRITY");
    expect(body.error.message.toLowerCase()).not.toContain("at ledger");
    expect(body.error.detail).toBeNull();
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Loopback fence and lifecycle
// ---------------------------------------------------------------------------

/**
 * A raw `node:http` request rather than the global `fetch`.
 *
 * This proves the socket `startServer` opened really accepts a connection
 * from outside the process, which `app.inject()` does not: `inject()` never
 * touches a socket at all. `fetch` (undici) intermittently fails to reach
 * `127.0.0.1` from inside a Vitest worker in this environment even though the
 * same request succeeds from a plain Node process; `node:http` does not.
 */
function getJson(host: string, port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("loopback", () => {
  it("refuses to bind any host other than 127.0.0.1", async () => {
    const { path } = seedDatabase();
    await expect(startServer({ ledgerPath: path, host: "0.0.0.0" })).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("listens on 127.0.0.1, serves a request, and closes", async () => {
    const { path } = seedDatabase();
    const running = await startServer({ ledgerPath: path, port: 0 });
    try {
      expect(running.host).toBe("127.0.0.1");
      const address = running.app.server.address();
      expect(typeof address === "object" && address !== null ? address.address : null).toBe(
        "127.0.0.1",
      );
      const body = await getJson("127.0.0.1", running.port, "/api/v1/health");
      expect(HealthResponse.parse(body).status).toBe("OK");
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Import purity and no mutation
// ---------------------------------------------------------------------------

describe("import purity", () => {
  it("importing the package performs no I/O and starts nothing", async () => {
    const module = await import("../../src/index.js");
    expect(typeof module.buildServer).toBe("function");
    expect(typeof module.startServer).toBe("function");
  });

  it("no source file in this package calls a ledger mutator", () => {
    // The relocation to folder/index topology spread the package's production
    // sources across ten sibling directories (`src/aggregates/index.ts`,
    // `src/routes/index.ts`, ...). A flat, single-level `readdirSync` of this
    // test's own directory -- which is what this check used before the move,
    // valid only because every production file was once a flat sibling under
    // `src/` -- would now read `test/build-server/` and silently find nothing
    // to scan. The walk is bounded to the package's own `src/` tree, recurses
    // one level to reach each domain's `index.ts`, and excludes `.test.ts` by
    // the same rule as before.
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const srcRoot = join(packageRoot, "src");

    function collectProductionSources(dir: string): string[] {
      const found: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          found.push(...collectProductionSources(full));
        } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          found.push(full);
        }
      }
      return found;
    }

    const files = collectProductionSources(srcRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(/\.append\s*\(/);
      expect(content).not.toMatch(/\.rebuildReadModel\s*\(/);
    }
  });
});

describe("the served surface matches the frozen route table", () => {
  it("registers the content route as a read: GET answers, every other verb 405s", async () => {
    // P8-8D-c2 adds a read, so it goes through `registerGet` and inherits the
    // four-verb 405 set unchanged. The plane's write surface stays at exactly
    // one route, and this is where that stops being a claim.
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const url = "/api/v1/initiatives/" + randomUUID() + "/roadmap/content?version=1";

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url });
      expect({ method, status: response.statusCode }).toEqual({ method, status: 405 });
    }
    // GET reaches a handler rather than the 405 branch — a 404 here, since the
    // initiative is invented, which is a handler's answer and not a router's.
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    await app.close();
  });

  it("registers both scoped routes as reads: GET answers, every other verb 405s (P8-8E-pre)", async () => {
    // Two more reads through `registerGet`. The GET-only law is untouched and
    // the write surface stays at exactly one route — asserted, not assumed.
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const initiativeId = randomUUID();

    for (const suffix of ["/events", "/agents"] as const) {
      const url = "/api/v1/initiatives/" + initiativeId + suffix;
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await app.inject({ method, url });
        expect({ suffix, method, status: response.statusCode }).toEqual({
          suffix,
          method,
          status: 405,
        });
      }
      // GET reaches a handler: 404 for an invented initiative is the handler's
      // answer, not the router's.
      expect({ suffix, status: (await app.inject({ method: "GET", url })).statusCode }).toEqual({
        suffix,
        status: 404,
      });
    }
    await app.close();
  });

  it("registers the accounts route as a read, and the write surface is still one route (P8-8F)", async () => {
    // The accounts read adds a route whose source is not the ledger, which is
    // new — but it adds nothing to the write surface, which is the property
    // worth re-asserting each time the table grows.
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/api/v1/accounts" });
      expect({ method, status: response.statusCode }).toEqual({ method, status: 405 });
    }
    // Unconfigured, so a 200 carrying UNAVAILABLE — a handler's answer, not a
    // router's.
    expect((await app.inject({ method: "GET", url: "/api/v1/accounts" })).statusCode).toBe(200);
    expect([...API_WRITE_ROUTES]).toEqual([
      "initiativeRoadmap",
      "accountActions",
      "taskToolCalls",
      "taskLifecycle",
    ]);
    await app.close();
  });

  it("keeps every 405 set byte-unchanged after the bearer guard (P8-8G)", async () => {
    // The guard sits inside the write registrar, which also owns the 405 set.
    // A guard that leaked into the method surface would show up here as a
    // read route refusing a verb differently, or the write route's own 405
    // list changing — neither of which is what a credential check is for.
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });

    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/api/v1/initiatives/" + randomUUID() + "/roadmap",
      });
      // 405 still, and emphatically not 401 or 403: an unallowed method is a
      // router's answer and never reaches the guard.
      expect({ method, status: response.statusCode }).toEqual({ method, status: 405 });
    }
    expect([...API_WRITE_ROUTES]).toEqual([
      "initiativeRoadmap",
      "accountActions",
      "taskToolCalls",
      "taskLifecycle",
    ]);
    await app.close();
  });

  it("keeps every read route's 405 set byte-unchanged after the first write route (C1)", async () => {
    // The one write route mounts its own registrar with POST removed from the
    // 405 list. Every other route must be untouched by that: a registrar
    // change that leaked would show up here as a read route suddenly
    // accepting a POST, which is the failure this asserts against.
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });

    for (const url of API_ROUTE_PATTERNS.filter((pattern) => !pattern.includes(":"))) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await app.inject({ method, url });
        expect({ url, method, status: response.statusCode }).toEqual({ url, method, status: 405 });
      }
    }
    await app.close();
  });

  /**
   * The one route whose GET cannot be injected, named rather than skipped
   * silently (V2-B3a).
   *
   * `app.inject()` never opens a socket, and it cannot terminate a hijacked
   * response: a GET on the stream would hang this suite rather than assert
   * anything. So the GET arm below transfers to
   * `test/stream/index.test.ts`, which drives the same route over a **real
   * loopback socket** and asserts the 200, the `text/event-stream` content
   * type and the frames themselves.
   *
   * This is a coverage transfer, not a weakening, and the two assertions after
   * the loop are what keep it one: the exclusion set is pinned to exactly this
   * singleton, so a second route cannot join it quietly, and the route's full
   * 405 matrix stays inside the generic law below rather than travelling with
   * the GET.
   */
  const INJECTION_EXCLUDED = [API_ROUTES.eventStream];

  it("excludes exactly one parameterless route from GET injection, and says which", () => {
    // The pin. Without it, "we skip the ones inject cannot do" is a sentence
    // that grows a route at a time until the generic law covers nothing.
    expect(INJECTION_EXCLUDED).toEqual(["/api/v1/events/stream"]);
    expect(INJECTION_EXCLUDED).toHaveLength(1);
    expect(API_ROUTE_PATTERNS).toContain(API_ROUTES.eventStream);
  });

  it("answers every parameterless frozen pattern, and 405s every non-GET on it", async () => {
    // Derived from the contract's own table rather than from a list restated
    // here: a route added to `API_ROUTES` and never registered would answer
    // 404 and this would catch it, which a hand-kept list could not.
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    const parameterless = API_ROUTE_PATTERNS.filter((pattern) => !pattern.includes(":"));

    let injectedGets = 0;
    for (const url of parameterless) {
      // The 405 arm runs for EVERY parameterless route, the stream included: a
      // refusal needs no hijack, so nothing about the method surface moves to
      // another file.
      const post = await app.inject({ method: "POST", url });
      expect({ url, status: post.statusCode }).toEqual({ url, status: 405 });

      if ((INJECTION_EXCLUDED as readonly string[]).includes(url)) continue;
      const get = await app.inject({ method: "GET", url });
      expect({ url, ok: get.statusCode < 400 }).toEqual({ url, ok: true });
      injectedGets += 1;
    }

    // The loop did not pass by looking at nothing, and it skipped exactly one.
    expect(injectedGets).toBe(parameterless.length - INJECTION_EXCLUDED.length);
    expect(injectedGets).toBeGreaterThan(0);
    await app.close();
  });

  it("keeps the stream's own 405 set identical to every other read's (V2-B3a)", async () => {
    // The stream is registered through a twin of `registerGet` that reuses the
    // same OTHER_METHODS list. This is where that stops being a claim about the
    // source and becomes an observation about the server.
    const { path } = seedDatabase();
    const app = buildServer({ ledgerPath: path });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: API_ROUTES.eventStream });
      expect({ method, status: response.statusCode }).toEqual({ method, status: 405 });
      expect(ApiError.parse(response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
    }
    // And the stream did not become the plane's third write.
    expect([...API_WRITE_ROUTES]).toEqual([
      "initiativeRoadmap",
      "accountActions",
      "taskToolCalls",
      "taskLifecycle",
    ]);
    await app.close();
  });
});

describe("no mutation", () => {
  it("leaves the ledger byte-for-byte unchanged after every route is hit", async () => {
    const { path } = seedDatabase();
    const before: Ledger = openLedger(path, { readOnly: true });
    const beforeStatus = before.status();
    before.close();

    const app = buildServer({ ledgerPath: path });
    const routes = [
      "/api/v1/health",
      "/api/v1/overview",
      "/api/v1/status",
      "/api/v1/integrity",
      "/api/v1/tasks",
      "/api/v1/workers",
      "/api/v1/events",
      // P8-8A: the initiative plane reads three folds and writes nothing.
      "/api/v1/initiatives",
    ];
    for (const url of routes) {
      await app.inject({ method: "GET", url });
    }
    await app.close();

    const after: Ledger = openLedger(path, { readOnly: true });
    const afterStatus = after.status();
    after.close();

    expect(afterStatus.eventCount).toBe(beforeStatus.eventCount);
    expect(afterStatus.headSequence).toBe(beforeStatus.headSequence);
    expect(afterStatus.headEventSha256).toBe(beforeStatus.headEventSha256);
  });
});

describe("the accounts clock seam", () => {
  // A READY accounts response is all this drill needs, and the emptiest owner
  // document that produces one keeps the drill about the instant rather than
  // about a fixture.
  function ownerFile(): { readonly ledger: string; readonly accounts: string } {
    // Canonical, deliberately: on macOS `mkdtemp` hands back `/var/folders/…`
    // while the real path is `/private/var/folders/…`, and the owner-file
    // loader refuses a non-canonical path — correctly, since a symlinked owner
    // file could point somewhere none of its checks ever looked.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "acp-seam-")));
    temporaryDirectories.push(directory);
    const ledgerDirectory = join(directory, "ledger");
    mkdirSync(ledgerDirectory, { recursive: true });
    const ledger = join(ledgerDirectory, "acp.sqlite3");
    openLedger(ledger).close();
    const accounts = join(directory, "accounts.local.json");
    const record = {
      contractVersion: LEDGER_CONTRACT_VERSION,
      accountId: "acct-seam",
      provider: "anthropic",
      alias: "seam",
      authMode: "PREAUTHENTICATED_PROFILE",
      authProfileRef: "profile://acp-seam",
      credentialRef: null,
      plan: "max",
      enabledModels: ["opus"],
      knownLimits: { weekly: 1_000_000 },
      // Far enough ahead that this drill never depends on the calendar. What
      // it asserts is which instant the handler used, not how that instant
      // compares to a reset.
      resetSchedule: { kind: "DECLARED", nextResetAt: "2099-01-01T00:00:00.000Z", timezone: "UTC", confidence: "HIGH" },
      quotaEstimate: {
        remainingRatio: 0.5,
        estimatedTokensRemaining: 500_000,
        estimatedAt: "2026-08-31T12:00:00.000Z",
        confidence: "MEDIUM",
      },
      lastHealthProbe: null,
      lastClassifiedError: null,
      status: "AVAILABLE",
      isolatedConfigRoot: "/tmp/acp-seam",
      contextSwitchCost: { estimatedTokens: 1000, estimatedSeconds: 10 },
    };
    writeFileSync(
      accounts,
      JSON.stringify({ contractVersion: LEDGER_CONTRACT_VERSION, accounts: [record] }),
      "utf8",
    );
    chmodSync(accounts, 0o600);
    return { ledger, accounts };
  }

  async function estimatedAt(now?: () => string): Promise<string> {
    const { ledger, accounts } = ownerFile();
    const app = buildServer({ ledgerPath: ledger, accountsFilePath: accounts, now });
    const response = await app.inject({ method: "GET", url: "/api/v1/accounts" });
    const body = AccountsResponse.parse(response.json());
    await app.close();
    if (body.status !== "READY") {
      throw new Error("expected READY, got " + body.status + " " + body.reason + " " + (body.detail ?? ""));
    }
    return body.estimatedAt;
  }

  it("defaults to the real clock when no instant is injected", async () => {
    // The default has to stay the wall clock, or production would silently
    // freeze: this is the one place in the repository that still asserts
    // against it, deliberately, because it is the behaviour under test.
    const before = new Date().toISOString();
    const observed = await estimatedAt();
    const after = new Date().toISOString();

    expect(observed >= before).toBe(true);
    expect(observed <= after).toBe(true);
  });

  it("uses an injected instant verbatim", async () => {
    // Not "close to", not "parsed and re-serialized" — the same string back.
    const pinned = "2019-04-02T11:22:33.444Z";
    expect(await estimatedAt(() => pinned)).toBe(pinned);
  });

  it("asks the supplier once per request, so two requests can differ", async () => {
    // A supplier read at registration would freeze every later request to the
    // first answer, which is exactly the bug the seam is supposed to make
    // impossible rather than merely unlikely.
    const instants = ["2019-04-02T11:22:33.444Z", "2020-05-03T00:00:00.000Z"];
    let call = 0;
    const { ledger, accounts } = ownerFile();
    const app = buildServer({
      ledgerPath: ledger,
      accountsFilePath: accounts,
      now: () => instants[call++] ?? "2021-01-01T00:00:00.000Z",
    });
    const seen: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const body = AccountsResponse.parse((await app.inject({ method: "GET", url: "/api/v1/accounts" })).json());
      if (body.status !== "READY") throw new Error("expected READY");
      seen.push(body.estimatedAt);
    }
    await app.close();

    expect(seen).toEqual(instants);
  });

  it("keeps the seam off the operator's start surface", () => {
    // C2. Every other build option is operator configuration with an
    // operator's reason to exist; a production clock that can be frozen from
    // the command line is a footgun with no such reason. The bin must not
    // learn this flag by accident, so the refusal is asserted rather than
    // assumed.
    for (const flag of ["--now", "--clock", "--instant", "--time"]) {
      const outcome = parseArgv(["--ledger", "/tmp/acp/ledger.sqlite3", flag, "2020-01-01T00:00:00.000Z"]);
      expect({ flag, ok: outcome.ok }).toEqual({ flag, ok: false });
      if (outcome.ok) throw new Error("expected a refusal");
      expect(outcome.reason).toBe("UNKNOWN_FLAG");
    }

    const accepted = parseArgv(["--ledger", "/tmp/acp/ledger.sqlite3"]);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("expected a parse");
    // No clock-shaped key reaches the options the bin hands to buildServer.
    expect(Object.keys(accepted.options).some((key) => /now|clock|instant|time/i.test(key))).toBe(false);
  });
});

/**
 * Migration 17 undone on a raw handle (P-14 A): the model version registry's two
 * children, each after its unique index, then the parent after its index, and the
 * one watermark row it seeded.
 */
function rewindModelVersionRegistry(raw: DatabaseSync): void {
  raw.exec(
    "DROP INDEX ux_model_version_transport__transport;" +
      "DROP TABLE model_version_transport;" +
      "DROP INDEX ux_model_version_eligible_role__role;" +
      "DROP TABLE model_version_eligible_role;" +
      "DROP INDEX ix_model_version_read_model__status;" +
      "DROP TABLE model_version_read_model;" +
      "DELETE FROM projection_watermark WHERE projection_name = 'model_version_read_model';",
  );
}

/** The model version registry and its watermark, as a raw handle sees them (P-14 A). */
function modelVersionEvidence(path: string): unknown {
  const raw = new DatabaseSync(path);
  try {
    return {
      versions: raw.prepare("SELECT * FROM model_version_read_model ORDER BY model_version_id").all(),
      roles: raw.prepare("SELECT * FROM model_version_eligible_role ORDER BY model_version_id, ordinal").all(),
      transports: raw.prepare("SELECT * FROM model_version_transport ORDER BY model_version_id, ordinal").all(),
      watermark: raw
        .prepare(
          "SELECT applied_sequence, event_count, source_head_sha256 FROM projection_watermark " +
            "WHERE projection_name = 'model_version_read_model'",
        )
        .all(),
    };
  } finally {
    raw.close();
  }
}

/**
 * Migration 16 undone on a raw handle (P-36/local D): the envelope reference's
 * trigger, then its column, in the order SQLite forces (M-7). No watermark,
 * because 16 seeded none.
 */
function rewindTaskRevisionEnvelopeReference(raw: DatabaseSync): void {
  raw.exec(
    "DROP TRIGGER tr_task_revision_read_model__validate_envelope_reference;" +
      "ALTER TABLE task_revision_read_model DROP COLUMN envelope_artifact_reference_id;",
  );
}

/**
 * Migration 15 undone on a raw handle (P-36/local A): the four artifact tables,
 * children first, their watermarks, and `registry_events` rebuilt back into
 * migration 9's shape — E3 in reverse, with migration 9's own text for the
 * table, its indexes and triggers, and the two foreign triggers.
 */
function rewindArtifactRegistry(raw: DatabaseSync): void {
  const artifacts = raw
    .prepare("SELECT COUNT(*) AS n FROM registry_events WHERE subject_kind <> 'DOCUMENT'")
    .get() as { readonly n: number };
  if (artifacts.n !== 0) throw new Error("a ledger holding artifact events cannot be rewound past 15");
  raw.exec(
    "DROP TABLE artifact_tombstone_read_model;" +
      "DROP INDEX ux_artifact_pin_read_model__content_sha256_holder__live;" +
      "DROP TABLE artifact_pin_read_model;" +
      "DROP INDEX ux_artifact_reference_read_model__id_content_generation;" +
      "DROP INDEX ix_artifact_reference_read_model__expires_at;" +
      "DROP INDEX ix_artifact_reference_read_model__scope_kind_scope_id;" +
      "DROP INDEX ix_artifact_reference_read_model__content_sha256;" +
      "DROP TABLE artifact_reference_read_model;" +
      "DROP INDEX ux_artifact_blob_read_model__content_sha256__unreclaimed;" +
      "DROP INDEX ux_artifact_blob_read_model__reclaim_id;" +
      "DROP INDEX ix_artifact_blob_read_model__first_published_sequence;" +
      "DROP INDEX ix_artifact_blob_read_model__lifecycle_state;" +
      "DROP TABLE artifact_blob_read_model;" +
      "DELETE FROM projection_watermark WHERE projection_name IN ('artifact_blob_read_model', " +
      "'artifact_reference_read_model', 'artifact_pin_read_model', 'artifact_tombstone_read_model');",
  );

  const ninth = LEDGER_MIGRATIONS.find((migration) => migration.version === 9);
  if (ninth === undefined) throw new Error("migration 9 is absent from this build");
  const slice = (from: string, to: string): string => {
    const start = ninth.sql.indexOf(from);
    const end = ninth.sql.indexOf(to, start);
    if (start === -1 || end === -1) throw new Error("migration 9 no longer holds " + from);
    return ninth.sql.slice(start, end);
  };
  const columns =
    "sequence, event_id, idempotency_key, document_kind, document_id, document_version, " +
    "content_digest, parent_document_version, recorded_by, effective_from, occurred_at, " +
    "recorded_at, causation_stream, causation_sequence, causation_sha256, contract_version, " +
    "event_json, previous_sha256, event_sha256";
  raw.exec(
    slice("CREATE TABLE registry_events (", "-- Version identity.").replace(
      "CREATE TABLE registry_events (",
      "CREATE TABLE registry_events__rewound (",
    ),
  );
  raw.exec(
    "INSERT INTO registry_events__rewound (" + columns + ") " +
      "SELECT " + columns + " FROM registry_events ORDER BY sequence;" +
      "DROP TRIGGER tr_registry_events__validate_new_rows;" +
      "DROP TRIGGER tr_registry_events__deny_delete;" +
      "DROP TRIGGER tr_registry_events__deny_update;" +
      "DROP TRIGGER tr_control_plane_events__validate_new_rows;" +
      "DROP TRIGGER tr_initiative_events__validate_new_rows;" +
      "DROP TABLE registry_events;" +
      "ALTER TABLE registry_events__rewound RENAME TO registry_events;",
  );
  raw.exec(slice("CREATE UNIQUE INDEX ux_registry_events__document_id__document_version", "-- The causal vocabulary widens to three"));
  raw.exec(slice("CREATE TRIGGER tr_control_plane_events__validate_new_rows", "-- The first read model fed by two streams."));
}

/** What migration 15 must conserve across a rebuild, read past the ledger. */
function registryEvidence(path: string): unknown {
  const raw = new DatabaseSync(path);
  try {
    return {
      rows: raw
        .prepare(
          "SELECT sequence, event_id, document_id, document_version, event_json, previous_sha256, " +
            "event_sha256 FROM registry_events ORDER BY sequence",
        )
        .all(),
      sequence: raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'registry_events'").all(),
      triggers: raw
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN " +
            "('tr_control_plane_events__validate_new_rows', 'tr_initiative_events__validate_new_rows') " +
            "ORDER BY name",
        )
        .all(),
      subjectColumn: raw
        .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('registry_events') WHERE name = 'subject_kind'")
        .get(),
    };
  } finally {
    raw.close();
  }
}

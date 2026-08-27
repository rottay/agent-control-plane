import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  API_CONTRACT_VERSION,
  ApiError,
  EventPageResponse,
  HealthResponse,
  IntegrityResult,
  LEDGER_CONTRACT_VERSION,
  LedgerStatusResponse,
  OverviewResponse,
  TaskDetailResponse,
  TaskPageResponse,
  WorkerDetailResponse,
  WorkerPageResponse,
} from "@acp/api-contracts";
import { openLedger, type Ledger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "./build-server.js";
import { startServer } from "./start.js";

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
    contractVersion: "1.0.0",
    eventId: input.eventId ?? randomUUID(),
    taskId,
    attempt,
    transitionId,
    // Mirrors @acp/contracts' buildIdempotencyKey, restated rather than
    // imported: this package's dependency surface is @acp/api-contracts and
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
    expect(body.pragmas.queryOnly).toBe(true);
    expect(body.migrations.length).toBeGreaterThan(0);
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
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Errors: 400 / 404 / 405
// ---------------------------------------------------------------------------

describe("errors", () => {
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
    const module = await import("./index.js");
    expect(typeof module.buildServer).toBe("function");
    expect(typeof module.startServer).toBe("function");
  });

  it("no source file in this package calls a ledger mutator", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(directory).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    for (const name of files) {
      const content = readFileSync(join(directory, name), "utf8");
      expect(content).not.toMatch(/\.append\s*\(/);
      expect(content).not.toMatch(/\.rebuildReadModel\s*\(/);
    }
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

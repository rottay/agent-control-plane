import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  API_ROUTES,
  DEFAULT_PAGE_LIMIT,
  EventPageResponse,
  HealthResponse,
  IntegrityResult,
  LEDGER_CONTRACT_VERSION,
  LedgerStatusResponse,
  OverviewResponse,
  PARITY_ROUTES,
  TaskDetailResponse,
  TaskPageResponse,
  WorkerDetailResponse,
  WorkerPageResponse,
  bindingCoversAllRoutes,
  canonicalRows,
  canonicalize,
  comparableFields,
  declaredExceptions,
  hasObservationPrivacyViolation,
} from "@acp/api-contracts";
import type { ApiRouteName } from "@acp/api-contracts";
import { openLedger } from "@acp/ledger";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildEventPage,
  buildIntegrity,
  buildOverview,
  buildStatus,
  buildTaskDetail,
  buildTaskPage,
  buildWorkerDetail,
  buildWorkerPage,
  cliRowModel,
  databaseIdentity,
} from "@acp/cli/observation-rows";
import { uiRowModel } from "@acp/ui/row-model";

import { buildServer } from "../../src/build-server/index.js";

/**
 * The three-way parity proof: ledger, CLI and UI must tell the same story.
 *
 * The CLI builds its rows from the ledger directly; the server answers over
 * HTTP; the UI projects a parsed response. All three converge on one canonical
 * row model defined in `@acp/api-contracts`, so this file compares row models
 * rather than scraping rendered output — which is what makes "exactly" a
 * checkable word.
 *
 * The CLI and UI modules arrive through the P3A deep aliases, which resolve
 * only in this project and only for this file. Neither package's entry point
 * was widened for a test.
 */

const temporaries: string[] = [];

afterEach(() => {
  while (temporaries.length > 0) {
    const directory = temporaries.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "acp-parity-"));
  temporaries.push(directory);
  return join(directory, "control-plane.sqlite");
}

interface EventInput {
  readonly taskId: string;
  readonly transitionId: string;
  readonly type: string;
  readonly fromState?: string | null;
  readonly toState: string;
  readonly emittedBy: string;
  readonly occurredAt?: string;
}

/** Fixture timestamps are fixed strings: nothing here reads a clock. */
function makeEvent(input: EventInput): Record<string, unknown> {
  const attempt = 1;
  const occurredAt = input.occurredAt ?? "2026-08-27T12:00:00.000Z";
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId: input.taskId,
    attempt,
    transitionId: input.transitionId,
    idempotencyKey: input.taskId + "/" + String(attempt) + "/" + input.transitionId,
    type: input.type,
    fromState: input.fromState ?? null,
    toState: input.toState,
    emittedBy: input.emittedBy,
    occurredAt,
    recordedAt: occurredAt,
    correlationId: null,
    causationId: null,
    payload: {},
  };
}

const WORKER_A = "anthropic/claude-sonnet-5/implementer/01";
const WORKER_B = "kimi/k3/coordinator/01";

interface Seed {
  readonly path: string;
  readonly taskA: string;
  readonly taskB: string;
}

/** Enough shape for ordering, pagination and detail to mean something. */
function seed(count = 2): Seed {
  const path = temporaryDatabase();
  const ledger = openLedger(path);
  const taskA = randomUUID();
  const taskB = randomUUID();
  const ids = [taskA, taskB];

  for (let index = 0; index < count; index += 1) {
    const taskId = ids[index] ?? randomUUID();
    const minute = String(index).padStart(2, "0");
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "discover",
        type: "TASK_DISCOVERED",
        toState: "DISCOVERED",
        emittedBy: WORKER_B,
        occurredAt: "2026-08-27T12:" + minute + ":00.000Z",
      }),
    );
    ledger.append(
      makeEvent({
        taskId,
        transitionId: "classify",
        type: "TASK_CLASSIFIED",
        fromState: "DISCOVERED",
        toState: "DT_CLASSIFIED",
        emittedBy: index % 2 === 0 ? WORKER_A : WORKER_B,
        occurredAt: "2026-08-27T12:" + minute + ":30.000Z",
      }),
    );
  }
  ledger.close();
  return { path, taskA, taskB };
}

/**
 * A seed whose tasks reach different states.
 *
 * The two-task seed above leaves every task in one state, so `tasks.byState`
 * has a single entry and any ordering difference in it is invisible. Aggregate
 * ordering is part of the parity contract, so it needs more than one bucket to
 * be exercised at all.
 */
function seedDiverse(): Seed {
  const path = temporaryDatabase();
  const ledger = openLedger(path);
  const taskA = randomUUID();
  const taskB = randomUUID();

  ledger.append(
    makeEvent({ taskId: taskA, transitionId: "discover", type: "TASK_DISCOVERED", toState: "DISCOVERED", emittedBy: WORKER_A }),
  );
  ledger.append(
    makeEvent({
      taskId: taskA,
      transitionId: "classify",
      type: "TASK_CLASSIFIED",
      fromState: "DISCOVERED",
      toState: "DT_CLASSIFIED",
      emittedBy: WORKER_A,
      occurredAt: "2026-08-27T12:00:30.000Z",
    }),
  );
  ledger.append(
    makeEvent({
      taskId: taskB,
      transitionId: "discover",
      type: "TASK_DISCOVERED",
      toState: "DISCOVERED",
      emittedBy: WORKER_B,
      occurredAt: "2026-08-27T12:01:00.000Z",
    }),
  );
  ledger.close();
  return { path, taskA, taskB };
}

/** Ask the server for one route and parse the body as a client would. */
async function serverBody(path: string, url: string, schema: { parse(value: unknown): unknown }) {
  const app = buildServer({ ledgerPath: path });
  try {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    return schema.parse(response.json());
  } finally {
    await app.close();
  }
}

/**
 * A fixed clock. Nothing here reads the wall clock, and the fields it feeds are
 * volatile ones the row model strips anyway.
 */
const FIXED_CLOCK = (): string => "2026-08-28T00:00:00.000Z";

/**
 * Build the CLI's answer **from the ledger**, not from the server's answer.
 *
 * This is what makes the equality a proof rather than a tautology. An earlier
 * version of this file fed one server body to all three row models, so the CLI
 * and UI comparisons only ever showed that two adapters call the same function.
 * The CLI has its own independent implementation over the same ledger — a
 * separate package, separate mapping code — and that is the thing parity is
 * supposed to check.
 */
function cliResponses(path: string, taskId: string, identity: string): Record<string, unknown> {
  // Read-only, because that is how the CLI opens a ledger in production
  // (`cli/index.ts` passes `{ readOnly: true }`) and how the server opens it too. An
  // earlier draft opened it read-write and the comparison failed on
  // `readOnly`/`queryOnly` — a difference between this harness and both real
  // clients, not between the clients themselves.
  const ledger = openLedger(path, { readOnly: true });
  try {
    const database = databaseIdentity(path);
    const integrity = ledger.verifyIntegrity();
    return {
      // `integrity: null` is the CLI's `--skip-integrity` mode, and it is the
      // right input here because the server's overview route deliberately does
      // not run an integrity check — it reports `checked: false`. Passing a
      // computed report would compare the CLI's answer to a question the server
      // was never asked. The integrity route below compares the real thing.
      overview: buildOverview({ ledger, database, integrity: null, now: FIXED_CLOCK }),
      tasks: buildTaskPage(ledger, { limit: DEFAULT_PAGE_LIMIT }),
      workers: buildWorkerPage(ledger, { limit: DEFAULT_PAGE_LIMIT }),
      events: buildEventPage(ledger, { limit: DEFAULT_PAGE_LIMIT }),
      status: buildStatus(ledger.status(), database, FIXED_CLOCK),
      integrity: buildIntegrity(integrity, FIXED_CLOCK),
      taskById: buildTaskDetail(ledger, taskId),
      workerByIdentity: buildWorkerDetail(ledger, identity),
    };
  } finally {
    ledger.close();
  }
}

/**
 * The same independence, for a paged query.
 *
 * Pagination is part of the parity law, so the CLI has to answer the *same
 * question* — same limit, same cursor — from the ledger, rather than be handed
 * the server's page. `afterTaskId` is the ledger-level spelling of the `cursor`
 * query parameter the route maps onto it (`routes/index.ts`), which is why the two
 * sides can be asked the same thing in their own vocabularies.
 */
function cliTaskPage(path: string, query: { limit: number; afterTaskId?: string }): unknown {
  const ledger = openLedger(path, { readOnly: true });
  try {
    return buildTaskPage(ledger, query);
  } finally {
    ledger.close();
  }
}

describe("the contract is wired into the running server", () => {
  it("covers every route the server actually serves", () => {
    expect(bindingCoversAllRoutes()).toBe(true);
    expect([...PARITY_ROUTES].sort()).toEqual(Object.keys(API_ROUTES).sort());
  });
});

describe("ledger, CLI and UI agree, route by route", () => {
  const cases: { route: ApiRouteName; url: string; schema: { parse(v: unknown): unknown } }[] = [
    { route: "overview", url: API_ROUTES.overview, schema: OverviewResponse },
    { route: "tasks", url: API_ROUTES.tasks, schema: TaskPageResponse },
    { route: "workers", url: API_ROUTES.workers, schema: WorkerPageResponse },
    { route: "events", url: API_ROUTES.events, schema: EventPageResponse },
    { route: "status", url: API_ROUTES.status, schema: LedgerStatusResponse },
    { route: "integrity", url: API_ROUTES.integrity, schema: IntegrityResult },
  ];

  for (const { route, url, schema } of cases) {
    it("agrees on " + route, async () => {
      const { path, taskA } = seed();

      // Three genuinely independent producers:
      //   ledger -> CLI builders        (its own mapping code, its own package)
      //   ledger -> server handlers     (a separate implementation)
      //   server body -> UI projection  (what the UI actually receives)
      const body = await serverBody(path, url, schema);
      const cliBuilt = cliResponses(path, taskA, WORKER_B)[route];

      const fromServer = canonicalRows(route, body);
      const fromCli = cliRowModel(route, cliBuilt);
      const fromUi = uiRowModel(route, body);

      // The load-bearing assertion: the CLI derived this from the ledger
      // without ever seeing the server's answer.
      expect(fromCli).toEqual(fromServer);
      expect(fromUi).toEqual(fromServer);

      // Every comparable field is actually present in what the clients render.
      const rendered = fromServer as Record<string, unknown>;
      for (const field of comparableFields(route)) {
        expect(Object.hasOwn(rendered, field)).toBe(true);
      }
    });
  }

  it("agrees on aggregate ordering, with more than one bucket", async () => {
    // Ordering is part of the equality, and an aggregate with one bucket cannot
    // show an ordering difference. This exercises both breakdowns.
    const { path, taskA } = seedDiverse();
    const body = await serverBody(path, API_ROUTES.overview, OverviewResponse);
    const cliBuilt = cliResponses(path, taskA, WORKER_B)["overview"];
    expect(cliRowModel("overview", cliBuilt)).toEqual(canonicalRows("overview", body));
  });

  it("treats health as the named non-ledger case", async () => {
    // health has no ledger content, so there is no independent CLI build to
    // compare against. The contract says so explicitly rather than omitting the
    // route, and what is checked here is exactly what the contract claims: the
    // two frozen constants agree, and every other field is a declared
    // exception carrying a reason.
    const { path } = seed();
    const body = (await serverBody(path, API_ROUTES.health, HealthResponse)) as Record<
      string,
      unknown
    >;
    expect(uiRowModel("health", body)).toEqual(canonicalRows("health", body));
    for (const field of comparableFields("health")) {
      expect(Object.hasOwn(body, field)).toBe(true);
    }
    for (const binding of declaredExceptions("health")) {
      expect(binding.because ?? "").not.toBe("");
    }
  });

  it("agrees on taskById and workerByIdentity", async () => {
    const { path, taskA } = seed();
    const cli = cliResponses(path, taskA, WORKER_B);

    const detail = await serverBody(
      path,
      "/api/v1/tasks/" + taskA,
      TaskDetailResponse,
    );
    // `cli["taskById"]` came from `buildTaskDetail` over the ledger and has
    // never seen `detail`. Comparing `cliRowModel(detail)` to
    // `canonicalRows(detail)` — as this test once did — only showed that one
    // function called another with the same argument.
    expect(cliRowModel("taskById", cli["taskById"])).toEqual(canonicalRows("taskById", detail));
    expect(uiRowModel("taskById", detail)).toEqual(canonicalRows("taskById", detail));

    const worker = await serverBody(
      path,
      "/api/v1/workers/" + encodeURIComponent(WORKER_B),
      WorkerDetailResponse,
    );
    expect(cliRowModel("workerByIdentity", cli["workerByIdentity"])).toEqual(
      canonicalRows("workerByIdentity", worker),
    );
    expect(uiRowModel("workerByIdentity", worker)).toEqual(
      canonicalRows("workerByIdentity", worker),
    );
  });
});

describe("ordering, pagination and cursors are part of the equality", () => {
  it("agrees on an empty ledger", async () => {
    // Parity that holds only on a populated fixture is the parity nobody's bug
    // report is about.
    const path = temporaryDatabase();
    openLedger(path).close();
    const body = await serverBody(path, API_ROUTES.tasks, TaskPageResponse);
    const page = body as { items: unknown[] };
    expect(page.items).toEqual([]);
    // The CLI answers the same question from the empty ledger itself. An empty
    // page is exactly where a tautological comparison would look healthiest,
    // because two projections of one empty body agree no matter what either
    // side believes.
    const cli = cliTaskPage(path, { limit: DEFAULT_PAGE_LIMIT });
    expect(cliRowModel("tasks", cli)).toEqual(canonicalRows("tasks", body));
    expect(uiRowModel("tasks", body)).toEqual(canonicalRows("tasks", body));
  });

  it("agrees on a single-item page", async () => {
    const { path } = seed(1);
    const body = await serverBody(path, API_ROUTES.tasks, TaskPageResponse);
    expect((body as { items: unknown[] }).items).toHaveLength(1);
    const cli = cliTaskPage(path, { limit: DEFAULT_PAGE_LIMIT });
    expect(cliRowModel("tasks", cli)).toEqual(canonicalRows("tasks", body));
    expect(uiRowModel("tasks", body)).toEqual(canonicalRows("tasks", body));
  });

  it("agrees at a page boundary, and carries the same cursor", async () => {
    const { path } = seed(2);
    const first = await serverBody(path, API_ROUTES.tasks + "?limit=1", TaskPageResponse);
    const page = first as { items: unknown[]; page: { nextCursor: string | null } };
    expect(page.items).toHaveLength(1);
    expect(page.page.nextCursor).not.toBeNull();

    // Same limit, asked of the ledger directly: the boundary is where a cursor
    // disagreement would actually live, so both sides must compute it.
    const cliFirst = cliTaskPage(path, { limit: 1 });
    expect(cliRowModel("tasks", cliFirst)).toEqual(canonicalRows("tasks", first));
    expect(uiRowModel("tasks", first)).toEqual(canonicalRows("tasks", first));

    const cursor = page.page.nextCursor ?? "";
    const next = await serverBody(
      path,
      API_ROUTES.tasks + "?limit=1&cursor=" + encodeURIComponent(cursor),
      TaskPageResponse,
    );
    // The CLI follows the cursor the *server* handed back. If the two sides
    // disagreed about what a cursor means, this is the assertion that fails.
    const cliNext = cliTaskPage(path, { limit: 1, afterTaskId: cursor });
    expect(cliRowModel("tasks", cliNext)).toEqual(canonicalRows("tasks", next));
    expect(uiRowModel("tasks", next)).toEqual(canonicalRows("tasks", next));
    // The second page is genuinely a different page, so the equality above is
    // not comparing a value with itself.
    expect(canonicalRows("tasks", next)).not.toEqual(canonicalRows("tasks", first));
  });

  it("notices a reordering, rather than agreeing on sets", async () => {
    const { path } = seed(2);
    const body = (await serverBody(path, API_ROUTES.tasks, TaskPageResponse)) as {
      items: unknown[];
    };
    const reversed = { ...body, items: [...body.items].reverse() };
    expect(canonicalRows("tasks", reversed)).not.toEqual(canonicalRows("tasks", body));
  });
});

describe("redaction is absence, in every client", () => {
  it("carries no credential- or transcript-shaped key on any route", async () => {
    // The one privacy vocabulary, reached through the contract's named helper.
    // This package may not depend on `@acp/contracts` directly — the same
    // exclusion `mappers/index.ts` records — so the shared contract both clients
    // already depend on answers the question instead of a second denylist.
    const { path, taskA } = seed();
    const bodies: unknown[] = [
      await serverBody(path, API_ROUTES.overview, OverviewResponse),
      await serverBody(path, API_ROUTES.tasks, TaskPageResponse),
      await serverBody(path, API_ROUTES.workers, WorkerPageResponse),
      await serverBody(path, API_ROUTES.events, EventPageResponse),
      await serverBody(path, API_ROUTES.status, LedgerStatusResponse),
      await serverBody(path, API_ROUTES.integrity, IntegrityResult),
      await serverBody(path, API_ROUTES.health, HealthResponse),
      await serverBody(path, "/api/v1/tasks/" + taskA, TaskDetailResponse),
      await serverBody(
        path,
        "/api/v1/workers/" + encodeURIComponent(WORKER_B),
        WorkerDetailResponse,
      ),
    ];

    for (const body of bodies) {
      for (const projection of [canonicalize(body), body]) {
        expect(hasObservationPrivacyViolation(projection)).toBe(false);
      }
    }
  });

  it("would report a blanked credential rather than accept it", () => {
    // Absence, not emptiness: a blanked field still names the secret.
    expect(hasObservationPrivacyViolation({ apiKey: "" })).toBe(true);
  });
});

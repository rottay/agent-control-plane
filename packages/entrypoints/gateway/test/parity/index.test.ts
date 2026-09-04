import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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
  ToolCallExecuteResponse,
  ToolCallPageResponse,
  toolCallsPath,
  WorkerDetailResponse,
  WorkerPageResponse,
  bindingCoversAllRoutes,
  StreamFrame,
  canonicalRows,
  canonicalize,
  comparableFields,
  declaredExceptions,
  hasObservationPrivacyViolation,
} from "@acp/protocol";
import type { ApiRouteName } from "@acp/protocol";
import { openToolClaimStore, openLedger, toolClaimStorePath } from "@acp/ledger";
import { TOOL_ARGUMENTS_BYTES_MAX } from "@acp/tools";
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
  buildToolCallPage,
  cliRowModel,
  databaseIdentity,
} from "@acp/cli/observation-rows";
// V2-B4b stage 3E: the CLI's write door, as values. The third deep alias, and
// the first that reaches a door rather than a projection.
import { runToolCallVerb } from "@acp/cli/tool-call-door";
import { uiRowModel } from "@acp/console/row-model";
// V2 X1b: the coordinate a request lands on, derived exactly as the operation
// derives it. Values, not a copy of the derivation.
import { deriveEventCoordinate, deriveInvocation, toolCallTransitionId } from "@acp/runtime";

import { buildServer } from "../../src/build-server/index.js";
import { startServer } from "../../src/start/index.js";

/**
 * The three-way parity proof: ledger, CLI and UI must tell the same story.
 *
 * The CLI builds its rows from the ledger directly; the server answers over
 * HTTP; the UI projects a parsed response. All three converge on one canonical
 * row model defined in `@acp/protocol`, so this file compares row models
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

/** A temp directory this suite owns and cleans, for the door fixtures. */
function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "acp-parity-door-")));
  temporaries.push(directory);
  return directory;
}

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

/**
 * Read a whole stream that is anchored at zero, up to `count` frames.
 *
 * A small reader rather than the full client the stream suite carries: this
 * file needs one shape of read — replay the log, then stop — and a second copy
 * of the general client would be more to keep in step than to write.
 */
function readStream(port: number, path: string, count: number): Promise<StreamFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: StreamFrame[] = [];
    let pending = "";
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { "last-event-id": "0" },
        agent: false,
      },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error("expected 200, got " + String(response.statusCode)));
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          pending += chunk;
          const blocks = pending.split("\n\n");
          pending = blocks.pop() ?? "";
          for (const block of blocks) {
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice(6))
              .join("");
            if (data === "") continue;
            frames.push(StreamFrame.parse(JSON.parse(data)));
          }
          if (frames.length >= count) {
            req.destroy();
            resolve(frames);
          }
        });
        response.on("error", () => {
          resolve(frames);
        });
      },
    );
    req.on("error", (error) => {
      // The destroy above is how this reader stops; it is not a failure.
      if (frames.length >= count) return;
      reject(error);
    });
    req.end();
    setTimeout(() => {
      reject(new Error("timed out reading the stream"));
    }, 20_000).unref();
  });
}

describe("the stream is a fourth transport of the same rows, not a fourth projection (V2-B3a)", () => {
  it("carries the item the CLI builds from the ledger, for the same sequence", async () => {
    // The load-bearing independence is the same one the rest of this file
    // rests on: the CLI derives its rows from the ledger without ever seeing
    // the server's answer, let alone the stream's. If the stream were a second
    // projection rather than a transport, this is where the two would part.
    const { path } = seed();
    const running = await startServer({ ledgerPath: path, port: 0 });
    try {
      const cliBuilt = (() => {
        const ledger = openLedger(path, { readOnly: true });
        try {
          return buildEventPage(ledger, { limit: DEFAULT_PAGE_LIMIT }) as {
            items: readonly unknown[];
          };
        } finally {
          ledger.close();
        }
      })();

      const frames = await readStream(running.port, API_ROUTES.eventStream, cliBuilt.items.length);
      expect(frames).toHaveLength(cliBuilt.items.length);

      for (const [index, item] of cliBuilt.items.entries()) {
        const frame = frames[index];
        if (frame?.kind !== "event") throw new Error("expected an event frame");
        expect(canonicalize(frame.item)).toEqual(canonicalize(item));
      }
    } finally {
      await running.close();
    }
  });

  it("binds the stream route like every other, so the contract still covers what is served", () => {
    // The route table grew; the parity table has to have grown with it, or
    // `bindingCoversAllRoutes` would be false and every claim in this file
    // would be a claim about a table with a hole in it.
    expect(bindingCoversAllRoutes()).toBe(true);
    expect(PARITY_ROUTES).toContain("eventStream");
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

// ---------------------------------------------------------------------------
// V2-B4b stage 3E — the explicit tool operation, proved equivalent across doors
// ---------------------------------------------------------------------------

/**
 * The closing proof of the A → E sequence.
 *
 * Three things are established here that no earlier packet could establish
 * alone, because each needs both doors in one place:
 *
 * 1. The **read** projection of `taskToolCalls` agrees three ways, with the CLI
 *    folding the ledger itself and never seeing the server's answer.
 * 2. The **write** is equivalent field for field — including `eventId` and
 *    `sequence`, with no exclusion list — because both doors are deterministic
 *    over the same request and the same seeded history.
 * 3. **One execution, one receipt across the doors**: a coordinate spent by one
 *    door replays at the other, in both directions, with no second child.
 *
 * The write proof runs over **two identically-seeded ledgers**, not one. Running
 * both doors at one coordinate on one ledger would compare an execution against
 * a replay and pass for the wrong reason — the coordinate is spent once by law.
 * Two ledgers give the stronger claim: `eventId` is `deterministicUuid` over
 * `(taskId, attempt, transitionId)` and nothing here reads a clock or a row
 * count, so the two responses must be byte-identical.
 */

const TOOL_TASK = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a0e";
const TOOL_IDENTITY = "claude/opus/implementer/01";
const TOOL_REVIEWER = "claude/opus/reviewer/01";
const TOOL_ACCOUNT = "acct-primary";
const TOOL_SUBMITTED_AT = "2026-09-03T12:00:00.000Z";
const TOOL_DIGEST = "a".repeat(64);
const TOOL_SENTINEL = "SENTINEL-STAGE3E-MUST-NOT-BE-DURABLE";
const TOOL_BEARER = "stage3e-parity-" + "t".repeat(28);

/** A tool-call receipt row, as the recorder writes one. */
function toolCallEvent(input: {
  readonly taskId: string;
  readonly callIndex: number;
  readonly outcome: "COMPLETED" | "REFUSED";
  readonly refusal: string | null;
  readonly occurredAt: string;
}): Record<string, unknown> {
  const transitionId = "tool.0." + String(input.callIndex);
  return {
    contractVersion: LEDGER_CONTRACT_VERSION,
    eventId: randomUUID(),
    taskId: input.taskId,
    attempt: 1,
    transitionId,
    idempotencyKey: input.taskId + "/1/" + transitionId,
    type: "TOOL_CALL_RECORDED",
    // A same-state passthrough: recording that a tool ran moves no lifecycle.
    fromState: "DISCOVERED",
    toState: "DISCOVERED",
    emittedBy: TOOL_IDENTITY,
    occurredAt: input.occurredAt,
    recordedAt: input.occurredAt,
    correlationId: null,
    causationId: null,
    payload: {
      accountId: TOOL_ACCOUNT,
      serverId: "docs",
      toolName: "docs.search",
      transport: "STDIO",
      outcome: input.outcome,
      refusal: input.refusal,
      argumentBytes: 12 + input.callIndex,
      resultBytes: 34 + input.callIndex,
      contentBlocks: input.outcome === "COMPLETED" ? 1 : 0,
    },
  };
}

/**
 * A ledger with one discovered task and two recorded tool calls.
 *
 * Two rows so ordering is part of the equality, and one of each outcome so both
 * `outcome` values are exercised rather than one being assumed.
 */
function seedWithToolCalls(): { readonly path: string; readonly taskId: string } {
  const path = temporaryDatabase();
  const ledger = openLedger(path);
  ledger.append(
    makeEvent({
      taskId: TOOL_TASK,
      transitionId: "discover",
      type: "TASK_DISCOVERED",
      toState: "DISCOVERED",
      emittedBy: WORKER_B,
    }),
  );
  ledger.append(
    toolCallEvent({
      taskId: TOOL_TASK,
      callIndex: 0,
      outcome: "COMPLETED",
      refusal: null,
      occurredAt: "2026-08-27T12:01:00.000Z",
    }),
  );
  ledger.append(
    toolCallEvent({
      taskId: TOOL_TASK,
      callIndex: 1,
      outcome: "REFUSED",
      refusal: "TOOL_NOT_ALLOWED",
      occurredAt: "2026-08-27T12:02:00.000Z",
    }),
  );
  ledger.close();
  return { path, taskId: TOOL_TASK };
}

describe("the tool-call read agrees three ways (V2-B4b stage 3E)", () => {
  it("agrees on taskToolCalls, with the CLI folding the ledger itself", async () => {
    const { path, taskId } = seedWithToolCalls();

    const body = await serverBody(path, toolCallsPath(taskId), ToolCallPageResponse);

    // The CLI's own producer, over the same ledger, never having seen the
    // server's answer. A dedicated seed rather than the shared one because a
    // page with no rows would agree vacuously.
    const ledger = openLedger(path, { readOnly: true });
    let cliBuilt;
    try {
      cliBuilt = buildToolCallPage(ledger, { taskId, limit: DEFAULT_PAGE_LIMIT });
    } finally {
      ledger.close();
    }

    const fromServer = canonicalRows("taskToolCalls", body);
    expect(cliRowModel("taskToolCalls", cliBuilt)).toEqual(fromServer);
    expect(uiRowModel("taskToolCalls", body)).toEqual(fromServer);

    const rendered = fromServer as Record<string, unknown>;
    for (const field of comparableFields("taskToolCalls")) {
      expect({ field, present: field in rendered }).toEqual({ field, present: true });
    }

    // Ordering and both outcomes are genuinely in the comparison.
    const page = body as { items: { outcome: string; sequence: number }[] };
    expect(page.items).toHaveLength(2);
    expect(page.items.map((row) => row.outcome)).toEqual(["COMPLETED", "REFUSED"]);
    expect(page.items[0]!.sequence).toBeLessThan(page.items[1]!.sequence);

    expect(hasObservationPrivacyViolation(body)).toBe(false);
  });
});

/** A minimal stdio MCP server this suite owns, logging its own pid. */
function writeToolServerScript(dir: string, pidLog: string, leak = false): string {
  const path = join(dir, "fake-mcp.mjs");
  const answer = leak
    ? "'sk-ant-api03-' + 'A'.repeat(32)"
    : "'the answer'";
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(" + JSON.stringify(pidLog) + ", String(process.pid) + '\\n');",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  let index = buffer.indexOf('\\n');",
      "  while (index >= 0) {",
      "    const line = buffer.slice(0, index);",
      "    buffer = buffer.slice(index + 1);",
      "    index = buffer.indexOf('\\n');",
      "    if (line.trim() !== '') handle(JSON.parse(line));",
      "  }",
      "});",
      "function send(v) { process.stdout.write(JSON.stringify(v) + '\\n'); }",
      "function handle(m) {",
      "  const { id, method } = m;",
      "  if (method === 'initialize') {",
      "    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18',",
      "      capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });",
      "    return;",
      "  }",
      "  if (method === 'notifications/initialized') return;",
      "  if (method === 'tools/list') {",
      "    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'docs.search',",
      "      description: 'd', inputSchema: { type: 'object' } }] } });",
      "    return;",
      "  }",
      "  if (method === 'tools/call') {",
      "    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: " + answer + " }],",
      "      isError: false } });",
      "  }",
      "}",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o700);
  return path;
}

interface DoorFixture {
  readonly dir: string;
  readonly pidLog: string;
  readonly bearerPath: string;
  readonly toolServersPath: string;
}

/** The operator documents both doors read, written once and shared by both. */
function doorFixture(options: { readonly leak?: boolean } = {}): DoorFixture {
  const dir = temporaryDirectory();
  const pidLog = join(dir, "pids.log");
  writeFileSync(pidLog, "", "utf8");

  const bearerPath = join(dir, "write.token");
  writeFileSync(bearerPath, TOOL_BEARER + "\n", "utf8");
  chmodSync(bearerPath, 0o600);

  const script = writeToolServerScript(dir, pidLog, options.leak ?? false);
  const toolServersPath = join(dir, "tool-servers.json");
  writeFileSync(
    toolServersPath,
    JSON.stringify([
      {
        serverId: "docs",
        transport: "STDIO",
        command: process.execPath,
        args: [script],
        tools: [
          { name: "docs.search", writes: false },
          { name: "docs.write", writes: true },
        ],
      },
    ]),
    "utf8",
  );
  chmodSync(toolServersPath, 0o600);
  return { dir, pidLog, bearerPath, toolServersPath };
}

/** A ledger holding exactly one discovered task, ready for a tool call. */
function seedForExecution(): string {
  const path = temporaryDatabase();
  const ledger = openLedger(path);
  ledger.append(
    makeEvent({
      taskId: TOOL_TASK,
      transitionId: "discover",
      type: "TASK_DISCOVERED",
      toState: "DISCOVERED",
      emittedBy: WORKER_B,
    }),
  );
  ledger.close();
  return path;
}

function toolRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: TOOL_TASK,
    attempt: 1,
    submittedAt: TOOL_SUBMITTED_AT,
    submissionDigest: TOOL_DIGEST,
    operationIndex: 0,
    callIndex: 0,
    accountId: TOOL_ACCOUNT,
    identity: TOOL_IDENTITY,
    serverId: "docs",
    toolName: "docs.search",
    arguments: { q: TOOL_SENTINEL },
    ...overrides,
  };
}

/** Drive the API door and return the parsed response document. */
async function apiDoor(
  ledgerPath: string,
  fixture: DoorFixture,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const app = buildServer({
    ledgerPath,
    writeBearerPath: fixture.bearerPath,
    toolServersPath: fixture.toolServersPath,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: toolCallsPath(String(request["taskId"])),
      headers: { authorization: "Bearer " + TOOL_BEARER },
      payload: request,
    });
    expect(response.statusCode).toBe(200);
    return ToolCallExecuteResponse.parse(response.json()) as unknown as Record<string, unknown>;
  } finally {
    await app.close();
  }
}

/** Drive the CLI door, as values, and return the parsed response document. */
async function cliDoor(
  ledgerPath: string,
  fixture: DoorFixture,
  request: Record<string, unknown>,
  name = "request.json",
): Promise<Record<string, unknown>> {
  // The CLI door's authority IS the uid ladder over real files, so the request
  // is written to disk rather than handed over as a value. Driving it any other
  // way would prove a path production never takes.
  const requestPath = join(fixture.dir, name);
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  chmodSync(requestPath, 0o600);
  const result = await runToolCallVerb({
    databasePath: ledgerPath,
    requestPath,
    toolServersPath: fixture.toolServersPath,
  });
  return result.document as unknown as Record<string, unknown>;
}

/**
 * The coordinate a `toolRequest()` lands on, derived as the operation derives
 * it rather than written out, so these cases cannot go vacuous by pinning a key
 * the plane stopped using.
 */
function coordinateOf(taskId: string, callIndex = 0): string {
  return deriveEventCoordinate(
    deriveInvocation(taskId, 1, TOOL_SUBMITTED_AT, TOOL_DIGEST),
    toolCallTransitionId(0, callIndex),
    0,
  ).idempotencyKey;
}

/**
 * Hold the coordinate the way another operating-system process would.
 *
 * The arbitration lives in a file, so a claim written straight into that file is
 * indistinguishable — to either door — from one written by a second gateway or a
 * second CLI. The cross-process race itself is drilled against eight real
 * processes in `@acp/ledger`; what these cases need is a *deterministic* loser,
 * so that "both doors consult the claim" is asserted rather than raced for.
 */
function holdCoordinate(ledgerPath: string, holder = "claude/sonnet/implementer/07"): void {
  const store = openToolClaimStore(toolClaimStorePath(ledgerPath));
  try {
    store.transact(coordinateOf(TOOL_TASK), () => ({
      verb: "TAKE",
      row: {
        claimId: randomUUID(),
        holder,
        claimedAt: "2026-09-04T05:00:00.000Z",
        // Far future: a live claimant, by the only test this plane has.
        expiresAt: "2200-01-01T00:00:00.000Z",
        taskId: TOOL_TASK,
        attempt: 1,
        transitionId: toolCallTransitionId(0, 0),
        submittedAt: TOOL_SUBMITTED_AT,
        accountId: TOOL_ACCOUNT,
        serverId: "docs",
        toolName: "docs.search",
        argumentBytes: 64,
      },
    }));
  } finally {
    store.close();
  }
}

function pidsIn(pidLog: string): readonly number[] {
  return readFileSync(pidLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => Number(line));
}

function rowCount(ledgerPath: string): number {
  const ledger = openLedger(ledgerPath, { readOnly: true });
  try {
    return ledger.listEvents({ taskId: TOOL_TASK, type: "TOOL_CALL_RECORDED" }).events.length;
  } finally {
    ledger.close();
  }
}

describe("the two doors are equivalent on the write (V2-B4b stage 3E)", () => {
  it("answers byte-identically over two identically-seeded ledgers, with no field excluded", async () => {
    const fixture = doorFixture();
    const api = await apiDoor(seedForExecution(), fixture, toolRequest());
    const cli = await cliDoor(seedForExecution(), fixture, toolRequest());

    // Every field, `eventId` and `sequence` included. An exclusion list here
    // would be a difference being papered over: both doors are deterministic
    // over the same request and the same seeded history, and neither reads a
    // clock, a row count or a random source for anything in this document.
    expect(cli).toEqual(api);
    expect(cli["outcome"]).toBe("COMPLETED");
    expect(cli["content"]).toEqual(["the answer"]);
  });

  it("agrees on a refusal exactly as it agrees on a completion", async () => {
    const fixture = doorFixture();
    const refusing = toolRequest({ toolName: "docs.write", identity: TOOL_REVIEWER });
    const api = await apiDoor(seedForExecution(), fixture, refusing);
    const cli = await cliDoor(seedForExecution(), fixture, refusing, "refusal.json");

    expect(cli).toEqual(api);
    expect(api["outcome"]).toBe("REFUSED");
    expect(api["refusal"]).toBe("IDENTITY_FORBIDS_WRITE");
    // A refusal is a recorded outcome at both doors: HTTP 200 and exit 0 are
    // the two spellings of "it became an operation".
    expect(api["at"]).toBe(cli["at"]);
  });

  it("differs where the request differs, and nowhere else", async () => {
    // The negative direction, so the equality above is not vacuous.
    const fixture = doorFixture();
    const first = await apiDoor(seedForExecution(), fixture, toolRequest());
    const second = await apiDoor(seedForExecution(), fixture, toolRequest({ callIndex: 1 }));

    expect(second["transitionId"]).not.toBe(first["transitionId"]);
    expect(second["eventId"]).not.toBe(first["eventId"]);
    for (const field of ["outcome", "refusal", "at", "serverId", "toolName", "transport",
      "accountId", "argumentBytes", "resultBytes", "contentBlocks", "sequence", "replayed"]) {
      expect({ field, equal: second[field] === first[field] }).toEqual({ field, equal: true });
    }
  });
});

describe("one execution, one receipt, across the two doors (V2-B4b stage 3E)", () => {
  it("replays at the CLI a coordinate the API spent, with no second child", async () => {
    const fixture = doorFixture();
    const ledgerPath = seedForExecution();

    const api = await apiDoor(ledgerPath, fixture, toolRequest());
    expect(api["replayed"]).toBe(false);
    expect(api["content"]).toEqual(["the answer"]);
    const spawnedOnce = pidsIn(fixture.pidLog).length;
    expect(spawnedOnce).toBeGreaterThan(0);
    expect(rowCount(ledgerPath)).toBe(1);

    const cli = await cliDoor(ledgerPath, fixture, toolRequest());
    expect(cli["replayed"]).toBe(true);
    expect(cli["eventId"]).toBe(api["eventId"]);
    expect(cli["transitionId"]).toBe(api["transitionId"]);
    expect(cli["sequence"]).toBe(api["sequence"]);
    expect(cli["content"]).toEqual([]);
    expect(cli["at"]).toBeNull();
    expect(rowCount(ledgerPath)).toBe(1);
    // The load-bearing half: no second execution happened.
    expect(pidsIn(fixture.pidLog).length).toBe(spawnedOnce);
  });

  it("replays at the API a coordinate the CLI spent, the mirror image", async () => {
    // Asserted in both directions on purpose: an implementation in which only
    // one door performed the replay read would pass one and fail the other.
    const fixture = doorFixture();
    const ledgerPath = seedForExecution();

    const cli = await cliDoor(ledgerPath, fixture, toolRequest());
    expect(cli["replayed"]).toBe(false);
    const spawnedOnce = pidsIn(fixture.pidLog).length;
    expect(spawnedOnce).toBeGreaterThan(0);

    const api = await apiDoor(ledgerPath, fixture, toolRequest());
    expect(api["replayed"]).toBe(true);
    expect(api["eventId"]).toBe(cli["eventId"]);
    expect(api["transitionId"]).toBe(cli["transitionId"]);
    expect(api["sequence"]).toBe(cli["sequence"]);
    expect(api["content"]).toEqual([]);
    expect(api["at"]).toBeNull();
    expect(rowCount(ledgerPath)).toBe(1);
    expect(pidsIn(fixture.pidLog).length).toBe(spawnedOnce);
  });
});

describe("the doors refuse alike, and neither records the argument (V2-B4b stage 3E)", () => {
  /**
   * The refusal ladder, driven through both doors on paired ledgers.
   *
   * Four of the five the stage names are driven here. `RESULT_UNSAFE` has its
   * own case below, because it needs a server that answers with something
   * credential-shaped rather than a differently-shaped request.
   */
  const LADDER: readonly (readonly [string, Record<string, unknown>])[] = [
    ["TOOL_NOT_ALLOWED", { toolName: "shell.exec" }],
    ["IDENTITY_FORBIDS_WRITE", { toolName: "docs.write", identity: TOOL_REVIEWER }],
    ["SERVER_NOT_ADMITTED", { serverId: "absent" }],
    // Just over the tool edge's own argument ceiling (8 KiB), and deliberately
    // well under the CLI door's 64 KiB document ceiling. The size is not
    // arbitrary: the two ceilings are ordered, so an argument big enough to
    // trip the tool edge still fits in a request document, and both doors reach
    // the same refusal. A first draft used 200 KB and the CLI refused the
    // *document* instead -- the doors would have looked divergent because the
    // fixture was wrong, not because they are.
    ["ARGUMENTS_UNBOUNDED", { arguments: { q: "x".repeat(9_000) } }],
  ];

  it("keeps the two ceilings ordered, which is what lets the doors agree above", () => {
    // Stated as an assertion rather than a comment: if the tool edge's argument
    // ceiling ever rose above the CLI's document ceiling, the CLI could never
    // produce ARGUMENTS_UNBOUNDED and the ladder case above would silently stop
    // comparing anything.
    expect(TOOL_ARGUMENTS_BYTES_MAX).toBeLessThan(64 * 1024);
  });

  it("gives the same refusal and the same field path at both doors", async () => {
    for (const [expected, overrides] of LADDER) {
      const fixture = doorFixture();
      const request = toolRequest(overrides);
      const api = await apiDoor(seedForExecution(), fixture, request);
      const cliLedger = seedForExecution();
      const cli = await cliDoor(cliLedger, fixture, request, "ladder.json");

      expect({ expected, api: api["refusal"] }).toEqual({ expected, api: expected });
      expect({ expected, cli: cli["refusal"] }).toEqual({ expected, cli: expected });
      expect({ expected, at: cli["at"] }).toEqual({ expected, at: api["at"] });
      // A refusal is a recorded outcome at both doors.
      expect({ expected, rows: rowCount(cliLedger) }).toEqual({ expected, rows: 1 });
    }
  });

  it("gives the same refusal when the server answers with something unsafe", async () => {
    const fixture = doorFixture({ leak: true });
    const request = toolRequest();
    const api = await apiDoor(seedForExecution(), fixture, request);
    const cliLedger = seedForExecution();
    const cli = await cliDoor(cliLedger, fixture, request, "unsafe.json");

    expect(api["refusal"]).toBe("RESULT_UNSAFE");
    expect(cli["refusal"]).toBe(api["refusal"]);
    expect(cli["at"]).toBe(api["at"]);
    expect(api["content"]).toEqual([]);
    expect(cli["content"]).toEqual([]);
    expect(rowCount(cliLedger)).toBe(1);
  });

  it("refuses the same malformed tool documents at both doors", async () => {
    // Packet D's D-7: the two doors read the document with two separate
    // ladders. This is the assertion standing between them and a silent
    // divergence about which documents are admissible.
    const malformed: readonly (readonly [string, unknown])[] = [
      ["not an array", { servers: [] }],
      ["empty", []],
      ["spaced server id", [{ serverId: "not a name", transport: "STDIO", command: "/bin/true", tools: [] }]],
      ["remote", [{ serverId: "remote", transport: "STDIO", url: "https://example.com", tools: [] }]],
    ];

    for (const [label, document] of malformed) {
      const fixture = doorFixture();
      const documentPath = join(fixture.dir, "bad-" + label.replace(/[^a-z]/g, "-") + ".json");
      writeFileSync(documentPath, JSON.stringify(document), "utf8");
      chmodSync(documentPath, 0o600);
      const bad = { ...fixture, toolServersPath: documentPath };

      // The API door answers 503: the document it was started with is not
      // admissible, so the capability is absent.
      const app = buildServer({
        ledgerPath: seedForExecution(),
        writeBearerPath: fixture.bearerPath,
        toolServersPath: documentPath,
      });
      let apiStatus: number;
      try {
        const response = await app.inject({
          method: "POST",
          url: toolCallsPath(TOOL_TASK),
          headers: { authorization: "Bearer " + TOOL_BEARER },
          payload: toolRequest(),
        });
        apiStatus = response.statusCode;
      } finally {
        await app.close();
      }
      expect({ label, apiStatus }).toEqual({ label, apiStatus: 503 });

      // The CLI door refuses the same document rather than admitting it.
      let cliRefused = false;
      try {
        await cliDoor(seedForExecution(), bad, toolRequest(), "with-bad-doc.json");
      } catch {
        cliRefused = true;
      }
      expect({ label, cliRefused }).toEqual({ label, cliRefused: true });
      expect({ label, spawned: pidsIn(fixture.pidLog).length }).toEqual({ label, spawned: 0 });
    }
  });

  it("keeps the argument out of the ledger at both doors, non-vacuously", async () => {
    const fixture = doorFixture();
    const apiLedger = seedForExecution();
    const cliLedger = seedForExecution();
    await apiDoor(apiLedger, fixture, toolRequest());
    await cliDoor(cliLedger, fixture, toolRequest(), "sentinel.json");

    for (const [label, ledgerPath] of [["api", apiLedger], ["cli", cliLedger]] as const) {
      const ledger = openLedger(ledgerPath, { readOnly: true });
      const canonical = ledger
        .listEvents({ taskId: TOOL_TASK })
        .events.map((row) => row.canonicalJson)
        .join("\n");
      ledger.close();
      expect({ label, leaked: canonical.includes(TOOL_SENTINEL) }).toEqual({
        label,
        leaked: false,
      });
      // Non-vacuous: the row that does not carry the argument carries its size.
      expect({ label, sized: canonical.includes("argumentBytes") }).toEqual({
        label,
        sized: true,
      });
    }
  });

  it("carries the nine payload key names, and no value, onto the read surface", async () => {
    const fixture = doorFixture();
    const ledgerPath = seedForExecution();
    await apiDoor(ledgerPath, fixture, toolRequest());

    const body = await serverBody(ledgerPath, API_ROUTES.events, EventPageResponse);
    const rendered = JSON.stringify(body);
    expect(rendered).not.toContain(TOOL_SENTINEL);
    // The timeline item projects key names and a byte size, structurally.
    expect(rendered).toContain("argumentBytes");
    expect(hasObservationPrivacyViolation(body)).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// V2 X1b — the two doors contend on one authority, not on two memories
// ---------------------------------------------------------------------------

/**
 * The claim, proved where it has to be proved: with both doors present.
 *
 * Stage 3E proved a coordinate spent by one door replays at the other —
 * *sequentially*. That was the strongest claim available then, and it left the
 * concurrent case open in the direction that mattered: two callers that reached
 * the operation together both found the coordinate unspent, and the CLI door
 * could not close it even in principle, because every `acp tool-call` is a new
 * process.
 *
 * These cases run the two doors **at the same coordinate at the same time**.
 * The arbitration they contend on is a file derived from the ledger, so the
 * property under test is exactly the one that was missing: one effect, whichever
 * door wins, and a loser that is told to read rather than to retry.
 *
 * The eight-process drill for the store itself lives in `@acp/ledger`. What is
 * proved here is that the two doors reach that store, and reach the same one.
 */

/** The API door, raw: this block is about the answers that are not `200`. */
async function apiDoorRaw(
  ledgerPath: string,
  fixture: DoorFixture,
  request: Record<string, unknown>,
): Promise<{ readonly status: number; readonly code: string | null; readonly body: string }> {
  const app = buildServer({
    ledgerPath,
    writeBearerPath: fixture.bearerPath,
    toolServersPath: fixture.toolServersPath,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: toolCallsPath(String(request["taskId"])),
      headers: { authorization: "Bearer " + TOOL_BEARER },
      payload: request,
    });
    const failure: { error?: { code?: string } } = response.json();
    const code = response.statusCode === 200 ? null : (failure.error?.code ?? null);
    return { status: response.statusCode, code, body: response.body };
  } finally {
    await app.close();
  }
}

/** The CLI door, raw: a refusal is a throw here, not a document. */
async function cliDoorRaw(
  ledgerPath: string,
  fixture: DoorFixture,
  request: Record<string, unknown>,
  name = "race.json",
): Promise<{ readonly ok: boolean; readonly code: string | null; readonly text: string }> {
  const requestPath = join(fixture.dir, name);
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  chmodSync(requestPath, 0o600);
  try {
    await runToolCallVerb({
      databasePath: ledgerPath,
      requestPath,
      toolServersPath: fixture.toolServersPath,
    });
    return { ok: true, code: null, text: "" };
  } catch (error: unknown) {
    const refusal = error as { code?: string; message?: string };
    return { ok: false, code: refusal.code ?? null, text: String(refusal.message ?? error) };
  }
}

describe("the two doors contend on one claim (V2 X1b)", () => {
  it("runs one tool for one coordinate when both doors start together", async () => {
    const fixture = doorFixture();
    const ledgerPath = seedForExecution();

    // Started together on purpose. Sequentially the coordinate is spent before
    // the second door looks, and the stage 3E replay cases already cover that;
    // it is the overlap that used to produce two children for one row.
    const [api, cli] = await Promise.all([
      apiDoorRaw(ledgerPath, fixture, toolRequest()),
      cliDoorRaw(ledgerPath, fixture, toolRequest()),
    ]);

    // The invariant, stated over both possible interleavings rather than over
    // the one this machine happened to produce: the loser either replayed the
    // winner's row or was refused the claim — never ran a second tool.
    expect(pidsIn(fixture.pidLog).length).toBe(1);
    expect(rowCount(ledgerPath)).toBe(1);

    const apiWon = api.status === 200;
    const cliWon = cli.ok;
    expect(apiWon || cliWon).toBe(true);
    if (!apiWon) expect(api.code).toBe("CLAIM_HELD");
    if (!cliWon) expect(cli.code).toBe("CLAIM_HELD");
  });

  it("refuses the CLI a coordinate the API is holding, and vice versa", async () => {
    // Deterministic rather than timing-dependent, and asserted in both
    // directions: an implementation in which only one door consulted the claim
    // would pass one of these and fail the other.
    const forCli = doorFixture();
    const cliLedger = seedForExecution();
    holdCoordinate(cliLedger);
    const cli = await cliDoorRaw(cliLedger, forCli, toolRequest());
    expect(cli.ok).toBe(false);
    expect(cli.code).toBe("CLAIM_HELD");
    expect(pidsIn(forCli.pidLog)).toHaveLength(0);
    expect(rowCount(cliLedger)).toBe(0);

    const forApi = doorFixture();
    const apiLedger = seedForExecution();
    holdCoordinate(apiLedger);
    const api = await apiDoorRaw(apiLedger, forApi, toolRequest());
    expect(api.status).toBe(409);
    expect(api.code).toBe("CLAIM_HELD");
    expect(pidsIn(forApi.pidLog)).toHaveLength(0);
    expect(rowCount(apiLedger)).toBe(0);
  });

  it("gives the same refusal code at both doors, and leaks nothing at either", async () => {
    const holder = "claude/sonnet/implementer/07";
    const forCli = doorFixture();
    const cliLedger = seedForExecution();
    holdCoordinate(cliLedger, holder);
    const cli = await cliDoorRaw(cliLedger, forCli, toolRequest());

    const forApi = doorFixture();
    const apiLedger = seedForExecution();
    holdCoordinate(apiLedger, holder);
    const api = await apiDoorRaw(apiLedger, forApi, toolRequest());

    // Parity is the point of this file: one fact, one code, both doors.
    expect(cli.code).toBe(api.code);
    for (const surface of [cli.text, api.body]) {
      expect(surface).not.toContain(holder);
      expect(surface).not.toContain(TOOL_SENTINEL);
      expect(surface).not.toContain(cliLedger);
      expect(surface).not.toContain(apiLedger);
    }
  });

  it("arbitrates over one file, which is what makes the two doors one plane", async () => {
    const fixture = doorFixture();
    const ledgerPath = seedForExecution();

    // The CLI walks the coordinate; the claim it leaves behind is the one the
    // API then reads. If the doors composed their paths separately this would
    // still pass every test above and fail here — two stores over one ledger is
    // no mutual exclusion at all, while presenting exactly as one.
    await cliDoor(ledgerPath, fixture, toolRequest());
    const store = openToolClaimStore(toolClaimStorePath(ledgerPath));
    try {
      expect(store.read(coordinateOf(TOOL_TASK))?.state).toBe("SETTLED");
    } finally {
      store.close();
    }
  });
});

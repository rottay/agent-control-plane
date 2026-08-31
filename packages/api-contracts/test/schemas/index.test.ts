import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  API_ALLOWED_METHODS,
  API_BASE_PATH,
  API_CONTRACT_VERSION,
  API_ERROR_CODES,
  API_ROUTES,
  API_ROUTE_PATTERNS,
  ApiError,
  CursorPageMeta,
  DEFAULT_PAGE_LIMIT,
  EventPageResponse,
  EventsQuery,
  HealthResponse,
  InitiativeDetailResponse,
  InitiativePortfolioResponse,
  InitiativeRoadmapResponse,
  InitiativeSummary,
  RoadmapVersionDto,
  RollupSummary,
  initiativePath,
  initiativeRoadmapPath,
  INTEGRITY_PROBLEM_KINDS,
  IntegrityResult,
  LEDGER_CONTRACT_VERSION,
  LedgerDatabaseIdentity,
  LedgerStatusResponse,
  MAX_PAGE_LIMIT,
  OverviewResponse,
  TaskDetail,
  TaskPageResponse,
  TaskSummary,
  TasksQuery,
  TimelineItem,
  WorkerDetail,
  WorkerSummary,
  WorkersQuery,
  taskPath,
  workerPath,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TASK_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const AT = "2026-08-27T12:00:00.000Z";
const LATER = "2026-08-27T12:30:00.000Z";
const SHA256 = "a".repeat(64);
const OTHER_SHA256 = "b".repeat(64);

const WRITER = "claude/opus/implementer/01";
const OTHER_WRITER = "kimi/k3/coordinator/01";

const DATABASE: unknown = {
  id: SHA256,
  label: "control-plane.sqlite",
  pathRedacted: true,
};

const TIMELINE_ITEM = {
  sequence: 7,
  eventId: EVENT_ID,
  taskId: TASK_ID,
  attempt: 1,
  transitionId: "run.started",
  type: "RUN_STARTED",
  fromState: "READY",
  toState: "RUNNING",
  emittedBy: WRITER,
  occurredAt: AT,
  recordedAt: AT,
  previousSha256: OTHER_SHA256,
  eventSha256: SHA256,
  payloadByteSize: 128,
  payloadKeys: ["attemptLabel", "worktreeId"],
};

const TASK_SUMMARY = {
  taskId: TASK_ID,
  currentState: "RUNNING",
  isTerminal: false,
  latestAttempt: 1,
  eventCount: 7,
  firstSequence: 1,
  lastSequence: 7,
  lastEventType: "RUN_STARTED",
  lastEmittedBy: WRITER,
  createdAt: AT,
  updatedAt: LATER,
};

const TASK_DETAIL = {
  ...TASK_SUMMARY,
  lastEventId: EVENT_ID,
  lastTransitionId: "run.started",
  recentEvents: [TIMELINE_ITEM],
};

const WORKER_SUMMARY = {
  identity: WRITER,
  provider: "claude",
  model: "opus",
  role: "implementer",
  instance: "01",
  eventCount: 7,
  taskCount: 2,
  firstSequence: 1,
  lastSequence: 7,
  firstSeenAt: AT,
  lastSeenAt: LATER,
  lastEventType: "RUN_STARTED",
};

const WORKER_DETAIL = {
  ...WORKER_SUMMARY,
  lastTaskId: TASK_ID,
  recentEvents: [TIMELINE_ITEM],
};

const HEALTH = {
  apiContractVersion: API_CONTRACT_VERSION,
  ledgerContractVersion: LEDGER_CONTRACT_VERSION,
  status: "OK",
  readOnly: true,
  observedAt: AT,
  database: DATABASE,
  detail: null,
};

const LEDGER_STATUS = {
  apiContractVersion: API_CONTRACT_VERSION,
  ledgerContractVersion: LEDGER_CONTRACT_VERSION,
  database: DATABASE,
  readOnly: true,
  headSequence: 7,
  headEventSha256: SHA256,
  eventCount: 7,
  pragmas: {
    journalMode: "wal",
    foreignKeys: true,
    synchronous: 1,
    busyTimeoutMs: 5_000,
    queryOnly: true,
  },
  migrations: [
    { version: 1, name: "0001_initial", sha256: SHA256, appliedAt: AT },
  ],
  projections: [
    {
      name: "task_read_model",
      appliedThroughSequence: 7,
      eventCount: 7,
      sourceHeadSha256: SHA256,
      updatedAt: AT,
      rowCount: 2,
    },
  ],
  observedAt: LATER,
};

const INTEGRITY_OK = {
  apiContractVersion: API_CONTRACT_VERSION,
  ledgerContractVersion: LEDGER_CONTRACT_VERSION,
  ok: true,
  checkedEvents: 7,
  headSequence: 7,
  headEventSha256: SHA256,
  problems: [],
  truncated: false,
  checkedAt: AT,
};

const OVERVIEW_ACTIVE = {
  apiContractVersion: API_CONTRACT_VERSION,
  ledgerContractVersion: LEDGER_CONTRACT_VERSION,
  state: "ACTIVE",
  observedAt: AT,
  database: DATABASE,
  ledger: {
    eventCount: 7,
    headSequence: 7,
    headEventSha256: SHA256,
    lastEventAt: LATER,
  },
  integrity: { checked: true, ok: true, problemCount: 0, checkedAt: AT },
  tasks: {
    total: 2,
    terminal: 1,
    active: 1,
    byState: [
      { state: "RUNNING", count: 1 },
      { state: "CHECKPOINTED", count: 1 },
    ],
  },
  workers: {
    total: 1,
    byRole: [{ role: "implementer", count: 1 }],
  },
  capabilities: {
    readOnly: true,
    writes: false,
    routing: false,
    accounts: false,
    leases: false,
  },
  notice: null,
};

const OVERVIEW_EMPTY = {
  ...OVERVIEW_ACTIVE,
  state: "EMPTY",
  ledger: {
    eventCount: 0,
    headSequence: 0,
    headEventSha256: "0".repeat(64),
    lastEventAt: null,
  },
  integrity: { checked: false, ok: null, problemCount: null, checkedAt: null },
  tasks: { total: 0, terminal: 0, active: 0, byState: [] },
  workers: { total: 0, byRole: [] },
  notice: null,
};

const OVERVIEW_UNAVAILABLE = {
  ...OVERVIEW_EMPTY,
  state: "UNAVAILABLE",
  database: null,
  ledger: null,
  notice: "the ledger could not be opened",
};

const OVERVIEW_DEGRADED = {
  ...OVERVIEW_ACTIVE,
  state: "DEGRADED",
  integrity: { checked: true, ok: false, problemCount: 3, checkedAt: AT },
  notice: "hash chain verification failed",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withKey(value: object, key: string, keyValue: unknown): unknown {
  return { ...value, [key]: keyValue };
}

function without(value: object, key: string): unknown {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  );
}

/** Every top level response schema, so strictness can be asserted uniformly. */
const RESPONSE_SCHEMAS = [
  ["HealthResponse", HealthResponse, HEALTH],
  ["LedgerStatusResponse", LedgerStatusResponse, LEDGER_STATUS],
  ["IntegrityResult", IntegrityResult, INTEGRITY_OK],
  ["OverviewResponse", OverviewResponse, OVERVIEW_ACTIVE],
  ["TaskSummary", TaskSummary, TASK_SUMMARY],
  ["TaskDetail", TaskDetail, TASK_DETAIL],
  ["WorkerSummary", WorkerSummary, WORKER_SUMMARY],
  ["WorkerDetail", WorkerDetail, WORKER_DETAIL],
  ["TimelineItem", TimelineItem, TIMELINE_ITEM],
] as const;

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

describe("contract versions", () => {
  it("keeps the API version distinct from the ledger contract version", () => {
    const api: string = API_CONTRACT_VERSION;
    const ledger: string = LEDGER_CONTRACT_VERSION;
    expect(api).not.toBe(ledger);
  });

  it("rejects a response stamped with the ledger version in the API slot", () => {
    const result = HealthResponse.safeParse(
      withKey(HEALTH, "apiContractVersion", LEDGER_CONTRACT_VERSION),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a response stamped with the API version in the ledger slot", () => {
    const result = HealthResponse.safeParse(
      withKey(HEALTH, "ledgerContractVersion", API_CONTRACT_VERSION),
    );
    expect(result.success).toBe(false);
  });

  it("rejects any other version string", () => {
    for (const version of ["0.0.1", "1.0.1", "2.0.0", "", "latest"]) {
      expect(
        HealthResponse.safeParse(withKey(HEALTH, "apiContractVersion", version)).success,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe("routes", () => {
  it("freezes the route table", () => {
    expect(Object.isFrozen(API_ROUTES)).toBe(true);
    expect(Object.isFrozen(API_ALLOWED_METHODS)).toBe(true);
  });

  it("puts every route under the versioned prefix", () => {
    expect(API_ROUTE_PATTERNS.length).toBe(Object.keys(API_ROUTES).length);
    for (const pattern of API_ROUTE_PATTERNS) {
      expect(pattern.startsWith(API_BASE_PATH + "/")).toBe(true);
    }
  });

  it("answers reads only", () => {
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
  });

  it("builds a task path from a validated identifier", () => {
    expect(taskPath(TASK_ID)).toBe("/api/v1/tasks/" + TASK_ID);
  });

  it("encodes a worker identity as exactly one path component", () => {
    expect(workerPath(WRITER)).toBe("/api/v1/workers/claude%2Fopus%2Fimplementer%2F01");
    expect(workerPath(WRITER).split("/").length).toBe(
      "/api/v1/workers/x".split("/").length,
    );
  });

  it("refuses unsafe route parameters", () => {
    const unsafeTaskIds = [
      "../../etc/passwd",
      "..",
      TASK_ID + "/../" + OTHER_TASK_ID,
      TASK_ID + "?admin=1",
      TASK_ID + "#fragment",
      "",
      "not-a-uuid",
    ];
    for (const value of unsafeTaskIds) {
      expect(() => taskPath(value)).toThrow();
    }

    const unsafeIdentities = [
      "../../etc/passwd",
      "claude/opus/implementer",
      "claude/opus/implementer/01/extra",
      "claude/opus/IMPLEMENTER/01",
      "claude/opus/implementer/01\n",
      "",
    ];
    for (const value of unsafeIdentities) {
      expect(() => workerPath(value)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Strictness
// ---------------------------------------------------------------------------

describe("strictness", () => {
  it("accepts every representative fixture", () => {
    for (const [name, schema, fixture] of RESPONSE_SCHEMAS) {
      const result = schema.safeParse(fixture);
      expect(name + ":" + String(result.success)).toBe(name + ":true");
    }
  });

  it("rejects an unknown key on every response schema", () => {
    for (const [name, schema, fixture] of RESPONSE_SCHEMAS) {
      const result = schema.safeParse(withKey(fixture, "extra", "surprise"));
      expect(name + ":" + String(result.success)).toBe(name + ":false");
    }
  });

  it("rejects a missing required key on every response schema", () => {
    for (const [name, schema, fixture] of RESPONSE_SCHEMAS) {
      const [first] = Object.keys(fixture);
      expect(first).toBeDefined();
      const result = schema.safeParse(without(fixture, first ?? ""));
      expect(name + ":" + String(result.success)).toBe(name + ":false");
    }
  });
});

// ---------------------------------------------------------------------------
// Credential and transcript guards
// ---------------------------------------------------------------------------

describe("credential and transcript guards", () => {
  it("rejects a secret shaped field smuggled into any response", () => {
    for (const key of ["password", "apiKey", "sessionToken", "authorization", "cookie"]) {
      for (const [name, schema, fixture] of RESPONSE_SCHEMAS) {
        const result = schema.safeParse(withKey(fixture, key, "value"));
        expect(name + "/" + key + ":" + String(result.success)).toBe(
          name + "/" + key + ":false",
        );
      }
    }
  });

  it("rejects credential shaped event payload key names", () => {
    for (const key of ["apiToken", "password", "clientSecret", "refreshToken"]) {
      const result = TimelineItem.safeParse(
        withKey(TIMELINE_ITEM, "payloadKeys", ["safeKey", key]),
      );
      expect(key + ":" + String(result.success)).toBe(key + ":false");
    }
  });

  it("rejects transcript shaped event payload key names", () => {
    for (const key of ["transcript", "messages", "conversation", "rawResponse"]) {
      const result = TimelineItem.safeParse(
        withKey(TIMELINE_ITEM, "payloadKeys", [key]),
      );
      expect(key + ":" + String(result.success)).toBe(key + ":false");
    }
  });

  it("still accepts opaque locator key names", () => {
    const result = TimelineItem.safeParse(
      withKey(TIMELINE_ITEM, "payloadKeys", ["credentialRef", "authProfileRef"]),
    );
    expect(result.success).toBe(true);
  });

  it("rejects duplicated payload key names", () => {
    const result = TimelineItem.safeParse(
      withKey(TIMELINE_ITEM, "payloadKeys", ["a", "a"]),
    );
    expect(result.success).toBe(false);
  });

  it("never describes a payload value in the contract", () => {
    const parsed = TimelineItem.parse(TIMELINE_ITEM);
    expect(Object.keys(parsed)).not.toContain("payload");
  });
});

// ---------------------------------------------------------------------------
// Database path redaction
// ---------------------------------------------------------------------------

describe("database path redaction", () => {
  it("accepts a redacted identity", () => {
    expect(LedgerDatabaseIdentity.safeParse(DATABASE).success).toBe(true);
  });

  it("refuses anything path shaped in the label", () => {
    const labels = [
      "/Users/someone/ledger.sqlite",
      "..",
      "../ledger.sqlite",
      "nested/ledger.sqlite",
      "C:\\ledger.sqlite",
      "~/ledger.sqlite",
      ".hidden",
      "",
    ];
    for (const label of labels) {
      const result = LedgerDatabaseIdentity.safeParse(
        withKey(DATABASE as object, "label", label),
      );
      expect(label + ":" + String(result.success)).toBe(label + ":false");
    }
  });

  it("refuses an identity that drops the redaction marker", () => {
    expect(
      LedgerDatabaseIdentity.safeParse(withKey(DATABASE as object, "pathRedacted", false))
        .success,
    ).toBe(false);
  });

  it("refuses a raw ledger status carrying an absolute path", () => {
    const raw = withKey(LEDGER_STATUS, "path", "/Users/someone/control-plane.sqlite");
    expect(LedgerStatusResponse.safeParse(raw).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ledger shaped projections
// ---------------------------------------------------------------------------

describe("ledger shaped projections", () => {
  /** Exactly the ledger's own TaskReadModel row shape. */
  const taskReadModel = {
    taskId: TASK_ID,
    currentState: "RUNNING",
    latestAttempt: 1,
    eventCount: 7,
    firstSequence: 1,
    lastSequence: 7,
    lastEventId: EVENT_ID,
    lastEventType: "RUN_STARTED",
    lastTransitionId: "run.started",
    lastEmittedBy: WRITER,
    createdAt: AT,
    updatedAt: LATER,
    isTerminal: false,
  };

  /** Exactly the ledger's own WorkerReadModel row shape. */
  const workerReadModel = {
    identity: WRITER,
    provider: "claude",
    model: "opus",
    role: "implementer",
    instance: "01",
    eventCount: 7,
    taskCount: 2,
    firstSequence: 1,
    lastSequence: 7,
    firstSeenAt: AT,
    lastSeenAt: LATER,
    lastTaskId: TASK_ID,
    lastEventType: "RUN_STARTED",
  };

  it("refuses a raw task read model, because a summary is a narrower shape", () => {
    expect(TaskSummary.safeParse(taskReadModel).success).toBe(false);
  });

  it("accepts the deliberate projection of a task read model", () => {
    const projected = {
      taskId: taskReadModel.taskId,
      currentState: taskReadModel.currentState,
      isTerminal: taskReadModel.isTerminal,
      latestAttempt: taskReadModel.latestAttempt,
      eventCount: taskReadModel.eventCount,
      firstSequence: taskReadModel.firstSequence,
      lastSequence: taskReadModel.lastSequence,
      lastEventType: taskReadModel.lastEventType,
      lastEmittedBy: taskReadModel.lastEmittedBy,
      createdAt: taskReadModel.createdAt,
      updatedAt: taskReadModel.updatedAt,
    };
    expect(TaskSummary.safeParse(projected).success).toBe(true);
  });

  it("refuses a raw worker read model, because lastTaskId belongs to the detail", () => {
    expect(WorkerSummary.safeParse(workerReadModel).success).toBe(false);
  });

  it("accepts the deliberate projection of a worker read model", () => {
    const projected = without(workerReadModel, "lastTaskId");
    expect(WorkerSummary.safeParse(projected).success).toBe(true);
  });

  it("refuses a worker whose identity disagrees with its fields", () => {
    expect(WorkerSummary.safeParse(withKey(WORKER_SUMMARY, "provider", "kimi")).success).toBe(
      false,
    );
    expect(WorkerSummary.safeParse(withKey(WORKER_SUMMARY, "role", "reviewer")).success).toBe(
      false,
    );
  });

  it("refuses a detail that carries another task's events", () => {
    const foreign = withKey(TIMELINE_ITEM, "taskId", OTHER_TASK_ID);
    expect(TaskDetail.safeParse(withKey(TASK_DETAIL, "recentEvents", [foreign])).success).toBe(
      false,
    );
  });

  it("refuses a detail that carries another worker's events", () => {
    const foreign = withKey(TIMELINE_ITEM, "emittedBy", OTHER_WRITER);
    expect(
      WorkerDetail.safeParse(withKey(WORKER_DETAIL, "recentEvents", [foreign])).success,
    ).toBe(false);
  });

  it("refuses a task whose sequences run backwards", () => {
    expect(TaskSummary.safeParse(withKey(TASK_SUMMARY, "lastSequence", 0)).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Cursor pages
// ---------------------------------------------------------------------------

describe("cursor pages", () => {
  const page = {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    items: [TASK_SUMMARY],
    page: { nextCursor: null, hasMore: false, limit: DEFAULT_PAGE_LIMIT, returned: 1 },
  };

  it("accepts a terminal page", () => {
    expect(TaskPageResponse.safeParse(page).success).toBe(true);
  });

  it("accepts a continuing page that carries its cursor", () => {
    const next = withKey(page, "page", {
      nextCursor: TASK_ID,
      hasMore: true,
      limit: DEFAULT_PAGE_LIMIT,
      returned: 1,
    });
    expect(TaskPageResponse.safeParse(next).success).toBe(true);
  });

  it("refuses a page that claims more without a cursor", () => {
    const bad = withKey(page, "page", {
      nextCursor: null,
      hasMore: true,
      limit: DEFAULT_PAGE_LIMIT,
      returned: 1,
    });
    expect(TaskPageResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a page that offers a cursor it has nothing to serve", () => {
    const bad = withKey(page, "page", {
      nextCursor: TASK_ID,
      hasMore: false,
      limit: DEFAULT_PAGE_LIMIT,
      returned: 1,
    });
    expect(TaskPageResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a page that returned more than its limit", () => {
    const bad = {
      nextCursor: null,
      hasMore: false,
      limit: 1,
      returned: 2,
    };
    expect(CursorPageMeta.safeParse(bad).success).toBe(false);
  });

  it("refuses an oversized page limit", () => {
    const bad = withKey(page, "page", {
      nextCursor: null,
      hasMore: false,
      limit: MAX_PAGE_LIMIT + 1,
      returned: 1,
    });
    expect(TaskPageResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a page whose returned count disagrees with its items", () => {
    const overstated = withKey(page, "page", {
      nextCursor: null,
      hasMore: false,
      limit: DEFAULT_PAGE_LIMIT,
      returned: 2,
    });
    expect(TaskPageResponse.safeParse(overstated).success).toBe(false);

    const understated = withKey(page, "page", {
      nextCursor: null,
      hasMore: false,
      limit: DEFAULT_PAGE_LIMIT,
      returned: 0,
    });
    expect(TaskPageResponse.safeParse(understated).success).toBe(false);

    const emptyMismatch = {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items: [],
      page: { nextCursor: null, hasMore: false, limit: DEFAULT_PAGE_LIMIT, returned: 1 },
    };
    expect(TaskPageResponse.safeParse(emptyMismatch).success).toBe(false);

    const emptyConsistent = withKey(emptyMismatch, "page", {
      nextCursor: null,
      hasMore: false,
      limit: DEFAULT_PAGE_LIMIT,
      returned: 0,
    });
    expect(TaskPageResponse.safeParse(emptyConsistent).success).toBe(true);
  });

  it("paginates events with the same envelope", () => {
    const events = {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items: [TIMELINE_ITEM],
      page: { nextCursor: "7", hasMore: true, limit: 10, returned: 1 },
    };
    expect(EventPageResponse.safeParse(events).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

describe("query schemas", () => {
  it("defaults the page limit", () => {
    expect(TasksQuery.parse({}).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(WorkersQuery.parse({}).limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(EventsQuery.parse({}).limit).toBe(DEFAULT_PAGE_LIMIT);
  });

  it("coerces a string limit within the ceiling", () => {
    expect(TasksQuery.parse({ limit: "25" }).limit).toBe(25);
    expect(TasksQuery.parse({ limit: String(MAX_PAGE_LIMIT) }).limit).toBe(MAX_PAGE_LIMIT);
  });

  it("refuses a limit outside the ceiling instead of clamping it", () => {
    for (const limit of [
      "0",
      "-1",
      "1.5",
      "abc",
      String(MAX_PAGE_LIMIT + 1),
      "",
      "0x10",
      "1e2",
      " 25",
      "+25",
      "Infinity",
    ]) {
      expect(limit + ":" + String(TasksQuery.safeParse({ limit }).success)).toBe(
        limit + ":false",
      );
    }
  });

  it("refuses an unknown query parameter", () => {
    expect(TasksQuery.safeParse({ order: "desc" }).success).toBe(false);
    expect(WorkersQuery.safeParse({ order: "desc" }).success).toBe(false);
    expect(EventsQuery.safeParse({ order: "desc" }).success).toBe(false);
  });

  it("refuses an unsafe cursor", () => {
    for (const cursor of ["../../etc/passwd", "not-a-uuid", "", "1 OR 1=1"]) {
      expect(cursor + ":" + String(TasksQuery.safeParse({ cursor }).success)).toBe(
        cursor + ":false",
      );
    }
    for (const cursor of ["-1", "abc", "1.5", "0x10", "1e3", " 7", "+7", "Infinity"]) {
      expect(cursor + ":" + String(EventsQuery.safeParse({ cursor }).success)).toBe(
        cursor + ":false",
      );
    }
    for (const cursor of ["claude/opus/implementer", "../../etc", "CLAUDE/opus/implementer/01"]) {
      expect(cursor + ":" + String(WorkersQuery.safeParse({ cursor }).success)).toBe(
        cursor + ":false",
      );
    }
  });

  it("accepts the filters the read model actually supports", () => {
    expect(TasksQuery.safeParse({ state: "RUNNING", cursor: TASK_ID }).success).toBe(true);
    expect(WorkersQuery.safeParse({ role: "implementer", provider: "claude" }).success).toBe(
      true,
    );
    expect(
      EventsQuery.safeParse({ taskId: TASK_ID, type: "RUN_STARTED", cursor: "7" }).success,
    ).toBe(true);
  });

  it("refuses a filter value outside the frozen enums", () => {
    expect(TasksQuery.safeParse({ state: "ALMOST_DONE" }).success).toBe(false);
    expect(WorkersQuery.safeParse({ role: "manager" }).success).toBe(false);
    expect(EventsQuery.safeParse({ type: "TASK_MAYBE" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Overview honesty
// ---------------------------------------------------------------------------

describe("overview", () => {
  it("accepts each of the four honest states", () => {
    for (const [name, fixture] of [
      ["ACTIVE", OVERVIEW_ACTIVE],
      ["EMPTY", OVERVIEW_EMPTY],
      ["UNAVAILABLE", OVERVIEW_UNAVAILABLE],
      ["DEGRADED", OVERVIEW_DEGRADED],
    ] as const) {
      const result = OverviewResponse.safeParse(fixture);
      expect(name + ":" + String(result.success)).toBe(name + ":true");
    }
  });

  it("refuses an unavailable overview that still reports ledger facts", () => {
    const bad = withKey(OVERVIEW_UNAVAILABLE, "ledger", OVERVIEW_ACTIVE.ledger);
    expect(OverviewResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses an unavailable overview with no explanation", () => {
    expect(
      OverviewResponse.safeParse(withKey(OVERVIEW_UNAVAILABLE, "notice", null)).success,
    ).toBe(false);
  });

  it("refuses an empty overview that counts tasks", () => {
    const bad = withKey(OVERVIEW_EMPTY, "tasks", {
      total: 1,
      terminal: 0,
      active: 1,
      byState: [{ state: "RUNNING", count: 1 }],
    });
    expect(OverviewResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses an active overview over an empty ledger", () => {
    const bad = withKey(OVERVIEW_ACTIVE, "ledger", OVERVIEW_EMPTY.ledger);
    expect(OverviewResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses an active overview with a failing integrity verdict", () => {
    const bad = withKey(OVERVIEW_ACTIVE, "integrity", {
      checked: true,
      ok: false,
      problemCount: 1,
      checkedAt: AT,
    });
    expect(OverviewResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a degraded overview whose integrity was never checked", () => {
    const bad = withKey(OVERVIEW_DEGRADED, "integrity", {
      checked: false,
      ok: null,
      problemCount: null,
      checkedAt: null,
    });
    expect(OverviewResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses an unchecked integrity block that publishes a verdict anyway", () => {
    const bad = withKey(OVERVIEW_EMPTY, "integrity", {
      checked: false,
      ok: true,
      problemCount: 0,
      checkedAt: AT,
    });
    expect(OverviewResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a breakdown that does not sum to its total", () => {
    const bad = withKey(OVERVIEW_ACTIVE, "tasks", {
      total: 2,
      terminal: 1,
      active: 1,
      byState: [{ state: "RUNNING", count: 1 }],
    });
    expect(OverviewResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a repeated state in the breakdown", () => {
    const bad = withKey(OVERVIEW_ACTIVE, "tasks", {
      total: 2,
      terminal: 1,
      active: 1,
      byState: [
        { state: "RUNNING", count: 1 },
        { state: "RUNNING", count: 1 },
      ],
    });
    expect(OverviewResponse.safeParse(bad).success).toBe(false);
  });

  it("states in data that routing, accounts and leases do not exist yet", () => {
    const parsed = OverviewResponse.parse(OVERVIEW_ACTIVE);
    expect(parsed.capabilities).toEqual({
      readOnly: true,
      writes: false,
      routing: false,
      accounts: false,
      leases: false,
    });
  });

  it("refuses an overview that claims a capability this phase does not have", () => {
    for (const key of ["routing", "accounts", "leases", "writes"]) {
      const bad = withKey(
        OVERVIEW_ACTIVE,
        "capabilities",
        withKey(OVERVIEW_ACTIVE.capabilities, key, true),
      );
      expect(key + ":" + String(OverviewResponse.safeParse(bad).success)).toBe(
        key + ":false",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Health, status and integrity
// ---------------------------------------------------------------------------

describe("health, status and integrity", () => {
  it("refuses an unavailable plane that claims an open database", () => {
    const bad = withKey(withKey(HEALTH, "status", "UNAVAILABLE") as object, "detail", "why");
    expect(HealthResponse.safeParse(bad).success).toBe(false);
  });

  it("accepts an unavailable plane that names no database and says why", () => {
    const good = {
      ...HEALTH,
      status: "UNAVAILABLE",
      database: null,
      detail: "the ledger could not be opened",
    };
    expect(HealthResponse.safeParse(good).success).toBe(true);
  });

  it("refuses a degraded plane that does not say why", () => {
    const bad = withKey(HEALTH, "status", "DEGRADED");
    expect(HealthResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a health response that is not read only", () => {
    expect(HealthResponse.safeParse(withKey(HEALTH, "readOnly", false)).success).toBe(false);
  });

  it("refuses an empty ledger status with a nonzero head", () => {
    const bad = withKey(withKey(LEDGER_STATUS, "eventCount", 0) as object, "headSequence", 3);
    expect(LedgerStatusResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses duplicated migration versions", () => {
    const migration = { version: 1, name: "0001_initial", sha256: SHA256, appliedAt: AT };
    const bad = withKey(LEDGER_STATUS, "migrations", [migration, migration]);
    expect(LedgerStatusResponse.safeParse(bad).success).toBe(false);
  });

  it("mirrors exactly the ledger's integrity problem kinds", () => {
    expect([...INTEGRITY_PROBLEM_KINDS]).toEqual([
      "SQLITE_INTEGRITY",
      "FOREIGN_KEY",
      "MIGRATION",
      "SCHEMA_SHAPE",
      "EVENT_JSON",
      "EVENT_CONTRACT",
      "EVENT_COORDINATES",
      "HASH_CHAIN",
      "SEQUENCE",
      "LEDGER_META",
      "PROJECTION_META",
      "PROJECTION",
    ]);
  });

  it("refuses an ok integrity result that carries problems", () => {
    const bad = withKey(INTEGRITY_OK, "problems", [
      { kind: "HASH_CHAIN", detail: "sequence 3 digest mismatch", sequence: 3 },
    ]);
    expect(IntegrityResult.safeParse(bad).success).toBe(false);
  });

  it("refuses a failing integrity result that names nothing", () => {
    expect(IntegrityResult.safeParse(withKey(INTEGRITY_OK, "ok", false)).success).toBe(false);
  });

  it("accepts a failing integrity result that names its problems", () => {
    const failing = {
      ...INTEGRITY_OK,
      ok: false,
      problems: [{ kind: "HASH_CHAIN", detail: "sequence 3 digest mismatch", sequence: 3 }],
    };
    expect(IntegrityResult.safeParse(failing).success).toBe(true);
  });

  it("refuses an unknown integrity problem kind", () => {
    const bad = {
      ...INTEGRITY_OK,
      ok: false,
      problems: [{ kind: "VIBES", detail: "something felt wrong", sequence: null }],
    };
    expect(IntegrityResult.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

describe("error envelope", () => {
  it("accepts every declared error code", () => {
    for (const code of API_ERROR_CODES) {
      const result = ApiError.safeParse({
        apiContractVersion: API_CONTRACT_VERSION,
        error: { code, message: "failed", detail: null },
      });
      expect(code + ":" + String(result.success)).toBe(code + ":true");
    }
  });

  it("refuses an undeclared error code", () => {
    const result = ApiError.safeParse({
      apiContractVersion: API_CONTRACT_VERSION,
      error: { code: "TEAPOT", message: "failed", detail: null },
    });
    expect(result.success).toBe(false);
  });

  it("refuses an error that smuggles a credential shaped field", () => {
    const result = ApiError.safeParse({
      apiContractVersion: API_CONTRACT_VERSION,
      error: { code: "INTERNAL", message: "failed", detail: null, token: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("refuses an empty message", () => {
    const result = ApiError.safeParse({
      apiContractVersion: API_CONTRACT_VERSION,
      error: { code: "INTERNAL", message: "", detail: null },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("safe serialization", () => {
  it("survives a JSON round trip unchanged", () => {
    for (const [name, schema, fixture] of RESPONSE_SCHEMAS) {
      const parsed: unknown = schema.parse(fixture);
      const roundTripped: unknown = JSON.parse(JSON.stringify(parsed));
      expect(name).toBe(name);
      expect(roundTripped).toEqual(parsed);
      expect(schema.safeParse(roundTripped).success).toBe(true);
    }
  });

  it("produces no undefined member that JSON would silently drop", () => {
    for (const [name, schema, fixture] of RESPONSE_SCHEMAS) {
      const parsed: unknown = schema.parse(fixture);
      const serialized = JSON.stringify(parsed);
      expect(name + ":" + String(serialized.includes("undefined"))).toBe(name + ":false");
    }
  });
});

// ---------------------------------------------------------------------------
// Browser safety
// ---------------------------------------------------------------------------

describe("browser safety", () => {
  const SOURCE_FILES = ["index.ts", "version.ts", "routes.ts", "schemas.ts"];

  /**
   * Each label's actual location relative to this test file, now that every
   * source module but the barrel lives one level deeper under its own
   * subdirectory. `index.ts` alone stays at the package root, per the
   * mirrored-root exception; the other three moved to `<name>/index.ts`.
   */
  const SOURCE_PATHS: Readonly<Record<string, string>> = {
    "index.ts": "../../src/index.ts",
    "version.ts": "../../src/version/index.ts",
    "routes.ts": "../../src/routes/index.ts",
    "schemas.ts": "../../src/schemas/index.ts",
  };

  function read(name: string): string {
    const relativePath = SOURCE_PATHS[name];
    if (relativePath === undefined) {
      throw new Error("no known path for source file " + name);
    }
    return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
  }

  /**
   * Matched against module specifiers rather than against prose, so a comment
   * that names a forbidden dependency in order to forbid it does not trip the
   * check that enforces it.
   */
  function specifiers(source: string): string[] {
    const found: string[] = [];
    const pattern = /(?:^|[\s({])(?:import|export)[^\n;]*?from\s*["']([^"']+)["']/g;
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) found.push(specifier);
      match = pattern.exec(source);
    }
    const bare = /(?:^|[\s({])import\s*["']([^"']+)["']/g;
    let bareMatch = bare.exec(source);
    while (bareMatch !== null) {
      const specifier = bareMatch[1];
      if (specifier !== undefined) found.push(specifier);
      bareMatch = bare.exec(source);
    }
    return found;
  }

  /** Where a same-package import must land, whatever shape it is written in. */
  const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));

  /**
   * Does this specifier, read from this file, stay inside the package?
   *
   * Resolved rather than pattern-matched. Every module now lives in its own
   * subdirectory, so a sibling import is legitimately `"../<name>/index.js"` —
   * but accepting any `"../"` prefix would also accept
   * `"../../ledger/src/index.js"`, which leaves the package entirely and which
   * the ledger check below does not catch, because that check matches the
   * package *name* and not a path. Resolving against the importing file and
   * requiring the result to sit under `src/` admits exactly the shapes the
   * topology produces and refuses every escape, however it is spelled.
   */
  function staysInsidePackage(name: string, specifier: string): boolean {
    const importer = SOURCE_PATHS[name];
    if (importer === undefined) return false;
    const importerPath = fileURLToPath(new URL(importer, import.meta.url));
    return resolve(dirname(importerPath), specifier).startsWith(SRC_ROOT);
  }

  it("imports only browser resolvable modules", () => {
    const allowed = new Set(["zod", "@acp/contracts"]);
    for (const name of SOURCE_FILES) {
      for (const specifier of specifiers(read(name))) {
        const relative =
          (specifier.startsWith("./") || specifier.startsWith("../")) &&
          staysInsidePackage(name, specifier);
        const ok = allowed.has(specifier) || relative;
        expect(name + " imports " + specifier + ":" + String(ok)).toBe(
          name + " imports " + specifier + ":true",
        );
        expect(name + ":node-builtin:" + String(specifier.startsWith("node:"))).toBe(
          name + ":node-builtin:false",
        );
      }
    }
  });

  it("refuses a relative specifier that escapes the package", () => {
    // The hole the resolve-and-contain check exists to close: a path-based
    // reach into another package is not a browser-safe same-package import,
    // and the name-matching check below would not see it.
    expect(staysInsidePackage("schemas.ts", "../version/index.js")).toBe(true);
    expect(staysInsidePackage("schemas.ts", "../../ledger/src/index.js")).toBe(false);
    expect(staysInsidePackage("index.ts", "./version/index.js")).toBe(true);
    expect(staysInsidePackage("index.ts", "../../ledger/src/index.js")).toBe(false);
  });

  it("never imports the ledger or a database driver", () => {
    for (const name of SOURCE_FILES) {
      for (const specifier of specifiers(read(name))) {
        expect(name + ":" + specifier + ":ledger:" + String(specifier === "@acp/ledger")).toBe(
          name + ":" + specifier + ":ledger:false",
        );
        expect(
          name + ":" + specifier + ":sqlite:" + String(specifier.includes("sqlite")),
        ).toBe(name + ":" + specifier + ":sqlite:false");
      }
    }
  });

  it("touches no node global and uses no CommonJS require", () => {
    for (const name of SOURCE_FILES) {
      const source = read(name);
      expect(name + ":buffer:" + String(/\bBuffer\s*\./.test(source))).toBe(
        name + ":buffer:false",
      );
      expect(name + ":process:" + String(/\bprocess\s*\./.test(source))).toBe(
        name + ":process:false",
      );
      expect(name + ":require:" + String(/\brequire\s*\(/.test(source))).toBe(
        name + ":require:false",
      );
      expect(name + ":dirname:" + String(/__dirname|__filename/.test(source))).toBe(
        name + ":dirname:false",
      );
    }
  });

});

// ---------------------------------------------------------------------------
// Initiatives (P8-8A)
// ---------------------------------------------------------------------------

describe("the initiative data plane's shapes", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";
  const TASK = "11111111-1111-4111-8111-111111111111";
  const DIGEST = "a".repeat(64);
  const AT = "2026-08-30T12:00:00.000Z";

  const rollup = { tokensUsed: 10, tokensReserved: 5, skippedMalformed: 0 };

  function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      initiativeId: INITIATIVE,
      slug: "acp-p8",
      title: "The P8 initiative",
      objective: "Land the control plane's execution boundary",
      status: "ACTIVE",
      eventCount: 3,
      headRoadmapDigest: DIGEST,
      roadmapVersionCount: 2,
      taskCount: 1,
      rollup,
      createdAt: AT,
      updatedAt: AT,
      ...overrides,
    };
  }

  it("accepts a portfolio row and rejects an unknown field", () => {
    expect(InitiativeSummary.safeParse(summary()).success).toBe(true);
    expect(InitiativeSummary.safeParse({ ...summary(), extra: 1 }).success).toBe(false);
  });

  it("carries an absent registration detail as null rather than as an empty string", () => {
    // The registration payload is a bounded free-form record, so an initiative
    // registered without a title has none. Null says the stream never carried
    // one; "" would invent a value that reads as a title nobody wrote.
    expect(
      InitiativeSummary.safeParse(summary({ slug: null, title: null, objective: null })).success,
    ).toBe(true);
    expect(InitiativeSummary.safeParse(summary({ title: "" })).success).toBe(false);
  });

  it("refuses a portfolio row that would carry credential material", () => {
    // The landed guard refinements, on the way out as well as in. The
    // projection layer between the ledger and the client is new code, and a
    // boundary that only trusts the layer below it is not a boundary.
    const parsed = InitiativeSummary.safeParse({ ...summary(), apiKey: "sk-live-000" });
    expect(parsed.success).toBe(false);
  });

  it("marks exactly one roadmap version as the head", () => {
    const version = {
      roadmapVersionId: "66666666-6666-4666-8666-666666666666",
      initiativeId: INITIATIVE,
      version: 1,
      contentDigest: DIGEST,
      parentVersionId: null,
      kind: "EDIT",
      restoresVersionId: null,
      recordedBy: "kimi/k3/coordinator/01",
      recordedAt: AT,
      sequence: 1,
      head: true,
    };
    expect(RoadmapVersionDto.safeParse(version).success).toBe(true);
    expect(RoadmapVersionDto.safeParse({ ...version, contentDigest: "nope" }).success).toBe(false);
    expect(RoadmapVersionDto.safeParse({ ...version, kind: "REWRITE" }).success).toBe(false);
  });

  it("bounds a rollup by the same ceiling the fold uses", () => {
    expect(RollupSummary.safeParse(rollup).success).toBe(true);
    expect(RollupSummary.safeParse({ ...rollup, tokensUsed: 10_000_001 }).success).toBe(false);
    expect(RollupSummary.safeParse({ ...rollup, tokensUsed: -1 }).success).toBe(false);
  });

  it("shapes the three responses, each carrying both contract versions", () => {
    const portfolio = InitiativePortfolioResponse.safeParse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items: [summary()],
      count: 1,
    });
    expect(portfolio.success).toBe(true);

    const detail = InitiativeDetailResponse.safeParse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiative: {
        initiative: summary(),
        roadmap: [],
        tasks: [
          {
            taskId: TASK,
            currentState: "RUNNING",
            eventCount: 4,
            rollup,
            createdAt: AT,
            updatedAt: AT,
          },
        ],
        quota: { confidence: "HIGH", skippedMalformed: 0, unscopedTokensUsed: 0 },
      },
    });
    expect(detail.success).toBe(true);

    const roadmap = InitiativeRoadmapResponse.safeParse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId: INITIATIVE,
      items: [],
      count: 0,
    });
    expect(roadmap.success).toBe(true);
  });

  it("builds initiative paths under the versioned prefix, validating first", () => {
    expect(initiativePath(INITIATIVE)).toBe(API_ROUTES.initiatives + "/" + INITIATIVE);
    expect(initiativeRoadmapPath(INITIATIVE)).toBe(
      API_ROUTES.initiatives + "/" + INITIATIVE + "/roadmap",
    );
    // A traversal segment is refused at the validator, not encoded into a
    // request to somewhere else.
    expect(() => initiativePath("../../etc/passwd")).toThrow();
  });
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTROL_PLANE_EVENT_TYPES } from "@acp/contracts";

import {
  API_ALLOWED_METHODS,
  API_WRITE_METHODS,
  API_WRITE_ROUTES,
  API_BASE_PATH,
  API_CONTRACT_VERSION,
  API_ERROR_CODES,
  API_ROUTES,
  API_ROUTE_PATTERNS,
  TaskLifecycleExecuteResponse,
  TaskLifecycleRequest,
  TaskLifecycleResponse,
  isWriteRoute,
  ApiError,
  CursorPageMeta,
  DEFAULT_PAGE_LIMIT,
  EventPageResponse,
  EventsQuery,
  HealthResponse,
  InitiativeDetailResponse,
  InitiativePortfolioResponse,
  InitiativeRegistrationRequest,
  InitiativeRegistrationResponse,
  InitiativeRoadmapResponse,
  TaskIntakeRequest,
  TaskIntakeResponse,
  RegistryPublicationRequest,
  RegistryPublicationResponse,
  RoadmapVersionWriteRequest,
  ApiErrorCode,
  ACCOUNTS_UNAVAILABLE_REASONS,
  AccountDto,
  AccountsResponse,
  InitiativeAgentsResponse,
  InitiativeSummary,
  InitiativeTimelineResponse,
  MAX_SCOPED_AGENTS,
  MAX_SCOPED_TIMELINE_ITEMS,
  ROADMAP_CONTENT_MAX_BYTES,
  RoadmapContentQuery,
  RoadmapContentResponse,
  RoadmapVersionDto,
  RollupSummary,
  initiativeAgentsPath,
  initiativeEventsPath,
  initiativePath,
  initiativeRoadmapContentPath,
  initiativeRoadmapPath,
  INTEGRITY_PROBLEM_KINDS,
  COVERAGE_KINDS,
  WATERMARK_SOURCE_STREAMS,
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
  STREAM_CHANNELS,
  STREAM_CHANNEL_BY_EVENT_TYPE,
  STREAM_RESYNC_REASONS,
  StreamFrame,
  StreamQuery,
  taskPath,
  workerPath,
  ToolCallExecuteRequest,
  ToolCallExecuteResponse,
  ToolCallRow,
} from "../../src/index.js";

/**
 * The instruction content for a fixture whose prose is `text` (P-06/B, ADR 0094).
 *
 * One text block, so the envelope's `objective` equals the first text block of its
 * content and the two spellings stay one fact. `contentSha256` is a placeholder:
 * escalón B admits and publishes, and escalón C is where a digest is checked
 * against the bytes it describes.
 */
function fixtureContent(text: string): Record<string, unknown> {
  return {
    contentContractVersion: 1,
    blocks: [
      {
        kind: "text",
        blockId: "b1",
        mediaType: "text/plain; charset=utf-8",
        byteLength: new TextEncoder().encode(text).byteLength,
        contentSha256: "0".repeat(64),
        artifactRefId: null,
        text,
        toolCallId: null,
        effectId: null,
      },
    ],
  };
}


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

/** Which FILE, beside DATABASE's which PATH (P-10/id-B). */
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const RESTORE_ID = "22222222-2222-4222-8222-222222222222";

const INSTANCE: unknown = {
  instanceId: INSTANCE_ID,
  restoreId: RESTORE_ID,
  restoreEpoch: 0,
};

/** The one lawful null: a ledger whose identity predates the build serving it. */
const INSTANCE_ABSENT: unknown = {
  instanceId: null,
  restoreId: null,
  restoreEpoch: null,
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
  correlationId: null,
  causationId: null,
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
  instance: INSTANCE,
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
      rowCount: 2,
      updatedAt: AT,
      watermarks: [
        {
          sourceStream: "control_plane_events",
          appliedThroughSequence: 7,
          eventCount: 7,
          sourceHeadSha256: SHA256,
        },
      ],
    },
  ],
  observedAt: LATER,
};

/** A projection fed by two streams, which is the shape the vector exists for. */
const TWO_HEADED_PROJECTION = {
  name: "routing_assignment_read_model",
  rowCount: 1,
  updatedAt: AT,
  watermarks: [
    {
      sourceStream: "initiative_events",
      appliedThroughSequence: 4,
      eventCount: 4,
      sourceHeadSha256: SHA256,
    },
    {
      sourceStream: "registry_events",
      appliedThroughSequence: 0,
      eventCount: 0,
      sourceHeadSha256: "0".repeat(64),
    },
  ],
};

/**
 * One chained stream's coverage entry (P-08/B).
 *
 * Three of the four streams look exactly like this: covered from sequence one
 * because they were chained as they appended, and carrying no baseline because
 * there was never an instant at which they were not covered.
 */
const chainedCoverage = (
  sourceStream: string,
  checkedThroughSequence: number,
): Record<string, unknown> => ({
  sourceStream,
  coverageKind: "CHAIN_FROM_APPEND",
  coveredSinceSequence: 1,
  checkedThroughSequence,
  integrityActivatedAt: null,
  baselineSequence: null,
  baselineSha256: null,
});

/** The account stream's, which is the only one that can carry a baseline. */
const BASELINED_COVERAGE = {
  sourceStream: "account_events",
  coverageKind: "BASELINED_AT_ACTIVATION",
  coveredSinceSequence: 1,
  checkedThroughSequence: 5,
  integrityActivatedAt: AT,
  baselineSequence: 3,
  baselineSha256: SHA256,
};

/** Ordered by stream name, which is what the array's own refine requires. */
const COVERAGE = [
  BASELINED_COVERAGE,
  chainedCoverage("control_plane_events", 7),
  chainedCoverage("initiative_events", 0),
  chainedCoverage("registry_events", 2),
];

const INTEGRITY_OK = {
  apiContractVersion: API_CONTRACT_VERSION,
  ledgerContractVersion: LEDGER_CONTRACT_VERSION,
  ok: true,
  checkedEvents: 7,
  headSequence: 7,
  headEventSha256: SHA256,
  problems: [],
  coverage: COVERAGE,
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
    // P8-8D-pre: the read plane's method list did not move when the first
    // write route arrived, and it has not moved since. The exceptions live in
    // their own frozen table, which is the one that grows -- six entries as of
    // P-14/C, the newest being the task intake.
    expect([...API_WRITE_ROUTES]).toEqual([
      "initiativeRoadmap",
      "accountActions",
      "taskToolCalls",
      "taskLifecycle",
      "initiatives",
      "tasks",
    ]);
    expect([...API_WRITE_METHODS]).toEqual(["GET", "POST"]);
    expect(Object.isFrozen(API_WRITE_ROUTES)).toBe(true);
    expect(isWriteRoute("initiativeRoadmap")).toBe(true);
    // `tasks` answered reads only until P-14/C gave it the intake; the single
    // task beside it still does.
    expect(isWriteRoute("tasks")).toBe(true);
    expect(isWriteRoute("taskById")).toBe(false);
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

  // ---------------------------------------------------------------------
  // The watermark vector (P-09/log-D)
  //
  // The gateway forwards the ledger's array raw, so this schema is the only
  // boundary between a producer and every reader. What it does not refuse,
  // a browser renders as a real head.
  // ---------------------------------------------------------------------

  it("accepts a projection fed by two streams, with both of its heads", () => {
    const good = withKey(LEDGER_STATUS, "projections", [TWO_HEADED_PROJECTION]);
    expect(LedgerStatusResponse.safeParse(good).success).toBe(true);
  });

  it("refuses a projection with no watermark at all", () => {
    const bad = withKey(LEDGER_STATUS, "projections", [
      { name: "task_read_model", rowCount: 2, updatedAt: AT, watermarks: [] },
    ]);
    expect(LedgerStatusResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses more watermarks than there are streams", () => {
    const bad = withKey(LEDGER_STATUS, "projections", [
      {
        ...TWO_HEADED_PROJECTION,
        watermarks: [
          ...WATERMARK_SOURCE_STREAMS.map((sourceStream) => ({
            sourceStream,
            appliedThroughSequence: 1,
            eventCount: 1,
            sourceHeadSha256: SHA256,
          })),
          {
            sourceStream: "registry_events",
            appliedThroughSequence: 1,
            eventCount: 1,
            sourceHeadSha256: SHA256,
          },
        ],
      },
    ]);
    expect(LedgerStatusResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a stream named twice in one projection", () => {
    // Two heads for one stream has no answer to "which is the real one".
    const entry = TWO_HEADED_PROJECTION.watermarks[0];
    const bad = withKey(LEDGER_STATUS, "projections", [
      { ...TWO_HEADED_PROJECTION, watermarks: [entry, entry] },
    ]);
    expect(LedgerStatusResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a vector that is not ordered by source stream", () => {
    const bad = withKey(LEDGER_STATUS, "projections", [
      { ...TWO_HEADED_PROJECTION, watermarks: [...TWO_HEADED_PROJECTION.watermarks].reverse() },
    ]);
    expect(LedgerStatusResponse.safeParse(bad).success).toBe(false);
  });

  // ---------------------------------------------------------------------
  // The file identity on the wire (P-10/id-B)
  // ---------------------------------------------------------------------

  it("refuses an instance id that is not a uuid", () => {
    const bad = withKey(LEDGER_STATUS, "instance", {
      instanceId: "not-a-uuid",
      restoreId: RESTORE_ID,
      restoreEpoch: 0,
    });
    expect(LedgerStatusResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses a restore epoch that is not a non-negative integer", () => {
    for (const restoreEpoch of [-1, 1.5, "3", Number.NaN]) {
      const bad = withKey(LEDGER_STATUS, "instance", {
        instanceId: INSTANCE_ID,
        restoreId: RESTORE_ID,
        restoreEpoch,
      });
      expect(LedgerStatusResponse.safeParse(bad).success, String(restoreEpoch)).toBe(false);
    }
  });

  it("refuses a half-present instance identity on the wire", () => {
    // Three independently nullable fields would admit six mixed shapes, and
    // "an instance with no restore" is a question with no answer: the ledger
    // writes the three rows in one transaction. The one lawful null is the
    // whole triple.
    const mixed = [
      { instanceId: INSTANCE_ID, restoreId: null, restoreEpoch: null },
      { instanceId: null, restoreId: RESTORE_ID, restoreEpoch: null },
      { instanceId: null, restoreId: null, restoreEpoch: 0 },
      { instanceId: INSTANCE_ID, restoreId: RESTORE_ID, restoreEpoch: null },
      { instanceId: INSTANCE_ID, restoreId: null, restoreEpoch: 0 },
      { instanceId: null, restoreId: RESTORE_ID, restoreEpoch: 0 },
    ];
    for (const instance of mixed) {
      const bad = withKey(LEDGER_STATUS, "instance", instance);
      expect(LedgerStatusResponse.safeParse(bad).success, JSON.stringify(instance)).toBe(false);
    }
  });

  it("accepts an identity that is wholly absent, which is the pre-upgrade window", () => {
    const good = withKey(LEDGER_STATUS, "instance", INSTANCE_ABSENT);
    expect(LedgerStatusResponse.safeParse(good).success).toBe(true);
  });

  it("refuses a source stream the contract does not define", () => {
    const bad = withKey(LEDGER_STATUS, "projections", [
      {
        ...TWO_HEADED_PROJECTION,
        watermarks: [
          { ...TWO_HEADED_PROJECTION.watermarks[0], sourceStream: "outbox_message" },
        ],
      },
    ]);
    expect(LedgerStatusResponse.safeParse(bad).success).toBe(false);
  });

  it("refuses an extra or a missing field inside a watermark entry", () => {
    // The uniform strictness loop above only reaches the top level; a strict
    // object nested two deep has to be asserted where it lives.
    const entry = TWO_HEADED_PROJECTION.watermarks[0];
    const extra = withKey(LEDGER_STATUS, "projections", [
      {
        ...TWO_HEADED_PROJECTION,
        watermarks: [{ ...entry, projectorVersion: 1 }],
      },
    ]);
    expect(LedgerStatusResponse.safeParse(extra).success).toBe(false);

    for (const field of [
      "sourceStream",
      "appliedThroughSequence",
      "eventCount",
      "sourceHeadSha256",
    ]) {
      const missing = withKey(LEDGER_STATUS, "projections", [
        { ...TWO_HEADED_PROJECTION, watermarks: [without(entry as object, field)] },
      ]);
      expect(LedgerStatusResponse.safeParse(missing).success, field).toBe(false);
    }
  });

  it("refuses a projection carrying the retired flat head fields", () => {
    // The wire break is complete: there is no dual form, so the old shape does
    // not parse as a courtesy to an un-upgraded producer.
    const bad = withKey(LEDGER_STATUS, "projections", [
      {
        name: "task_read_model",
        appliedThroughSequence: 7,
        eventCount: 7,
        sourceHeadSha256: SHA256,
        updatedAt: AT,
        rowCount: 2,
      },
    ]);
    expect(LedgerStatusResponse.safeParse(bad).success).toBe(false);
  });

  it("counts projections and not heads against the fifty-projection bound", () => {
    const projection = (index: number) => ({
      ...TWO_HEADED_PROJECTION,
      name: "projection_" + String(index),
    });
    // Twenty two-headed projections is forty heads, and passes.
    const twenty = withKey(
      LEDGER_STATUS,
      "projections",
      Array.from({ length: 20 }, (_, index) => projection(index)),
    );
    expect(LedgerStatusResponse.safeParse(twenty).success).toBe(true);

    const fiftyOne = withKey(
      LEDGER_STATUS,
      "projections",
      Array.from({ length: 51 }, (_, index) => projection(index)),
    );
    expect(LedgerStatusResponse.safeParse(fiftyOne).success).toBe(false);
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

  // -------------------------------------------------------------------------
  // The coverage report (P-08/B)
  // -------------------------------------------------------------------------
  //
  // Coverage says FROM WHEN each stream's chain is evidence. It is a different
  // claim from the problem list, which says whether that evidence holds, and
  // NEITHER of them asserts authenticity of anything recorded before coverage
  // began. These refines exist so a producer cannot blur the two on the wire.

  it("requires exactly one coverage entry per stream, in stream order", () => {
    expect(IntegrityResult.safeParse(INTEGRITY_OK).success).toBe(true);
    expect(INTEGRITY_OK.coverage).toHaveLength(WATERMARK_SOURCE_STREAMS.length);

    // A subset is refused rather than tolerated: the interesting answer is the
    // account stream's, and a report free to omit a stream is free to omit
    // exactly that one.
    const short = withKey(INTEGRITY_OK, "coverage", COVERAGE.slice(1));
    expect(IntegrityResult.safeParse(short).success).toBe(false);

    // Four entries naming three streams. The length alone would pass.
    const duplicated = withKey(INTEGRITY_OK, "coverage", [
      BASELINED_COVERAGE,
      BASELINED_COVERAGE,
      chainedCoverage("control_plane_events", 7),
      chainedCoverage("initiative_events", 0),
    ]);
    expect(IntegrityResult.safeParse(duplicated).success).toBe(false);

    const unordered = withKey(INTEGRITY_OK, "coverage", [
      COVERAGE[1],
      COVERAGE[0],
      COVERAGE[2],
      COVERAGE[3],
    ]);
    expect(IntegrityResult.safeParse(unordered).success).toBe(false);
  });

  it("refuses an ok integrity result that reports a stream with no coverage", () => {
    // The gate. `NOT_ACTIVATED` means "does not satisfy the integrity gate,
    // even though a legacy read may be possible" — so it cannot sit inside a
    // passing verdict. The value stays in the vocabulary because another build
    // may legitimately emit it; what is refused is emitting it beside `ok`.
    const unactivated = [
      {
        sourceStream: "account_events",
        coverageKind: "NOT_ACTIVATED",
        coveredSinceSequence: null,
        checkedThroughSequence: 0,
        integrityActivatedAt: null,
        baselineSequence: null,
        baselineSha256: null,
      },
      ...COVERAGE.slice(1),
    ];
    const bad = withKey(INTEGRITY_OK, "coverage", unactivated);
    expect(IntegrityResult.safeParse(bad).success).toBe(false);

    // The same coverage under a failing verdict is exactly what a tampered
    // ledger reports, and must parse.
    expect(
      IntegrityResult.safeParse({
        ...INTEGRITY_OK,
        ok: false,
        coverage: unactivated,
        problems: [{ kind: "LEDGER_META", detail: "none of the five keys", sequence: null }],
      }).success,
    ).toBe(true);
  });

  it("makes the shape of a coverage entry a function of its kind", () => {
    const replace = (entry: Record<string, unknown>): unknown =>
      withKey(INTEGRITY_OK, "coverage", [entry, ...COVERAGE.slice(1)]);

    // A chained stream wearing a baseline. This is the shape that would let a
    // producer present retroactive coverage as if it had always been there.
    expect(
      IntegrityResult.safeParse(
        replace({ ...chainedCoverage("account_events", 5), baselineSequence: 3 }),
      ).success,
    ).toBe(false);

    // A baselined stream with its provenance blanked — the same lie pointing
    // the other way: coverage claimed from sequence one with nothing recording
    // when, or from what, it was taken.
    for (const field of ["integrityActivatedAt", "baselineSequence", "baselineSha256"]) {
      expect(
        IntegrityResult.safeParse(replace({ ...BASELINED_COVERAGE, [field]: null })).success,
        field,
      ).toBe(false);
    }

    // An unactivated stream that claims to cover something.
    expect(
      IntegrityResult.safeParse(
        replace({
          sourceStream: "account_events",
          coverageKind: "NOT_ACTIVATED",
          coveredSinceSequence: 1,
          checkedThroughSequence: 0,
          integrityActivatedAt: null,
          baselineSequence: null,
          baselineSha256: null,
        }),
      ).success,
    ).toBe(false);

    // A baseline ahead of the cut examined PARSES, and that is the point.
    //
    // `{baselineSequence: 3, checkedThroughSequence: 2}` is exactly what a
    // ledger whose account stream was truncated below its own baseline reports
    // — truthfully — and the verifier already names it as a `LEDGER_META`
    // finding. The wire has to be able to carry that beside `ok: false`.
    // Refusing the pair as a shape violation would turn the honest report of a
    // tampered ledger into a 500 at the door, which is the one outcome the
    // report exists to prevent.
    expect(
      IntegrityResult.safeParse({
        ...INTEGRITY_OK,
        ok: false,
        problems: [
          {
            kind: "LEDGER_META",
            detail:
              "the account integrity baseline names sequence 3 which the chain does not reach",
            sequence: null,
          },
        ],
        coverage: [
          { ...BASELINED_COVERAGE, checkedThroughSequence: 2 },
          ...COVERAGE.slice(1),
        ],
      }).success,
    ).toBe(true);

    // And only the account stream has a sidecar at all. The other three chain
    // as they append, so they can be neither baselined nor unactivated, and a
    // report that said otherwise would be describing a mechanism that does not
    // exist.
    expect(
      IntegrityResult.safeParse(
        withKey(INTEGRITY_OK, "coverage", [
          COVERAGE[0],
          { ...BASELINED_COVERAGE, sourceStream: "control_plane_events" },
          COVERAGE[2],
          COVERAGE[3],
        ]),
      ).success,
    ).toBe(false);
  });

  it("accepts an empty stream as covered from one through zero", () => {
    // `[1, 0]` is the positive, and it is not a contradiction: covered from the
    // first row it will ever hold, holding none yet. `null` there would say
    // "covers nothing", which is the vocabulary for a stream with no chain.
    const empty = COVERAGE[2] as Record<string, unknown>;
    expect([empty["coveredSinceSequence"], empty["checkedThroughSequence"]]).toEqual([1, 0]);
    expect(IntegrityResult.safeParse(INTEGRITY_OK).success).toBe(true);

    // Zero is the floor. A head below it is not a shorter cut, it is nonsense.
    expect(
      IntegrityResult.safeParse(
        withKey(INTEGRITY_OK, "coverage", [
          COVERAGE[0],
          COVERAGE[1],
          { ...chainedCoverage("initiative_events", 0), checkedThroughSequence: -1 },
          COVERAGE[3],
        ]),
      ).success,
    ).toBe(false);
  });

  it("refuses an unknown coverage kind", () => {
    const bad = withKey(INTEGRITY_OK, "coverage", [
      { ...BASELINED_COVERAGE, coverageKind: "PROBABLY_FINE" },
      ...COVERAGE.slice(1),
    ]);
    expect(IntegrityResult.safeParse(bad).success).toBe(false);
    expect(COVERAGE_KINDS).toEqual([
      "CHAIN_FROM_APPEND",
      "BASELINED_AT_ACTIVATION",
      "NOT_ACTIVATED",
    ]);
  });

  it("refuses an extra or a missing key inside a coverage entry", () => {
    const missing: Record<string, unknown> = { ...BASELINED_COVERAGE };
    delete missing["baselineSha256"];
    expect(
      IntegrityResult.safeParse(withKey(INTEGRITY_OK, "coverage", [missing, ...COVERAGE.slice(1)]))
        .success,
    ).toBe(false);

    expect(
      IntegrityResult.safeParse(
        withKey(INTEGRITY_OK, "coverage", [
          { ...BASELINED_COVERAGE, coveredThrough: 9 },
          ...COVERAGE.slice(1),
        ]),
      ).success,
    ).toBe(false);
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

describe("the roadmap content read", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";
  const DIGEST = "a".repeat(64);

  function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId: INITIATIVE,
      version: 2,
      contentDigest: DIGEST,
      kind: "EDIT",
      content: "# The P8 roadmap\n",
      ...overrides,
    };
  }

  it("reads the selector as a version number, not as whatever Number() would take", () => {
    expect(RoadmapContentQuery.parse({ version: "3" }).version).toBe(3);
    expect(RoadmapContentQuery.parse({ version: 3 }).version).toBe(3);
    for (const version of ["0x2", "1e3", " 3", "3.0", "+3", "", "3 "]) {
      expect(version + ":" + String(RoadmapContentQuery.safeParse({ version }).success)).toBe(
        version + ":false",
      );
    }
  });

  it("requires a version and refuses the ones no fold can hold", () => {
    // Versions are one-based, so 0 is not a lower bound to clamp to — it is a
    // selector for a version that cannot exist. Absent is refused outright
    // rather than defaulted to the head: a caller that meant the head can ask
    // the metadata route which version that is and say so.
    expect(RoadmapContentQuery.safeParse({}).success).toBe(false);
    expect(RoadmapContentQuery.safeParse({ version: "0" }).success).toBe(false);
    expect(RoadmapContentQuery.safeParse({ version: -1 }).success).toBe(false);
    expect(RoadmapContentQuery.safeParse({ version: "1000001" }).success).toBe(false);
  });

  it("refuses a digest selector, which is the boundary and not an omission", () => {
    // The strictness here is load-bearing. A digest selector would have let any
    // caller fetch any object in the store by naming its digest, including one
    // recorded against a different initiative; the version selector can only
    // name something the initiative's own fold already knows.
    expect(RoadmapContentQuery.safeParse({ digest: DIGEST }).success).toBe(false);
    expect(RoadmapContentQuery.safeParse({ version: 1, digest: DIGEST }).success).toBe(false);
  });

  it("shapes the response around the content and the record that names it", () => {
    expect(RoadmapContentResponse.safeParse(body()).success).toBe(true);
    expect(RoadmapContentResponse.safeParse({ ...body(), extra: 1 }).success).toBe(false);
    expect(RoadmapContentResponse.safeParse({ ...body(), contentDigest: "nope" }).success).toBe(
      false,
    );
    expect(RoadmapContentResponse.safeParse({ ...body(), kind: "REWRITE" }).success).toBe(false);
    expect(RoadmapContentResponse.safeParse({ ...body(), version: 0 }).success).toBe(false);
  });

  it("bounds the content by the same ceiling the store enforces", () => {
    // Restated as a contract term rather than re-derived, so the route and the
    // store cannot drift to two different megabytes.
    const at = "x".repeat(ROADMAP_CONTENT_MAX_BYTES);
    expect(RoadmapContentResponse.safeParse(body({ content: at })).success).toBe(true);
    expect(RoadmapContentResponse.safeParse(body({ content: at + "x" })).success).toBe(false);
    // An empty document is refused: the store never admitted one, so a response
    // carrying one would be reporting a store the plane does not have.
    expect(RoadmapContentResponse.safeParse(body({ content: "" })).success).toBe(false);
  });

  it("refuses to carry a credential shape out of the store", () => {
    // The guards ran on ingest and they run again here. Not because the store
    // is distrusted, but because this is the response that carries free text to
    // a browser and a terminal, and a boundary that only trusts the layer below
    // it is not a boundary.
    const planted = "# Setup\n\nRun with sk-ant-api03-" + "B".repeat(80) + "\n";
    expect(RoadmapContentResponse.safeParse(body({ content: planted })).success).toBe(false);
  });

  it("builds the content path under the versioned prefix, validating first", () => {
    expect(initiativeRoadmapContentPath(INITIATIVE)).toBe(
      API_ROUTES.initiatives + "/" + INITIATIVE + "/roadmap/content",
    );
    expect(() => initiativeRoadmapContentPath("../../etc/passwd")).toThrow();
  });

  it("is a read: the content route is not among the write routes", () => {
    // Asserted against the one route that IS a write, so this discriminates
    // rather than restating that most routes are reads.
    expect(isWriteRoute("initiativeRoadmap")).toBe(true);
    expect(isWriteRoute("initiativeRoadmapContent")).toBe(false);
    expect(API_WRITE_ROUTES).not.toContain("initiativeRoadmapContent");
  });
});

describe("the scoped initiative reads (P8-8E-pre)", () => {
  const INITIATIVE = "44444444-4444-4444-8444-444444444444";
  const OTHER_EVENT = "55555555-5555-4555-8555-555555555555";

  const taskRow = {
    stream: "TASK",
    sequence: 3,
    eventId: EVENT_ID,
    taskId: TASK_ID,
    type: "RUN_STARTED",
    fromState: "READY",
    toState: "RUNNING",
    emittedBy: WRITER,
    occurredAt: AT,
    recordedAt: AT,
    correlationId: null,
    causationId: null,
  };

  const initiativeRow = {
    stream: "INITIATIVE",
    sequence: 1,
    eventId: OTHER_EVENT,
    initiativeId: INITIATIVE,
    type: "INITIATIVE_REGISTERED",
    fromStatus: null,
    toStatus: "ACTIVE",
    emittedBy: WRITER,
    occurredAt: AT,
    recordedAt: AT,
  };

  function timeline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId: INITIATIVE,
      items: [initiativeRow, taskRow],
      count: 2,
      truncated: false,
      ...overrides,
    };
  }

  it("surfaces the edge facts on the base event DTO (C1)", () => {
    // The facts the graph's edges are drawn from. Nullable because most events
    // cause nothing, and carried rather than omitted so a reader can tell
    // "no cause recorded" from "this build does not report causes".
    expect(TimelineItem.parse(TIMELINE_ITEM).causationId).toBeNull();
    expect(TimelineItem.parse({ ...TIMELINE_ITEM, causationId: EVENT_ID }).causationId).toBe(EVENT_ID);
    expect(TimelineItem.safeParse({ ...TIMELINE_ITEM, causationId: "nope" }).success).toBe(false);
    // Absent is not the same as null, and strictness says so.
    const withoutEdges: Record<string, unknown> = { ...TIMELINE_ITEM };
    delete withoutEdges["causationId"];
    expect(TimelineItem.safeParse(withoutEdges).success).toBe(false);
  });

  it("tags each timeline row with its stream, and keeps the two shapes apart", () => {
    expect(InitiativeTimelineResponse.safeParse(timeline()).success).toBe(true);
    // A task row carrying an initiative row's field, and the reverse: the
    // discriminated union refuses both, which is what makes the tag load-bearing
    // rather than decorative.
    expect(
      InitiativeTimelineResponse.safeParse(
        timeline({ items: [{ ...taskRow, toStatus: "ACTIVE" }], count: 1 }),
      ).success,
    ).toBe(false);
    expect(
      InitiativeTimelineResponse.safeParse(
        timeline({ items: [{ ...initiativeRow, causationId: null }], count: 1 }),
      ).success,
    ).toBe(false);
    expect(
      InitiativeTimelineResponse.safeParse(
        timeline({ items: [{ ...taskRow, stream: "BOTH" }], count: 1 }),
      ).success,
    ).toBe(false);
  });

  it("bounds the timeline and makes truncation a stated fact", () => {
    const many = Array.from({ length: MAX_SCOPED_TIMELINE_ITEMS }, () => taskRow);
    expect(
      InitiativeTimelineResponse.safeParse(timeline({ items: many, count: many.length })).success,
    ).toBe(true);
    expect(
      InitiativeTimelineResponse.safeParse(
        timeline({ items: [...many, taskRow], count: many.length + 1 }),
      ).success,
    ).toBe(false);
    // `truncated` is required: a reader must never have to infer from a full
    // page whether the fold stopped early.
    const withoutFlag: Record<string, unknown> = timeline();
    delete withoutFlag["truncated"];
    expect(InitiativeTimelineResponse.safeParse(withoutFlag).success).toBe(false);
  });

  it("shapes a scoped agent row and refuses credential material in it", () => {
    const agents = {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId: INITIATIVE,
      items: [
        {
          identity: WRITER,
          provider: "anthropic",
          model: "claude-opus-5",
          role: "implementer",
          instance: "01",
          eventCount: 4,
          taskCount: 2,
          firstSeenAt: AT,
          lastSeenAt: LATER,
          currentTaskId: TASK_ID,
          lastEventType: "RUN_STARTED",
        },
      ],
      count: 1,
    };
    expect(InitiativeAgentsResponse.safeParse(agents).success).toBe(true);
    expect(InitiativeAgentsResponse.safeParse({ ...agents, extra: 1 }).success).toBe(false);
    // The guards run here too: an agent row is a projection of free-ish text
    // (provider, model) heading for a browser.
    expect(
      InitiativeAgentsResponse.safeParse({
        ...agents,
        items: [{ ...agents.items[0], model: "sk-ant-api03-" + "A".repeat(80) }],
      }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: MAX_SCOPED_AGENTS + 1 }, () => agents.items[0]);
    expect(InitiativeAgentsResponse.safeParse({ ...agents, items: tooMany, count: tooMany.length }).success).toBe(false);
  });

  it("builds both scoped paths under the versioned prefix, validating first", () => {
    expect(initiativeEventsPath(INITIATIVE)).toBe(API_ROUTES.initiatives + "/" + INITIATIVE + "/events");
    expect(initiativeAgentsPath(INITIATIVE)).toBe(API_ROUTES.initiatives + "/" + INITIATIVE + "/agents");
    expect(() => initiativeEventsPath("../../etc/passwd")).toThrow();
    expect(() => initiativeAgentsPath("../../etc/passwd")).toThrow();
  });

  it("keeps both scoped routes reads", () => {
    expect(isWriteRoute("initiativeRoadmap")).toBe(true);
    expect(isWriteRoute("initiativeEvents")).toBe(false);
    expect(isWriteRoute("initiativeAgents")).toBe(false);
  });
});

describe("the accounts read (P8-8F)", () => {
  const ACCOUNT = {
    accountId: "acct-primary",
    provider: "anthropic",
    models: ["opus", "sonnet"],
    plan: "max",
    state: "AVAILABLE",
    quota: { remainingRatio: 0.5, confidence: "MEDIUM" },
    reset: { nextResetAt: AT, source: "DECLARED", confidence: "HIGH" },
    lastProbeAt: null,
    lastError: null,
    effectiveState: "AVAILABLE",
    stateSource: "OWNER_FILE",
    lastAction: null,
  };

  function ready(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      status: "READY",
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items: [ACCOUNT],
      count: 1,
      estimatedAt: AT,
      ...overrides,
    };
  }

  it("shapes an account and refuses an unknown field", () => {
    expect(AccountDto.safeParse(ACCOUNT).success).toBe(true);
    expect(AccountDto.safeParse({ ...ACCOUNT, extra: 1 }).success).toBe(false);
  });

  it("has no place to put a credential or profile reference at all", () => {
    // Not nulled, not redacted — absent. Strictness makes the omission
    // enforceable: a server that grew either field fails here rather than
    // shipping a name that says a secret exists and where to look for it.
    expect(AccountDto.safeParse({ ...ACCOUNT, credentialRef: null }).success).toBe(false);
    expect(AccountDto.safeParse({ ...ACCOUNT, authProfileRef: "profile://x" }).success).toBe(false);
    expect(Object.keys(AccountDto.shape)).not.toContain("credentialRef");
  });

  it("keeps quota and reset confidence separate, because they are separately known", () => {
    // An account can have a well-observed spend rate and no idea when its
    // window rolls over. One shared confidence would report the better-known
    // fact as if the worse-known one were equally sound.
    expect(
      AccountDto.safeParse({
        ...ACCOUNT,
        quota: { remainingRatio: 0.9, confidence: "HIGH" },
        reset: { nextResetAt: null, source: "UNKNOWN", confidence: "LOW" },
      }).success,
    ).toBe(true);
    // Null ratio is a real answer — the fold could not estimate. Zero would be
    // a different and false claim.
    expect(AccountDto.safeParse({ ...ACCOUNT, quota: { remainingRatio: null, confidence: "LOW" } }).success).toBe(true);
    expect(AccountDto.safeParse({ ...ACCOUNT, quota: { remainingRatio: 1.5, confidence: "LOW" } }).success).toBe(false);
  });

  it("accepts both union arms and keeps them apart", () => {
    expect(AccountsResponse.safeParse(ready()).success).toBe(true);
    const unavailable = {
      status: "UNAVAILABLE",
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      reason: "ACCOUNTS_FILE_ABSENT",
    };
    expect(AccountsResponse.safeParse(unavailable).success).toBe(true);
    // Detail is optional; a refusal that has nothing to point at says nothing.
    expect(AccountsResponse.safeParse({ ...unavailable, detail: "accounts[0].provider" }).success).toBe(true);
    // The arms do not blend: a READY body may not carry a reason, and an
    // UNAVAILABLE body may not carry items.
    expect(AccountsResponse.safeParse({ ...ready(), reason: "ACCOUNTS_FILE_ABSENT" }).success).toBe(false);
    expect(AccountsResponse.safeParse({ ...unavailable, items: [], count: 0 }).success).toBe(false);
  });

  it("round-trips every word of the closed vocabulary, and refuses one outside it", () => {
    for (const reason of ACCOUNTS_UNAVAILABLE_REASONS) {
      const parsed = AccountsResponse.safeParse({
        status: "UNAVAILABLE",
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        reason,
      });
      expect({ reason, ok: parsed.success }).toEqual({ reason, ok: true });
    }
    expect(
      AccountsResponse.safeParse({
        status: "UNAVAILABLE",
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        reason: "ACCOUNTS_FILE_HAUNTED",
      }).success,
    ).toBe(false);
  });

  it("refuses credential material anywhere in either arm", () => {
    const planted = "sk-ant-api03-" + "A".repeat(80);
    expect(AccountsResponse.safeParse(ready({ items: [{ ...ACCOUNT, plan: planted }] })).success).toBe(false);
    expect(
      AccountsResponse.safeParse({
        status: "UNAVAILABLE",
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        reason: "ACCOUNTS_FILE_SCHEMA_REFUSED",
        detail: planted,
      }).success,
    ).toBe(false);
  });

  it("is a read", () => {
    expect(isWriteRoute("accounts")).toBe(false);
    expect(API_ROUTES.accounts).toBe("/api/v1/accounts");
  });
});

describe("the initiative registration's wire contract (P-14/B)", () => {
  const INITIATIVE_ID = "55555555-5555-4555-8555-555555555555";

  function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      initiativeId: INITIATIVE_ID,
      slug: "acp-p14",
      title: "The P-14 bootstrap",
      objective: "Register an initiative by command and by API.",
      recordedBy: WRITER,
      ...overrides,
    };
  }

  function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      replayed: false,
      sequence: 1,
      registration: {
        initiativeId: INITIATIVE_ID,
        slug: "acp-p14",
        title: "The P-14 bootstrap",
        objectiveSha256: SHA256,
        status: "ACTIVE",
        eventCount: 1,
        createdAt: "2026-09-13T12:00:00.000Z",
        updatedAt: "2026-09-13T12:00:00.000Z",
      },
      ...overrides,
    };
  }

  it("admits the five fields and names the caller's own initiative id", () => {
    expect(InitiativeRegistrationRequest.safeParse(registration()).success).toBe(true);
    expect(Object.keys(InitiativeRegistrationRequest.shape).sort()).toEqual(
      ["initiativeId", "objective", "recordedBy", "slug", "title"],
    );
    expect(InitiativeRegistrationRequest.safeParse(registration({ initiativeId: "not-a-uuid" })).success).toBe(false);
  });

  it("refuses what the door composes or computes, so a caller cannot state it", () => {
    for (const composed of [{ status: "ACTIVE" }, { createdAt: "2026-09-13T12:00:00.000Z" }, { objectiveSha256: SHA256 }]) {
      expect(InitiativeRegistrationRequest.safeParse(registration(composed)).success).toBe(false);
    }
  });

  it("bounds every field, the objective at the contract's four thousand", () => {
    expect(InitiativeRegistrationRequest.safeParse(registration({ objective: "o".repeat(4_000) })).success).toBe(true);
    expect(InitiativeRegistrationRequest.safeParse(registration({ objective: "o".repeat(4_001) })).success).toBe(false);
    expect(InitiativeRegistrationRequest.safeParse(registration({ objective: "" })).success).toBe(false);
    expect(InitiativeRegistrationRequest.safeParse(registration({ title: "t".repeat(201) })).success).toBe(false);
    expect(InitiativeRegistrationRequest.safeParse(registration({ slug: "s".repeat(81) })).success).toBe(false);
  });

  it("N-P14B-4: refuses a credential-shaped objective at its own path, before any door acts", () => {
    const planted = registration({ objective: "deploy with sk-ant-api03-" + "A".repeat(40) });
    const parsed = InitiativeRegistrationRequest.safeParse(planted);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("objective");
  });

  it("answers the registration by digest and never echoes the objective", () => {
    expect(InitiativeRegistrationResponse.safeParse(response()).success).toBe(true);
    const echoed = response();
    (echoed["registration"] as Record<string, unknown>)["objective"] = "Register an initiative.";
    expect(InitiativeRegistrationResponse.safeParse(echoed).success).toBe(false);
    expect(InitiativeRegistrationResponse.safeParse(response({ replayed: "yes" })).success).toBe(false);
    expect(InitiativeRegistrationResponse.safeParse(response({ sequence: 0 })).success).toBe(false);
  });

  it("N-P14B-14: moves the API version and the write table, and adds no error code", () => {
    // `0.16.0` when it landed; P-14/C's sixth write door moved it again.
    expect(API_CONTRACT_VERSION).toBe("0.18.0");
    expect(isWriteRoute("initiatives")).toBe(true);
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
    expect(API_ERROR_CODES).toHaveLength(15);
  });
});

describe("the task intake's wire contract (P-14/C)", () => {
  const TASK_ID = "66666666-6666-4666-8666-666666666666";
  const INITIATIVE_ID = "55555555-5555-4555-8555-555555555555";
  const VERSION_ID = "77777777-7777-4777-8777-777777777777";

  function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      contractVersion: LEDGER_CONTRACT_VERSION,
      taskId: TASK_ID,
      initiativeId: INITIATIVE_ID,
      title: "Enter a task",
      objective: "Enter one task by command and by API.",
      content: fixtureContent("Enter one task by command and by API."),
      classification: "MECHANICAL",
      issuedBy: "kimi/k3/coordinator/01",
      issuedAt: "2026-09-13T12:00:00.000Z",
      authority: [],
      readSet: [],
      writeSet: ["docs/intake.md"],
      conflictKeys: [],
      allowedCommands: [],
      forbiddenActions: [],
      output: { kind: "DIFF", description: "" },
      validation: { commands: [], independentVerifierRequired: false },
      eligibility: { roles: ["implementer"], providers: null, requiredCapabilities: [] },
      budget: { maxTokens: 1000, maxWallClockSeconds: 60, reserveTokensForCheckpoint: 100 },
      visualEvidenceRequired: false,
      commitPolicy: "NO_COMMIT",
      checkpointPolicy: { onEveryAtomicStep: true, maxStepsWithoutCheckpoint: 1 },
      ...overrides,
    };
  }

  function intake(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      envelope: envelope(),
      clientScope: WRITER,
      clientRequestKey: "intake-0001",
      roadmapVersionId: VERSION_ID,
      stepId: "step.one",
      role: "implementer",
      slot: 0,
      transportKind: "CLI_SUBSCRIPTION",
      recordedBy: WRITER,
      ...overrides,
    };
  }

  function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      replayed: false,
      sequence: 1,
      task: {
        taskId: TASK_ID,
        revisionNumber: 1,
        revisionId: "88888888-8888-4888-8888-888888888888",
        envelopeSha256: SHA256,
        envelopeArtifactReferenceId: "99999999-9999-4999-8999-999999999999",
        state: "DISCOVERED",
        resolution: {
          assignmentId: "routing:GLOBAL:implementer:0",
          assignmentVersion: 1,
          slot: 0,
          modelVersionId: "model-one",
          provider: "claude",
          model: "claude-opus-5",
          release: "2026-06-01",
          transportKind: "CLI_SUBSCRIPTION",
          watermarks: [
            {
              projectionName: "model_version_read_model",
              sourceStream: "registry_events",
              appliedThroughSequence: 3,
              eventCount: 3,
              sourceHeadSha256: SHA256,
            },
          ],
        },
      },
      ...overrides,
    };
  }

  it("admits the nine fields, the envelope beside everything that is not the work", () => {
    expect(TaskIntakeRequest.safeParse(intake()).success).toBe(true);
    expect(Object.keys(TaskIntakeRequest.shape).sort()).toEqual([
      "clientRequestKey",
      "clientScope",
      "envelope",
      "recordedBy",
      "roadmapVersionId",
      "role",
      "slot",
      "stepId",
      "transportKind",
    ]);
    expect(TaskIntakeRequest.safeParse(intake({ roadmapVersionId: null, stepId: null })).success).toBe(true);
  });

  it("parses the envelope through the contract's own schema, strictly", () => {
    expect(TaskIntakeRequest.safeParse(intake({ envelope: envelope({ stepId: "step.one" }) })).success).toBe(false);
    expect(TaskIntakeRequest.safeParse(intake({ envelope: envelope({ taskId: "not-a-uuid" }) })).success).toBe(false);
    const planted = TaskIntakeRequest.safeParse(
      intake({ envelope: envelope({ objective: "deploy with sk-ant-api03-" + "A".repeat(40) }) }),
    );
    expect(planted.success).toBe(false);
    expect(planted.error?.issues.map((issue) => issue.path.join("."))).toContain("envelope.objective");
  });

  it("holds the key, the step, the role, the slot and the transport to their grammars", () => {
    for (const bad of [
      { clientScope: "" },
      { clientScope: "has space" },
      { clientRequestKey: "k".repeat(201) },
      { stepId: "../escape" },
      { roadmapVersionId: "not-a-uuid" },
      { role: "janitor" },
      { slot: -1 },
      { slot: 1.5 },
      { transportKind: "PIGEON" },
      { recordedBy: "nobody" },
    ]) {
      expect(TaskIntakeRequest.safeParse(intake(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(TaskIntakeRequest.safeParse(intake({ clientRequestKey: "k".repeat(200) })).success).toBe(true);
  });

  it("refuses what the door computes, so a caller cannot state it", () => {
    for (const computed of [{ envelopeSha256: SHA256 }, { revisionId: "r" }, { taskId: TASK_ID }]) {
      expect(TaskIntakeRequest.safeParse(intake(computed)).success).toBe(false);
    }
  });

  it("N-P14C-16: answers the task by digest and reference, and never echoes the envelope", () => {
    expect(TaskIntakeResponse.safeParse(response()).success).toBe(true);
    const echoed = response();
    (echoed["task"] as Record<string, unknown>)["envelope"] = envelope();
    expect(TaskIntakeResponse.safeParse(echoed).success).toBe(false);
    const objective = response();
    (objective["task"] as Record<string, unknown>)["objective"] = "Enter one task.";
    expect(TaskIntakeResponse.safeParse(objective).success).toBe(false);
    expect(TaskIntakeResponse.safeParse(response({ sequence: 0 })).success).toBe(false);
    const unread = response();
    ((unread["task"] as Record<string, unknown>)["resolution"] as Record<string, unknown>)["watermarks"] = [];
    expect(TaskIntakeResponse.safeParse(unread).success).toBe(false);
  });

  it("N-P14C-23: moves the API version and the write table, and adds no method and no error code", () => {
    expect(API_CONTRACT_VERSION).toBe("0.18.0");
    expect(isWriteRoute("tasks")).toBe(true);
    expect(API_WRITE_ROUTES).toHaveLength(6);
    expect([...API_ALLOWED_METHODS]).toEqual(["GET"]);
    expect(API_ERROR_CODES).toHaveLength(15);
    // Derived from `CONTRACT_VERSION`, which P-15 escalón C moved to 2.9.0 (ADR 0103).
    expect(LEDGER_CONTRACT_VERSION).toBe("2.9.0");
  });
});

describe("the registry publication's request (P-15/R, ADR 0104)", () => {
  const OWNER = "claude/opus/coordinator/01";
  const RULES_FROM = "2026-09-01T00:00:00.000Z";

  function publication(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      documentKind: "PRICE_TABLE",
      documentId: "catalog-claude",
      documentVersion: 1,
      parentDocumentVersion: null,
      effectiveFrom: RULES_FROM,
      recordedBy: OWNER,
      payload: { intervals: [] },
      ...overrides,
    };
  }

  /**
   * The verdict for one request, written here and not read from the schema: the
   * independent oracle the NULL matrix is held against (N-R10).
   */
  function oracle(candidate: Record<string, unknown>): boolean {
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(candidate, key);
    const kind = candidate["documentKind"];
    const id = candidate["documentId"];
    const version = candidate["documentVersion"];
    const parent = candidate["parentDocumentVersion"];
    const from = candidate["effectiveFrom"];
    const by = candidate["recordedBy"];
    const payload = candidate["payload"];
    const kindOk = typeof kind === "string" && /^[A-Z][A-Z_]{0,63}$/.test(kind);
    const idOk = typeof id === "string" && id.length >= 1 && id.length <= 256 && Array.from({ length: id.length }, (_, i) => id.charCodeAt(i)).every((code) => code >= 0x21 && code <= 0x7e);
    const versionOk = typeof version === "number" && Number.isSafeInteger(version) && version >= 1;
    const parentOk = has("parentDocumentVersion") && versionOk && parent === (version === 1 ? null : version - 1);
    const fromOk =
      typeof from === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(from) &&
      !Number.isNaN(Date.parse(from)) &&
      new Date(from).toISOString() === from;
    const byOk = by === OWNER;
    const payloadOk = typeof payload === "object" && payload !== null && !Array.isArray(payload);
    return kindOk && idOk && versionOk && parentOk && fromOk && byOk && payloadOk;
  }

  it("N-R10: absent, null, empty, wrong type and valid, per field, each verdict the oracle's", () => {
    const ABSENT = Symbol("absent");
    const cells: Record<string, readonly unknown[]> = {
      documentKind: [ABSENT, null, "", 7, "price_table", "PRICE_TABLE", "CAPABILITY_POLICY"],
      documentId: [ABSENT, null, "", 7, "has space", "x".repeat(257), "claude-opus-5@2026-06-01", "x".repeat(256)],
      documentVersion: [ABSENT, null, "", "1", 0, -1, 1.5, 2 ** 53, 1],
      parentDocumentVersion: [ABSENT, null, "", "1", 0, 1],
      effectiveFrom: [
        ABSENT,
        null,
        "",
        1,
        "2026-09-01T00:00:00Z",
        "2026-09-01T02:00:00.000+02:00",
        "2026-09-01T00:00:00.000z",
        "2026-02-30T00:00:00.000Z",
        RULES_FROM,
      ],
      recordedBy: [ABSENT, null, "", 7, "not an identity", OWNER],
      payload: [ABSENT, null, "", 7, [], {}],
    };
    let admitted = 0;
    let refused = 0;
    for (const [field, values] of Object.entries(cells)) {
      for (const version of [1, 2]) {
        for (const value of values) {
          const base = publication(version === 1 ? {} : { documentVersion: 2, parentDocumentVersion: 1 });
          const candidate: Record<string, unknown> = { ...base };
          if (value === ABSENT) Reflect.deleteProperty(candidate, field);
          else candidate[field] = value;
          const cell = field + "=" + (value === ABSENT ? "<absent>" : JSON.stringify(value)) + " at v" + String(version);
          const verdict = oracle(candidate);
          expect({ cell, admitted: RegistryPublicationRequest.safeParse(candidate).success }).toEqual({ cell, admitted: verdict });
          if (verdict) admitted += 1;
          else refused += 1;
        }
      }
    }
    // The matrix measured both verdicts, so neither half is vacuous.
    expect(admitted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(admitted);
  });

  it("N-R14: a digest, a key, an event id or an instant of the door's is refused: the door derives them", () => {
    expect(RegistryPublicationRequest.safeParse(publication()).success).toBe(true);
    for (const derived of ["contentDigest", "idempotencyKey", "eventId", "occurredAt", "recordedAt", "contractVersion"]) {
      expect(RegistryPublicationRequest.safeParse(publication({ [derived]: "x" })).success, derived).toBe(false);
    }
  });

  it("runs the guards over the payload", () => {
    const planted = RegistryPublicationRequest.safeParse(publication({ payload: { apiKey: "sk-" + "ant-api03-SENTINEL" } }));
    expect(planted.success).toBe(false);
  });

  it("answers the version by digest, never with its payload, and names one of the three kinds", () => {
    const response = {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      replayed: false,
      sequence: 3,
      document: {
        documentKind: "PRICE_TABLE",
        documentId: "catalog-claude",
        documentVersion: 1,
        parentDocumentVersion: null,
        contentDigest: "a".repeat(64),
        effectiveFrom: RULES_FROM,
        recordedBy: OWNER,
        recordedAt: "2026-09-20T10:00:00.000Z",
        eventId: "7c4a701f-2d9c-50bc-bcc8-a9456ee22dfd",
      },
    };
    expect(RegistryPublicationResponse.safeParse(response).success).toBe(true);
    expect(RegistryPublicationResponse.safeParse({ ...response, document: { ...response.document, payload: {} } }).success).toBe(false);
    expect(
      RegistryPublicationResponse.safeParse({ ...response, document: { ...response.document, documentKind: "CAPABILITY_POLICY" } }).success,
    ).toBe(false);
    // No route parses it: the API contract version and the write table do not move.
    expect(API_CONTRACT_VERSION).toBe("0.18.0");
    expect(API_WRITE_ROUTES).toHaveLength(6);
  });
});

describe("the document bound is a byte bound (P8-8G R2)", () => {
  function write(content: string): Record<string, unknown> {
    return {
      content,
      expectedHeadDigest: null,
      kind: "EDIT",
      restoresVersionId: null,
      recordedBy: WRITER,
    };
  }

  it("admits a document at the ceiling and refuses one byte over", () => {
    const atCeiling = "é".repeat(ROADMAP_CONTENT_MAX_BYTES / 2);
    expect(RoadmapVersionWriteRequest.safeParse(write(atCeiling)).success).toBe(true);
    expect(RoadmapVersionWriteRequest.safeParse(write(atCeiling + "x")).success).toBe(false);
  });

  it("refuses what a code-unit bound would have admitted", () => {
    // The regression, stated as arithmetic. `.max()` counts UTF-16 code units,
    // so this string passed the old bound while weighing twice the ceiling —
    // and the store, which weighs bytes, would then have refused it. The API
    // was accepting requests the plane could not honour.
    const twiceTheBytes = "é".repeat(ROADMAP_CONTENT_MAX_BYTES);
    expect(twiceTheBytes.length).toBe(ROADMAP_CONTENT_MAX_BYTES);
    expect(RoadmapVersionWriteRequest.safeParse(write(twiceTheBytes)).success).toBe(false);
  });

  it("bounds the response's content the same way", () => {
    const atCeiling = "é".repeat(ROADMAP_CONTENT_MAX_BYTES / 2);
    const body = {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      initiativeId: "44444444-4444-4444-8444-444444444444",
      version: 1,
      contentDigest: SHA256,
      kind: "EDIT",
      content: atCeiling,
    };
    expect(RoadmapContentResponse.safeParse(body).success).toBe(true);
    expect(RoadmapContentResponse.safeParse({ ...body, content: atCeiling + "x" }).success).toBe(false);
  });
});

describe("the write door's two authentication codes (P8-8G)", () => {
  it("names both, and keeps them apart", () => {
    expect(API_ERROR_CODES).toContain("AUTH_REQUIRED");
    expect(API_ERROR_CODES).toContain("WRITE_BEARER_UNCONFIGURED");
    // Two codes because they are two different people's problems: a caller
    // can fix the first with a better header and can do nothing about the
    // second.
    expect(ApiErrorCode.safeParse("AUTH_REQUIRED").success).toBe(true);
    expect(ApiErrorCode.safeParse("WRITE_BEARER_UNCONFIGURED").success).toBe(true);
    expect(ApiErrorCode.safeParse("UNAUTHORIZED").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The event stream (V2-B3a)
// ---------------------------------------------------------------------------

describe("the stream channel map is total over the ledger's own vocabulary", () => {
  it("names every event type the contract declares, and nothing else", () => {
    // Read out of `@acp/contracts` rather than restated here. A literal list
    // would pass forever: the failure this catches is a type added upstream
    // and never mapped, and a fixture that was written beside the map cannot
    // see that happen.
    const mapped = Object.keys(STREAM_CHANNEL_BY_EVENT_TYPE).sort();
    expect(mapped).toEqual([...CONTROL_PLANE_EVENT_TYPES].sort());
    expect(mapped).toHaveLength(CONTROL_PLANE_EVENT_TYPES.length);
  });

  it("maps each type exactly once, to a declared channel", () => {
    for (const type of CONTROL_PLANE_EVENT_TYPES) {
      const channel = STREAM_CHANNEL_BY_EVENT_TYPE[type];
      expect({ type, declared: STREAM_CHANNELS.includes(channel) }).toEqual({
        type,
        declared: true,
      });
    }
  });

  it("leaves no channel empty, so the reduction is a partition and not a label", () => {
    // A channel nothing maps to is a channel a reader can subscribe and never
    // hear from — indistinguishable, from the outside, from a quiet system.
    const populated = new Set(Object.values(STREAM_CHANNEL_BY_EVENT_TYPE));
    expect([...populated].sort()).toEqual([...STREAM_CHANNELS].sort());
  });

  it("is frozen, so a consumer cannot re-channel an event at runtime", () => {
    expect(Object.isFrozen(STREAM_CHANNEL_BY_EVENT_TYPE)).toBe(true);
  });

  it("partitions the vocabulary into the five declared sizes", () => {
    // The counts are the shape of the reduction, and stating them is what makes
    // a silent re-channelling — moving a type from one channel to another —
    // fail here rather than surface as a UI that quietly stopped showing a row.
    const sizes: Record<string, number> = {};
    for (const channel of Object.values(STREAM_CHANNEL_BY_EVENT_TYPE)) {
      sizes[channel] = (sizes[channel] ?? 0) + 1;
    }
    // `progress` 2 -> 4 with P-32/captura B's two usage types (H-6); `execution`
    // stays at fifteen.
    expect(sizes).toEqual({ lifecycle: 7, execution: 15, steps: 2, state: 7, progress: 4 });
    const total = Object.values(sizes).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(CONTROL_PLANE_EVENT_TYPES.length);
  });

  it("N-P32B-30: puts the two usage types on progress, by name (P-32/captura B)", () => {
    // Asserted separately for the reason below. `progress` is usage attribution,
    // and an observation's counts are spend attributed through its stream to an
    // account and a segment — unlike D's occurrences, whose byte counts are part
    // of what the occurrence is. The declaration names where that attribution
    // goes, so it sits beside it; neither is "what it took to run it".
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.USAGE_STREAM_DECLARED).toBe("progress");
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.USAGE_OBSERVATION_RECORDED).toBe("progress");
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.TOKEN_USAGE_RECORDED).toBe("progress");
  });

  it("puts the tool-call receipt on execution, by name (V2-B4b stage 2)", () => {
    // Totality above covers this member by construction, which is exactly why
    // the choice has to be asserted separately: a type mapped to the wrong
    // channel satisfies every law in this describe. `execution` is "what it
    // took to run it" — a slot, an account, a raised hand, and now a tool call.
    // `steps` is the durable walk's own beats and `progress` is usage
    // attribution; a receipt is neither.
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.TOOL_CALL_RECORDED).toBe("execution");
  });

  it("puts the three outbox types on execution, by name (P-18/protocolo F)", () => {
    // Asserted separately for the reason above. Intending a command, intending
    // one delivery of it and observing how it went are "what it took to run it".
    // They are not `state`: `LEASE_REVOKED` records a revocation that happened,
    // and these record that one was asked for and what was heard back.
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.OUTBOX_COMMAND_INTENDED).toBe("execution");
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.OUTBOX_DELIVERY_INTENDED).toBe("execution");
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.OUTBOX_DELIVERY_OBSERVED).toBe("execution");
  });

  it("puts the two occurrence types on execution, by name (P-18/protocolo D)", () => {
    // Asserted separately for the reason above. A prompt sent and the answer it
    // received are "what it took to run it". They carry byte counts and are
    // still not `progress`: the count is part of what the occurrence is, not
    // usage attributed to an account.
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.PROMPT_OCCURRENCE_RECORDED).toBe("execution");
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.RESPONSE_OCCURRENCE_RECORDED).toBe("execution");
  });

  it("puts the three effect types on execution, by name (P-18/protocolo C)", () => {
    // Asserted separately from totality for the reason above: a type on the
    // wrong channel satisfies every other law here. `execution` is "what it
    // took to run it", and intending an effect, intending a delivery and
    // reporting how a delivery went are all that. None of them is a beat of the
    // durable walk — an effect is what a beat asks for — and none of them is
    // usage attribution.
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.EFFECT_INTENDED).toBe("execution");
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.DISPATCH_INTENDED).toBe("execution");
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.DISPATCH_OUTCOME_RECORDED).toBe("execution");
  });

  it("puts the attempt opening on execution, by name (P-18/protocolo B)", () => {
    // Asserted separately for the reason above: totality covers the member by
    // construction, and a type on the wrong channel satisfies every other law
    // in this describe. `execution` is "what it took to run it" — the attempt's
    // opening says a run exists and what its durable identity is. It is
    // deliberately not `lifecycle`, where `RUN_STARTED` sits because it
    // genuinely changes state while this one is a same-state passthrough; and
    // not `steps`, which is the durable walk's own beats — an attempt is the
    // thing those beats happen inside.
    expect(STREAM_CHANNEL_BY_EVENT_TYPE.TASK_ATTEMPT_OPENED).toBe("execution");
  });
});

describe("the stream query is the events query without its page controls", () => {
  it("accepts the four filters", () => {
    const parsed = StreamQuery.safeParse({
      taskId: TASK_ID,
      type: "RUN_STARTED",
      emittedBy: WRITER,
      toState: "RUNNING",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts no filters at all", () => {
    expect(StreamQuery.safeParse({}).success).toBe(true);
  });

  it("refuses a cursor and a limit, because neither is the caller's to set", () => {
    // The cursor authority is the Last-Event-ID header and the page size is the
    // server's. Accepting either here would be a second place to say where a
    // reader is, and two places can disagree.
    expect(StreamQuery.safeParse({ cursor: 5 }).success).toBe(false);
    expect(StreamQuery.safeParse({ limit: 10 }).success).toBe(false);
  });

  it("refuses an unknown parameter, so a typo is a 400 and not a silent stream", () => {
    expect(StreamQuery.safeParse({ taksId: TASK_ID }).success).toBe(false);
  });

  it("names exactly the filters EventsQuery names, minus the two page controls", () => {
    // Derived rather than restated: a filter added to the paged route and not
    // to the stream would make the two routes answer different questions under
    // the same query vocabulary.
    const paged = Object.keys(EventsQuery.shape).filter(
      (key) => key !== "cursor" && key !== "limit",
    );
    expect(Object.keys(StreamQuery.shape).sort()).toEqual(paged.sort());
  });
});

describe("the stream frame", () => {
  const VERSIONS = {
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
  };

  it("accepts the three kinds it declares", () => {
    expect(
      StreamFrame.safeParse({
        ...VERSIONS,
        kind: "hello",
        database: DATABASE,
        instance: INSTANCE,
        headSequence: 7,
        resumedFrom: null,
      }).success,
    ).toBe(true);
    expect(
      StreamFrame.safeParse({
        ...VERSIONS,
        kind: "event",
        channel: "lifecycle",
        item: TIMELINE_ITEM,
      }).success,
    ).toBe(true);
    expect(
      StreamFrame.safeParse({ ...VERSIONS, kind: "resync", reason: "ANCHOR_AHEAD_OF_HEAD" })
        .success,
    ).toBe(true);
  });

  it("admits a hello against an empty ledger, whose head is zero", () => {
    expect(
      StreamFrame.safeParse({
        ...VERSIONS,
        kind: "hello",
        database: DATABASE,
        instance: INSTANCE,
        headSequence: 0,
        resumedFrom: null,
      }).success,
    ).toBe(true);
  });

  it("refuses a hello frame missing the instance identity", () => {
    // Strict and required: this is the shape a reader pinned at 0.13.0 has
    // never seen, which is why the API version moved minor rather than patch.
    const base = {
      ...VERSIONS,
      kind: "hello",
      database: DATABASE,
      headSequence: 7,
      resumedFrom: null,
    };
    expect(StreamFrame.safeParse(base).success).toBe(false);
    expect(StreamFrame.safeParse({ ...base, instance: INSTANCE }).success).toBe(true);
    expect(StreamFrame.safeParse({ ...base, instance: INSTANCE_ABSENT }).success).toBe(true);
    expect(
      StreamFrame.safeParse({
        ...base,
        instance: { instanceId: INSTANCE_ID, restoreId: null, restoreEpoch: null },
      }).success,
    ).toBe(false);
  });

  it("requires resumedFrom on hello, and lets it be null (V2-B3c)", () => {
    // Required and nullable, not optional, and the distinction is the whole
    // point: a missing key and a live open would otherwise be the same wire
    // shape, so a client could not tell "this server opened me live" from "this
    // server is older than the field". Required makes the answer always
    // present, which is also what forces the minor version bump — every arm is
    // a `z.strictObject`, so a reader at `0.11.0` rejects the frame outright.
    const base = {
      ...VERSIONS,
      kind: "hello",
      database: DATABASE,
      instance: INSTANCE,
      headSequence: 7,
    };

    expect(StreamFrame.safeParse({ ...base, resumedFrom: null }).success).toBe(true);
    expect(StreamFrame.safeParse({ ...base, resumedFrom: 0 }).success).toBe(true);
    expect(StreamFrame.safeParse({ ...base, resumedFrom: 7 }).success).toBe(true);

    // Omitted is refused. Without this the field would be optional in practice
    // whatever the type said.
    expect(StreamFrame.safeParse(base).success).toBe(false);

    // And it is a sequence, so it obeys the same grammar every other sequence
    // on this plane does.
    for (const bad of [-1, 1.5, "3", true, {}]) {
      expect({ bad, ok: StreamFrame.safeParse({ ...base, resumedFrom: bad }).success }).toEqual({
        bad,
        ok: false,
      });
    }
  });

  it("keeps resumedFrom off the arms that are not hello (V2-B3c)", () => {
    // The field is a fact about the connection's anchor, and only the opening
    // frame states it. An `event` or `resync` carrying one would be a second
    // place for a client to read a position from, which is the thing this
    // plane's one-cursor rule exists to prevent.
    expect(
      StreamFrame.safeParse({
        ...VERSIONS,
        kind: "event",
        channel: "lifecycle",
        item: TIMELINE_ITEM,
        resumedFrom: 3,
      }).success,
    ).toBe(false);
    expect(
      StreamFrame.safeParse({
        ...VERSIONS,
        kind: "resync",
        reason: "ANCHOR_AHEAD_OF_HEAD",
        resumedFrom: 3,
      }).success,
    ).toBe(false);
  });

  it("refuses a kind it does not declare", () => {
    expect(StreamFrame.safeParse({ ...VERSIONS, kind: "heartbeat" }).success).toBe(false);
    expect(
      StreamFrame.safeParse({ ...VERSIONS, kind: "event", channel: "audit", item: TIMELINE_ITEM })
        .success,
    ).toBe(false);
  });

  it("refuses a resync reason outside the closed list", () => {
    expect(
      StreamFrame.safeParse({ ...VERSIONS, kind: "resync", reason: "TOO_OLD" }).success,
    ).toBe(false);
    expect(STREAM_RESYNC_REASONS).toEqual(["ANCHOR_AHEAD_OF_HEAD"]);
  });

  it("keeps each arm strict, so a field cannot ride along on the wrong kind", () => {
    // A resync carrying an item, or a hello carrying a channel, would be a
    // frame whose kind no longer describes it.
    expect(
      StreamFrame.safeParse({
        ...VERSIONS,
        kind: "resync",
        reason: "ANCHOR_AHEAD_OF_HEAD",
        item: TIMELINE_ITEM,
      }).success,
    ).toBe(false);
    expect(
      StreamFrame.safeParse({
        ...VERSIONS,
        kind: "hello",
        database: DATABASE,
        headSequence: 1,
        resumedFrom: null,
        // The foreign key. `resumedFrom` is stated above it so this frame is
        // refused for the key it does not belong to rather than for one it is
        // missing — otherwise the assertion would pass while measuring nothing.
        channel: "lifecycle",
      }).success,
    ).toBe(false);
  });

  it("carries no payload, and refuses a frame that grew one", () => {
    // The privacy boundary, stated where it is enforced: the item is the
    // redacted projection, and there is no field here for a payload value.
    const withPayload = {
      ...VERSIONS,
      kind: "event",
      channel: "lifecycle",
      item: { ...TIMELINE_ITEM, payload: { prompt: "..." } },
    };
    expect(StreamFrame.safeParse(withPayload).success).toBe(false);
  });

  it("refuses a credential-shaped payload key, through the same guards every response uses", () => {
    const leaky = {
      ...VERSIONS,
      kind: "event",
      channel: "lifecycle",
      item: { ...TIMELINE_ITEM, payloadKeys: ["apiKey"] },
    };
    expect(StreamFrame.safeParse(leaky).success).toBe(false);
  });

  it("pins both version lines, so a frame from another build cannot be read as this one's", () => {
    expect(
      StreamFrame.safeParse({
        ...VERSIONS,
        apiContractVersion: "0.1.0",
        kind: "resync",
        reason: "ANCHOR_AHEAD_OF_HEAD",
      }).success,
    ).toBe(false);
  });
});

describe("the stream's refusal code", () => {
  it("is declared, and is not one of the codes it could have been confused with", () => {
    expect(API_ERROR_CODES).toContain("STREAM_CAPACITY");
    expect(ApiErrorCode.safeParse("STREAM_CAPACITY").success).toBe(true);
    // The three it is deliberately not: the caller sent nothing wrong, this is
    // not a defect, and the ledger is fine.
    expect(ApiErrorCode.safeParse("TOO_MANY_STREAMS").success).toBe(false);
    for (const code of ["BAD_REQUEST", "INTERNAL", "LEDGER_UNAVAILABLE"]) {
      expect(API_ERROR_CODES.filter((declared) => declared === code)).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The explicit tool call (V2-B4b stage 3C)
// ---------------------------------------------------------------------------

describe("the tool call's wire contract", () => {
  const TASK = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a01";

  function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      taskId: TASK,
      attempt: 1,
      submittedAt: "2026-09-03T12:00:00.000Z",
      submissionDigest: "a".repeat(64),
      operationIndex: 0,
      callIndex: 0,
      accountId: "acct-primary",
      identity: "claude/opus/implementer/01",
      serverId: "docs",
      toolName: "docs.search",
      arguments: { q: "acp" },
      ...overrides,
    };
  }

  it("accepts a well-formed request", () => {
    expect(ToolCallExecuteRequest.safeParse(request()).success).toBe(true);
  });

  it("bounds exactly what the operation's first four prechecks bound", () => {
    // Each of these would otherwise reach `runToolCall` and be refused by a
    // throw, which the door cannot turn into anything but a 500. Refusing them
    // here is what makes each a 400 that names its field.
    expect(ToolCallExecuteRequest.safeParse(request({ toolName: "rm -rf /" })).success).toBe(false);
    expect(ToolCallExecuteRequest.safeParse(request({ serverId: "" })).success).toBe(false);
    expect(ToolCallExecuteRequest.safeParse(request({ accountId: "acct primary" })).success).toBe(false);
    expect(ToolCallExecuteRequest.safeParse(request({ identity: "not-an-identity" })).success).toBe(false);
    expect(ToolCallExecuteRequest.safeParse(request({ operationIndex: -1 })).success).toBe(false);
    expect(ToolCallExecuteRequest.safeParse(request({ callIndex: 1.5 })).success).toBe(false);
    expect(ToolCallExecuteRequest.safeParse(request({ attempt: 0 })).success).toBe(false);
    expect(ToolCallExecuteRequest.safeParse(request({ attempt: 10_001 })).success).toBe(false);
    expect(ToolCallExecuteRequest.safeParse(request({ submittedAt: "yesterday" })).success).toBe(false);
  });

  it("takes an optional causal link, and refuses one that is not an event id", () => {
    expect(ToolCallExecuteRequest.safeParse(request({ causedBy: null })).success).toBe(true);
    expect(ToolCallExecuteRequest.safeParse(request({ causedBy: TASK })).success).toBe(true);
    expect(ToolCallExecuteRequest.safeParse(request({ causedBy: "not-a-uuid" })).success).toBe(false);
    // Whether the event exists is the door's to check: it needs a ledger.
  });

  it("refuses an unknown member, so the two doors cannot drift apart", () => {
    expect(ToolCallExecuteRequest.safeParse(request({ extra: 1 })).success).toBe(false);
  });

  it("gives the GET row model no content member, because none was ever durable", () => {
    const keys = Object.keys(ToolCallRow.shape);
    expect(keys).not.toContain("content");
    expect(keys).toContain("argumentBytes");
    expect(keys).toContain("causedBy");
  });

  it("carries content only on the execute response", () => {
    expect(Object.keys(ToolCallExecuteResponse.shape)).toContain("content");
  });

  it("names the twelfth error code, and the version the surface now stands at", () => {
    expect(API_ERROR_CODES).toContain("TOOL_SERVERS_UNCONFIGURED");
    expect(API_CONTRACT_VERSION).toBe("0.18.0");
  });

  it("names the thirteenth error code, and the version the surface now stands at", () => {
    // V2 X1b. A client can branch on a code, so a code a reader at `0.10.0` has
    // never seen is a shape it did not know about — the rule this file's own
    // version docblock states, and the one `WRITE_REFUSED`, `STREAM_CAPACITY`
    // and `TOOL_SERVERS_UNCONFIGURED` each set. Hence a minor, not a patch.
    expect(API_ERROR_CODES).toContain("CLAIM_HELD");
    expect(API_ERROR_CODES).toHaveLength(15);
    // The literal is the version the surface stands at TODAY, not the one this
    // code arrived with, and the two titles were corrected at V2-B3c to stop
    // saying otherwise. `CLAIM_HELD` landed at `0.11.0`; the constant has since
    // moved to `0.12.0` for the stream's `resumedFrom`, and an error-code count
    // that did not move with it is exactly the point — the version tracks the
    // whole surface, not one list. The number stays a literal so it is asserted
    // rather than echoed.
    expect(API_CONTRACT_VERSION).toBe("0.18.0");
    // The door surface is unchanged: X1b adds a way for an existing route to
    // refuse, not a new route.
    expect(API_ERROR_CODES.filter((code) => code === "CLAIM_HELD")).toHaveLength(1);
  });

  it("names the fourteenth and fifteenth error codes, and keeps them apart", () => {
    // V2 L3. Two codes, not one, and the count moves by two: a writer who
    // bumped it by one would get this line red rather than a plane that
    // silently answers the wrong status for one of them.
    expect(API_ERROR_CODES).toContain("CAPABILITY_UNSUPPORTED");
    expect(API_ERROR_CODES).toContain("SCENARIO_UNCONFIGURED");
    expect(API_ERROR_CODES).toHaveLength(15);
    expect(API_CONTRACT_VERSION).toBe("0.18.0");

    // The distinction is the reason both exist. `SCENARIO_UNCONFIGURED` is an
    // operator problem a restart fixes, on the shape
    // `TOOL_SERVERS_UNCONFIGURED` set; `CAPABILITY_UNSUPPORTED` is an engine
    // that will never serve the verb, which no restart and no retry changes.
    // Reusing either for the other would tell a caller something false.
    expect(API_ERROR_CODES.filter((code) => code === "CAPABILITY_UNSUPPORTED")).toHaveLength(1);
    expect(API_ERROR_CODES.filter((code) => code === "SCENARIO_UNCONFIGURED")).toHaveLength(1);
  });

  it("closes the lifecycle request against every authority a caller does not hold", () => {
    const valid = {
      verb: "CANCEL",
      mode: "RESTATE",
      taskId: "0f2a1a34-0f6f-4d55-9d0a-2a4b1d3e5f60",
      attempt: 1,
    };
    expect(TaskLifecycleRequest.safeParse(valid).success).toBe(true);

    // D2, enforced by the schema rather than by a check a later field could
    // outgrow: a body may never name a scenario root, a database path, a route
    // or a commit policy. `strictObject` refuses each on the unknown key.
    for (const extra of [
      { scenario: "l3" },
      { scenarioId: "l3" },
      { database: "/tmp/ledger.sqlite" },
      { databasePath: "/tmp/ledger.sqlite" },
      { route: { provider: "claude" } },
      { commitPolicy: "NO_COMMIT" },
    ]) {
      const parsed = TaskLifecycleRequest.safeParse({ ...valid, ...extra });
      expect({ extra, ok: parsed.success }).toEqual({ extra, ok: false });
    }

    // D3: two verbs, and the omission is enforced rather than implied.
    for (const verb of ["SIGNAL", "TIMER", "signal", "cancel"]) {
      expect(TaskLifecycleRequest.safeParse({ ...valid, verb }).success).toBe(false);
    }
    // N1: no alias, and no lower-cased spelling. A second spelling would be a
    // second vocabulary.
    for (const mode of ["restate", "sqlite_supervisor", "SQLITE", ""]) {
      expect(TaskLifecycleRequest.safeParse({ ...valid, mode }).success).toBe(false);
    }
    for (const attempt of [0, -1, 1.5]) {
      expect(TaskLifecycleRequest.safeParse({ ...valid, attempt }).success).toBe(false);
    }
  });

  it("answers the lifecycle verb with exactly the seven fields the CLI door prints", () => {
    // The document is the parity subject, so its key set is pinned by equality
    // rather than by containment: a field added on one door and not the other
    // is the beginning of an exclusion list, which is what this assertion
    // exists to prevent.
    expect(Object.keys(TaskLifecycleExecuteResponse.shape).sort()).toEqual(
      ["attempt", "finalSequence", "mode", "ok", "refusal", "taskId", "verb"],
    );
    // No contract-version envelope on this arm, deliberately: the CLI document
    // has never carried one.
    expect(Object.keys(TaskLifecycleExecuteResponse.shape)).not.toContain("apiContractVersion");

    // The read half does carry one, like every other read on this plane.
    expect(Object.keys(TaskLifecycleResponse.shape).sort()).toEqual(
      ["apiContractVersion", "currentState", "latestAttempt", "ledgerContractVersion", "taskId"],
    );
  });
});

/** The captured canonical-instant matrix (P-15 escalón I, ADR 0106), read from disk; absent or malformed fails loudly. */
function canonicalInstantVectors(path: string): readonly { readonly vector: string | number | null; readonly canonical: boolean; readonly arbiter: string | null }[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const vectors = (parsed as { readonly vectors?: unknown }).vectors;
  if (!Array.isArray(vectors) || vectors.length === 0) throw new Error("the canonical-instant matrix carries no vectors");
  return vectors.map((entry: unknown, index) => {
    const { vector, canonical, arbiter } = entry as Record<string, unknown>;
    if (
      !(typeof vector === "string" || typeof vector === "number" || vector === null) ||
      typeof canonical !== "boolean" ||
      !(typeof arbiter === "string" || arbiter === null)
    ) {
      throw new Error("the canonical-instant matrix's row " + String(index) + " is malformed");
    }
    return { vector, canonical, arbiter };
  });
}

describe("P-15/I: the registry instant reads contracts' canonical instant, verdict for verdict", () => {
  const TABLE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../contracts/test/testing/canonical-instant-vectors/index.json");

  it("RegistryPublicationRequest.effectiveFrom reproduces every captured verdict", () => {
    for (const row of canonicalInstantVectors(TABLE)) {
      const parsed = RegistryPublicationRequest.safeParse({
        documentKind: "MODEL_VERSION",
        documentId: "claude-opus-5@2026-06-01",
        documentVersion: 1,
        parentDocumentVersion: null,
        effectiveFrom: row.vector,
        recordedBy: "claude/opus/coordinator/01",
        payload: {},
      });
      const admitted = parsed.success || !parsed.error.issues.some((issue) => issue.path[0] === "effectiveFrom");
      expect(admitted, String(row.vector)).toBe(row.canonical);
    }
  });

  it("the protocol's Timestamp is the contract's: HealthResponse.observedAt reproduces its captured verdicts", () => {
    const parsed: unknown = JSON.parse(readFileSync(TABLE, "utf8"));
    const rows = (parsed as { readonly timestamps?: unknown }).timestamps;
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("the matrix carries no Timestamp vectors");
    for (const entry of rows as readonly { readonly vector: unknown; readonly timestamp: unknown }[]) {
      if (typeof entry.timestamp !== "boolean") throw new Error("a Timestamp row is malformed");
      const result = HealthResponse.safeParse({ observedAt: entry.vector });
      const admitted = result.success || !result.error.issues.some((issue) => issue.path[0] === "observedAt");
      expect(admitted, String(entry.vector)).toBe(entry.timestamp);
    }
  });
});

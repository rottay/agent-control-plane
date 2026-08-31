import { describe, expect, it } from "vitest";

import { findCredentialViolations, findTranscriptViolations } from "@acp/contracts";

import { API_ROUTES } from "../../src/routes/index.js";
import {
  EventPageResponse,
  HealthResponse,
  IntegrityResult,
  LedgerStatusResponse,
  OverviewResponse,
  TaskDetailResponse,
  TaskPageResponse,
  WorkerDetailResponse,
  WorkerPageResponse,
} from "../../src/schemas/index.js";
import {
  NON_LEDGER_SOURCES,
  PARITY_BINDINGS,
  PARITY_ROUTES,
  VOLATILE_FIELDS,
  bindingCoversAllRoutes,
  canonicalRows,
  canonicalize,
  comparableFields,
  declaredExceptions,
  hasObservationPrivacyViolation,
} from "../../src/parity/index.js";
import {
  InitiativeDetailResponse,
  InitiativePortfolioResponse,
  InitiativeRoadmapResponse,
  InitiativeAgentsResponse,
  InitiativeTimelineResponse,
  RoadmapContentResponse,
} from "../../src/schemas/index.js";

describe("the contract covers every frozen route", () => {
  it("binds every frozen route, not all but one", () => {
    // The preaudit's B1: a table that covers all but one route while claiming
    // to cover every one is the overclaim shape this repository keeps finding.
    // `health` is bound as a named exception rather than left out.
    //
    // The count is asserted against the route table rather than against a
    // literal, so adding a route cannot pass by editing one number here: the
    // two lists have to agree, and the equality below is what actually holds
    // them together.
    expect(PARITY_ROUTES.length).toBe(Object.keys(API_ROUTES).length);
    expect(bindingCoversAllRoutes()).toBe(true);
    expect([...PARITY_ROUTES].sort()).toEqual(Object.keys(API_ROUTES).sort());
  });

  it("gives every non-ledger field a stated reason", () => {
    // An exception without a reason is an omission with better presentation.
    for (const route of PARITY_ROUTES) {
      for (const binding of declaredExceptions(route)) {
        expect(NON_LEDGER_SOURCES).toContain(binding.source);
        expect(binding.because ?? "").not.toBe("");
      }
    }
  });

  it("declares health entirely as non-ledger, and every other route as mostly ledger", () => {
    expect(comparableFields("health")).toEqual([
      "apiContractVersion",
      "ledgerContractVersion",
    ]);
    for (const route of PARITY_ROUTES) {
      if (route === "health") continue;
      const ledgerFields = PARITY_BINDINGS[route].filter((b) => b.source === "LEDGER");
      expect(ledgerFields.length).toBeGreaterThan(0);
    }
  });
});

describe("the binding table matches the schemas it claims to bind", () => {
  /** Resolve a response schema's top-level keys, through any refinement. */
  function shapeKeys(schema: unknown): string[] {
    const candidate = schema as {
      shape?: Record<string, unknown>;
      _def?: { shape?: unknown; schema?: { shape?: Record<string, unknown> } };
    };
    const direct = candidate.shape ?? (candidate._def?.shape as Record<string, unknown> | undefined);
    const resolved =
      typeof direct === "function" ? (direct as () => Record<string, unknown>)() : direct;
    const inner = candidate._def?.schema?.shape;
    return Object.keys(resolved ?? inner ?? {}).sort();
  }

  const schemas: Readonly<Record<string, unknown>> = {
    health: HealthResponse,
    overview: OverviewResponse,
    tasks: TaskPageResponse,
    taskById: TaskDetailResponse,
    workers: WorkerPageResponse,
    workerByIdentity: WorkerDetailResponse,
    events: EventPageResponse,
    status: LedgerStatusResponse,
    integrity: IntegrityResult,
    initiatives: InitiativePortfolioResponse,
    initiativeById: InitiativeDetailResponse,
    initiativeRoadmap: InitiativeRoadmapResponse,
    initiativeRoadmapContent: RoadmapContentResponse,
    initiativeEvents: InitiativeTimelineResponse,
    initiativeAgents: InitiativeAgentsResponse,
  };

  it("binds the roadmap route's read, and deliberately not its write (P8-8D-pre)", () => {
    // Parity is an equality over what the three clients *render*. The write
    // route's response is not rendered by any of them — the CLI and the
    // browser read histories, they do not record versions — so binding it here
    // would claim a parity that does not exist. The write's own shape is held
    // by its schema and its endpoint tests instead.
    const bound = PARITY_BINDINGS.initiativeRoadmap.map((binding) => binding.field).sort();
    expect(bound).toEqual(shapeKeys(InitiativeRoadmapResponse));
    expect(bound).not.toContain("sequence");
  });

  it("has a schema for every bound route, so the comparison below can be total", () => {
    // Without this, a route added to the table with no schema beside it would
    // make `shapeKeys(undefined)` return `[]` and the field comparison would
    // quietly pass for a route nothing checked.
    expect(Object.keys(schemas).sort()).toEqual([...PARITY_ROUTES].sort());
  });

  it("binds exactly the fields each response actually has", () => {
    // This is the check that would have caught the first draft of the table,
    // which named `taskStates`, `recent`, `timeline`, `head` and
    // `problemCount` — five fields no schema has — while omitting the contract
    // versions every response carries. A binding table written by reading is a
    // table that drifts the first time a schema moves; this compares it to the
    // schemas themselves.
    for (const route of PARITY_ROUTES) {
      const bound = PARITY_BINDINGS[route].map((binding) => binding.field).sort();
      expect({ route, fields: bound }).toEqual({ route, fields: shapeKeys(schemas[route]) });
    }
  });

  it("declares every volatile field that actually appears in a response", () => {
    for (const route of PARITY_ROUTES) {
      for (const field of shapeKeys(schemas[route])) {
        if (!VOLATILE_FIELDS.includes(field)) continue;
        const binding = PARITY_BINDINGS[route].find((entry) => entry.field === field);
        expect(binding?.source).toBe("OBSERVED_AT");
      }
    }
  });
});

describe("the canonical row model", () => {
  it("normalises key order so equal data compares equal", () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalize(a)).toEqual(canonicalize(b));
    expect(JSON.stringify(canonicalize(a))).toBe(JSON.stringify(canonicalize(b)));
  });

  it("preserves array order, because ordering is part of the contract", () => {
    // A client that sorted differently would agree on sets and tell a
    // different story. Sets are not what a reader of a page sees.
    const forward = canonicalize({ items: [{ id: "a" }, { id: "b" }] });
    const reversed = canonicalize({ items: [{ id: "b" }, { id: "a" }] });
    expect(forward).not.toEqual(reversed);
  });

  it("strips volatile fields at every depth, and only those", () => {
    const value = {
      observedAt: "2026-08-27T00:00:00.000Z",
      keep: 1,
      nested: { checkedAt: "2026-08-27T00:00:00.000Z", alsoKeep: 2 },
      items: [{ observedAt: "2026-08-27T00:00:00.000Z", id: "x" }],
    };
    expect(canonicalize(value)).toEqual({
      keep: 1,
      nested: { alsoKeep: 2 },
      items: [{ id: "x" }],
    });
    for (const field of VOLATILE_FIELDS) {
      expect(JSON.stringify(canonicalize(value))).not.toContain(field);
    }
  });

  it("makes two responses differing only by observation instant compare equal", () => {
    // The reason volatile fields are declared rather than compared: three
    // clients observe at three instants, and a suite that failed for the
    // passage of time teaches a reader to ignore it.
    const first = { ok: true, checkedAt: "2026-08-27T00:00:00.000Z", problemCount: 0 };
    const later = { ok: true, checkedAt: "2026-08-28T11:22:33.000Z", problemCount: 0 };
    expect(canonicalize(first)).toEqual(canonicalize(later));
  });

  it("still notices a real divergence hiding beside a timestamp", () => {
    const good = { ok: true, checkedAt: "2026-08-27T00:00:00.000Z", problemCount: 0 };
    const bad = { ok: false, checkedAt: "2026-08-27T00:00:00.000Z", problemCount: 1 };
    expect(canonicalize(good)).not.toEqual(canonicalize(bad));
  });

  it("refuses a route it has no binding for", () => {
    expect(() => canonicalRows("nope" as never, {})).toThrow(/no parity binding/);
  });
});

describe("redaction is absence, checked with the one privacy vocabulary", () => {
  it("reports a credential-shaped key rather than tolerating a blanked one", () => {
    // Reusing the existing guards rather than a second denylist: one privacy
    // vocabulary, not two that can disagree about what a secret looks like.
    const blanked = canonicalize({ items: [{ id: "t", apiKey: "" }] });
    expect(findCredentialViolations(blanked).length).toBeGreaterThan(0);

    const absent = canonicalize({ items: [{ id: "t" }] });
    expect(findCredentialViolations(absent)).toEqual([]);
    expect(findTranscriptViolations(absent)).toEqual([]);
  });

  // The same vocabulary behind one exported predicate. The server package may
  // not reach `@acp/contracts`, so this helper is how it asks the question at
  // all; these three cases are what it is entitled to rely on.
  it("answers for a credential-shaped key", () => {
    expect(hasObservationPrivacyViolation(canonicalize({ items: [{ id: "t", apiKey: "" }] }))).toBe(
      true,
    );
  });

  it("answers for a transcript-shaped key", () => {
    expect(
      hasObservationPrivacyViolation(canonicalize({ items: [{ id: "t", transcript: [] }] })),
    ).toBe(true);
  });

  it("stays quiet on a clean body", () => {
    expect(hasObservationPrivacyViolation(canonicalize({ items: [{ id: "t", state: "OPEN" }] }))).toBe(
      false,
    );
  });
});

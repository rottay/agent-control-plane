import { describe, expect, it } from "vitest";

import { API_ROUTES, API_WRITE_ROUTES } from "../../src/routes/index.js";
import type { SurfaceEntry } from "../../src/surface-map/index.js";
import { SURFACE_MAP, surfaceDefects } from "../../src/surface-map/index.js";

/**
 * The CLI/API surface map, measured against the live route table (old-V2 R1).
 *
 * Every fixture here drives `surfaceDefects` over a **mutated input**, and that
 * is what makes it causal rather than incidental. A fixture asserting a property
 * its subject already has proves nothing: the docblock above
 * `bindingCoversAllRoutes` said "twelve" over twenty routes for eight packets,
 * and no test could have caught it, because that function reads `API_ROUTES`
 * itself and can never be handed a different one. `surfaceDefects` takes its
 * tables as arguments for exactly that reason, so a probe here can inject a
 * route the map has never seen and demand that it be named.
 *
 * No count in this file is written as a literal. Every expected total is
 * computed from the injected tables, because a test that typed `toBe(24)` would
 * be the same defect one layer down.
 */

const ROUTES: Readonly<Record<string, string>> = API_ROUTES;
const WRITE_ROUTES: readonly string[] = API_WRITE_ROUTES;

/** The map against the live tables, with the CLI half deliberately not checked. */
function defects(
  entries: readonly SurfaceEntry[] = SURFACE_MAP,
  routes: Readonly<Record<string, string>> = ROUTES,
  writeRoutes: readonly string[] = WRITE_ROUTES,
): readonly string[] {
  return surfaceDefects({ entries, routes, writeRoutes, commands: null });
}

/** Every entry the predicate does not name. */
function without(predicate: (entry: SurfaceEntry) => boolean): readonly SurfaceEntry[] {
  return SURFACE_MAP.filter((entry) => !predicate(entry));
}

/** Does one sentence name all of these subjects at once? */
function names(sentences: readonly string[], ...subjects: readonly string[]): boolean {
  return sentences.some((sentence) => subjects.every((subject) => sentence.includes(subject)));
}

/** The arms the injected tables demand: a GET for every route, a POST for every write. */
function expectedArms(
  routes: Readonly<Record<string, string>> = ROUTES,
  writeRoutes: readonly string[] = WRITE_ROUTES,
): ReadonlySet<string> {
  const arms = new Set<string>();
  for (const route of Object.keys(routes)) {
    arms.add(route + " GET");
  }
  for (const route of writeRoutes) {
    arms.add(route + " POST");
  }
  return arms;
}

/** The arms the map actually carries. */
function coveredArms(entries: readonly SurfaceEntry[] = SURFACE_MAP): ReadonlySet<string> {
  const arms = new Set<string>();
  for (const entry of entries) {
    if (entry.route !== null) {
      arms.add(entry.route + " " + String(entry.method));
    }
  }
  return arms;
}

// ---------------------------------------------------------------------------
// F1 — missing, on the API side
// ---------------------------------------------------------------------------

describe("the map answers every arm the route table declares", () => {
  it("finds no defect in the map as declared", () => {
    expect(defects()).toEqual([]);
  });

  it("names the arm when an entry is dropped", () => {
    const mutated = without((entry) => entry.route === "taskLifecycle" && entry.method === "GET");
    const found = defects(mutated);
    expect(found.length).toBeGreaterThan(0);
    expect(names(found, "taskLifecycle", "GET")).toBe(true);
  });

  it("names an arm the injected table declares and the map has never seen", () => {
    // The probe that matters, and the one `bindingCoversAllRoutes()` cannot
    // have: the map is left whole and the *table* grows. A checker that had
    // memorised its own list instead of reading the argument stays silent here.
    const grown = { ...ROUTES, syntheticRoute: "/api/v1/synthetic" };
    const found = defects(SURFACE_MAP, grown);
    expect(names(found, "syntheticRoute", "GET")).toBe(true);
  });

  it("names an arm a widened write table declares", () => {
    const grown = [...WRITE_ROUTES, "overview"];
    const found = defects(SURFACE_MAP, ROUTES, grown);
    expect(names(found, "overview", "POST")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F2 — extra
// ---------------------------------------------------------------------------

describe("the map carries no arm the route table does not have", () => {
  it("names a route the table does not declare", () => {
    const mutated: readonly SurfaceEntry[] = [
      ...SURFACE_MAP,
      {
        command: null,
        // The type forbids this, which is the point: the guard exists for a
        // hand-edited table and a JavaScript caller, neither of which the
        // compiler sees.
        route: "accountsx" as unknown as SurfaceEntry["route"],
        method: "GET",
        equivalence: "API_ONLY",
        because: "a plausible near-miss",
      },
    ];
    expect(names(defects(mutated), "accountsx")).toBe(true);
  });

  it("names a write declared on a read route", () => {
    const mutated: readonly SurfaceEntry[] = [
      ...SURFACE_MAP,
      { command: null, route: "overview", method: "POST", equivalence: "API_ONLY", because: "a write that does not exist" },
    ];
    expect(names(defects(mutated), "overview", "POST")).toBe(true);
  });

  it("names a method that is neither read nor write", () => {
    const mutated: readonly SurfaceEntry[] = [
      ...SURFACE_MAP,
      {
        command: null,
        route: "overview",
        method: "DELETE" as unknown as SurfaceEntry["method"],
        equivalence: "API_ONLY",
        because: "a method this plane never answers",
      },
    ];
    expect(names(defects(mutated), "DELETE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F3 — duplicate
// ---------------------------------------------------------------------------

describe("the map states each pairing once", () => {
  it("refuses the same command, route and method twice", () => {
    const toolCall = SURFACE_MAP.find((entry) => entry.command === "tool-call");
    expect(toolCall).toBeDefined();
    const mutated: readonly SurfaceEntry[] = [...SURFACE_MAP, toolCall!];
    expect(names(defects(mutated), "tool-call")).toBe(true);
  });

  it("refuses one command carrying two different arms", () => {
    const mutated: readonly SurfaceEntry[] = [
      ...SURFACE_MAP,
      { command: "overview", route: "tasks", method: "GET", equivalence: "PROJECTION" },
    ];
    expect(names(defects(mutated), "overview")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F4 — mismatched
// ---------------------------------------------------------------------------

describe("the map cannot manufacture an equivalence it does not have", () => {
  it("refuses a projection that names no command", () => {
    // The assertion that mechanically forbids the easy lie: an API-only arm
    // promoted to PROJECTION so the table looks symmetrical.
    const mutated = SURFACE_MAP.map((entry) =>
      entry.route === "accounts" && entry.method === "GET"
        ? ({ ...entry, equivalence: "PROJECTION" } as SurfaceEntry)
        : entry,
    );
    expect(names(defects(mutated), "accounts")).toBe(true);
  });

  it("refuses one arm carrying two different equivalences", () => {
    const mutated = SURFACE_MAP.map((entry) =>
      entry.command === "attach"
        ? ({ ...entry, equivalence: "PROJECTION" } as SurfaceEntry)
        : entry,
    );
    expect(names(defects(mutated), "taskLifecycle", "POST")).toBe(true);
  });

  it("refuses an api-only arm with no recorded reason", () => {
    const mutated = SURFACE_MAP.map((entry) =>
      entry.route === "health" ? ({ ...entry, because: "" } as SurfaceEntry) : entry,
    );
    expect(names(defects(mutated), "health")).toBe(true);
  });

  it("refuses a cli-only command that names a route", () => {
    const mutated = SURFACE_MAP.map((entry) =>
      entry.command === "submission"
        ? ({ ...entry, route: "tasks", method: "GET" } as SurfaceEntry)
        : entry,
    );
    expect(names(defects(mutated), "submission")).toBe(true);
  });

  it("refuses a method with no route, and a route with no method", () => {
    const methodOnly: readonly SurfaceEntry[] = [
      ...SURFACE_MAP,
      { command: "submission", route: null, method: "GET", equivalence: "CLI_ONLY", because: "no route" },
    ];
    expect(defects(methodOnly).length).toBeGreaterThan(0);
    const routeOnly: readonly SurfaceEntry[] = [
      ...SURFACE_MAP,
      { command: null, route: "overview", method: null, equivalence: "API_ONLY", because: "no method" },
    ];
    expect(defects(routeOnly).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F5 — many-to-one, admitted and asserted as admitted
// ---------------------------------------------------------------------------

describe("one arm two commands reach is admitted, and admitted on purpose", () => {
  it("carries exactly cancel and attach on the lifecycle write, both documents", () => {
    // Asserted rather than tolerated, so a later author who "fixes the
    // duplicate" breaks a test instead of silently dropping a verb.
    const pair = SURFACE_MAP.filter(
      (entry) => entry.route === "taskLifecycle" && entry.method === "POST",
    );
    expect(pair.map((entry) => entry.command).sort()).toEqual(["attach", "cancel"]);
    expect(new Set(pair.map((entry) => entry.equivalence))).toEqual(new Set(["DOCUMENT"]));
  });

  it("goes red if a later author drops one of the two", () => {
    // The probe that gives the assertion above its teeth. Dropping `attach`
    // leaves the arm covered, so no defect is raised and nothing else notices —
    // this is the only place the loss is visible.
    const dropped = without((entry) => entry.command === "attach");
    const pair = dropped.filter(
      (entry) => entry.route === "taskLifecycle" && entry.method === "POST",
    );
    expect(pair.map((entry) => entry.command).sort()).not.toEqual(["attach", "cancel"]);
  });

  it("admits the shared arm without complaint", () => {
    expect(defects()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F8 — the causal regression the stale prose could not have had
// ---------------------------------------------------------------------------

describe("totality is a function of the live table, not of a number in a comment", () => {
  it("names the arm when a route leaves the injected table", () => {
    const shrunk = Object.fromEntries(
      Object.entries(ROUTES).filter(([name]) => name !== "accounts"),
    );
    expect(names(defects(SURFACE_MAP, shrunk), "accounts")).toBe(true);
  });

  it("names the arm when a route joins the injected table", () => {
    const grown = { ...ROUTES, laterRoute: "/api/v1/later" };
    expect(names(defects(SURFACE_MAP, grown), "laterRoute")).toBe(true);
  });

  it("covers exactly the arms the injected tables demand, counted from them", () => {
    expect([...coveredArms()].sort()).toEqual([...expectedArms()].sort());
  });

  it("partitions every entry into exactly one recorded class", () => {
    const classes = ["PROJECTION", "DOCUMENT", "API_ONLY", "CLI_ONLY"] as const;
    const counted = classes.reduce(
      (total, name) => total + SURFACE_MAP.filter((entry) => entry.equivalence === name).length,
      0,
    );
    expect(counted).toBe(SURFACE_MAP.length);
    for (const entry of SURFACE_MAP) {
      expect(classes).toContain(entry.equivalence);
      if (entry.equivalence === "API_ONLY" || entry.equivalence === "CLI_ONLY") {
        expect((entry.because ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  it("reaches every paired arm from a command, and every api-only arm from none", () => {
    const paired = SURFACE_MAP.filter(
      (entry) => entry.equivalence === "PROJECTION" || entry.equivalence === "DOCUMENT",
    );
    for (const entry of paired) {
      expect(entry.command).not.toBeNull();
      expect(entry.route).not.toBeNull();
      expect(entry.method).not.toBeNull();
    }
    for (const entry of SURFACE_MAP.filter((candidate) => candidate.equivalence === "API_ONLY")) {
      expect(entry.command).toBeNull();
      expect(entry.route).not.toBeNull();
    }
    for (const entry of SURFACE_MAP.filter((candidate) => candidate.equivalence === "CLI_ONLY")) {
      expect(entry.route).toBeNull();
      expect(entry.method).toBeNull();
      expect(entry.command).not.toBeNull();
    }
  });
});

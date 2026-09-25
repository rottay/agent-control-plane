import type { ApiRouteName, ApiWriteMethod } from "../routes/index.js";

/**
 * What each door answers, and where the two doors meet (old-roadmap R1).
 *
 * The V2 draft asserts that the CLI and the API are equivalent. This module is
 * what turns that assertion into a checked statement: one entry per pairing,
 * every arm of the route table accounted for, and every asymmetry recorded with
 * the reason it exists rather than left as a silence.
 *
 * **The relation is many-to-many, not a bijection.** `cancel` and `attach` both
 * reach `taskLifecycle` POST, distinguished only by the `verb` field of the
 * lifecycle request; a registry shaped as a bijection would have been forced to
 * invent a second route or to drop one of the two commands. The paired arms
 * therefore carry one more entry than there are arms (a count this sentence said
 * as two cardinals, and let go stale, until P-24/B(a)), and the duplicate rule
 * below is written over the key that makes the distinction.
 *
 * **This is a compile, test and documentation contract, and nothing else.** No
 * runtime dispatch, no help output and no request handling reads it. That is a
 * decision rather than an omission, for two reasons: a documentation contract
 * that becomes a request-path dependency stops being cheap to change, and a
 * machine-readable list of every write door emitted by a running process is an
 * attack aid. It is imported by tests and read as text by the architecture
 * fence, which runs before any build and cannot import it. ADR 0049 records it.
 *
 * It lives in this package because this is the one package both doors may name:
 * the gateway may not reach `@acp/contracts`, the CLI does not depend on it
 * either, the gateway may not import the CLI, and the CLI naming the gateway is
 * a stop in its own right.
 */

/** How a command and an arm of the route table relate, when they relate at all. */
export type SurfaceEquivalence =
  /** The same rows, rendered twice: the command projects what the route serves. */
  | "PROJECTION"
  /** The same act, recorded once: both doors submit it and print the receipt. */
  | "DOCUMENT"
  /** An arm no command answers, with the reason recorded. */
  | "API_ONLY"
  /** A command no arm answers, with the reason recorded. */
  | "CLI_ONLY";

/** One pairing, or one recorded absence of a pairing. */
export interface SurfaceEntry {
  /** The CLI command, or `null` when no command reaches this arm. */
  readonly command: string | null;
  /** The route, or `null` when no route answers this command. */
  readonly route: ApiRouteName | null;
  /** The method on that route; `null` exactly when `route` is `null`. */
  readonly method: ApiWriteMethod | null;
  /** Which of the four relations this entry states. */
  readonly equivalence: SurfaceEquivalence;
  /** Required for `API_ONLY` and `CLI_ONLY`: why the other door is silent. */
  readonly because?: string;
}

/**
 * The tables a check is measured against, passed in rather than read.
 *
 * This is the load-bearing shape of the module, not a convenience. A checker
 * that reached for `API_ROUTES` itself could never be handed a different table,
 * so no test could prove it actually reads one — which is exactly how the
 * docblock above `bindingCoversAllRoutes` came to say "twelve" over twenty
 * routes for eight packets while the function it described stayed green.
 */
export interface SurfaceMapInput {
  readonly entries: readonly SurfaceEntry[];
  readonly routes: Readonly<Record<string, string>>;
  readonly writeRoutes: readonly string[];
  /** `null` means "do not check the CLI half here" — the protocol suite cannot see COMMANDS. */
  readonly commands: readonly string[] | null;
}

function entry(
  command: string | null,
  route: ApiRouteName | null,
  method: ApiWriteMethod | null,
  equivalence: SurfaceEquivalence,
  because?: string,
): SurfaceEntry {
  return because === undefined
    ? { command, route, method, equivalence }
    : { command, route, method, equivalence, because };
}

/**
 * Every pairing this plane has, and every absence of one.
 *
 * Written through a module-private helper with one `entry(` per line, because
 * the architecture fence parses this literal as text: it runs before any build
 * and cannot import the compiled module.
 */
export const SURFACE_MAP: readonly SurfaceEntry[] = Object.freeze([
  entry("overview", "overview", "GET", "PROJECTION"),
  entry("tasks", "tasks", "GET", "PROJECTION"),
  entry("task", "taskById", "GET", "PROJECTION"),
  entry("workers", "workers", "GET", "PROJECTION"),
  entry("worker", "workerByIdentity", "GET", "PROJECTION"),
  entry("events", "events", "GET", "PROJECTION"),
  entry("status", "status", "GET", "PROJECTION"),
  entry("integrity", "integrity", "GET", "PROJECTION"),
  entry("tool-calls", "taskToolCalls", "GET", "PROJECTION"),
  entry("tool-call", "taskToolCalls", "POST", "DOCUMENT"),
  entry("cancel", "taskLifecycle", "POST", "DOCUMENT"),
  entry("attach", "taskLifecycle", "POST", "DOCUMENT"),
  entry("initiative", "initiatives", "POST", "DOCUMENT"),
  entry("intake", "tasks", "POST", "DOCUMENT"),
  entry("effects", "taskEffects", "GET", "PROJECTION"),
  entry("result", "taskEffectResult", "GET", "DOCUMENT"),
  entry("tool-servers", "toolServerTools", "GET", "DOCUMENT"),
  entry("submission", null, null, "CLI_ONLY",
    "a planning verb: it re-elects a config's route and prints the document; it opens " +
      "the ledger query-only and appends nothing, and the plane exposes no route that plans"),
  entry("switch-decision", null, null, "CLI_ONLY",
    "a decision verb: it folds recorded pressure through the switch policy and prints " +
      "what it decided; it plays no plan and moves no account, and the plane exposes no " +
      "route that decides"),
  entry("registry", null, null, "CLI_ONLY",
    "registry configuration is an owner act on the local plane: the specification names " +
      "no API door for it (requirements E4, streams §4), so a route is added only when a " +
      "specification row asks for one (P-15/R, decision 128)"),
  entry(null, "health", "GET", "API_ONLY",
    "liveness of a server process; a CLI has no process to report on, and the contract " +
      "already names it the non-ledger exception"),
  entry(null, "eventStream", "GET", "API_ONLY",
    "a connection, not a body: Last-Event-ID resumption has no CLI shape, and a CLI that " +
      "streamed would be a second liveness contract. The parity suite does compare one " +
      "frame's item against a CLI builder, which is not the same claim as a CLI verb " +
      "answering this arm"),
  entry(null, "taskLifecycle", "GET", "API_ONLY",
    "the lifecycle read; the CLI reaches this task's coordinates through events and task, " +
      "and a read verb here would be a second projection of rows the CLI already folds"),
  entry(null, "initiatives", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "initiativeById", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "initiativeRoadmap", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "initiativeRoadmap", "POST", "API_ONLY",
    "a write door with a bearer guard; the CLI has no bearer and takes exactly one " +
      "writable open, in the tool-call verb"),
  entry(null, "initiativeRoadmapContent", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "initiativeRoadmapSteps", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "initiativeRoadmapDiff", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "initiativeStepGraph", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "initiativeStepGraph", "POST", "API_ONLY",
    "a bearer-guarded write door; the same answer as initiativeRoadmap POST"),
  entry(null, "initiativeTaskStep", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "initiativeTaskStep", "POST", "API_ONLY",
    "a bearer-guarded write door; the same answer as initiativeRoadmap POST"),
  entry(null, "initiativeEvents", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "initiativeAgents", "GET", "API_ONLY",
    "the initiative data plane is a console surface (P8-8A); no CLI verb was ever " +
      "specified for it"),
  entry(null, "accounts", "GET", "API_ONLY",
    "reads the owner's accounts file, the contract's declared non-ledger source; the CLI " +
      "reaches that file only as an explicit --accounts input to two planning verbs, " +
      "which is a different question from serving the route"),
  entry(null, "accountActions", "GET", "API_ONLY",
    "the action history beside accounts, and the same answer: the CLI reaches account " +
      "material only as an explicit --accounts input to two planning verbs, which is a " +
      "different question from serving the route"),
  entry(null, "accountActions", "POST", "API_ONLY",
    "a bearer-guarded write door; the same answer as initiativeRoadmap POST"),
]);

/** `route method`, the key an arm is identified by. */
function armOf(route: string, method: string): string {
  return route + " " + method;
}

/** What a defect sentence calls this entry. */
function labelOf(item: SurfaceEntry): string {
  if (item.route !== null) {
    const arm = armOf(item.route, item.method ?? "no method");
    return item.command === null ? "the arm " + arm : "the pairing " + item.command + " -> " + arm;
  }
  return item.command === null ? "an entry naming neither door" : "the command " + item.command;
}

/**
 * Every defect in a surface map, as sentences. Empty means total and consistent.
 *
 * Six classes, each naming its subject: an arm the tables demand and no entry
 * answers; an entry naming something the tables do not carry; the same pairing
 * twice, or one command reaching two arms; an entry whose equivalence contradicts
 * its own nulls; and — when `commands` is given — a command with no entry or an
 * entry with no command.
 *
 * One arm reached by two different commands is **not** a defect, provided they
 * agree on the equivalence. That admission is deliberate and it is the reason
 * `cancel` and `attach` can both name `taskLifecycle` POST.
 */
export function surfaceDefects(input: SurfaceMapInput): readonly string[] {
  const found: string[] = [];
  const routeNames = new Set(Object.keys(input.routes));
  const writeRoutes = new Set(input.writeRoutes);

  for (const item of input.entries) {
    const label = labelOf(item);
    // Widened on purpose: the fields are typed, but this module is the contract
    // a JavaScript caller and a hand-edited table are both measured against, so
    // the guard has to be able to see a value the type says cannot arrive.
    const method: string | null = item.method;
    const route: string | null = item.route;

    if (route === null && method !== null) {
      found.push("mismatched: " + label + " names the method " + method + " but no route");
    }
    if (route !== null && method === null) {
      found.push("mismatched: " + label + " names a route but no method");
    }
    if (route !== null && !routeNames.has(route)) {
      found.push("extra: " + label + " names " + route + ", which the route table does not declare");
    }
    if (route !== null && method !== null && method !== "GET" && method !== "POST") {
      found.push(
        "extra: " + label + " names the method " + method + " on " + route +
          ", which is neither GET nor POST",
      );
    }
    if (route !== null && method === "POST" && !writeRoutes.has(route)) {
      found.push("extra: " + label + " names POST on " + route + ", which is not a write route");
    }

    if (item.equivalence === "PROJECTION" || item.equivalence === "DOCUMENT") {
      if (item.command === null) {
        found.push("mismatched: " + label + " is " + item.equivalence + " but names no command");
      }
      if (route === null) {
        found.push("mismatched: " + label + " is " + item.equivalence + " but names no route");
      }
    }
    if (item.equivalence === "API_ONLY") {
      if (item.command !== null) {
        found.push("mismatched: " + label + " is API_ONLY and names the command " + item.command);
      }
      if (route === null) {
        found.push("mismatched: " + label + " is API_ONLY and names no route");
      }
    }
    if (item.equivalence === "CLI_ONLY") {
      if (route !== null) {
        found.push("mismatched: " + label + " is CLI_ONLY and names the route " + route);
      }
      if (item.command === null) {
        found.push("mismatched: " + label + " is CLI_ONLY and names no command");
      }
    }
    if (item.equivalence === "API_ONLY" || item.equivalence === "CLI_ONLY") {
      if (item.because === undefined || item.because.trim() === "") {
        found.push(
          "mismatched: " + label + " is " + item.equivalence + " with no recorded reason",
        );
      }
    }
  }

  // --- the same pairing twice, and one command reaching two arms ------------
  const seen = new Map<string, number>();
  const armsByCommand = new Map<string, Set<string>>();
  for (const item of input.entries) {
    const triple =
      (item.command ?? "none") + " | " + (item.route ?? "none") + " | " + (item.method ?? "none");
    seen.set(triple, (seen.get(triple) ?? 0) + 1);
    if (item.command !== null) {
      const arms = armsByCommand.get(item.command) ?? new Set<string>();
      arms.add(item.route === null ? "no route" : armOf(item.route, item.method ?? "no method"));
      armsByCommand.set(item.command, arms);
    }
  }
  for (const [triple, count] of seen) {
    if (count > 1) {
      found.push("duplicate: the entry " + triple + " appears " + String(count) + " times");
    }
  }
  for (const [command, arms] of armsByCommand) {
    if (arms.size > 1) {
      found.push(
        "duplicate: the command " + command + " carries more than one arm: " +
          [...arms].sort().join(", "),
      );
    }
  }

  // --- one arm, one equivalence, however many commands reach it ------------
  const classesByArm = new Map<string, Set<SurfaceEquivalence>>();
  for (const item of input.entries) {
    if (item.route === null) {
      continue;
    }
    const arm = armOf(item.route, item.method ?? "no method");
    const classes = classesByArm.get(arm) ?? new Set<SurfaceEquivalence>();
    classes.add(item.equivalence);
    classesByArm.set(arm, classes);
  }
  for (const [arm, classes] of classesByArm) {
    if (classes.size > 1) {
      found.push(
        "mismatched: the arm " + arm + " carries more than one equivalence: " +
          [...classes].sort().join(", "),
      );
    }
  }

  // --- every arm the tables demand ----------------------------------------
  const covered = new Set<string>();
  for (const item of input.entries) {
    if (item.route !== null) {
      covered.add(armOf(item.route, item.method ?? "no method"));
    }
  }
  const demanded: string[] = [];
  for (const route of routeNames) {
    demanded.push(armOf(route, "GET"));
  }
  for (const route of writeRoutes) {
    demanded.push(armOf(route, "POST"));
  }
  for (const arm of demanded) {
    if (!covered.has(arm)) {
      found.push("missing: no entry answers the arm " + arm);
    }
  }

  // --- the CLI half, when the caller can see it ---------------------------
  if (input.commands !== null) {
    const commandNames = new Set(input.commands);
    for (const item of input.entries) {
      if (item.command !== null && !commandNames.has(item.command)) {
        found.push(
          "extra: the entry names the command " + item.command + ", which this CLI does not have",
        );
      }
    }
    const named = new Set(
      input.entries.flatMap((item) => (item.command === null ? [] : [item.command])),
    );
    for (const command of input.commands) {
      if (!named.has(command)) {
        found.push("missing: no entry names the command " + command);
      }
    }
  }

  return found;
}

import { findCredentialViolations, findTranscriptViolations } from "@acp/contracts";

import type { ApiRouteName } from "./routes.js";
import { API_ROUTES } from "./routes.js";

/**
 * The ledger-to-client parity contract.
 *
 * P3's third obligation is that the UI matches the ledger exactly. "Exactly"
 * has to mean something checkable, so this module states it as an equality over
 * a canonical row model:
 *
 *   ledger projection  ==  server response  ==  CLI rows  ==  UI rows
 *
 * The contract is here, in the shared package, rather than in any one client,
 * because a parity law that lived in a client would be a law that client could
 * quietly redefine.
 *
 * Two things make the equality honest rather than decorative:
 *
 * 1. **Every field is bound to a source.** A field a client renders with no
 *    ledger expression behind it is a parity failure, not a nicety — unless it
 *    is one of the named non-ledger exceptions below, which are written down
 *    here as decisions rather than left as omissions.
 * 2. **Volatile fields are declared, not silently ignored.** The three clients
 *    observe at different instants, so a wall-clock field can never be equal
 *    between them. Those fields are named, excluded from the comparison, and
 *    still required to be *present and well-formed*. Comparing them would make
 *    the suite fail for the passage of time; ignoring them undeclared would let
 *    a real divergence hide behind a timestamp.
 */

/** Where a rendered field's value comes from. */
export type ParitySource =
  /** Derived from ledger state; must be equal across all three clients. */
  | "LEDGER"
  /** Not from the ledger, and equal across clients: a frozen constant. */
  | "CONTRACT_VERSION"
  /** Not from the ledger, and not comparable: process liveness. */
  | "LIVENESS"
  /** Not from the ledger, and not comparable: an observation instant. */
  | "OBSERVED_AT";

export interface FieldBinding {
  readonly field: string;
  readonly source: ParitySource;
  /** Why, when the source is not the ledger. Required for every exception. */
  readonly because?: string;
}

/** A source that is exempt from cross-client equality, and must say why. */
export const NON_LEDGER_SOURCES: readonly ParitySource[] = Object.freeze([
  "CONTRACT_VERSION",
  "LIVENESS",
  "OBSERVED_AT",
]);

/**
 * Field names whose values are an instant of observation.
 *
 * Stripped before comparison wherever they appear, at any depth. This is the
 * "no brittle timestamp" law applied to parity: a suite that compared these
 * would fail because time passed, which teaches a reader to ignore it.
 */
export const VOLATILE_FIELDS: readonly string[] = Object.freeze([
  "observedAt",
  "checkedAt",
]);

/**
 * Every field of every one of the nine frozen routes, bound to its source.
 *
 * `health` is the only route with no ledger content, and it is declared in full
 * rather than omitted — an unlisted route would let "all nine routes are
 * parity-proven" be true of a table that covered eight.
 */
function bind(field: string, source: ParitySource, because?: string): FieldBinding {
  return because === undefined ? { field, source } : { field, source, because };
}

export const PARITY_BINDINGS: Readonly<Record<ApiRouteName, readonly FieldBinding[]>> =
  Object.freeze({
    health: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package, not ledger state"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package, not ledger state"),
      bind("status", "LIVENESS", "whether this process can reach a ledger, which is not a fact in one"),
      bind("readOnly", "LIVENESS", "a structural property of the server, always true"),
      bind("observedAt", "OBSERVED_AT", "the instant of the check"),
      bind("database", "LIVENESS", "identity of the file this process opened, not its contents"),
      bind("detail", "LIVENESS", "why the ledger is unreachable, when it is"),
    ]),
    overview: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("state", "LEDGER"),
      bind("database", "LEDGER"),
      bind("ledger", "LEDGER"),
      bind("integrity", "LEDGER"),
      bind("tasks", "LEDGER"),
      bind("workers", "LEDGER"),
      bind("capabilities", "CONTRACT_VERSION", "a frozen capability set"),
      bind("notice", "LIVENESS", "why the plane is degraded, when it is"),
      bind("observedAt", "OBSERVED_AT", "the instant of the read"),
    ]),
    tasks: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("items", "LEDGER"),
      bind("page", "LEDGER"),
    ]),
    taskById: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("task", "LEDGER"),
    ]),
    workers: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("items", "LEDGER"),
      bind("page", "LEDGER"),
    ]),
    workerByIdentity: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("worker", "LEDGER"),
    ]),
    events: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("items", "LEDGER"),
      bind("page", "LEDGER"),
    ]),
    status: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("database", "LEDGER"),
      bind("readOnly", "LIVENESS", "a structural property of the server, always true"),
      bind("headSequence", "LEDGER"),
      bind("headEventSha256", "LEDGER"),
      bind("eventCount", "LEDGER"),
      bind("pragmas", "LEDGER"),
      bind("migrations", "LEDGER"),
      bind("projections", "LEDGER"),
      bind("observedAt", "OBSERVED_AT", "the instant of the read"),
    ]),
    integrity: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ok", "LEDGER"),
      bind("checkedEvents", "LEDGER"),
      bind("headSequence", "LEDGER"),
      bind("headEventSha256", "LEDGER"),
      bind("problems", "LEDGER"),
      bind("truncated", "LEDGER"),
      bind("checkedAt", "OBSERVED_AT", "the instant of the verification"),
    ]),
  });

/** Every route the contract covers. Nine, matching the frozen route table. */
export const PARITY_ROUTES: readonly ApiRouteName[] = Object.freeze(
  Object.keys(PARITY_BINDINGS) as ApiRouteName[],
);

/** The fields of a route that must be equal across all three clients. */
export function comparableFields(route: ApiRouteName): readonly string[] {
  return PARITY_BINDINGS[route]
    .filter((binding) => binding.source === "LEDGER" || binding.source === "CONTRACT_VERSION")
    .map((binding) => binding.field);
}

/** The declared exceptions of a route, each of which must state a reason. */
export function declaredExceptions(route: ApiRouteName): readonly FieldBinding[] {
  return PARITY_BINDINGS[route].filter((binding) =>
    NON_LEDGER_SOURCES.includes(binding.source),
  );
}

/**
 * Project a response into the canonical row model.
 *
 * Key order is normalised so two objects that carry the same data compare
 * equal, and volatile fields are removed at every depth. **Array order is
 * preserved**: ordering, pagination boundaries and cursors are part of the
 * contract, and a client that sorted differently would agree on sets while
 * telling a different story.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (VOLATILE_FIELDS.includes(key)) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

/**
 * The canonical row model for one route's response.
 *
 * Each client exposes an adapter that calls this with its own output, so there
 * is one definition of the row model and three sources for it, rather than
 * three definitions that have to be kept in step.
 */
export function canonicalRows(route: ApiRouteName, response: unknown): unknown {
  if (!Object.hasOwn(PARITY_BINDINGS, route)) {
    throw new Error("no parity binding for route " + route);
  }
  return canonicalize(response);
}

/** Are the nine frozen routes exactly the routes this contract binds? */
export function bindingCoversAllRoutes(): boolean {
  const frozen = Object.keys(API_ROUTES).sort().join(",");
  const bound = [...PARITY_ROUTES].sort().join(",");
  return frozen === bound;
}

/**
 * Does this value carry anything the observation surface must never expose?
 *
 * Redaction here is **absence, not blanking**: a field named `apiKey` is a
 * violation whether or not its value is empty, because the name alone tells a
 * reader that a secret belongs there. The two guards behind this come from
 * `@acp/contracts`, so the whole system keeps one privacy vocabulary — a
 * second denylist would be a second opinion about what a secret looks like.
 *
 * It is exposed as a named helper because the server package may not reach
 * `@acp/contracts` directly: that reach is excluded by its dependency law
 * (`mappers.ts` records the same exclusion). Rather than widen the server or
 * restate the guards in a second place, the shared contract that both the
 * server and the browser already depend on answers the question for them. This
 * is the only privacy surface `@acp/api-contracts` adds.
 */
export function hasObservationPrivacyViolation(value: unknown): boolean {
  return findCredentialViolations(value).length > 0 || findTranscriptViolations(value).length > 0;
}

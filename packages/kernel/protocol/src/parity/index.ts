import { findCredentialViolations, findTranscriptViolations } from "@acp/contracts";

import type { ApiRouteName } from "../routes/index.js";
import { API_ROUTES } from "../routes/index.js";

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
  | "OBSERVED_AT"
  /**
   * Not from the ledger: the owner's accounts file, read at request time.
   *
   * Added in P8-8F, and the first source in this table that is neither ledger
   * state nor a constant. Two clients handed the same file at the same instant
   * agree, so the value is deterministic — but "the same file" is a
   * precondition none of the ledger's own routes need, and the CLI and UI row
   * models never read it at all. Binding these fields to `LEDGER` would make
   * this table assert a provenance the data does not have, so the honest move
   * is a source of its own that must say why.
   */
  | "ACCOUNTS_FILE";

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
  "ACCOUNTS_FILE",
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
 * Every field of every one of the twelve frozen routes, bound to its source.
 *
 * `health` is the only route with no ledger content, and it is declared in full
 * rather than omitted — an unlisted route would let "every route is
 * parity-proven" be true of a table that covered all but one.
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
    // P8-8A: the initiative data plane. Every field is ledger-derived —
    // including the rollups, which are a fold over ledger events rather than a
    // measurement taken anywhere else — so the initiative routes add no new
    // non-ledger exception to the table.
    initiatives: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("items", "LEDGER"),
      bind("count", "LEDGER"),
    ]),
    initiativeById: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("initiative", "LEDGER"),
    ]),
    // The roadmap route answers a GET with the history and a POST with the
    // recorded version. Parity is about what the three clients *read*, so the
    // binding below stays the GET's response — the write's own shape is
    // asserted by the schema and the endpoint's tests, and binding it here
    // would claim a CLI and a browser render it, which neither does.
    /**
     * The content route's parity exception (P8-8D-c2), recorded here rather
     * than left as an omission — which is this module's own rule for every
     * exception it makes.
     *
     * Every other route's response is a **projection**: a set of fields folded
     * out of ledger state, and the parity law is that three clients fold them
     * identically. This one serves a **document** — bytes the ledger does not
     * contain, named by a digest it does. `content` is therefore bound to the
     * ledger in a different sense from every field above it: the ledger fixes
     * *which* bytes, and the artifact store holds them.
     *
     * That distinction is why the binding is still `LEDGER` and still
     * comparable: two clients asking for version 3 must receive the same
     * bytes, and the digest beside them is what makes that checkable rather
     * than assumed. What does not carry over is the row-model framing — there
     * is no row here, and `canonicalize` sorting keys of a markdown string
     * would be sorting nothing.
     */
    initiativeRoadmapContent: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("initiativeId", "LEDGER"),
      bind("version", "LEDGER"),
      bind("contentDigest", "LEDGER"),
      bind("kind", "LEDGER"),
      bind("content", "LEDGER"),
    ]),
    initiativeRoadmap: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("initiativeId", "LEDGER"),
      bind("items", "LEDGER"),
      bind("count", "LEDGER"),
    ]),
    /**
     * The merged timeline (P8-8E-pre, C2).
     *
     * `items` binds to `LEDGER` in the strong sense: every field of every entry
     * is a value one of the two chains recorded, and the merge adds exactly one
     * thing that neither chain contains — the `stream` tag, which is not a fact
     * about an event but a statement of which chain it was read from. That is
     * derivable by any client from the same two queries, which is why it stays
     * comparable under the parity law rather than becoming an exception.
     *
     * `truncated` binds to the fold, not to the ledger: it reports whether this
     * response stopped at the ceiling. Two clients folding the same ledger with
     * the same ceiling agree on it, which is all parity asks.
     */
    initiativeEvents: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("initiativeId", "LEDGER"),
      bind("items", "LEDGER"),
      bind("count", "LEDGER"),
      bind("truncated", "LEDGER"),
    ]),
    /**
     * The scoped workers (P8-8E-pre, C3).
     *
     * Every field is folded from this initiative's own task events. The global
     * worker projection is deliberately **not** the source: it would answer the
     * same question faster and wrongly, because its `lastTaskId` names the last
     * task anywhere. A binding of `LEDGER` here therefore means "folded from
     * the scoped events", and two clients folding the same scope agree.
     */
    initiativeAgents: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("initiativeId", "LEDGER"),
      bind("items", "LEDGER"),
      bind("count", "LEDGER"),
    ]),
    /**
     * The accounts read (P8-8F).
     *
     * The recorded exception, and the sharpest one in this table: **the source
     * is not the ledger.** Every other route folds the append-only stream;
     * this one reads the owner's accounts file and computes quota and reset
     * against an injected instant. Two clients handed the same file and the
     * same instant agree, which is the property the parity law actually
     * protects — but "the same file" is a precondition the ledger's own
     * routes never need, and pretending otherwise by binding these to `LEDGER`
     * would make the table say something false about where the data lives.
     *
     * `status` binds to the fold in the same sense: whether the file is
     * readable is a fact about the machine at request time, and two clients
     * on the same machine at the same instant agree about it.
     */
    accounts: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("status", "ACCOUNTS_FILE", "the owner's accounts file, read at request time"),
      bind("items", "ACCOUNTS_FILE", "the owner's accounts file, read at request time"),
      bind("count", "ACCOUNTS_FILE", "the owner's accounts file, read at request time"),
      bind("estimatedAt", "OBSERVED_AT", "the instant injected into this request, not ledger state"),
      bind("reason", "ACCOUNTS_FILE", "the loader's refusal, mapped to the closed API vocabulary"),
      bind("detail", "ACCOUNTS_FILE", "a field path from the loader; never a value from the file"),
    ]),
    /**
     * The account-actions door (P8-8G packet 2).
     *
     * The GET arm's history is ledger state in the ordinary sense — it folds
     * the `account_events` stream, and three clients folding it agree. It is
     * bound to `ACCOUNTS_FILE` rather than `LEDGER` for one field only,
     * `accountId`, because the account the history belongs to is named by the
     * owner file; everything else here the ledger recorded.
     */
    accountActions: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("accountId", "ACCOUNTS_FILE", "the account the owner file names; the history hangs off it"),
      bind("items", "LEDGER"),
      bind("count", "LEDGER"),
    ]),
  });

/** Every route the contract covers, matching the frozen route table exactly. */
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

/** Are the frozen routes exactly the routes this contract binds? */
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
 * is the only privacy surface `@acp/protocol` adds.
 */
export function hasObservationPrivacyViolation(value: unknown): boolean {
  return findCredentialViolations(value).length > 0 || findTranscriptViolations(value).length > 0;
}

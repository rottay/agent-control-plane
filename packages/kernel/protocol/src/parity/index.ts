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
 * Every field of every route `API_ROUTES` declares, bound to its source.
 *
 * The claim is over the frozen table, not over a count: this docblock said
 * "twelve" from the day the table held twelve until the day it held twenty, and
 * nothing failed, because `bindingCoversAllRoutes()` reads `API_ROUTES` itself
 * and can never be handed a table that disagrees with it. A sentence that names
 * the table instead of counting it cannot go stale that way.
 *
 * `health` is the only route with no ledger content, and it is declared in full
 * rather than omitted — an unlisted route would let "every route is
 * parity-proven" be true of a table that covered all but one.
 *
 * `SURFACE_MAP` in `../surface-map/index.js` is this contract's sibling and not
 * part of it: this table binds a rendered field to the source it comes from,
 * that one binds a CLI command to an arm of the route table. They share the
 * `ApiRouteName` key and nothing else.
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
      bind("instance", "LEDGER"),
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
      // From when each stream's chain is evidence, and how that coverage came
      // to be. Every field of it is read from `ledger_meta` and the sidecar, so
      // two clients over one file emit the same values — including
      // `integrityActivatedAt`, which is an instant and is NOT volatile: it is
      // when the chain was computed, recorded once and never rewritten, not
      // when this process looked.
      bind("coverage", "LEDGER"),
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
     * A version's steps and the diff between two versions (P-26 cut C, ADR 0113).
     *
     * Both are folds of the read model and nothing else, so every field is
     * `LEDGER`. That includes the diff's `roles`: the word is not a constant of
     * this contract but a measurement over the step rows — it is answered only
     * when no step row of either side carries a routing assignment, and a row
     * that carries one is refused — so two clients folding the same rows agree
     * on it, and a producer of STEP assignments would change it by changing the
     * rows.
     */
    initiativeRoadmapSteps: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("initiativeId", "LEDGER"),
      bind("version", "LEDGER"),
      bind("steps", "LEDGER"),
    ]),
    initiativeRoadmapDiff: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("initiativeId", "LEDGER"),
      bind("from", "LEDGER"),
      bind("to", "LEDGER"),
      bind("added", "LEDGER"),
      bind("removed", "LEDGER"),
      bind("changed", "LEDGER"),
      bind("dependencies", "LEDGER"),
      bind("contentChanged", "LEDGER"),
      bind("restores", "LEDGER"),
      bind("roles", "LEDGER"),
    ]),
    /**
     * One step's task graph and its READY verdicts (P-27 cut A, ADR 0115), bound on
     * its read and only its read, as `initiativeRoadmap` is.
     *
     * `graph` and `nodes` are folds of the read model: the revision, its nodes and
     * edges, and each node's four verdicts, which the pure predicate computes from
     * rows two clients read alike. The one input that is not a row is the instant an
     * approval's expiry is compared against, and in this build no approval producer
     * exists, so no verdict reads it. `evaluatedAt` echoes that instant and is the
     * exception: an observation instant, never ledger state.
     */
    initiativeStepGraph: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("initiativeId", "LEDGER"),
      bind("version", "LEDGER"),
      bind("stepId", "LEDGER"),
      bind("graph", "LEDGER"),
      bind("nodes", "LEDGER"),
      bind("evaluatedAt", "OBSERVED_AT", "the instant the verdicts were computed against"),
    ]),
    /**
     * One task's step chain (P-27 cut C, ADR 0116), bound on its read and only its
     * read, as `initiativeStepGraph` is. Every field is a fold of the read model: the
     * intake's pair, the link rows in `sequence` order and the current step they
     * derive, with every version resolved to its number.
     */
    initiativeTaskStep: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("initiativeId", "LEDGER"),
      bind("taskId", "LEDGER"),
      bind("enteredOn", "LEDGER"),
      bind("links", "LEDGER"),
      bind("current", "LEDGER"),
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
    /**
     * The event stream (V2-B3a).
     *
     * The bound fields are the **union of the frame union's arms** — every
     * field a reader can receive, whichever kind it gets — which is the same
     * rule `accounts` established when it became the first union here.
     *
     * `item` binds to `LEDGER` in the strongest sense in this table: it is the
     * identical `TimelineItem` the `events` route serves for the same row,
     * built by the same mapper. That is what makes "the stream is a transport,
     * not a second projection" a checkable claim rather than an intention, and
     * a drill compares the two projections row by row.
     *
     * `channel` binds to `LEDGER` too, and deliberately not to a new source:
     * it is a total function of `item.type`, declared as data in
     * `STREAM_CHANNEL_BY_EVENT_TYPE`, so any client holding the same event can
     * derive the same channel without asking this process anything. A field
     * two clients can compute identically from ledger state is ledger-derived,
     * however it happens to be transported.
     *
     * `reason` and `resumedFrom` are the two exceptions, and both are
     * `LIVENESS` rather than `LEDGER`. "This connection cannot serve the anchor
     * you gave me" and "this connection resumed at N, or opened live" are facts
     * about *this process's* handle on the file — which ledger it opened, how
     * far it has read, what cursor the browser happened to send — and not facts
     * recorded anywhere in the ledger. Binding either to `LEDGER` would claim a
     * CLI folding the same events would arrive at the same value, and it would
     * not, because it was never given an anchor.
     *
     * `resumedFrom` joined at V2-B3c and the exception list widened from one
     * field to two. That widening is the visible cost of the design and it is
     * deliberate: the server cannot detect a foreign resume — `Last-Event-ID`
     * is a bare sequence by L1 and by the frame union's shape — so it restates
     * what it knows about *this connection* and lets the client compare. A
     * restatement about a connection is liveness by construction.
     */
    eventStream: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("kind", "LEDGER"),
      bind("channel", "LEDGER"),
      bind("item", "LEDGER"),
      bind("database", "LEDGER"),
      // Which file, not which connection. It is read out of the ledger on every
      // open, so two clients reading the same file agree on it — which is what
      // makes it comparable, and why it is not one of the two LIVENESS
      // exceptions beside it.
      bind("instance", "LEDGER"),
      bind("headSequence", "LEDGER"),
      bind("reason", "LIVENESS", "why this process's handle cannot serve the anchor; never a fact in the ledger"),
      bind(
        "resumedFrom",
        "LIVENESS",
        "the anchor this connection resumed at, or null on a live open; a fact about this process's handle, never recorded in the ledger",
      ),
    ]),
    /**
     * The task's recorded tool calls (V2-B4b stage 3C).
     *
     * The bound fields are the **GET row model's**, which is the projection
     * parity is about: `ToolCallRow` is a fold of one `TOOL_CALL_RECORDED`
     * event, so every member below is ledger-derived and a CLI folding the same
     * rows reaches the same values.
     *
     * `content` is deliberately **absent from this table**, and the absence is
     * the point rather than an omission. It is not a field of the row model at
     * all: the recorder never wrote it, so no client can fold it out of the
     * ledger and there is nothing for parity to compare. It exists only on the
     * POST response, where it travels once to the caller who made the call and
     * is never recorded. A binding here would claim a durable fact that does
     * not exist.
     */
    taskToolCalls: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("taskId", "LEDGER"),
      bind("items", "LEDGER"),
      bind("count", "LEDGER"),
      bind("nextCursor", "LEDGER"),
    ]),
    /**
     * The lifecycle route (V2 L3), bound on its **read** and only its read.
     *
     * The `initiativeRoadmap` precedent, applied to a door whose write is even
     * less of a projection than that one's: the POST answers a document about
     * an operation the driver performed, whose `finalSequence` is a head this
     * process moved. A parity claim over that would be comparing two clients'
     * accounts of one side effect, which is not what this table means by
     * equality — it means two clients reading one ledger see the same rows.
     *
     * So the GET's five fields are bound here, all of them ledger-derived, and
     * the write's document is proved equal across the doors by the equivalence
     * suite instead. The two claims are different in kind and are kept apart on
     * purpose.
     */
    taskLifecycle: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("taskId", "LEDGER"),
      bind("latestAttempt", "LEDGER"),
      bind("currentState", "LEDGER"),
    ]),
    /** A task's effects (P-15/F): every field is a row of the effect read model. */
    taskEffects: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("taskId", "LEDGER"),
      bind("effects", "LEDGER"),
      bind("truncated", "LEDGER"),
    ]),
    /**
     * One effect's result (P-15/F). Ledger-derived like every read: the row names
     * the pair and the plane gives back the bytes the pair names, so two clients
     * reading one ledger and one plane answer the same document. `blockContent`
     * is the block's own bytes by the same rule.
     */
    taskEffectResult: Object.freeze([
      bind("apiContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("ledgerContractVersion", "CONTRACT_VERSION", "a frozen constant of the contract package"),
      bind("taskId", "LEDGER"),
      bind("effectId", "LEDGER"),
      bind("state", "LEDGER"),
      bind("outcomeStatus", "LEDGER"),
      bind("outcomeRecordedAt", "LEDGER"),
      bind("cohort", "LEDGER"),
      bind("result", "LEDGER"),
      bind("blockContent", "LEDGER"),
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

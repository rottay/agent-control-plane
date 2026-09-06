import { ResolvedRoute, findCredentialViolations, findTranscriptViolations } from "@acp/contracts";
import type { ControlPlaneEvent } from "@acp/contracts";

/**
 * Neutral telemetry: the ledger's events as OpenTelemetry-shaped values.
 *
 * Law 9 of the P8 addendum puts the order of dependence beyond argument:
 * observability emits **neutral events first**, compatible with
 * OpenTelemetry and OpenInference conventions; a vendor exporter may come
 * later and optionally; and **no observability vendor is ever required** for
 * routing, recovery or evidence. This module is the neutral half. The vendor
 * half is one pure translator in `./langfuse/`, which nothing here calls.
 *
 * **A read model, never an authority.** These values are derived from the
 * ledger and no decision is ever made from them. Deleting this module, and the
 * translator beside it, removes a projection — routing still routes, recovery
 * still recovers, and the evidence is exactly where it always was, in the
 * append-only chain. That is what "no vendor required" means as a property of
 * the import graph rather than a promise in a paragraph.
 *
 * **Pure, and deliberately ledger-free.** Events arrive as contract values
 * because this package has exactly one module allowed to name `@acp/ledger`
 * and it is not this one — a fence law, and one that costs nothing here. The
 * caller pages. There is no clock, no filesystem, no randomness: two runs over
 * the same events are byte-identical, which is the only reason telemetry
 * emitted today can be compared with the same chain replayed tomorrow.
 *
 * **The redaction gate is structural.** Every record passes the contracts'
 * own guard functions *inside* `emitTelemetry`, on the way in — there is no
 * path around it, because there is no other way to obtain a `TelemetryEvent`.
 * A record whose payload is credential- or transcript-shaped is refused and
 * **counted**, never emitted. The read-model discipline holds: this module may
 * not throw and it may not lie by silence, so the count is what stands between
 * those two failures.
 *
 * **The tree is folded from the causal columns, and from nothing else.** A
 * `traceId` is the normalized hex of `correlationId`; a `spanId` is the head of
 * `eventId`; and a `parentSpanId` is drawn only where `causationId` names an
 * event this same batch emitted, in the same trace. Parentage is therefore
 * batch-scoped, which is a real limitation and is counted rather than
 * described. The ledger's causation is advisory by the contract's own
 * statement, so this projection draws no edge it cannot substantiate: several
 * roots under one trace is the honest output, and no synthetic root is minted
 * to make it look like a tree.
 *
 * **Refusal diagnostics carry coordinates and counts only.** A refusal names
 * the task, the attempt, the transition and the JSON paths that tripped the
 * guard, plus a classified reason from a closed set. It never carries the
 * payload, a fragment of it, or the matched content. A redaction report that
 * quoted what it caught would be the leak it exists to prevent — and it would
 * be a worse one, because it would travel to exactly the vendor the gate
 * exists to keep clean.
 */

// ---------------------------------------------------------------------------
// The gated shape
// ---------------------------------------------------------------------------

declare const gatedBrand: unique symbol;

/** OpenTelemetry's span status codes, which are the three it defines. */
export type TelemetryStatus = "UNSET" | "OK" | "ERROR";

/**
 * An attribute value, bounded to what OTel's attribute model carries.
 *
 * Strings, numbers and booleans only. Nested structure is deliberately not
 * representable: a telemetry attribute that could carry an object could carry
 * a payload, and the gate would be arguing with the shape rather than
 * enforcing it.
 */
export type TelemetryAttribute = string | number | boolean;

/**
 * Where one event sits in the tree the ledger's causal columns describe.
 *
 * **A top-level member, not an attribute**, and the distinction is the OTel
 * data model's own: trace and span identity is span *context*, which every
 * exporter reads from a different place than it reads attribute data. It is
 * also what keeps the vendor translator flat without an edit -- that translator
 * forwards `attributes` and nothing else, so a context expressed as attributes
 * would have leaked a half-tree into a surface that cannot represent one.
 *
 * **The nesting is load-bearing.** Three sibling fields would make
 * all-or-nothing a convention every reader has to remember; nested, it is
 * structural. A span id without a trace id is not a span in OTel, and this
 * shape cannot express one -- the same move the module already makes with the
 * gate brand.
 */
export interface TelemetrySpanContext {
  /** 32 lowercase hex, never all-zero. Losslessly derived from `correlationId`. */
  readonly traceId: string;
  /** 16 lowercase hex, never all-zero. The head of `eventId`. */
  readonly spanId: string;
  /** A span id in the SAME trace, or null for a root of this trace. */
  readonly parentSpanId: string | null;
}

interface TelemetryEventFields {
  /** The span name. Stable, derived from the event type, never free text. */
  readonly name: string;
  /** ISO-8601, taken from the event. Never a clock read. */
  readonly startTime: string;
  readonly endTime: string;
  readonly status: TelemetryStatus;
  /**
   * The event's place in the tree, or null where it cannot be placed.
   *
   * Null is a degeneration and never a refusal: an event with no correlation,
   * or with an id that folds to zero, still emits with every attribute it has.
   * Refusing it would mis-signal the refusal count, which is the allocation
   * this module already settled for the malformed route.
   */
  readonly spanContext: TelemetrySpanContext | null;
  readonly attributes: Readonly<Record<string, TelemetryAttribute>>;
}

/**
 * One neutral telemetry event.
 *
 * Branded, and that brand is the C2 guarantee rather than decoration: the only
 * way to obtain a value of this type is `emitTelemetry`, so anything typed on
 * it — the Langfuse translator, above all — is structurally incapable of
 * receiving an event that did not pass the redaction gate. A caller cannot
 * hand-build one, and a future exporter cannot accidentally accept one.
 */
export type TelemetryEvent = TelemetryEventFields & { readonly [gatedBrand]: true };

/** Why a record was refused. Closed, so a caller can exhaust it. */
export type TelemetryRefusalReason = "CREDENTIAL_SHAPED" | "TRANSCRIPT_SHAPED";

export const TELEMETRY_REFUSAL_REASONS: readonly TelemetryRefusalReason[] = Object.freeze([
  "CREDENTIAL_SHAPED",
  "TRANSCRIPT_SHAPED",
]);

/**
 * A refused record, in coordinates only.
 *
 * `paths` are the guard's JSON paths — where the violation is, never what it
 * was. The contracts' own `GuardViolation.reason` is deliberately **not**
 * carried through: it is a sentence rather than a code, and a closed
 * classification is what a caller can branch on and a test can assert.
 */
export interface TelemetryRefusal {
  readonly taskId: string;
  readonly attempt: number;
  readonly transitionId: string;
  readonly reason: TelemetryRefusalReason;
  readonly paths: readonly string[];
}

/**
 * What the gate produced: what passed, what did not, and how much did not.
 *
 * `refusedCount` is not `refused.length` restated for convenience — it is the
 * number this module promises to keep true even if the diagnostics are ever
 * bounded. A read model that silently dropped records would be indistinguishable
 * from one that had none to drop.
 */
export interface TelemetryBatch {
  readonly events: readonly TelemetryEvent[];
  readonly refused: readonly TelemetryRefusal[];
  readonly refusedCount: number;
  /**
   * Emitted events whose causation named something this batch could not
   * resolve into a parent.
   *
   * It exists for the reason `refusedCount` exists. Parentage is batch-scoped:
   * a cause outside the page, a cause in another trace, a cause the gate
   * refused, or an event with no trace of its own all produce a root where the
   * ledger records a link. A tree that discarded those silently would be
   * indistinguishable from one whose chains had no such links -- and for a real
   * account switch, which is caused cross-task by construction, every one of
   * its spans lands in this count.
   *
   * Refused records are NOT counted. A refused record projects nothing at all,
   * so its causation is not unresolved; counting it would report one
   * withholding under two counters.
   */
  readonly unresolvedCausationCount: number;
}

// ---------------------------------------------------------------------------
// The ACP vocabulary, mapped onto conventional attribute names
// ---------------------------------------------------------------------------

/**
 * The attribute keys this module emits.
 *
 * Where a convention already names a thing, the convention's name is used:
 * `gen_ai.request.model` comes from the OpenTelemetry generative-AI semantic
 * conventions and `openinference.span.kind` from OpenInference. Everything the
 * conventions do not name is namespaced under `acp.`, which is the honest way
 * to add a term: inventing a `gen_ai.*` key the convention has never defined
 * would look standard while being ours alone.
 *
 * The mirror of that rule governs too, and it is why the token count is
 * `acp.usage.tokens` rather than `gen_ai.usage.output_tokens`: filling a
 * precisely-defined conventional key with a value that does not carry that
 * meaning looks standard and is false. `gen_ai.request.model` is kept because
 * it is honest — the contract calls `route.model` "the routing alias the DT
 * scheduled against, not the provider's exact resolution", which is exactly
 * OTel's request-side model.
 *
 * Two provider attributes, because there are two facts. `acp.route.provider`
 * is the provider the route named; `acp.pressure.provider` is the provider
 * that reported pressure, as the adapter classified it. Reporting the second
 * under the first would assert a route its event does not carry.
 *
 * Pinned as a table so an added key is a deliberate edit and a test can assert
 * the whole surface rather than sample it.
 */
export const TELEMETRY_ATTRIBUTE_KEYS = Object.freeze({
  taskId: "acp.task.id",
  attempt: "acp.task.attempt",
  initiativeId: "acp.initiative.id",
  eventType: "acp.event.type",
  transitionId: "acp.event.transition_id",
  /**
   * The event's own id, in full, and the id of the event that caused it.
   *
   * Both exist because the span context is lossy in two specific ways. A span
   * id is 64 of the event id's 128 bits, so the ledger row is not recoverable
   * from the span alone; and `parentSpanId` is *dropped* whenever the four
   * clauses refuse the relation, which for a real cross-task account switch is
   * always. The causation attribute is what keeps that fact reportable after
   * the edge is refused.
   *
   * There is deliberately no `acp.event.correlation_id`. `traceId` is the
   * normalized hex of the correlation -- lossless and trivially invertible --
   * so wherever there is a correlation to report there is already a trace id
   * reporting it, and wherever there is no trace id there is no correlation
   * either. A third key would be a second spelling of a fact already carried.
   */
  eventId: "acp.event.id",
  causationId: "acp.event.causation_id",
  fromState: "acp.task.state.from",
  toState: "acp.task.state.to",
  emittedBy: "acp.worker.identity",
  accountId: "acp.account.id",
  pressureProvider: "acp.pressure.provider",
  routeProvider: "acp.route.provider",
  transportKind: "acp.route.transport_kind",
  policyVersion: "acp.route.capability_policy_version",
  model: "gen_ai.request.model",
  /**
   * The count the adapter reported; its provider-specific meaning is not
   * normalized (output-only for one adapter, total for another, unspecified
   * for a third). `TOKEN_USAGE_RECORDED.payload` carries no provider, so the
   * projection could not branch per provider even if a neutral projection were
   * allowed to.
   */
  tokens: "acp.usage.tokens",
  spanKind: "openinference.span.kind",
});

/**
 * The OpenInference span kind an ACP lifecycle event carries by default.
 *
 * One event is not a lifecycle step: a tool-call receipt is what OpenInference
 * names a `TOOL` span, and stamping it `AGENT` would make the OpenInference
 * half of the projection false for the one event the convention has a word
 * for. The exceptions are a table below; the default stays this.
 */
export const TELEMETRY_SPAN_KIND = "AGENT";

/** The events whose span kind is not the default. Unexported, and closed. */
const SPAN_KIND_BY_TYPE: Readonly<Record<string, string>> = Object.freeze({
  TOOL_CALL_RECORDED: "TOOL",
});

/**
 * Event types whose occurrence is a fault, whatever else the event says.
 *
 * Each is produced in production and each is unambiguously a failure:
 * `TASK_FAILED` is the walk's own, `AUTH_REQUIRED_RAISED` is the provider
 * refusing to serve, and `WRITE_SET_VIOLATION_DETECTED` is a walk that wrote
 * outside its declared set. Two literals that used to sit in this list --
 * `TASK_QUARANTINED` and `COMMIT_REFUSED` -- are gone: neither is a member of
 * the frozen 24-type vocabulary, so no event could ever have selected them.
 * Quarantine is a state change, and it is classified as one below.
 */
const ERROR_TYPES: readonly string[] = Object.freeze([
  "AUTH_REQUIRED_RAISED",
  "TASK_FAILED",
  "WRITE_SET_VIOLATION_DETECTED",
]);

/**
 * The revocation causes production writes that ARE faults, and those that are
 * not.
 *
 * `LEASE_REVOKED` used to be an error on every revocation, which made every
 * successful walk end in an `ERROR` span: a clean walk releases its lease with
 * `cause: "RELEASED"`, and a lawful account switch revokes with
 * `cause: "ACCOUNT_SWITCH"`. Neither is a fault. The three that are -- a
 * conformance violation, a dead holder, an expiry -- are named here.
 *
 * Both sets are closed and unexported, and `cause` is typed as a string rather
 * than an enum, so a cause in neither set is **unclassified** rather than
 * assumed either way. `UNSET` is the OTel status for exactly that, and
 * guessing in either direction would be a claim this module cannot support.
 */
const FAULT_REVOCATION_CAUSES: readonly string[] = Object.freeze([
  "EXPIRED",
  "HOLDER_DEAD",
  "WRITE_SET_VIOLATION_DETECTED",
]);

const CLEAN_REVOCATION_CAUSES: readonly string[] = Object.freeze([
  "ACCOUNT_SWITCH",
  "RELEASED",
]);

/** The state a quarantined task moves to. A state change, not an event type. */
const QUARANTINE_STATE = "SUSPECT_WORKTREE";

/**
 * The status of one event, as a function of the event rather than of its type.
 *
 * A cancellation is an outcome and a warning is a warning: OTel's `ERROR` is
 * not "not-success", and a projection that treated it that way would report a
 * routine chain as a wall of failures.
 */
function statusFor(event: ControlPlaneEvent): TelemetryStatus {
  if (ERROR_TYPES.includes(event.type)) return "ERROR";

  if (event.type === "LEASE_REVOKED") {
    const cause: unknown = event.payload["cause"];
    if (typeof cause !== "string") return "UNSET";
    if (FAULT_REVOCATION_CAUSES.includes(cause)) return "ERROR";
    if (CLEAN_REVOCATION_CAUSES.includes(cause)) return "OK";
    return "UNSET";
  }

  // What the dead `TASK_QUARANTINED` literal meant. Quarantine is reached as a
  // state change, so the truthful replacement classifies on the state.
  if (event.type === "TASK_STATE_CHANGED" && event.toState === QUARANTINE_STATE) return "ERROR";

  return "OK";
}

/** A span name from an event type: lower-cased, dotted, never free text. */
export function telemetrySpanName(eventType: string): string {
  return "acp." + eventType.toLowerCase();
}

function isAttribute(value: unknown): value is TelemetryAttribute {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * The payload keys promoted to attributes, and the attribute each becomes.
 *
 * An allowlist rather than a copy of the payload. A telemetry event that
 * mirrored whatever a payload happened to carry would export tomorrow's new
 * field without anyone deciding to, which is how a neutral projection becomes
 * an unreviewed egress.
 */
const PAYLOAD_ATTRIBUTES: Readonly<Record<string, string>> = Object.freeze({
  initiativeId: TELEMETRY_ATTRIBUTE_KEYS.initiativeId,
  accountId: TELEMETRY_ATTRIBUTE_KEYS.accountId,
  // The pressure recorder's own key, and its only writer. `model`,
  // `transportKind`, `capabilityPolicyVersion`, `verdict` and `resolvedModel`
  // used to sit here and are gone: three are written nested rather than flat
  // and are read below, one has no production writer at all, and one was never
  // a control-plane payload key -- it is a field of the provider contract, and
  // it collided with `model` on the way out.
  provider: TELEMETRY_ATTRIBUTE_KEYS.pressureProvider,
});

/**
 * The one payload key the recorded route travels under.
 *
 * Declared here and, identically, at the producer in `@acp/runtime` and the
 * projection in `@acp/ledger`. Three homes for one key is a drift risk, so the
 * fence pins all three declarations by equality and compares their literals:
 * the key cannot be changed on one side alone, and naming `"route"` inline here
 * to stay out of the law would be exactly the drift the law exists to refuse.
 */
const RECORDED_ROUTE_KEY = "route";

/** The event type whose `tokens` is spend. No other type's is. */
const TOKEN_USAGE_TYPE = "TOKEN_USAGE_RECORDED";

function attributesFor(event: ControlPlaneEvent): Readonly<Record<string, TelemetryAttribute>> {
  const attributes: Record<string, TelemetryAttribute> = {
    [TELEMETRY_ATTRIBUTE_KEYS.taskId]: event.taskId,
    [TELEMETRY_ATTRIBUTE_KEYS.attempt]: event.attempt,
    [TELEMETRY_ATTRIBUTE_KEYS.eventId]: event.eventId,
    [TELEMETRY_ATTRIBUTE_KEYS.eventType]: event.type,
    [TELEMETRY_ATTRIBUTE_KEYS.transitionId]: event.transitionId,
    [TELEMETRY_ATTRIBUTE_KEYS.toState]: event.toState,
    [TELEMETRY_ATTRIBUTE_KEYS.emittedBy]: event.emittedBy,
    [TELEMETRY_ATTRIBUTE_KEYS.spanKind]: SPAN_KIND_BY_TYPE[event.type] ?? TELEMETRY_SPAN_KIND,
  };

  // The causation, when there is one, and omitted when there is not -- the
  // same rule `fromState` follows below, and for the same reason: a string
  // spelling of null is a value a reader would have to know to disbelieve.
  // This is the raw ledger id, never the folded span head. The relation may be
  // refused; the fact the producer recorded is still reported.
  if (event.causationId !== null) {
    attributes[TELEMETRY_ATTRIBUTE_KEYS.causationId] = event.causationId;
  }

  // A task's first event has no prior state, and `fromState` is null there.
  // The attribute is **omitted** rather than rendered as "null" or an empty
  // string: an absent attribute is how OTel says "not applicable", and a
  // string spelling of null is a value a reader would have to know to
  // disbelieve.
  if (event.fromState !== null) {
    attributes[TELEMETRY_ATTRIBUTE_KEYS.fromState] = event.fromState;
  }

  for (const [key, attribute] of Object.entries(PAYLOAD_ATTRIBUTES)) {
    const value: unknown = event.payload[key];
    if (isAttribute(value)) attributes[attribute] = value;
  }

  // The token count is promoted for ONE event type, from the key the recorder
  // writes. A `tokens` key on any other type -- a reservation above all --
  // projects nothing: held tokens are not spent tokens, and reporting a
  // reservation under a usage key is the fabrication this rule exists to
  // refuse. There is no reservation attribute here either, because no
  // production emitter writes a reservation.
  if (event.type === TOKEN_USAGE_TYPE) {
    const tokens: unknown = event.payload["tokens"];
    if (isAttribute(tokens)) attributes[TELEMETRY_ATTRIBUTE_KEYS.tokens] = tokens;
  }

  // The route, read where the walk writes it.
  //
  // The INTENT beat is the sole writer and it writes the route NESTED, under
  // one pinned key. Reading it flat, as this module did, meant the one event
  // that carries a model, a provider, a transport and a policy version emitted
  // none of them.
  //
  // Malformed projects **nothing**, and refuses nothing -- the same allocation
  // of duties the ledger's own route projection makes. A bad route is not a
  // redaction failure: refusing the event would mis-signal the refusal count,
  // and promoting the fields that happened to parse would put a partial row
  // where a reader expects a route.
  const route = ResolvedRoute.safeParse(event.payload[RECORDED_ROUTE_KEY]);
  if (route.success) {
    attributes[TELEMETRY_ATTRIBUTE_KEYS.model] = route.data.model;
    attributes[TELEMETRY_ATTRIBUTE_KEYS.routeProvider] = route.data.provider;
    attributes[TELEMETRY_ATTRIBUTE_KEYS.transportKind] = route.data.transportKind;
    attributes[TELEMETRY_ATTRIBUTE_KEYS.policyVersion] = route.data.capabilityPolicyVersion;
    attributes[TELEMETRY_ATTRIBUTE_KEYS.accountId] = route.data.accountId;
    // `resolvedAt` is not promoted: the instant a route was chosen at is not an
    // identifying field, and `gen_ai.response.model` has no source at all --
    // the provider's own `resolvedModel` never reaches the ledger.
  }

  // Sorted, so two runs over the same events serialize identically rather than
  // in whatever order the payload's keys happened to arrive in.
  const sorted: Record<string, TelemetryAttribute> = {};
  for (const key of Object.keys(attributes).sort()) {
    const value = attributes[key];
    if (value !== undefined) sorted[key] = value;
  }
  return Object.freeze(sorted);
}

// ---------------------------------------------------------------------------
// The tree, folded from the causal columns and from nothing else
// ---------------------------------------------------------------------------

/**
 * The all-zero ids, which OTel names invalid in both widths.
 *
 * Named rather than compared inline so the two guards below read as one rule.
 * A trace of thirty-two zeroes would collect every degenerate event of every
 * chain into one enormous fictional trace, which is worse than no trace at all.
 */
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/** A UUID as the 32 lowercase hex characters OTel's ids are written in. */
function uuidHex(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}

/**
 * The trace id of one correlation, or null where there is none to derive.
 *
 * Lossless: a `traceId` is the correlation with its hyphens removed, so the
 * correlation is recoverable from the trace and no attribute needs to restate
 * it.
 */
function traceIdOf(correlationId: string | null): string | null {
  if (correlationId === null) return null;
  const hex = uuidHex(correlationId);
  return hex === ZERO_TRACE_ID ? null : hex;
}

/**
 * The span id of one event id: its first eight bytes, truncated, never hashed.
 *
 * **Why truncation and not a digest.** A hash would buy uniform bits and cost
 * a `node:crypto` import in a module whose whole claim is that it is a pure
 * fold with no capability -- and it would buy them for a projection that
 * already derives its ids deterministically. Truncation keeps the span id
 * *inspectable*: a reader holding a span id can find its ledger row by prefix,
 * which a digest would make impossible.
 *
 * **The entropy is 60 bits, not 64, and that is stated rather than hidden.**
 * `deterministicUuid` forces the version nibble into byte 6, which is hex
 * index 12 and inside this window, so every production span id carries a fixed
 * `5` there. Over the tens of spans one correlation holds, the birthday
 * probability is far below anything that would matter; over a corpus large
 * enough to matter, this projection is the wrong tool anyway.
 */
function spanIdOf(eventId: string | null): string | null {
  if (eventId === null) return null;
  const head = uuidHex(eventId).slice(0, 16);
  return head === ZERO_SPAN_ID ? null : head;
}

/**
 * Where one event sits, given what this batch actually emitted.
 *
 * **All or nothing.** A degenerate trace or a degenerate span yields no
 * context at all, because half a context is not a span.
 *
 * **The parent relation holds only where four clauses do**, and each answers a
 * different way the ledger's advisory causation can fail to be a drawable edge:
 *
 * 1. the event names a cause at all, and does not name *itself* -- a self-loop
 *    is representable in the contract and producible by no writer in this
 *    repository, and it is an invalid edge rather than a weak one;
 * 2. the cause is among the events this batch **emitted** -- not merely among
 *    its inputs. A refused record has no span, so an edge to it would name a
 *    span that does not exist and would leak a structural trace of exactly the
 *    record the gate exists to withhold;
 * 3. the cause carries the **same** correlation, so parent and child are in one
 *    trace. In OTel a cross-trace parent is not a weak edge, it is a corrupt
 *    one -- and this is production behaviour, not a hypothesis: the switch
 *    executor threads the elector's `decidedFromEventId`, which names another
 *    task's event and therefore another trace;
 * 4. the cause's own id folds to a usable span.
 *
 * Otherwise the event is a root of its trace, and the batch counts it.
 *
 * **`has` before `get`, and that is not style.** A survivor may legitimately
 * carry `correlationId: null`, so `get` returning `undefined` could not tell
 * "not in this batch" from "in this batch with no correlation" -- which would
 * silently conflate clause 2 with clause 3.
 */
function spanContextFor(
  event: ControlPlaneEvent,
  correlationByEventId: ReadonlyMap<string, string | null>,
): TelemetrySpanContext | null {
  const traceId = traceIdOf(event.correlationId);
  const spanId = spanIdOf(event.eventId);
  if (traceId === null || spanId === null) return null;

  let parentSpanId: string | null = null;
  if (event.causationId !== null && event.causationId !== event.eventId) {
    if (correlationByEventId.has(event.causationId)) {
      const causeCorrelation = correlationByEventId.get(event.causationId);
      if (causeCorrelation === event.correlationId) {
        const candidate = spanIdOf(event.causationId);
        if (candidate !== null) parentSpanId = candidate;
      }
    }
  }

  return Object.freeze({ traceId, spanId, parentSpanId });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Project ledger events into neutral telemetry, refusing what must not travel.
 *
 * The only producer of `TelemetryEvent`. The guard runs here, on the payload,
 * before anything is shaped — so a refused record never becomes an event that
 * something downstream might forward.
 *
 * **Two passes, and the second one is not an optimisation.** Parentage must be
 * resolved against the events this call actually **emitted**, and a single fold
 * cannot know that set while it is still building it. The gate runs first and
 * unchanged; the resolution index is built from the survivors alone; only then
 * is anything shaped. A one-pass version differs from this one on exactly one
 * case, and it is the case that matters: an event whose cause the gate refused
 * would be given a parent naming a span that was never emitted.
 *
 * **Ledger-free, and it stays that way.** The signature takes contract values
 * and nothing else -- no ledger, no resolver, no second argument. So parentage
 * is bounded by the page the caller passed, which is a real limitation and is
 * therefore *counted* rather than described: `unresolvedCausationCount` is what
 * makes the boundary visible to a reader who cannot see this comment.
 */
export function emitTelemetry(events: readonly ControlPlaneEvent[]): TelemetryBatch {
  const survivors: ControlPlaneEvent[] = [];
  const refused: TelemetryRefusal[] = [];

  for (const event of events) {
    const credential = findCredentialViolations(event.payload);
    const transcript = findTranscriptViolations(event.payload);

    if (credential.length > 0 || transcript.length > 0) {
      // Credential first when both fire: it is the more serious classification,
      // and a record can only carry one reason without the reason becoming a
      // list a caller has to interpret.
      const violations = credential.length > 0 ? credential : transcript;
      refused.push(
        Object.freeze({
          taskId: event.taskId,
          attempt: event.attempt,
          transitionId: event.transitionId,
          reason: credential.length > 0 ? ("CREDENTIAL_SHAPED" as const) : ("TRANSCRIPT_SHAPED" as const),
          // Paths only. The guard's own `reason` sentence is dropped here on
          // purpose: it is not a coordinate, and this list travels.
          paths: Object.freeze(violations.map((violation) => violation.path)),
        }),
      );
      continue;
    }

    survivors.push(event);
  }

  // The resolution index: survivors ONLY. A refused record contributes no span
  // and no entry, so nothing can resolve a parent onto it.
  //
  // The value is the correlation, which may itself be null, and that is why
  // the lookup below asks `has` before `get`.
  const correlationByEventId = new Map<string, string | null>();
  for (const event of survivors) {
    correlationByEventId.set(event.eventId, event.correlationId);
  }

  const out: TelemetryEvent[] = [];
  let unresolvedCausationCount = 0;

  for (const event of survivors) {
    const spanContext = spanContextFor(event, correlationByEventId);
    // Counted here rather than inside the resolution, so the predicate is one
    // sentence a reader can check: an emitted event that names a cause and
    // emits no parent for it. That covers every way the four clauses fail, and
    // the case where the event has no context of its own at all.
    const parentSpanId = spanContext === null ? null : spanContext.parentSpanId;
    if (event.causationId !== null && parentSpanId === null) {
      unresolvedCausationCount += 1;
    }

    const fields: TelemetryEventFields = {
      name: telemetrySpanName(event.type),
      startTime: event.occurredAt,
      endTime: event.recordedAt,
      status: statusFor(event),
      spanContext,
      attributes: attributesFor(event),
    };
    // The one mint site. The brand is what makes "gated" a type rather than a
    // convention, and this is the single place it is applied.
    out.push(Object.freeze(fields) as TelemetryEvent);
  }

  return Object.freeze({
    events: Object.freeze(out),
    refused: Object.freeze(refused),
    refusedCount: refused.length,
    unresolvedCausationCount,
  });
}

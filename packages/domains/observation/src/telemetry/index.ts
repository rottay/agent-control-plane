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

interface TelemetryEventFields {
  /** The span name. Stable, derived from the event type, never free text. */
  readonly name: string;
  /** ISO-8601, taken from the event. Never a clock read. */
  readonly startTime: string;
  readonly endTime: string;
  readonly status: TelemetryStatus;
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
    [TELEMETRY_ATTRIBUTE_KEYS.eventType]: event.type,
    [TELEMETRY_ATTRIBUTE_KEYS.transitionId]: event.transitionId,
    [TELEMETRY_ATTRIBUTE_KEYS.toState]: event.toState,
    [TELEMETRY_ATTRIBUTE_KEYS.emittedBy]: event.emittedBy,
    [TELEMETRY_ATTRIBUTE_KEYS.spanKind]: SPAN_KIND_BY_TYPE[event.type] ?? TELEMETRY_SPAN_KIND,
  };

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
// The gate
// ---------------------------------------------------------------------------

/**
 * Project ledger events into neutral telemetry, refusing what must not travel.
 *
 * The only producer of `TelemetryEvent`. The guard runs here, on the payload,
 * before anything is shaped — so a refused record never becomes an event that
 * something downstream might forward.
 */
export function emitTelemetry(events: readonly ControlPlaneEvent[]): TelemetryBatch {
  const out: TelemetryEvent[] = [];
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

    const fields: TelemetryEventFields = {
      name: telemetrySpanName(event.type),
      startTime: event.occurredAt,
      endTime: event.recordedAt,
      status: statusFor(event),
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
  });
}

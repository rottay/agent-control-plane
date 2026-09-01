import { findCredentialViolations, findTranscriptViolations } from "@acp/contracts";
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
 * `gen_ai.usage.output_tokens` and `gen_ai.request.model` come from the
 * OpenTelemetry generative-AI semantic conventions, and
 * `openinference.span.kind` from OpenInference. Everything the conventions do
 * not name is namespaced under `acp.`, which is the honest way to add a term:
 * inventing a `gen_ai.*` key the convention has never defined would look
 * standard while being ours alone.
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
  verdict: "acp.audit.verdict",
  accountId: "acp.account.id",
  provider: "acp.route.provider",
  transportKind: "acp.route.transport_kind",
  policyVersion: "acp.route.capability_policy_version",
  model: "gen_ai.request.model",
  tokensUsed: "gen_ai.usage.output_tokens",
  spanKind: "openinference.span.kind",
});

/** The OpenInference span kind every ACP lifecycle event carries. */
export const TELEMETRY_SPAN_KIND = "AGENT";

/** Event types whose occurrence is an error in the OTel sense. */
const ERROR_TYPES: readonly string[] = Object.freeze([
  "TASK_FAILED",
  "TASK_QUARANTINED",
  "COMMIT_REFUSED",
  "LEASE_REVOKED",
  "AUTH_REQUIRED_RAISED",
]);

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
  verdict: TELEMETRY_ATTRIBUTE_KEYS.verdict,
  accountId: TELEMETRY_ATTRIBUTE_KEYS.accountId,
  provider: TELEMETRY_ATTRIBUTE_KEYS.provider,
  transportKind: TELEMETRY_ATTRIBUTE_KEYS.transportKind,
  capabilityPolicyVersion: TELEMETRY_ATTRIBUTE_KEYS.policyVersion,
  model: TELEMETRY_ATTRIBUTE_KEYS.model,
  tokens: TELEMETRY_ATTRIBUTE_KEYS.tokensUsed,
  resolvedModel: TELEMETRY_ATTRIBUTE_KEYS.model,
});

function attributesFor(event: ControlPlaneEvent): Readonly<Record<string, TelemetryAttribute>> {
  const attributes: Record<string, TelemetryAttribute> = {
    [TELEMETRY_ATTRIBUTE_KEYS.taskId]: event.taskId,
    [TELEMETRY_ATTRIBUTE_KEYS.attempt]: event.attempt,
    [TELEMETRY_ATTRIBUTE_KEYS.eventType]: event.type,
    [TELEMETRY_ATTRIBUTE_KEYS.transitionId]: event.transitionId,
    [TELEMETRY_ATTRIBUTE_KEYS.toState]: event.toState,
    [TELEMETRY_ATTRIBUTE_KEYS.emittedBy]: event.emittedBy,
    [TELEMETRY_ATTRIBUTE_KEYS.spanKind]: TELEMETRY_SPAN_KIND,
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
      status: ERROR_TYPES.includes(event.type) ? "ERROR" : "OK",
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

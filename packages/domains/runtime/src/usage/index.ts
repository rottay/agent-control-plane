import { OBSERVATIONS_MAX, usageObservationsFrom } from "@acp/accounts";
import type { QuotaObservation, QuotaRefused } from "@acp/accounts";
import { CONTRACT_VERSION, ControlPlaneEvent } from "@acp/contracts";
import type {
  ControlPlaneEvent as ControlPlaneEventType,
  ControlPlaneEventType as ControlPlaneEventTypeName,
} from "@acp/contracts";
import { USAGE_REPORT_KINDS, USAGE_SOURCE_CLASSES, measurementStreamIdV1 } from "@acp/ledger";
import type { UsageReportKind, UsageSourceClass } from "@acp/ledger";

import type { DurableInvocation, InvocationRevision } from "../contracts/index.js";
import { deriveEventCoordinate } from "../core/coordinates/index.js";
import type { LedgerPort } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";

/**
 * Token usage and reservation emission.
 *
 * The observation plane folds `TOKEN_USAGE_RECORDED` and
 * `TOKEN_RESERVATION_RECORDED` into per-task and per-initiative rollups; this
 * module is what puts them in the ledger. It records a fact a caller observed
 * — it does not measure anything itself, and it has no opinion about whether
 * the number is right.
 *
 * The house determinism laws hold exactly as they do for a plan step: the
 * coordinates come from the durable invocation, nothing reads a clock or a
 * random source, and the payload is the observed pair verbatim. Recording the
 * same observation twice appends once, because the second append is an exact
 * replay under the same key.
 *
 * **The module never opens a task.** An observation about a task the ledger has
 * never seen is refused, not appended. A usage event that could create a task
 * would make spend an origin story: a rollup would show tokens burned against
 * a task with no discovery, no initiative and no lifecycle, and nothing later
 * could repair the attribution. The ledger's own contiguity guard would refuse
 * a `fromState` for a task it does not know, but relying on that would put the
 * error one layer from the cause; this module refuses at the door and says why.
 *
 * **Two producers speak economy §1 rather than a total** (P-32/captura C, ADR
 * 0090): `recordUsageStreamDeclaration` and `recordUsageObservation`, with
 * `readUsageStreamLineage` beside them. They are unwired until P-15 binds a
 * normalizing adapter; `recordTokenObservation` and its key are untouched.
 */

/**
 * Ceiling for a single observation's `tokens` (V2-B7T, D-B7T-2).
 *
 * Declared here rather than imported, in the same idiom
 * `observation/src/rollups` uses for its own bound and for the same stated
 * reason: this module's bounds are its own, and a change to one measure must
 * not silently move another. `@acp/observation` is not in the runtime's import
 * allowlist, so it could not be imported even if that were the preference — and
 * the fence, which is the only place that can read both files, pins the two
 * literals equal.
 *
 * **Why refuse rather than append.** The rollup fold drops any event whose
 * `payload.tokens` exceeds its own ceiling and counts it in `skippedMalformed`
 * — silently, and correctly, because a read model may not refuse. So an
 * observation above the ceiling would be durably appended and then quietly
 * absent from every rollup: the quiet-wrong-number failure this plane exists to
 * avoid. Refusing at the recorder puts the error at the cause, where a caller
 * can see it, and appends nothing.
 */
export const USAGE_TOKENS_MAX = 10_000_000;

/**
 * The durable name one execution-trail usage entry is recorded under.
 *
 * Derived from the landing generation, the operation's own plan index and the
 * trail entry's own step index, so it is unique within the attempt, stable
 * across replay, and carries no clock and no counter. A resumed attempt that
 * re-executes rebuilds exactly this name, which is why the second append is an
 * exact replay rather than a second row — the ledger recognises the key, and
 * nothing anywhere has to remember that it already recorded this.
 *
 * **The generation is the switch landing's, and it is why this name carries
 * three components rather than two (V2-B1f/F5).** After a landing the
 * destination re-executes the SAME operation: `operationName` is built from
 * the invocation, the task, the attempt, the transition id and the plan index,
 * and it names no account at all. So the destination emits usage entries at
 * the same step indices the source did, under the same two-component name,
 * with a different account in the payload — and the ledger fails closed on
 * that second append, because one idempotency key may not carry two sets of
 * bytes. The generation is what separates them, and it is spelled uniformly:
 * an unlanded walk passes `0`, and no caller special-cases it.
 *
 * **Stated cost.** A ledger written before this packet carries the
 * two-component spelling, so a walk resumed across it re-appends its usage
 * rows under new keys. Nothing is in operation and every ledger in the tree is
 * a drill ledger, so the cost is recorded rather than migrated around.
 *
 * All three components are non-negative integers, so the result always
 * satisfies the contract's transition-id grammar
 * (`/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`, at most 120 characters) with room to
 * spare.
 */
export function usageTransitionId(
  generation: number,
  operationIndex: number,
  stepIndex: number,
): string {
  return "usage." + String(generation) + "." + String(operationIndex) + "." + String(stepIndex);
}

/** Which of the two usage facts an observation carries. */
export type TokenObservationKind = "USAGE" | "RESERVATION";

const EVENT_TYPE: Readonly<Record<TokenObservationKind, "TOKEN_USAGE_RECORDED" | "TOKEN_RESERVATION_RECORDED">> =
  Object.freeze({
    USAGE: "TOKEN_USAGE_RECORDED",
    RESERVATION: "TOKEN_RESERVATION_RECORDED",
  });

export interface TokenObservation {
  readonly invocation: DurableInvocation;
  readonly kind: TokenObservationKind;
  /** The account the tokens were spent from, or held against. */
  readonly accountId: string;
  readonly tokens: number;
  /**
   * The event that prompted this observation, when one genuinely did.
   *
   * Optional and normally absent: spend accrues across a run rather than being
   * caused by a single event, and inventing a cause to fill the field would be
   * exactly the fabricated causality the consumer refuses to draw.
   */
  readonly causedBy?: string | null;
  /**
   * A durable name for this observation, unique within the task's attempt.
   *
   * It is the caller's, not this module's: only the caller knows whether two
   * observations are the same fact seen twice or two different facts. A derived
   * name would have to guess, and guessing here either loses a record or
   * duplicates one.
   */
  readonly transitionId: string;
  readonly emittedBy: string;
}

export interface TokenRecordResult {
  /** false means this exact observation was already recorded. */
  readonly inserted: boolean;
  readonly event: ControlPlaneEventType;
}

/**
 * Append one usage or reservation observation.
 *
 * A same-state passthrough: recording what was spent does not move the task's
 * lifecycle, so `fromState` and `toState` are both the state the ledger
 * currently holds — read from the ledger rather than claimed by the caller,
 * for the same reason every other beat reads it there.
 */
export function recordTokenObservation(
  ledger: LedgerPort,
  observation: TokenObservation,
): TokenRecordResult {
  const { invocation, kind, accountId, tokens, transitionId, emittedBy } = observation;

  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new SupervisorError(
      "refusing to record a token observation that is not a non-negative integer count",
    );
  }
  // D-B7T-2. Above the rollup's ceiling the fold would drop this row and count
  // it as malformed, so appending it would put a number in the ledger that
  // every reader silently ignores. Raised the same way as the guard above it:
  // one failure shape in this module, not two.
  if (tokens > USAGE_TOKENS_MAX) {
    throw new SupervisorError(
      "refusing to record a token observation above the rollup ceiling; the" +
        " fold would drop it as malformed and the spend would be durably" +
        " recorded and permanently invisible",
    );
  }
  if (accountId.length === 0) {
    throw new SupervisorError("refusing to record a token observation with no account");
  }

  // N1. The task must already exist. This module records against history; it
  // never begins one.
  const task = ledger.getTask(invocation.taskId);
  if (task === null) {
    throw new SupervisorError(
      "refusing to record token usage for a task the ledger has never seen;" +
        " a usage event may never open a task, because spend recorded against" +
        " a task with no discovery has no initiative and no lifecycle to" +
        " attribute it to",
    );
  }

  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  const event = ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: EVENT_TYPE[kind],
    fromState: task.currentState,
    toState: task.currentState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    // The correlation is the walk's own invocation id: a usage observation
    // rides an attempt rather than starting one, so it belongs to that run's
    // thread and says so. Causation is the caller's to supply when a specific
    // event genuinely prompted the observation; spend is normally continuous
    // rather than caused, so null is the honest common case and not a gap.
    correlationId: invocation.invocationId,
    causationId: observation.causedBy ?? null,
    // Verbatim, and exactly the pair the rollup fold reads. The plural key is
    // load bearing: the contract's credential guard denies a singular `token`.
    payload: { accountId, tokens },
  });

  const result = ledger.append(event);
  return { inserted: result.inserted, event: result.record.event };
}

/**
 * The ledger surface `readAccountUsage` needs, and nothing more (V2-B1d).
 *
 * Structural rather than the `Ledger` class, so the paging and ceiling
 * behaviours can be driven by a fake without appending a hundred thousand real
 * rows. `LedgerPort` is not the seam: it has no `listEvents`, and widening it
 * would put a read the step executor never makes into the executor's own port.
 */
export interface UsageEventSource {
  listEvents(query: {
    // The contract's own closed event-type union, not a bare string: a wider
    // parameter here would make the real `Ledger` unassignable to this port,
    // which is the shape a structural seam is supposed to accept.
    readonly type?: ControlPlaneEventTypeName | undefined;
    readonly afterSequence?: number | undefined;
    readonly limit?: number | undefined;
  }): {
    readonly events: readonly { readonly event: ControlPlaneEventType }[];
    readonly nextCursor: number | null;
    readonly hasMore: boolean;
  };
}

/** The ledger's own page ceiling, restated where the pager needs it. */
const USAGE_PAGE_LIMIT = 1_000;

/**
 * Read one account's recorded usage since an instant, exhaustively (V2-B1d).
 *
 * The acquisition half of the quota estimate: `@acp/accounts` owns the fold and
 * may not import a ledger, so this module — which already owns the usage
 * vocabulary and writes the very events being read — does the paging and hands
 * the rows to that one fold.
 *
 * **Exhaustive, or a refusal. There is no truncated success.** The scan follows
 * `nextCursor` while `hasMore`, and a partial sum is never returned: it would
 * under-count spend, which over-reports remaining quota — the single direction
 * this whole packet exists to close. A caller that receives observations may
 * rely on them covering every recorded row for that account since the anchor.
 *
 * **`OBSERVATIONS_MAX` counts filtered per-account rows, never plane-wide.**
 * `EventQuery` has no account filter, so a plane-wide ceiling would refuse
 * every election permanently once the ledger held that many usage rows across
 * all accounts combined — a monotone, silent, plane-wide failure. The row scan
 * itself is bounded only by the ledger's size, which is stated here rather than
 * implied: the cost is one query per thousand usage events, and the correctness
 * bound is on what is kept.
 */
export function readAccountUsage(
  source: UsageEventSource,
  accountId: string,
  options: { readonly since: string },
):
  | { readonly ok: true; readonly observations: readonly QuotaObservation[] }
  | QuotaRefused {
  const kept: QuotaObservation[] = [];
  let afterSequence = 0;

  for (;;) {
    const page = source.listEvents({
      type: "TOKEN_USAGE_RECORDED",
      afterSequence,
      limit: USAGE_PAGE_LIMIT,
    });

    const folded = usageObservationsFrom(
      page.events.map((record) => record.event),
      accountId,
      options.since,
    );
    // Verbatim. A refusal from the fold is the answer, not something to
    // summarise or coerce to zero observations -- zero observations means "the
    // published position stands", and a failed scan is not that fact.
    if (!folded.ok) return folded;

    for (const observation of folded.observations) {
      kept.push(observation);
      if (kept.length > OBSERVATIONS_MAX) {
        return { ok: false, reason: "OBSERVATION_COUNT_EXCEEDED", at: "observations" };
      }
    }

    if (!page.hasMore || page.nextCursor === null) break;
    afterSequence = page.nextCursor;
  }

  return { ok: true, observations: kept };
}

// ---------------------------------------------------------------------------
// P-32/captura C — a stream and its observations, as the adapter normalized them
// ---------------------------------------------------------------------------

/**
 * The record keys the ledger's door reads, restated (H-8).
 *
 * `USAGE_STREAM_KEY` and `USAGE_OBSERVATION_KEY` live in the ledger's projection
 * and are not on its barrel, exactly as `{accountId, tokens}` is restated by the
 * legacy recorder. Widening the ledger's surface to export two words would move
 * a pin for nothing; a drift is caught by the door, which refuses a payload whose
 * record is not under its key, and by this module's suite, which appends through
 * it.
 */
const STREAM_RECORD_KEY = "usageStream";
const OBSERVATION_RECORD_KEY = "usageObservation";

/**
 * The durable name a stream declaration is recorded under.
 *
 * The stream id alone. It is the digest of `(source, accountId, routeSegmentId,
 * sourceEpoch)`, so one coordinate is one name, a restated declaration is an
 * exact replay under the same key, and a new epoch is a new name.
 *
 * **Why no landing generation, unlike `usageTransitionId` (V2-B1f/F5).** That
 * name needed the generation because the legacy payload names an account the key
 * did not: a destination re-executing the same step under the same key with
 * another account was a conflict. Here the account and the segment are inside
 * the id, so the destination of a switch declares another stream under another
 * name by construction. Adding the generation would give one stream two names.
 *
 * `usage-stream.` and 64 hex digits: 77 characters, inside the contract's
 * transition-id grammar (`/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`, at most 120).
 */
export function usageStreamTransitionId(measurementStreamId: string): string {
  return "usage-stream." + measurementStreamId;
}

/**
 * The durable name one observation is recorded under: its stream and its
 * ordinal.
 *
 * The ordinal is the source report's (economy §1.2, unique per stream), never a
 * counter this module keeps: a resumed adapter restating report `n` rebuilds
 * exactly this name, so the second append is a replay. A CORRECTION carries its
 * own ordinal, so it has its own name. At most 18 + 64 + 1 + 16 = 99 characters.
 */
export function usageObservationTransitionId(measurementStreamId: string, ordinal: number): string {
  return "usage-observation." + measurementStreamId + "." + String(ordinal);
}

/** What a stream or observation recorder answers. */
export interface UsageRecordResult {
  /** false means this exact event was already recorded. */
  readonly inserted: boolean;
  readonly event: ControlPlaneEventType;
  /** The stream the event declares or reports on, computed once by the ledger's identity. */
  readonly measurementStreamId: string;
}

/**
 * A stream an adapter registered, as it hands it over.
 *
 * Nothing here is normalized by this module. `sourceClass` is the adapter's
 * registered classification, not inferred from a number; `normalizationPolicySha256`
 * is the adapter's own policy digest; `sourceEpoch` is the generation the caller
 * decided after reading the lineage back (`readUsageStreamLineage`).
 */
export interface UsageStreamDeclaration {
  readonly invocation: DurableInvocation;
  readonly source: string;
  readonly accountId: string;
  readonly routeSegmentId: string;
  /**
   * The counter generation, decided by the caller from what the ledger holds.
   *
   * The same generation after a restart is the latest declared epoch of the
   * lineage, restated; a restarted counter is that epoch plus one; `0` only when
   * the lineage read found no declaration at all. The recorder never picks one:
   * a generation chosen here, after a restart, would be a generation reinvented.
   */
  readonly sourceEpoch: number;
  readonly sourceClass: UsageSourceClass;
  readonly normalizationPolicySha256: string;
  readonly emittedBy: string;
  /** The event that prompted the declaration, when one genuinely did. */
  readonly causedBy?: string | null;
}

/**
 * One report an adapter normalized, as it hands it over.
 *
 * The four classes and the total are the adapter's, passed verbatim: the door
 * holds the total to their `BigInt` sum, the report's shape, the exposure and
 * the duplicates, inside the append's transaction. `occurredAt` is the source's
 * instant; the event's own instants are the invocation's.
 */
export interface UsageObservationReport {
  readonly invocation: DurableInvocation;
  /** The stream this report belongs to, as its declaration or the lineage read named it. */
  readonly measurementStreamId: string;
  readonly observationId: string;
  readonly ordinal: number;
  readonly sourceObservationId: string;
  readonly reportKind: UsageReportKind;
  readonly rangeFromCounter: number | null;
  readonly rangeToCounter: number | null;
  readonly correctsObservationId: string | null;
  readonly effectId: string;
  /** The source's explicit close of the measurement, never inferred from a process ending. */
  readonly isFinal: 0 | 1;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly totalTokens: number;
  readonly occurredAt: string;
  readonly emittedBy: string;
  readonly causedBy?: string | null;
}

/**
 * The revision a usage record must be recorded under, or a refusal by name (H-3).
 *
 * Both payloads carry the full V2 coordinate, and it is read off the revision —
 * never off `invocation.attempt`, the flat plan attempt, which the door does not
 * compare with anything. A V1 invocation names no segment and no effect, so the
 * door would refuse it one step after the cause; this refuses at the cause.
 */
function revisionOf(invocation: DurableInvocation, what: string): InvocationRevision {
  const revision = invocation.revision;
  if (revision === undefined) {
    throw new SupervisorError(
      "refusing to record a " +
        what +
        " for an invocation without a revision; a usage record carries the V2 coordinate," +
        " and a V1 invocation names no segment or effect to attribute it to",
    );
  }
  return revision;
}

/** The task's current state, or a refusal: the recorders never open a task (N1). */
function currentStateOf(ledger: LedgerPort, invocation: DurableInvocation, what: string): ControlPlaneEventType["fromState"] {
  const task = ledger.getTask(invocation.taskId);
  if (task === null) {
    throw new SupervisorError(
      "refusing to record a " +
        what +
        " for a task the ledger has never seen; a usage record may never open a task",
    );
  }
  return task.currentState;
}

/** Build, parse and append one usage event on the invocation's own coordinate. */
function appendUsageEvent(
  ledger: LedgerPort,
  input: {
    readonly invocation: DurableInvocation;
    readonly revision: InvocationRevision;
    readonly state: ControlPlaneEventType["fromState"];
    readonly type: "USAGE_STREAM_DECLARED" | "USAGE_OBSERVATION_RECORDED";
    readonly transitionId: string;
    readonly recordKey: string;
    readonly record: Readonly<Record<string, unknown>>;
    readonly emittedBy: string;
    readonly causedBy: string | null;
  },
): { readonly inserted: boolean; readonly event: ControlPlaneEventType } {
  const { invocation, revision, transitionId } = input;
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  const event = ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: input.type,
    // A same-state passthrough, read from the ledger: the door refuses a usage
    // event that moves a task.
    fromState: input.state,
    toState: input.state,
    emittedBy: input.emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: invocation.invocationId,
    causationId: input.causedBy,
    payload: {
      revisionNumber: revision.revisionNumber,
      attemptNumber: revision.attemptNumber,
      [input.recordKey]: input.record,
    },
  });
  const result = ledger.append(event);
  return { inserted: result.inserted, event: result.record.event };
}

/**
 * Declare one measurement stream, before any report of it (economy §1.1).
 *
 * The id is `measurementStreamIdV1`, imported from the ledger — the one encoder
 * the door recomputes — and never restated here. The recorder refuses by name
 * only what the door cannot see or would see a step late (H-7): an invocation
 * without a revision, a task the ledger has never seen, and a class outside
 * `USAGE_SOURCE_CLASSES`. Everything else is passed verbatim, and the door
 * decides the segment, its attempt and a stream already declared with another
 * class or policy, in the append's transaction.
 */
export function recordUsageStreamDeclaration(
  ledger: LedgerPort,
  declaration: UsageStreamDeclaration,
): UsageRecordResult {
  const { invocation } = declaration;
  const revision = revisionOf(invocation, "usage stream declaration");
  if (!(USAGE_SOURCE_CLASSES as readonly string[]).includes(declaration.sourceClass)) {
    throw new SupervisorError(
      "refusing to declare a usage stream whose source class is not registered; it is one of " +
        USAGE_SOURCE_CLASSES.join(", ") +
        ", as the adapter classified it, and never inferred here",
    );
  }
  const state = currentStateOf(ledger, invocation, "usage stream declaration");

  const measurementStreamId = measurementStreamIdV1({
    source: declaration.source,
    accountId: declaration.accountId,
    routeSegmentId: declaration.routeSegmentId,
    sourceEpoch: declaration.sourceEpoch,
  });
  const appended = appendUsageEvent(ledger, {
    invocation,
    revision,
    state,
    type: "USAGE_STREAM_DECLARED",
    transitionId: usageStreamTransitionId(measurementStreamId),
    recordKey: STREAM_RECORD_KEY,
    record: {
      measurementStreamId,
      source: declaration.source,
      accountId: declaration.accountId,
      routeSegmentId: declaration.routeSegmentId,
      sourceEpoch: declaration.sourceEpoch,
      sourceClass: declaration.sourceClass,
      normalizationPolicySha256: declaration.normalizationPolicySha256,
    },
    emittedBy: declaration.emittedBy,
    causedBy: declaration.causedBy ?? null,
  });
  return { ...appended, measurementStreamId };
}

/**
 * Record one normalized report of a declared stream (economy §1.2).
 *
 * It cannot stand without its declaration: the door refuses a report of a stream
 * it has not recorded (`STREAM_UNKNOWN`), and an effect that has not been
 * delivered. The recorder refuses by name an invocation without a revision, a
 * task the ledger has never seen and a report kind outside `USAGE_REPORT_KINDS`;
 * the classes, the total, the range and the correction are the adapter's and
 * pass verbatim.
 */
export function recordUsageObservation(
  ledger: LedgerPort,
  report: UsageObservationReport,
): UsageRecordResult {
  const { invocation, measurementStreamId } = report;
  const revision = revisionOf(invocation, "usage observation");
  if (!(USAGE_REPORT_KINDS as readonly string[]).includes(report.reportKind)) {
    throw new SupervisorError(
      "refusing to record a usage observation whose report kind is not one of " + USAGE_REPORT_KINDS.join(", "),
    );
  }
  const state = currentStateOf(ledger, invocation, "usage observation");

  const appended = appendUsageEvent(ledger, {
    invocation,
    revision,
    state,
    type: "USAGE_OBSERVATION_RECORDED",
    transitionId: usageObservationTransitionId(measurementStreamId, report.ordinal),
    recordKey: OBSERVATION_RECORD_KEY,
    record: {
      observationId: report.observationId,
      measurementStreamId,
      ordinal: report.ordinal,
      sourceObservationId: report.sourceObservationId,
      reportKind: report.reportKind,
      rangeFromCounter: report.rangeFromCounter,
      rangeToCounter: report.rangeToCounter,
      correctsObservationId: report.correctsObservationId,
      effectId: report.effectId,
      isFinal: report.isFinal,
      inputTokens: report.inputTokens,
      outputTokens: report.outputTokens,
      cacheWriteTokens: report.cacheWriteTokens,
      cacheReadTokens: report.cacheReadTokens,
      totalTokens: report.totalTokens,
      occurredAt: report.occurredAt,
    },
    emittedBy: report.emittedBy,
    causedBy: report.causedBy ?? null,
  });
  return { ...appended, measurementStreamId };
}

/** The lineage a generation belongs to: the stream coordinate without its epoch. */
export interface UsageStreamLineage {
  readonly source: string;
  readonly accountId: string;
  readonly routeSegmentId: string;
}

/** The latest declaration of a lineage, as the ledger recorded it. */
export interface UsageStreamLineageHead {
  readonly measurementStreamId: string;
  readonly sourceEpoch: number;
  readonly sourceClass: string;
  readonly normalizationPolicySha256: string;
}

export type UsageStreamLineageOutcome =
  | { readonly ok: true; readonly latest: UsageStreamLineageHead | null }
  | {
      readonly ok: false;
      readonly reason: "LINEAGE_SCAN_INCOMPLETE" | "LINEAGE_DECLARATION_UNREADABLE";
      readonly at: string;
    };

/** A text field of a record, or null. */
function lineageText(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read back the latest declared generation of one lineage, exhaustively (H-2).
 *
 * The recorder's other half. A caller that restarts reads the lineage before it
 * declares: the same counter restates `latest.sourceEpoch`, a restarted counter
 * declares `latest.sourceEpoch + 1`, and only `latest: null` licenses epoch `0`.
 * The reader never answers `0` itself; "no declaration" is the answer `null`.
 *
 * It reads the event stream, not a table: a declaration the door refused never
 * lands, so the recorded `USAGE_STREAM_DECLARED` events answer exactly what the
 * stream table would. No read verb is added to the ledger.
 *
 * **Exhaustive, or a refusal. There is no truncated success** — the law of
 * `readAccountUsage`, and here the stakes are the generation itself: a scan that
 * stopped early and answered `null` would license epoch `0` over a lineage that
 * already declared it, reinventing a generation. So a page that claims more
 * without a cursor past the last one is `LINEAGE_SCAN_INCOMPLETE`, and a
 * declaration whose coordinate cannot be read is `LINEAGE_DECLARATION_UNREADABLE`
 * rather than skipped: skipping it could hide this lineage's latest epoch. A page
 * read that throws propagates.
 */
export function readUsageStreamLineage(
  source: UsageEventSource,
  lineage: UsageStreamLineage,
): UsageStreamLineageOutcome {
  for (const field of ["source", "accountId", "routeSegmentId"] as const) {
    if (lineage[field].length === 0) {
      throw new SupervisorError("refusing to read a usage stream lineage with no " + field);
    }
  }

  let latest: UsageStreamLineageHead | null = null;
  let afterSequence = 0;
  let pageIndex = 0;

  for (;;) {
    const page = source.listEvents({
      type: "USAGE_STREAM_DECLARED",
      afterSequence,
      limit: USAGE_PAGE_LIMIT,
    });

    for (const [rowIndex, row] of page.events.entries()) {
      const at = "pages[" + String(pageIndex) + "].events[" + String(rowIndex) + "]";
      const payload: Readonly<Record<string, unknown>> = row.event.payload;
      const recorded: unknown = payload[STREAM_RECORD_KEY];
      if (typeof recorded !== "object" || recorded === null || Array.isArray(recorded)) {
        return { ok: false, reason: "LINEAGE_DECLARATION_UNREADABLE", at: at + ".payload." + STREAM_RECORD_KEY };
      }
      const record = recorded as Readonly<Record<string, unknown>>;
      const recordedSource = lineageText(record, "source");
      const accountId = lineageText(record, "accountId");
      const routeSegmentId = lineageText(record, "routeSegmentId");
      const measurementStreamId = lineageText(record, "measurementStreamId");
      const sourceClass = lineageText(record, "sourceClass");
      const normalizationPolicySha256 = lineageText(record, "normalizationPolicySha256");
      const sourceEpoch = record["sourceEpoch"];
      if (
        recordedSource === null ||
        accountId === null ||
        routeSegmentId === null ||
        measurementStreamId === null ||
        sourceClass === null ||
        normalizationPolicySha256 === null ||
        typeof sourceEpoch !== "number" ||
        !Number.isSafeInteger(sourceEpoch) ||
        sourceEpoch < 0
      ) {
        return { ok: false, reason: "LINEAGE_DECLARATION_UNREADABLE", at: at + ".payload." + STREAM_RECORD_KEY };
      }
      if (
        recordedSource !== lineage.source ||
        accountId !== lineage.accountId ||
        routeSegmentId !== lineage.routeSegmentId
      ) {
        continue;
      }
      if (latest === null || sourceEpoch > latest.sourceEpoch) {
        latest = { measurementStreamId, sourceEpoch, sourceClass, normalizationPolicySha256 };
      }
    }

    if (!page.hasMore) break;
    if (page.nextCursor === null || page.nextCursor <= afterSequence) {
      return { ok: false, reason: "LINEAGE_SCAN_INCOMPLETE", at: "pages[" + String(pageIndex) + "].nextCursor" };
    }
    afterSequence = page.nextCursor;
    pageIndex += 1;
  }

  return { ok: true, latest };
}

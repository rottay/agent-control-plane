import type { ControlPlaneEvent } from "@acp/contracts";

/**
 * The shadow baseline: five measures over a ledger-ordered chain of frozen
 * `ControlPlaneEvent` values.
 *
 * Everything here is a pure function of the events handed to it. There is no
 * clock, no filesystem, no ledger and no randomness, which is what lets the
 * same chain be replayed later and compared byte-for-byte against the answer
 * recorded the first time. A measurement that moves when nothing moved is not
 * a measurement.
 *
 * Two laws shape every measure below, both from ADR 0009:
 *
 * 1. **Artifact-supplied, never estimated.** Tokens come from a named payload
 *    field on the event type production actually writes it on; durations come
 *    from event-carried timestamps. Nothing is inferred, interpolated or
 *    defaulted. Where the number is not there, this module stops rather than
 *    inventing one — and where the *field* is one no emitter ever writes, it
 *    says so as a count rather than stopping. Those are different failures and
 *    R9b separates them: a malformed artifact is a defect, an absent one is a
 *    fact about the walk.
 * 2. **The frozen vocabulary is the vocabulary.** All five measures are
 *    expressed with the 24 event types `@acp/contracts` already declares. A
 *    measure that cannot be expressed that way is a STOP condition escalated
 *    to the DT — never a reason to widen the contract, and never a reason to
 *    press an unrelated event type into service.
 */

/**
 * Ceiling for `TOKEN_USAGE_RECORDED.payload.tokens`, matching the budget
 * convention.
 *
 * One authority since G7 D2: `@acp/contracts` owns the number, this module
 * re-exports it so the package's own surface is byte-stable for consumers. It
 * is the same 10,000,000 the recorder itself refuses above (`USAGE_TOKENS_MAX`
 * in `runtime/src/usage`) and the same the sibling rollup bounds by
 * (`ROLLUP_TOKENS_MAX`), so a row this measure would call out of range is a row
 * the writer would never have appended.
 */
import { TOKENS_USED_MAX } from "@acp/contracts";
export { TOKENS_USED_MAX };

/** The bound on a classification reason, so one event cannot dominate a key set. */
export const REASON_MAX_LENGTH = 80;

/** The closed audit verdict set P3 recognizes. */
export const AUDIT_VERDICTS: readonly string[] = Object.freeze([
  "ACCEPT",
  "ACCEPT_WITH_CORRECTIONS",
  "REJECT",
]);

/** The terminal outcomes counted separately from audit verdicts. */
export const TERMINAL_OUTCOME_TYPES: readonly string[] = Object.freeze([
  "COMMIT_RECORDED",
  "TASK_CANCELLED",
  "TASK_FAILED",
]);

/**
 * Why a baseline refused to be computed.
 *
 * Closed, and every member describes the *shape* of the defect rather than the
 * data that carried it: a reason code never becomes a channel for the content
 * it rejected.
 *
 * **Three of these are unreachable from a production-shaped chain, and stay
 * anyway** (R9b, DT ruling: document, do not retire). `MISSING_REASON`,
 * `MISSING_TOKENS_USED` and `MISSING_VERDICT` each answer a payload field that
 * is *present and malformed*, never one that is absent — absence is now a
 * counted fact (`routing.unreported`, `acceptance.unreported`) rather than a
 * stop. The walk writes `TASK_CLASSIFIED` and `AUDIT_COMPLETED` as PLAIN beats
 * carrying neither field, and the recorder that writes `TOKEN_USAGE_RECORDED`
 * always writes `tokens`, so reaching any of the three requires a chain
 * hand-built to carry a broken field. They are retained rather than retired
 * because a synthetic chain is exactly what the shadow ledger replays, and a
 * measure that silently accepted a malformed artifact there would be the
 * estimate ADR 0009 forbids. Each is pinned by its own synthetic test.
 */
export type BaselineStopReason =
  | "EVENT_NOT_OBJECT"
  | "MISSING_REASON"
  | "MISSING_TOKENS_USED"
  | "TOKENS_OUT_OF_RANGE"
  | "UNSAFE_TOKEN_SUM"
  | "MISSING_TIMESTAMP"
  | "TIMESTAMP_REGRESSION"
  | "MISSING_VERDICT"
  | "VERDICT_NOT_RECOGNIZED";

/**
 * The one error this module throws.
 *
 * It carries a closed reason, the event type under discussion and a task id —
 * never a payload, a value, a path or a message quoted from the data. A stop
 * has to be diagnosable without becoming a leak.
 */
export class BaselineStopError extends Error {
  readonly reason: BaselineStopReason;
  readonly eventType: string;
  readonly taskId: string;

  constructor(reason: BaselineStopReason, eventType: string, taskId: string) {
    super("baseline stopped: " + reason + " at " + eventType);
    this.reason = reason;
    this.eventType = eventType;
    this.taskId = taskId;
    this.name = "BaselineStopError";
  }
}

export interface ReasonCount {
  readonly reason: string;
  readonly count: number;
}

export interface RoutingBaseline {
  /** Classifications that reported a reason. `byReason` sums to exactly this. */
  readonly total: number;
  /**
   * Classifications carrying no reason at all.
   *
   * Stated rather than folded into `total`, because "no classification
   * happened" and "every classification happened without saying why" are
   * different facts about a chain and a single zero cannot tell them apart.
   * The walk's `TASK_CLASSIFIED` is a PLAIN beat, so today this is where a real
   * chain's classifications land.
   */
  readonly unreported: number;
  /** Sorted by reason. */
  readonly byReason: readonly ReasonCount[];
}

export interface TokensBaseline {
  readonly events: number;
  readonly total: number;
}

export interface TaskDuration {
  readonly taskId: string;
  /** Milliseconds between the first and last event-supplied `occurredAt`. */
  readonly durationMs: number;
  readonly events: number;
}

export interface TimeBaseline {
  /** Sorted by task id. */
  readonly byTask: readonly TaskDuration[];
  readonly totalMs: number;
}

export interface TaskReworkCount {
  readonly taskId: string;
  readonly count: number;
}

export interface ReworkBaseline {
  readonly total: number;
  /** Sorted by task id; tasks with no rework are omitted. */
  readonly byTask: readonly TaskReworkCount[];
}

export interface VerdictCount {
  readonly verdict: string;
  readonly count: number;
}

export interface OutcomeCount {
  readonly type: string;
  readonly count: number;
}

export interface AcceptanceBaseline {
  /** Audits that reported a verdict. `byVerdict` sums to exactly this. */
  readonly audits: number;
  /**
   * Audits carrying no verdict at all.
   *
   * The same distinction `routing.unreported` draws, for the same reason. The
   * walk's `AUDIT_COMPLETED` is a PLAIN beat; the one emitter that does write a
   * verdict (`authorizeCommit`) produces an `AuthorizationEvent` rather than a
   * `ControlPlaneEvent` and never reaches a ledger, so a real chain's audits
   * land here.
   */
  readonly unreported: number;
  /** Sorted by verdict. */
  readonly byVerdict: readonly VerdictCount[];
  /** Sorted by type; all three are always present, zeroes included. */
  readonly terminalOutcomes: readonly OutcomeCount[];
}

export interface Baseline {
  readonly events: number;
  readonly tasks: number;
  readonly routing: RoutingBaseline;
  readonly tokens: TokensBaseline;
  readonly time: TimeBaseline;
  readonly rework: ReworkBaseline;
  readonly acceptance: AcceptanceBaseline;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadOf(event: ControlPlaneEvent): Record<string, unknown> {
  const candidate = (event as { readonly payload?: unknown }).payload;
  return isRecord(candidate) ? candidate : {};
}

/**
 * Parse an event-supplied ISO timestamp.
 *
 * `Date.parse` on a contract-validated ISO string, never `Date.now()`. The
 * distinction matters more than it looks: reading the clock here would make
 * every baseline depend on when it ran, and no rebuild could ever prove byte
 * identity again.
 */
function instantOf(event: ControlPlaneEvent): number {
  const raw = (event as { readonly occurredAt?: unknown }).occurredAt;
  if (typeof raw !== "string" || raw === "") {
    throw new BaselineStopError("MISSING_TIMESTAMP", event.type, event.taskId);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new BaselineStopError("MISSING_TIMESTAMP", event.type, event.taskId);
  }
  return parsed;
}

function sortedCounts<T>(
  counts: ReadonlyMap<string, number>,
  build: (key: string, count: number) => T,
): readonly T[] {
  return Object.freeze(
    [...counts.keys()]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => build(key, counts.get(key) ?? 0)),
  );
}

/**
 * Compute the baseline over one ledger-ordered chain.
 *
 * The events must arrive in ledger order, because three of the five measures
 * are order-dependent: durations run first-to-last, rework is re-entry into a
 * state already left, and a timestamp regression is only detectable against
 * the order the ledger itself recorded.
 */
export function computeBaseline(events: readonly ControlPlaneEvent[]): Baseline {
  const byReason = new Map<string, number>();
  const byVerdict = new Map<string, number>();
  const terminal = new Map<string, number>();
  for (const type of TERMINAL_OUTCOME_TYPES) terminal.set(type, 0);

  const reworkByTask = new Map<string, number>();
  const statesByTask = new Map<string, Set<string>>();
  const firstInstant = new Map<string, number>();
  const lastInstant = new Map<string, number>();
  const eventsByTask = new Map<string, number>();

  let routingTotal = 0;
  let routingUnreported = 0;
  let tokenEvents = 0;
  let tokenTotal = 0;
  let audits = 0;
  let auditsUnreported = 0;

  for (const event of events) {
    if (!isRecord(event)) {
      throw new BaselineStopError("EVENT_NOT_OBJECT", "<unknown>", "<unknown>");
    }
    const payload = payloadOf(event);
    const taskId = event.taskId;

    // time — event-carried timestamps only, and monotonic per task.
    const instant = instantOf(event);
    const previous = lastInstant.get(taskId);
    if (previous !== undefined && instant < previous) {
      // A negative duration would be a confident lie. Refuse instead.
      throw new BaselineStopError("TIMESTAMP_REGRESSION", event.type, taskId);
    }
    if (!firstInstant.has(taskId)) firstInstant.set(taskId, instant);
    lastInstant.set(taskId, instant);
    eventsByTask.set(taskId, (eventsByTask.get(taskId) ?? 0) + 1);

    // rework — re-entry into a state this task has already reached.
    const reached = statesByTask.get(taskId) ?? new Set<string>();
    const toState = (event as { readonly toState?: unknown }).toState;
    if (typeof toState === "string" && toState !== "") {
      if (event.type === "TASK_STATE_CHANGED" && reached.has(toState)) {
        reworkByTask.set(taskId, (reworkByTask.get(taskId) ?? 0) + 1);
      }
      reached.add(toState);
    }
    statesByTask.set(taskId, reached);

    switch (event.type) {
      case "TASK_CLASSIFIED": {
        // Absent is tolerated and counted; present-and-broken still stops. The
        // walk writes this beat with no `reason` at all, so tolerating absence
        // is what lets a real chain be measured; tolerating an empty string or
        // an 81-character one would be accepting an artifact that is there and
        // wrong, which is the case ADR 0009 refuses.
        if (!Object.hasOwn(payload, "reason")) {
          routingUnreported += 1;
          break;
        }
        const reason = payload["reason"];
        if (typeof reason !== "string" || reason === "" || reason.length > REASON_MAX_LENGTH) {
          throw new BaselineStopError("MISSING_REASON", event.type, taskId);
        }
        routingTotal += 1;
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
        break;
      }
      case "TOKEN_USAGE_RECORDED": {
        // The measure reads the event production actually writes spend on, and
        // the plural key the recorder writes it under. `ATOMIC_STEP_COMPLETED`
        // is the OUTCOME beat of the plan and carries a content digest and a
        // postcondition; it never carried a token count, and demanding one
        // there is what stopped this module on every real chain until R9b.
        //
        // Usage only. `TOKEN_RESERVATION_RECORDED` carries the identical key
        // and means a hold rather than a spend, so it is not read here for the
        // reason the sibling rollup keeps the two apart: adding a reservation
        // to a spend total would overstate a bill.
        const tokens = payload["tokens"];
        if (typeof tokens !== "number" || !Number.isInteger(tokens)) {
          throw new BaselineStopError("MISSING_TOKENS_USED", event.type, taskId);
        }
        if (tokens < 0 || tokens > TOKENS_USED_MAX) {
          throw new BaselineStopError("TOKENS_OUT_OF_RANGE", event.type, taskId);
        }
        const next = tokenTotal + tokens;
        if (!Number.isSafeInteger(next)) {
          throw new BaselineStopError("UNSAFE_TOKEN_SUM", event.type, taskId);
        }
        tokenEvents += 1;
        tokenTotal = next;
        break;
      }
      case "AUDIT_COMPLETED": {
        // Absent is tolerated and counted, exactly as for `reason` above; a
        // verdict that is present but empty, non-string or outside the closed
        // set still stops.
        if (!Object.hasOwn(payload, "verdict")) {
          auditsUnreported += 1;
          break;
        }
        const verdict = payload["verdict"];
        if (typeof verdict !== "string" || verdict === "") {
          throw new BaselineStopError("MISSING_VERDICT", event.type, taskId);
        }
        if (!AUDIT_VERDICTS.includes(verdict)) {
          throw new BaselineStopError("VERDICT_NOT_RECOGNIZED", event.type, taskId);
        }
        audits += 1;
        byVerdict.set(verdict, (byVerdict.get(verdict) ?? 0) + 1);
        break;
      }
      default: {
        if (TERMINAL_OUTCOME_TYPES.includes(event.type)) {
          terminal.set(event.type, (terminal.get(event.type) ?? 0) + 1);
        }
        break;
      }
    }
  }

  const taskIds = [...firstInstant.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const durations = taskIds.map((taskId) => ({
    taskId,
    durationMs: (lastInstant.get(taskId) ?? 0) - (firstInstant.get(taskId) ?? 0),
    events: eventsByTask.get(taskId) ?? 0,
  }));
  let totalMs = 0;
  for (const entry of durations) {
    const next = totalMs + entry.durationMs;
    if (!Number.isSafeInteger(next)) {
      throw new BaselineStopError("TIMESTAMP_REGRESSION", "<aggregate>", entry.taskId);
    }
    totalMs = next;
  }

  let reworkTotal = 0;
  for (const count of reworkByTask.values()) reworkTotal += count;

  return Object.freeze({
    events: events.length,
    tasks: taskIds.length,
    routing: Object.freeze({
      total: routingTotal,
      unreported: routingUnreported,
      byReason: sortedCounts(byReason, (reason, count) => Object.freeze({ reason, count })),
    }),
    tokens: Object.freeze({ events: tokenEvents, total: tokenTotal }),
    time: Object.freeze({ byTask: Object.freeze(durations.map((entry) => Object.freeze(entry))), totalMs }),
    rework: Object.freeze({
      total: reworkTotal,
      byTask: sortedCounts(reworkByTask, (taskId, count) => Object.freeze({ taskId, count })),
    }),
    acceptance: Object.freeze({
      audits,
      unreported: auditsUnreported,
      byVerdict: sortedCounts(byVerdict, (verdict, count) => Object.freeze({ verdict, count })),
      terminalOutcomes: sortedCounts(terminal, (type, count) => Object.freeze({ type, count })),
    }),
  });
}

/**
 * Serialize a baseline canonically.
 *
 * Object keys are emitted in a fixed order rather than insertion or alphabetical
 * order, and every array is already sorted by `computeBaseline`, so the string
 * is a function of the measurement alone. `shadow-ledger.ts` hashes this to
 * prove a rebuilt chain produced the same answer; nothing else may depend on
 * its exact shape.
 */
export function serializeBaseline(baseline: Baseline): string {
  return JSON.stringify({
    events: baseline.events,
    tasks: baseline.tasks,
    routing: {
      total: baseline.routing.total,
      unreported: baseline.routing.unreported,
      byReason: baseline.routing.byReason.map((entry) => [entry.reason, entry.count]),
    },
    tokens: { events: baseline.tokens.events, total: baseline.tokens.total },
    time: {
      totalMs: baseline.time.totalMs,
      byTask: baseline.time.byTask.map((entry) => [entry.taskId, entry.durationMs, entry.events]),
    },
    rework: {
      total: baseline.rework.total,
      byTask: baseline.rework.byTask.map((entry) => [entry.taskId, entry.count]),
    },
    acceptance: {
      audits: baseline.acceptance.audits,
      unreported: baseline.acceptance.unreported,
      byVerdict: baseline.acceptance.byVerdict.map((entry) => [entry.verdict, entry.count]),
      terminalOutcomes: baseline.acceptance.terminalOutcomes.map((entry) => [entry.type, entry.count]),
    },
  });
}

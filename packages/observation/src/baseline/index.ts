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
 *    field; durations come from event-carried timestamps. Nothing is inferred,
 *    interpolated or defaulted. Where the number is not there, this module
 *    stops rather than inventing one.
 * 2. **The frozen vocabulary is the vocabulary.** All five measures are
 *    expressed with the 21 event types `@acp/contracts` already declares. A
 *    measure that cannot be expressed that way is a STOP condition escalated
 *    to the DT — never a reason to widen the contract, and never a reason to
 *    press an unrelated event type into service.
 */

/** Ceiling for `payload.tokensUsed`, matching the budget convention. */
export const TOKENS_USED_MAX = 10_000_000;

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
  readonly total: number;
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
  readonly audits: number;
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
  let tokenEvents = 0;
  let tokenTotal = 0;
  let audits = 0;

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
        const reason = payload["reason"];
        if (typeof reason !== "string" || reason === "" || reason.length > REASON_MAX_LENGTH) {
          throw new BaselineStopError("MISSING_REASON", event.type, taskId);
        }
        routingTotal += 1;
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
        break;
      }
      case "ATOMIC_STEP_COMPLETED": {
        const used = payload["tokensUsed"];
        if (typeof used !== "number" || !Number.isInteger(used)) {
          throw new BaselineStopError("MISSING_TOKENS_USED", event.type, taskId);
        }
        if (used < 0 || used > TOKENS_USED_MAX) {
          throw new BaselineStopError("TOKENS_OUT_OF_RANGE", event.type, taskId);
        }
        const next = tokenTotal + used;
        if (!Number.isSafeInteger(next)) {
          throw new BaselineStopError("UNSAFE_TOKEN_SUM", event.type, taskId);
        }
        tokenEvents += 1;
        tokenTotal = next;
        break;
      }
      case "AUDIT_COMPLETED": {
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
      byVerdict: baseline.acceptance.byVerdict.map((entry) => [entry.verdict, entry.count]),
      terminalOutcomes: baseline.acceptance.terminalOutcomes.map((entry) => [entry.type, entry.count]),
    },
  });
}

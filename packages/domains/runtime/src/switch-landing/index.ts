import { CONTRACT_VERSION, ControlPlaneEvent, ResolvedRoute } from "@acp/contracts";
import type {
  ControlPlaneEvent as ControlPlaneEventValue,
  HealthProbe,
  ResolvedRoute as ResolvedRouteValue,
  TaskState,
} from "@acp/contracts";

import type { DurableInvocation } from "../contracts/index.js";
import { deriveEventCoordinate } from "../core/coordinates/index.js";
import { INTENT_STEP } from "../core/lifecycle/index.js";
import type { LedgerPort } from "../core/step-executor/index.js";
import { SupervisorError } from "../errors/index.js";

/**
 * The switch lands on the account it chose (V2-B1f/F5).
 *
 * A switch that has been played is a switch that has not finished. The plan's
 * first five steps have an executor — the account is marked, the task is
 * blocked, the lease is revoked, and the started row names a destination — and
 * steps 6 to 11 have none. `QUOTA_BLOCKED` has no outbound plan step, so the
 * walk that reaches it stops visibly rather than settling a task a landing is
 * still owed. This module is what turns that visible stop into a lawful
 * continuation.
 *
 * **It is a restart-time interposition, and it has to be.** The play happens
 * inside the supervisor's catch and rethrows the original error, so the
 * process unwinds and there is no in-process continuation to interpose on.
 * Everything a landing needs is durable by then: the task's state, the started
 * row's destination, the blocked row's own `fromState`, the bindings the
 * config admitted, and the lease the arbiter grants the next process.
 *
 * **It decides nothing.** The elector chose the account, the config door
 * admitted the authorization, and the player appended the started row. What
 * this module does is read what the plane already recorded, admit a
 * destination the config already carries, and append the one event that says
 * the switch finished. It takes no lease, releases none and renews none; it
 * opens no session; it touches no account state and appends no account action.
 *
 * **One append, and it is last.** Everything before it is a read, an admission
 * or a refusal, so a refused landing leaves the ledger head exactly where it
 * was and the task at `QUOTA_BLOCKED` — the same visible stop ADR 0044 already
 * describes.
 */

/**
 * How many landings one attempt may have.
 *
 * One, and the number is not a budget to spend down. The generation exists so
 * the destination's usage rows cannot collide with the source's, not so a
 * second landing can be counted: `invocationId` is fixed per attempt, every
 * switch event's id is derived from its plan position, and after a landing no
 * switch port is composed at all. A second landing is unreachable by three
 * independent mechanisms, so the probe below is a single read rather than a
 * loop and there is no budget refusal in the vocabulary.
 */
export const SWITCH_LANDINGS_MAX = 1;

/** The state a played switch leaves the task in, and the only landable one. */
const BLOCKED_STATE: TaskState = "QUOTA_BLOCKED";

/** The state a landing may return a task to, checked rather than assumed. */
const RESUMABLE_STATE: TaskState = "RUNNING";

/**
 * The durable names this landing reads.
 *
 * They are the executor's own spelling: it derives every id as
 * `"switch." + index + "." + type.toLowerCase()` over a plan whose SWITCH
 * branch builds exactly four events in one order, so position 1 is the state
 * change and position 3 is the started row. The mirrored suite asserts that by
 * building a real plan and indexing its events rather than trusting these two
 * constants.
 */
const BLOCKED_TRANSITION_ID = "switch.1.task_state_changed";
const STARTED_TRANSITION_ID = "switch.3.account_switch_started";

/**
 * The durable name one landing is recorded under. Module-private.
 *
 * The generation is the only component, and `landed` is not an integer — so
 * this name can never collide with a played row, whose ids are always
 * `switch.<integer>.<type>` over a plan of at most eleven members.
 */
function landingTransitionId(generation: number): string {
  return "switch.landed." + String(generation);
}

/**
 * Why a landing was refused.
 *
 * Closed, ordered cheapest-first, and every member is a refusal to FINISH a
 * switch — never a judgement about routing. Two words are deliberately reused
 * from the player's own decline vocabulary rather than invented, because they
 * refuse the same thing for the same reason one layer up; the set is otherwise
 * this module's own and extends no frozen enum.
 *
 * `NOT_BLOCKED` is the one a caller reads as "nothing was owed": a task that
 * never switched is not `QUOTA_BLOCKED`, and a walk that owes no landing is
 * the ordinary case rather than an error. Every other member is a stop.
 */
export const SWITCH_LANDING_REFUSALS = Object.freeze([
  "ATTEMPT_MISMATCH",
  "NOT_BLOCKED",
  "SWITCH_NOT_STARTED",
  "RESUME_STATE_UNSUPPORTED",
  "DESTINATION_UNBOUND",
  "DESTINATION_UNLANDABLE",
  "ROUTE_INVALID",
  "TRANSPORT_UNHEALTHY",
] as const);
export type SwitchLandingRefusal = (typeof SWITCH_LANDING_REFUSALS)[number];

/** One binding the config admitted, as the destination check reads it. */
export interface SwitchLandingBinding {
  readonly accountId: string;
  /** The binding's OWN declared provider, never the route's (V2-B1f/F2b). */
  readonly provider: string;
}

/**
 * The read-only half of the execution port, and nothing more.
 *
 * Structural rather than `ModelExecutionPort`, for the reason every other port
 * in this stratum is structural: the landing reaches exactly one member, and a
 * surface naming `start` would invite a session this module must never open. A
 * double that fails the test if `start` is called is then a real assertion
 * rather than a hope.
 */
export interface SwitchLandingProbe {
  healthProbe(route: ResolvedRouteValue): Promise<HealthProbe>;
}

export interface SwitchLandingInput {
  readonly ledger: LedgerPort;
  readonly invocation: DurableInvocation;
  /** The route the walk was admitted on: the source, never the destination. */
  readonly route: ResolvedRouteValue;
  /** The bindings the config admitted, each carrying its own provider. */
  readonly bindings: readonly SwitchLandingBinding[];
  /** Read-only: only `healthProbe` is ever reached. */
  readonly port: SwitchLandingProbe;
  /**
   * The seam's own conformance gate closure, called once before the append.
   *
   * The value `conformanceGateFor` returns, passed in rather than rebuilt: a
   * second digester would be a second answer to "did the prestate move", and
   * the honest answer is the one the walk's own gate already gives.
   */
  readonly checkConformance: (operationIndex: number) => void;
  /**
   * The name the resumed walk will execute under, for a given account.
   *
   * A closure, because the one producer of that name lives in the providers
   * edge and this stratum may not import it. Restating the scheme here would
   * be the second naming scheme that producer's own docblock forbids, so the
   * daemon — which already holds it — passes the answer in.
   *
   * **It is a name, not a claim that a process exists.** Nothing here starts
   * anything; the session is opened by the resumed walk, and only when the
   * effect's own probe says the work is not already done.
   */
  readonly sessionIdFor: (accountId: string) => string;
  readonly emittedBy: string;
}

/** What a landing that happened, or was already durable, tells its caller. */
export interface SwitchLanded {
  readonly ok: true;
  /** false means the completion was already durable and nothing was appended. */
  readonly inserted: boolean;
  /** This landing's own generation. Never zero: zero means no landing. */
  readonly generation: number;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  /** The submission's route with the account replaced, and nothing else. */
  readonly route: ResolvedRouteValue;
  readonly sessionId: string;
  readonly event: ControlPlaneEventValue;
}

export type SwitchLandingOutcome =
  | SwitchLanded
  | {
      readonly ok: false;
      readonly reason: SwitchLandingRefusal;
      /** A field name or a state name. Never a value out of a credential. */
      readonly at: string;
    };

function refuse(reason: SwitchLandingRefusal, at: string): SwitchLandingOutcome {
  return { ok: false, reason, at };
}

/** One durable row, read by its idempotency key and parsed, or null. */
function durableRow(
  ledger: LedgerPort,
  invocation: DurableInvocation,
  transitionId: string,
): ControlPlaneEventValue | null {
  const key = deriveEventCoordinate(invocation, transitionId, 0).idempotencyKey;
  const row = ledger.getEventByIdempotencyKey(key);
  if (row === null) return null;
  const parsed: unknown = JSON.parse(row.canonicalJson);
  return ControlPlaneEvent.parse(parsed);
}

/** A payload field, as a non-empty string, or null. */
function text(event: ControlPlaneEventValue, name: string): string | null {
  const payload: unknown = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/** A payload field, as a positive integer, or null. */
function counted(event: ControlPlaneEventValue, name: string): number | null {
  const payload: unknown = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[name];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The destination route: the submission's route with the account replaced.
 *
 * Every other field is carried verbatim, `provider` included — the caller has
 * already proved the destination binding declares the same one, so replacing
 * it here would restate a fact rather than resolve one. The result is parsed,
 * so the contract's CLI-provider refinement applies to a route a landing
 * produced exactly as it does to a route a router produced.
 */
function routeOnto(route: ResolvedRouteValue, accountId: string): ResolvedRouteValue | null {
  const parsed = ResolvedRoute.safeParse({ ...route, accountId });
  return parsed.success ? parsed.data : null;
}

/**
 * Finish a switch this plane has already played, or refuse it by name.
 *
 * The order is the design, and everything before the append is a read, an
 * admission or a refusal:
 *
 * 1. **The probe, first.** A completion durable under this attempt's key means
 *    the landing already happened — in this process or in one that died before
 *    the walk resumed — so it is returned and nothing else is done.
 *    Idempotence comes from the ledger, never from memory, and the probe has
 *    to precede the state checks: after a durable completion the task is
 *    `RUNNING`, and a state check taken first would refuse the very restart it
 *    exists to serve.
 * 2. **Nothing owed.** A task the ledger has never seen, or one that is not
 *    `QUOTA_BLOCKED`, owes no landing. That is `NOT_BLOCKED`, and it is the
 *    answer every ordinary walk gets — the cheapest possible answer, reached
 *    after two reads and before anything else happens.
 * 3. **The attempt**, then the started row, then the blocked row, then the
 *    durable INTENT — each read and refused rather than assumed.
 * 4. **The destination**, from the started row's `toAccountId` and from
 *    nothing else. Never the first binding, never the route's own account.
 * 5. **The transport**, read-only, whose refusal set is exactly `FAILED`.
 * 6. **The gate**, once, before the append.
 * 7. **The append**, last and alone.
 *
 * **The INTENT, and nothing about the OUTCOME.** The last precondition reads
 * one durable idempotency key. A durable OUTCOME does not refuse a landing:
 * the step executor already owns whether that means resume or skip, and
 * refusing it here would strand the legitimate crash window that opens after
 * an effect has completed.
 */
export async function landAccountSwitch(input: SwitchLandingInput): Promise<SwitchLandingOutcome> {
  const { ledger, invocation, route, bindings, port, checkConformance, sessionIdFor, emittedBy } = input;

  // 1. The probe. A completion is durable, or it is not.
  const transitionId = landingTransitionId(SWITCH_LANDINGS_MAX);
  const existing = durableRow(ledger, invocation, transitionId);
  if (existing !== null) {
    const landedOn = text(existing, "toAccountId");
    const recorded = counted(existing, "generation");
    if (landedOn === null || recorded === null) {
      throw new SupervisorError(
        "a durable landing names no destination account and no generation; the" +
          " completion this attempt already recorded cannot be read back as the" +
          " route the walk must resume on",
      );
    }
    const bound = bindings.find((entry) => entry.accountId === landedOn);
    if (bound === undefined) return refuse("DESTINATION_UNBOUND", "payload.toAccountId");
    const resumed = routeOnto(route, landedOn);
    if (resumed === null) return refuse("ROUTE_INVALID", "route.accountId");
    return {
      ok: true,
      inserted: false,
      generation: recorded,
      fromAccountId: text(existing, "fromAccountId") ?? route.accountId,
      toAccountId: landedOn,
      route: resumed,
      sessionId: text(existing, "sessionId") ?? sessionIdFor(landedOn),
      event: existing,
    };
  }

  // 2. Nothing owed. Every walk that never switched reaches exactly this line.
  const task = ledger.getTask(invocation.taskId);
  if (task === null) return refuse("NOT_BLOCKED", "task");
  if (task.currentState !== BLOCKED_STATE) return refuse("NOT_BLOCKED", task.currentState);

  // 3. The attempt. The evidence marker is keyed by it, so a landing taken on
  // another attempt would finish one attempt's switch under another's name.
  if (invocation.attempt !== task.latestAttempt) {
    return refuse("ATTEMPT_MISMATCH", "invocation.attempt");
  }

  // The started row, which is the destination authority. A blocked task with
  // no started row is a switch nobody can finish, and saying so by name is
  // better than inventing a destination the plane never chose.
  const started = durableRow(ledger, invocation, STARTED_TRANSITION_ID);
  if (started === null) return refuse("SWITCH_NOT_STARTED", STARTED_TRANSITION_ID);
  const toAccountId = text(started, "toAccountId");
  if (toAccountId === null) return refuse("SWITCH_NOT_STARTED", "payload.toAccountId");
  const fromAccountId = text(started, "fromAccountId") ?? route.accountId;

  // The blocked row, which says where the task must be returned to. Read,
  // never a literal: the player takes the pre-block state from its caller, and
  // nothing in the type system makes that `RUNNING`.
  const blocked = durableRow(ledger, invocation, BLOCKED_TRANSITION_ID);
  if (blocked === null) return refuse("RESUME_STATE_UNSUPPORTED", BLOCKED_TRANSITION_ID);
  const toState = blocked.fromState;
  if (toState !== RESUMABLE_STATE) return refuse("RESUME_STATE_UNSUPPORTED", "fromState");

  // The durable INTENT, and nothing about the OUTCOME.
  const intent = deriveEventCoordinate(invocation, INTENT_STEP.transitionId, INTENT_STEP.index);
  if (ledger.getEventByIdempotencyKey(intent.idempotencyKey) === null) {
    return refuse("RESUME_STATE_UNSUPPORTED", INTENT_STEP.transitionId);
  }

  // 4. The destination, from the started row and from nothing else.
  const destination = bindings.find((entry) => entry.accountId === toAccountId);
  if (destination === undefined) return refuse("DESTINATION_UNBOUND", "payload.toAccountId");
  // Defensive, and unreachable through a production-produced row: the config
  // door refuses a cross-provider authorization at admission and the player
  // refuses it again before any append. A hand-built row does not walk past it.
  if (destination.provider !== route.provider) {
    return refuse("DESTINATION_UNLANDABLE", "binding.provider");
  }
  const landedRoute = routeOnto(route, toAccountId);
  if (landedRoute === null) return refuse("ROUTE_INVALID", "route.accountId");

  // 5. Read-only reachability, and nothing is spawned to ask. The refusal set
  // is exactly `FAILED`: `UNKNOWN` is the only answer the CLI leg can give for
  // a bound account, and reading it as `OK` would report the configuration
  // rather than the transport.
  const health = await port.healthProbe(landedRoute);
  if (health.status === "FAILED") return refuse("TRANSPORT_UNHEALTHY", "healthProbe.status");

  // 6. The prestate, through the ONE gate, before the append. The closure
  // observes the worktree, checks the declared write-set against the held
  // lease and, on a violation, records the finding, quarantines the task to a
  // terminal state and throws. That is the honest answer to a moved prestate,
  // and it is why no second digester is invented here.
  checkConformance(INTENT_STEP.index);

  // 7. The one append. Every field is derived from a durable value: the
  // coordinates from the invocation, `toState` from the blocked row,
  // `causationId` from the started row's own id, and the payload from the
  // ledger and the bindings. No clock and no random source, so a repeated
  // landing rebuilds byte-identical bytes and the ledger replays it.
  const sessionId = sessionIdFor(toAccountId);
  const coordinate = deriveEventCoordinate(invocation, transitionId, 0);
  const event = ControlPlaneEvent.parse({
    contractVersion: CONTRACT_VERSION,
    eventId: coordinate.eventId,
    taskId: invocation.taskId,
    attempt: invocation.attempt,
    transitionId,
    idempotencyKey: coordinate.idempotencyKey,
    type: "ACCOUNT_SWITCH_COMPLETED",
    fromState: BLOCKED_STATE,
    toState,
    emittedBy,
    occurredAt: coordinate.occurredAt,
    recordedAt: coordinate.recordedAt,
    correlationId: invocation.invocationId,
    // A real, durably-present predecessor: the row that started this switch.
    causationId: started.eventId,
    // Bounded scalars, built field by field from named members. No checkpoint
    // digest, no credential root, no binary path, no worktree path, no
    // provider output, and no free text of any kind.
    payload: { fromAccountId, toAccountId, sessionId, generation: SWITCH_LANDINGS_MAX },
  });

  const appended = ledger.append(event);
  return {
    ok: true,
    inserted: appended.inserted,
    generation: SWITCH_LANDINGS_MAX,
    fromAccountId,
    toAccountId,
    route: landedRoute,
    sessionId,
    event: appended.record.event,
  };
}

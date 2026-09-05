import { ControlPlaneEvent, DriverMode, ResolvedRoute } from "@acp/contracts";
import type { DriverOutcome, DriverMode as DriverModeName, TransportKind } from "@acp/contracts";

import type { DurableInvocation, OrchestrationDriver } from "../contracts/index.js";
import type { BeatContext, EffectPort, LedgerPort } from "../core/step-executor/index.js";
import { canonicalSubmissionDigest, deriveInvocation } from "../submission/index.js";

/**
 * The lifecycle operation: what a door does when an operator cancels or rejoins
 * a durable invocation (V2 L2).
 *
 * Two things live here, and the packet's whole argument is that they live here
 * *once*.
 *
 * **The recovery producer.** A door that cancels arrives holding coordinates —
 * a task, an attempt — and nothing else. Everything the drivers need in order
 * to act on that attempt is already in the ledger, written by the walk that
 * opened it, so the producer reads it back rather than asking an operator to
 * restate it. Five values come out: the invocation identity, the instant it was
 * submitted, the digest that pins what was asked for, the worker that opened
 * the attempt, and the initiative it belongs to. A sixth, the route, is
 * recovered from the ledger's own projection and then *verified* against the
 * digest, because a route is the one recovered value that reaches a new event's
 * payload.
 *
 * **The operation.** Both verbs are one call on an injected
 * `OrchestrationDriver`, and this module adds nothing to what the driver
 * answers: the outcome crosses back verbatim. That is deliberate. The
 * settlement policy is `@acp/runtime`'s already and the engine call is the
 * edge's already; an operation that re-interpreted either would be a third
 * authority on a question two modules have settled.
 *
 * **Nothing here constructs a driver, opens a ledger, reads a clock or reaches
 * an engine.** The driver arrives by injection, so this module has no
 * dependency on `@acp/durability` and the runtime domain's import purity is
 * untouched. The port below is structural for the same reason `LedgerPort` is.
 *
 * **Why one producer, and why it is pinned.** The CLI door and the API door
 * both have to build this context, and a door that composed it for itself would
 * be composing an invocation identity out of parts — which is the shape that
 * lets two doors disagree about which attempt they are acting on. `L-V2L-1`
 * asserts that no entrypoint composes one.
 */

// ---------------------------------------------------------------------------
// The ledger surface recovery reads
// ---------------------------------------------------------------------------

/** One attempt's admitted route, as the ledger's projection reports it. */
export interface RecordedRoute {
  readonly provider: string;
  readonly model: string;
  readonly accountId: string;
  readonly transportKind: TransportKind;
  readonly capabilityPolicyVersion: string;
  readonly resolvedAt: string;
}

/**
 * The read surface recovery needs. Satisfied structurally by `Ledger`.
 *
 * Read-only by shape: there is no `append` here, and there may not be. This
 * module recovers what a walk already recorded; a producer that could write
 * would be able to invent the very evidence it claims to be reading.
 */
export interface LifecycleRecoveryPort {
  getTask(
    taskId: string,
  ): { readonly currentState: string; readonly latestAttempt: number; readonly firstSequence: number } | null;
  getEventBySequence(sequence: number): { readonly canonicalJson: string } | null;
  getExecutionRoute(taskId: string, attempt: number): RecordedRoute | null;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every way recovery can decline, and not one word more.
 *
 * Closed and sorted, like every other refusal vocabulary in this plane. Each
 * member names a fact the ledger either does not hold or holds differently from
 * what the caller assumed; none of them is a guess, and none of them has a
 * fallback. A door that met one of these and carried on would be acting on an
 * attempt it could not identify.
 */
export const LIFECYCLE_RECOVERY_REFUSALS = [
  "ATTEMPT_NOT_LATEST",
  "DISCOVERY_UNREADABLE",
  "ROUTE_NOT_RECORDED",
  "SUBMISSION_DIGEST_MISMATCH",
  "TASK_UNKNOWN",
] as const;
export type LifecycleRecoveryRefusal = (typeof LIFECYCLE_RECOVERY_REFUSALS)[number];

/** What was recovered, or why it could not be. */
export interface RecoveredLifecycleContext {
  readonly invocation: DurableInvocation;
  /** The worker that opened the attempt. Never the operator asking to cancel. */
  readonly emittedBy: string;
  readonly initiativeId: string;
  /** The route the attempt was admitted on, verified against the digest. */
  readonly route: ResolvedRoute;
}

export interface LifecycleRecovered {
  readonly ok: true;
  readonly context: RecoveredLifecycleContext;
}

export interface LifecycleRecoveryRefused {
  readonly ok: false;
  readonly refusal: LifecycleRecoveryRefusal;
  /** The field path the refusal is about. Never the caller's own value. */
  readonly at: string;
}

export type LifecycleRecoveryOutcome = LifecycleRecovered | LifecycleRecoveryRefused;

function refuse(refusal: LifecycleRecoveryRefusal, at: string): LifecycleRecoveryRefused {
  return { ok: false, refusal, at };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Rebuild an attempt's durable identity and beat attribution from the ledger.
 *
 * **The lookup order is `assertInvocationContinuity`'s, deliberately.** That
 * guard reads the task, compares the attempt against `latestAttempt`, and only
 * then reads `firstSequence`. This function does the same two reads in the same
 * order, so the producer and the guard cannot disagree about which event is
 * "step 0" — a producer that reached for the first event before checking the
 * attempt would recover step 0 of an attempt the guard is about to refuse.
 *
 * **The attempt must be the latest, and the refusal is this module's rather
 * than a driver's.** The domain already refuses a stale attempt inside the
 * walk; refusing it here as well means an operator learns it before an engine
 * has been touched, and learns it as a field path rather than as a supervisor
 * error carrying two attempt numbers.
 *
 * **`route` is recovered from `RUN_STARTED` onward and refused before it.** The
 * route enters the ledger through the INTENT payload and nowhere else, so an
 * attempt that has not reached the INTENT beat has no recorded route at all.
 * There is nothing honest to do about that: a placeholder would put a route the
 * plane never elected into an appended OUTCOME, and a flag would be a second
 * authority for a value the log is supposed to own. So the earlier states are a
 * window this door does not serve, and it says so with a field path.
 *
 * **The recovered route is verified, not trusted.** `submissionDigest` rides
 * every event of the attempt and is the hash of the submission preimage — task,
 * attempt, instant, initiative and the six route fields. Recomputing it over
 * the recovered values and comparing is what turns "the projection says this
 * route" into "the log's own digest agrees". A ledger whose route row disagrees
 * with its events is refused rather than acted on, which is the property the
 * non-vacuity drill measures.
 *
 * **No commit policy is recovered, because none is recorded and none is
 * needed.** Both plans share steps 0-7 as the same frozen objects, and the
 * policy first becomes evident at step 8 — by which point the task is past the
 * states an operator cancels from. The verbs this context serves read the plan
 * only inside that shared prefix, so `SHARED_PLAN_PREFIX` answers for both.
 */
export function restateInvocation(
  ledger: LifecycleRecoveryPort,
  taskId: string,
  attempt: number,
): LifecycleRecoveryOutcome {
  const task = ledger.getTask(taskId);
  if (task === null) return refuse("TASK_UNKNOWN", "task");

  if (attempt !== task.latestAttempt) return refuse("ATTEMPT_NOT_LATEST", "attempt");

  const recorded = ledger.getEventBySequence(task.firstSequence);
  if (recorded === null) return refuse("DISCOVERY_UNREADABLE", "task.firstSequence");

  const discovery = readDiscovery(recorded.canonicalJson, taskId, attempt);
  if (discovery === null) return refuse("DISCOVERY_UNREADABLE", "task.firstSequence");

  const recordedRoute = ledger.getExecutionRoute(taskId, attempt);
  if (recordedRoute === null) return refuse("ROUTE_NOT_RECORDED", "attempt.route");

  const parsedRoute = ResolvedRoute.safeParse({
    provider: recordedRoute.provider,
    model: recordedRoute.model,
    accountId: recordedRoute.accountId,
    transportKind: recordedRoute.transportKind,
    capabilityPolicyVersion: recordedRoute.capabilityPolicyVersion,
    resolvedAt: recordedRoute.resolvedAt,
  });
  if (!parsedRoute.success) return refuse("ROUTE_NOT_RECORDED", "attempt.route");
  const route = parsedRoute.data;

  const expected = canonicalSubmissionDigest({
    taskId,
    attempt,
    submittedAt: discovery.submittedAt,
    initiativeId: discovery.initiativeId,
    route,
  });
  if (expected !== discovery.submissionDigest) {
    return refuse("SUBMISSION_DIGEST_MISMATCH", "attempt.submissionDigest");
  }

  return {
    ok: true,
    context: {
      invocation: deriveInvocation(
        taskId,
        attempt,
        discovery.submittedAt,
        discovery.submissionDigest,
      ),
      emittedBy: discovery.emittedBy,
      initiativeId: discovery.initiativeId,
      route,
    },
  };
}

interface Discovery {
  readonly submittedAt: string;
  readonly submissionDigest: string;
  readonly emittedBy: string;
  readonly initiativeId: string;
}

/**
 * Read step 0, through the contract rather than around it.
 *
 * The row is parsed by `ControlPlaneEvent` before a single field is read, so a
 * first event that is not a well-formed event refuses here instead of producing
 * a context assembled from whatever the JSON happened to contain. What the
 * parse cannot say — that this is a discovery, of this task, of this attempt,
 * carrying a string initiative and a string digest — is asserted afterwards,
 * because those are facts about which event this is rather than about its shape.
 */
function readDiscovery(canonicalJson: string, taskId: string, attempt: number): Discovery | null {
  let raw: unknown;
  try {
    raw = JSON.parse(canonicalJson);
  } catch {
    return null;
  }

  const parsed = ControlPlaneEvent.safeParse(raw);
  if (!parsed.success) return null;
  const event = parsed.data;

  if (event.type !== "TASK_DISCOVERED") return null;
  if (event.taskId !== taskId || event.attempt !== attempt) return null;

  const initiativeId: unknown = event.payload["initiativeId"];
  const submissionDigest: unknown = event.payload["submissionDigest"];
  if (typeof initiativeId !== "string" || initiativeId === "") return null;
  if (typeof submissionDigest !== "string" || submissionDigest === "") return null;

  return {
    // The coordinate derivation writes the submission instant into both
    // timestamps, so `occurredAt` is the submitted instant restated rather than
    // a second clock reading that happens to agree.
    submittedAt: event.occurredAt,
    submissionDigest,
    emittedBy: event.emittedBy,
    initiativeId,
  };
}

// ---------------------------------------------------------------------------
// The beat producer
// ---------------------------------------------------------------------------

/**
 * The beat context both drivers take, built from a recovered context.
 *
 * One producer, called by every door, for the same reason `restateInvocation`
 * is one producer: the daemon has its own submission-side composition, and a
 * door that wrote a second recovery-side one would give the plane two accounts
 * of what a beat context is. The two are different by design — the daemon binds
 * a route it just elected, this binds a route it just recovered — and it is the
 * recovery half that L3's parity will compare across doors.
 *
 * The invocation is taken from the driver's own argument rather than closed
 * over, so a driver that rebuilt an address from coordinates gets a context for
 * the invocation it actually asked about.
 */
export function lifecycleBeat(
  ledger: LedgerPort,
  effects: EffectPort,
  context: RecoveredLifecycleContext,
): (invocation: DurableInvocation) => Omit<BeatContext, "plan" | "initiativeId"> {
  return (invocation: DurableInvocation) => ({
    ledger,
    effects,
    invocation,
    emittedBy: context.emittedBy,
    route: context.route,
  });
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

/**
 * The lifecycle verbs a door may expose.
 *
 * Two, and the absences are deliberate. `signal` releases a durable gate and
 * `timer` schedules a walk; both are things a *packet* asks for while it runs,
 * not things an operator asks for from outside, and neither has a door. They
 * stay unexposed until a packet argues for them.
 */
export const LIFECYCLE_VERBS = ["ATTACH", "CANCEL"] as const;
export type LifecycleVerb = (typeof LIFECYCLE_VERBS)[number];

/**
 * Admit an operator's `--mode` through the contract's own enum, or refuse.
 *
 * It lives here, beside the other producers, rather than at each door, and the
 * reason is the same one that puts the recovery producer here: a door that
 * matched the mode itself would be a second vocabulary for a value the contract
 * already closes, and two doors could then admit different spellings of one
 * engine. `DriverMode.safeParse` is the whole implementation — no aliases, no
 * case folding, no `restate`-for-`RESTATE` — because a second spelling is a
 * second vocabulary even when it maps onto the first.
 *
 * `null` rather than a throw: which exit code an unadmitted mode earns is the
 * door's decision, and this module holds no exit-code table.
 */
export function admitDriverMode(raw: string): DriverModeName | null {
  const parsed = DriverMode.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A mode that has been through the contract's enum. */
export type AdmittedDriverMode = NonNullable<ReturnType<typeof admitDriverMode>>;

export interface LifecycleOperationInput {
  /** Injected. This module constructs no driver and knows no engine. */
  readonly driver: OrchestrationDriver;
  readonly verb: LifecycleVerb;
  readonly invocation: DurableInvocation;
}

export interface LifecycleOperationResult {
  readonly verb: LifecycleVerb;
  /** Which engine answered. Read off the driver, never assumed by the caller. */
  readonly mode: DriverModeName;
  /** The driver's own answer, verbatim. */
  readonly outcome: DriverOutcome;
}

/**
 * Run one lifecycle verb against one invocation.
 *
 * **Exactly one driver call, and no retry.** Both verbs are already idempotent
 * where idempotency is meaningful — a repeated cancellation rebuilds identical
 * bytes and the ledger returns the existing row — but idempotent is not the
 * same as free: `cancel` stops an engine, and a door that called it twice
 * because the first answer was a refusal would be interfering with a run to
 * learn what it had already been told.
 *
 * **The outcome crosses verbatim.** A refusal keeps the driver's own closed
 * name, so `CAPABILITY_UNSUPPORTED` from a supervisor that declares the verb
 * unsupported reaches the operator as exactly that, and the door decides an
 * exit code rather than a meaning. A throw is not caught here either: an
 * unreachable engine is a failure of the channel, and translating it into a
 * refusal would tell a caller the engine cannot cancel when what happened is
 * that this attempt could not ask.
 */
export async function runLifecycleOperation(
  input: LifecycleOperationInput,
): Promise<LifecycleOperationResult> {
  const { driver, verb, invocation } = input;
  const outcome =
    verb === "CANCEL" ? await driver.cancel(invocation) : await driver.reattach(invocation);
  return { verb, mode: driver.mode, outcome };
}

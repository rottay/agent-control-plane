/**
 * Public surface of the Agent Control Plane daemon package.
 *
 * This is P2D: the supervised process lifecycle around the runtime durability
 * plane. The launchd template, the observation route and any product adoption
 * are not here.
 *
 * Importing this module has no side effects. It parses no argv, creates no
 * directory, opens no database, binds no socket, spawns no child, installs no
 * signal handler and writes no file. Effects begin only inside `startDaemon` or
 * the internal child entry, and a fresh-process drill proves it rather than a
 * comment claiming it.
 *
 * The daemon adds no authority. The ledger remains the only one: the status
 * document and the lock file are observations, and no daemon authority exists
 * that could disagree with the ledger.
 *
 * P2D is not P2 completion, and it is no product adoption.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Checkpoint, Lease, ModelExecutionPort, ResolvedRoute, TaskEnvelope } from "@acp/contracts";
import { CONTRACT_VERSION, buildIdempotencyKey } from "@acp/contracts";
import type { Ledger, LeaseStore } from "@acp/ledger";
import { createCheckpointStore, openLeaseStore, openLedger } from "@acp/ledger";
import { deriveInvocation } from "@acp/durability";
import type { AgentHarness, ApiKeyBinding, ApiStreamingClient, CliBinding, ProviderAdapter } from "@acp/providers";
import {
  AdapterError,
  admitBinary,
  admitConfigRoot,
  admitWorkdir,
  claudeAdapter,
  executionSessionId,
  codexAdapter,
  createAgentHarness,
  createExecutionPort,
  kimiAdapter,
} from "@acp/providers";
import type {
  CheckpointPort,
  CheckpointRefused,
  CheckpointSource,
  DurableInvocation,
  LedgerPort,
  PlanStep,
  ScenarioRoot,
  SwitchPort,
  WorktreeObservation,
} from "@acp/runtime";
import {
  OUTCOME_STEP,
  checkWriteSetConformance,
  createExecutionEffects,
  deriveEventCoordinate,
  considerSwitch,
  deterministicUuid,
  landAccountSwitch,
  pressureTransitionId,
  recordProviderPressure,
  recordTokenObservation,
  resolveScenarioRoot,
  scenarioLedgerPath,
  usageTransitionId,
} from "@acp/runtime";

import { createArbiter, leaseStorePath } from "./arbiter/index.js";
import { createGitObserver, observeWorktree } from "./git-observer/index.js";
import { WALK_CONCURRENCY_MAX, admitWalks, runAdmitted } from "./scheduler/index.js";
import type { ScheduledWalk, SchedulerPorts, WalkOutcome } from "./scheduler/index.js";
import type { Arbiter, ArbiterRenewal, LeaseHold } from "./arbiter/index.js";
import {
  DRAIN_DEADLINE_MS,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
} from "./constants/index.js";
import type { DaemonExecutionBinding, DaemonExecutionConfig } from "./daemon-child/index.js";
import type { DaemonErrorCode } from "./errors/index.js";
import { ModeError, StartupError } from "./errors/index.js";
import type { ProcessInspector, RecordedIdentity } from "./identity-probe/index.js";
import { createPsInspector, ownIdentity } from "./identity-probe/index.js";
import type { DaemonMode, Resource, UnwindOutcome } from "./lifecycle/index.js";
import { UnwindStack, assertReservedPortsFree, classify, isDaemonMode } from "./lifecycle/index.js";
import { createLogger } from "./log/index.js";
import type { DaemonRoot } from "./paths/index.js";
import { existingDaemonRoot, redactPath, resolveDaemonRoot } from "./paths/index.js";
import { runSqliteMode } from "./mode-sqlite/index.js";
import { startRestateMode, superviseRestate } from "./mode-restate/index.js";
import type { RecordedServer } from "./singleton/index.js";
import { acquireSingleton, recoverStaleLock, releaseSingleton } from "./singleton/index.js";
import type { DaemonPhase, DaemonStatusDocument } from "./status/index.js";
import { clearStatus, readStatusFrom, writeStatus } from "./status/index.js";

/**
 * The closed public surface: start, stop, terminate, observe, recover.
 *
 * Everything else is an implementation detail and stays behind the package
 * boundary. The first version of this file re-exported the root brand and its
 * resolver, the logger, signal installation, the identity inspector, the unwind
 * stack, the lock primitives and every constant — a second wide surface around
 * precisely the boundaries this package exists to draw. A consumer given
 * `resolveDaemonRoot` and `installSignalHandlers` can assemble its own daemon
 * beside this one, and then the singleton means nothing.
 *
 * Tests import the relative modules directly. That is deliberate: they are
 * inside the boundary, and narrowing the public surface is not meant to make
 * the package harder to prove.
 */
export type { DaemonMode } from "./lifecycle/index.js";
export type { DaemonErrorCode } from "./errors/index.js";
export {
  DaemonError,
  DaemonRootError,
  IdentityProbeError,
  ModeError,
  ShutdownError,
  SingletonError,
  StaleLockError,
  StartupError,
  SupervisionError,
} from "./errors/index.js";
export type { IdentityVerdict } from "./identity-probe/index.js";
export type { RecoveryResult } from "./singleton/index.js";
export type { DaemonPhase, DaemonStatusDocument } from "./status/index.js";

/**
 * The launchd surface, added by P2E.
 *
 * A rendering and validation surface, not an adoption API: nothing here
 * installs, loads, copies or schedules anything, and the only function that
 * writes refuses any destination outside the ignored local root. The closed
 * export set widens by exactly these names, and the fence is updated to the new
 * size in the same change, so the widening is a decision rather than a drift.
 */
export type { LaunchAgentValues } from "./launchd/render/index.js";
export { renderLaunchAgent, writeLaunchAgent } from "./launchd/render/index.js";
export type { LaunchdRefusal, LaunchdVerdict } from "./launchd/validate/index.js";
export { validatePlist, validateTemplate } from "./launchd/validate/index.js";

export interface DaemonOptions {
  /** Explicit. There is no auto-detection and no failover. */
  readonly mode: DaemonMode;
  /** A scenario identifier, never a path: a caller cannot name a directory. */
  readonly scenarioId: string;
  readonly emittedBy: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly submittedAt: string;
  /**
   * The digest of this run's canonical submission (V2-B1c, stage 2).
   *
   * Not an opaque 64-hex token any more. It is
   * `canonicalSubmissionDigest({taskId, attempt, submittedAt, initiativeId, route})`
   * over the admitted route in `execution`, and the config door refuses a
   * declared value that is not exactly that. It is what pins the route as
   * `SUBMISSION`: it rides every event's base payload, so a resume carrying a
   * different route rebuilds step 0 to different bytes and the continuity
   * guard refuses instead of adopting the change.
   *
   * A caller assembling `DaemonOptions` by hand is therefore stating a fact it
   * must actually compute; `canonicalSubmissionDigest` is exported from
   * `./daemon-child/index.js` so there is one producer of it and no second
   * spelling of the preimage.
   */
  readonly submissionDigest: string;
  /**
   * The initiative this packet belongs to.
   *
   * Required, with no default. It arrives with the packet exactly as the
   * commit policy will: the daemon states it once, at its own call site, and
   * passes it to whichever mode runs. There are no CLI flags here -- this
   * option surface is how a caller says it.
   */
  readonly initiativeId: string;
  /** Injectable so the identity verdicts are testable without a real process. */
  readonly inspector?: ProcessInspector | undefined;
  readonly clock?: (() => string) | undefined;
  /** Off only for unit tests that never bind anything. */
  readonly checkPorts?: boolean | undefined;
  /**
   * The execution the walk performs: the resolved route and the one admitted
   * CLI binding that serves it (V2-B1b, D5). Required, never defaulted -- the
   * toy effect is no longer bound anywhere in production, and a daemon that
   * assumed one would re-hide exactly the binding this packet made visible.
   */
  readonly execution: DaemonExecutionConfig;
  /**
   * The packet's envelope, and this path's authority for what it may write
   * (V2 concurrency C4, DT Option B).
   *
   * **Required, not optional.** The walks form has carried an envelope since
   * C3; the singular form did not, and a path with no declared write-set is a
   * path write-set conformance cannot judge — which is the bypass this packet
   * exists to close. Required in the **type** rather than only at the door, so
   * the compiler and not a runtime refusal is what finds a caller that forgot.
   *
   * Not a bare `writeSet: string[]`: that would be a second declaration of what
   * a `TaskEnvelope` already declares, which is the second-registry antipattern
   * this programme refuses everywhere else. Authoritative means the contract
   * type.
   */
  readonly envelope: TaskEnvelope;
  /**
   * Many walks inside this one plane (V2 concurrency C3).
   *
   * Optional and additive, the third use of the `harness?` / `recordUsage?`
   * precedent: every existing caller passes the singular fields and keeps
   * compiling. When present, the singular fields are not the walk — each entry
   * carries its own scenario, task, initiative, envelope and worktree, and the
   * scheduler admits them through the graph and then the lease.
   *
   * `RESTATE` accepts exactly one. That is a declared capability, not an
   * omission: its endpoint hosts one task object closed over one walk's ledger,
   * effects and route on a fixed port, so N walks there would be one walk
   * wearing N task ids. A `RESTATE` daemon handed more than one **refuses to
   * start** rather than quietly running the first, and `L-C-3b` keeps that true
   * as the code moves.
   */
  readonly walks?: readonly ScheduledWalk[] | undefined;
  /**
   * The streaming client an API_KEY account is served by, if any (V2-BE/R6).
   *
   * Optional and additive, the fourth use of the `harness?` / `recordUsage?` /
   * `walks?` precedent above: every existing caller keeps compiling and keeps
   * its behaviour byte for byte.
   *
   * **There is no default, and that is the whole control.** No factory, or a
   * factory that returns `undefined` for an account, leaves that account
   * unbound — and an unbound account is a refusal at `route.accountId`, not a
   * fallback to somebody else's binding. A default of any kind would open this
   * transport for every operator who never asked for it, which is exactly what
   * "subscription operation does not depend on an API key" forbids.
   *
   * The daemon never sees a credential: the factory returns a client that has
   * already closed over its own, so nothing reaches the config, the bindings,
   * the ledger or the marker.
   */
  readonly apiClientFor?: ((accountId: string) => ApiStreamingClient | undefined) | undefined;
}

export interface StopResult {
  readonly stopped: boolean;
  readonly outcome: UnwindOutcome;
}

/**
 * A running daemon, as much of one as a caller may hold.
 *
 * Deliberately does not carry the raw `Ledger`, the absolute daemon root or the
 * recorded process identity. Handing out the ledger would give a consumer a
 * second way to write to the authority behind the driver's back; handing out
 * the root or the identity would let it rewrite the lock this run depends on.
 */
export interface DaemonRun {
  readonly mode: DaemonMode;
  readonly phases: readonly DaemonPhase[];
  readonly serverPid: number | null;
  /** Resolves if the external server dies while the daemon is supervising. */
  readonly terminal: Promise<string> | null;
  stop(): Promise<StopResult>;
  /**
   * Shut down because something failed, not because we were asked.
   *
   * Publishes a classified `TERMINAL` status **before** unwinding, and
   * deliberately leaves that document in place afterwards. A clean shutdown
   * removes its status because nothing remains to explain; a terminal one is
   * the only record of why the daemon is gone, and clearing it would destroy
   * the evidence at exactly the moment somebody needs it.
   */
  terminate(errorCode: DaemonErrorCode, detail: string): Promise<StopResult>;
}

/**
 * Read this daemon's own status. Resolves the owned root itself.
 *
 * Creates nothing. Reading the status of a daemon that has never run returns
 * `null` and leaves the checkout untouched — an observation that had to create
 * a directory before it could report "there is nothing here" would be making
 * the thing it claims to observe.
 */
export function readOwnStatus(): DaemonStatusDocument | null {
  const root = existingDaemonRoot();
  return root === null ? null : readStatusFrom(root);
}

/** Explicitly reclaim an abandoned lock. Never removes a live daemon's lock. */
/**
 * The instruction an execution carries, and the only place it is produced.
 *
 * It is the packet's own `objective` and nothing else: not a template, not a
 * rendering, not a concatenation of context. Both `createExecutionEffects`
 * sites call this, so there is exactly one answer to "what was the model
 * asked?" and it is the sentence the authorizing envelope already contains.
 *
 * `L-B1C-1` pins that: within the daemon, the runtime and the edges there is
 * exactly one producer of an `instructions:` field for an `ExecutionRequest`,
 * and it reads `envelope.objective`. The two drill children are named in the
 * law as deterministic, drill-only exceptions. Presentation code that renders
 * an initiative's objective on a page is outside the law's scope, because
 * rendering an objective is not producing an execution instruction.
 *
 * No bound is applied here. `TaskEnvelope.objective` and
 * `ExecutionRequest.instructions` carry the same `min(1).max(4_000)`, so a
 * value that passed the envelope door passes this one; re-bounding would be a
 * second policy able to disagree with the first.
 */
function instructionFor(envelope: TaskEnvelope): string {
  return envelope.objective;
}

export function recoverOwnStaleLock(options: {
  readonly adoptStale: boolean;
  readonly inspector?: ProcessInspector | undefined;
}): ReturnType<typeof recoverStaleLock> {
  const root = existingDaemonRoot();
  if (root === null) {
    return Promise.resolve({
      recovered: false,
      verdict: "ABSENT" as const,
      detail: "there is no daemon root, so there is no lock to recover",
    });
  }
  // The observation is read HERE, where reading it is lawful, and crosses into
  // the decision as a closed value it cannot re-read (V2-B2-6). A lifecycle
  // decision may not consult the status document — the moment it does, the
  // document becomes a second authority that can disagree with the ledger — so
  // this function lifts a validated observation into a struct and does nothing
  // else with it: no comparison, no probe, no signal.
  //
  // `readStatusFrom` returns null for a document that fails `validateStatus`,
  // so a pre-packet document (refused on its key set) and a half-identity
  // (refused on atomicity) both arrive as `null` without a second validator.
  const status = readStatusFrom(root);
  const server: RecordedServer | null =
    status?.serverPid != null &&
    status.serverStartToken !== null &&
    status.serverArgvDigest !== null
      ? {
          statusPid: status.pid,
          identity: {
            pid: status.serverPid,
            startToken: status.serverStartToken,
            argvDigest: status.serverArgvDigest,
          },
        }
      : null;
  return recoverStaleLock(root, options.inspector ?? createPsInspector(), {
    adoptStale: options.adoptStale,
    server,
  });
}

/**
 * Compose the seam that plays an already-decided switch (V2-B1f/F4d).
 *
 * **Data crossed the door; a closure crosses into the walk.** The
 * authorization is a value an elector decided and this daemon's own config
 * door admitted, so it travels with the route and the bindings. The lease is a
 * live grant this process holds and renews: serializing it would let a second
 * holder claim the same grant, which is the shape the enforcement fence exists
 * to refuse. Only a closure can carry both, and it is the idiom this
 * composition already uses for spend, conformance and pressure.
 *
 * Returns `undefined` when the config admitted no authorization, so a walk
 * without one is byte-identical to what it was before this packet: the
 * supervisor's fork is gated on the port being present at all.
 *
 * **And `undefined` again when this process landed a switch (V2-B1f/F5).** One
 * landed attempt may not initiate a second switch, and that is the deliberate
 * invariant rather than a happy accident: before the landing existed, a stale
 * authorization left in the config was stopped only by `considerSwitch`
 * declining `ACCOUNT_MISMATCH`, because the route had been re-elected. That is
 * accidental safety — it holds for a reason that is about routing rather than
 * about landings. After a landing, no port is composed at all, so there is
 * nothing to decline. An UNLANDED walk keeps its port exactly as it was.
 *
 * **A runtime condition, never a deleted literal.** The suppression is this
 * early return; both `runSqliteMode({` call sites keep their `switchPort:`
 * member and the lease beside it, which is the shape the enforcement law reads
 * and the reason it is still able to read it.
 *
 * The destinations are the bindings' own declared providers (V2-B1f/F2b), so
 * the unlandable-destination refusal costs no import and no `describe` call.
 */
function switchPortFor(input: {
  readonly execution: DaemonExecutionConfig;
  readonly ledger: Ledger;
  readonly lease: Lease;
  /** Whether a completion exists for this attempt, appended now or found. */
  readonly landed: boolean;
}): SwitchPort | undefined {
  if (input.landed) return undefined;
  const authorization = input.execution.switchAuthorization;
  if (authorization === undefined) return undefined;

  // Only CLI entries are switch destinations: a destination is named by the
  // provider it speaks, and an API entry declares none (D3). The elector's
  // vocabulary is unchanged; what changed is that the array can now hold a
  // shape that was never a destination.
  const destinations = cliBindingsOf(input.execution).map((entry) => ({
    accountId: entry.accountId,
    provider: entry.provider,
  }));

  return {
    consider: (context) =>
      Promise.resolve(
        considerSwitch(context, {
          authorization,
          lease: input.lease,
          routeAccountId: input.execution.route.accountId,
          routeProvider: routeProviderOf(input.execution),
          destinations,
          source: input.ledger,
        }),
      ),
  };
}

/**
 * What the landing dispatch decided for one walk (V2-B1f/F5).
 *
 * Three facts, and every one of them is read off the ledger rather than
 * configured: which route this walk runs on, which generation its usage rows
 * are named under, and whether a switch has been landed for this attempt.
 */
interface WalkLanding {
  readonly route: ResolvedRoute;
  readonly generation: number;
  readonly landed: boolean;
}

/**
 * Finish a switch this plane already played, before the walk's route is bound.
 *
 * **A restart-time interposition, and it runs at both walk forms.** A played
 * switch throws out of the supervisor's catch and unwinds the process, so
 * there is no in-process continuation to interpose on: the landing belongs to
 * the NEXT start, before the seam is composed, which is the only place the
 * route can still be bound to the account the switch chose. `startDaemon`
 * binds a route twice — once for the single walk and once per scheduled walk —
 * so this is called twice, exactly as the conformance gate and the two
 * recorders already are. Landing only the first form would leave a switched
 * walk under concurrency permanently unlandable, and silently.
 *
 * **The dispatch has three answers, and the module gives them.** A completion
 * durable for this attempt means the walk is landed, whether this process
 * appended it or found it; `NOT_BLOCKED` means nothing was owed, which is what
 * every ordinary walk gets and is byte-identical to what it did before this
 * packet; anything else is a refusal to finish a switch that WAS owed, and it
 * stops the start rather than resuming on a route nobody authorized.
 */
async function landingFor(input: {
  readonly ledger: Ledger;
  readonly invocation: DurableInvocation;
  readonly execution: DaemonExecutionConfig;
  readonly port: ModelExecutionPort;
  readonly checkConformance: (operationIndex: number) => void;
  readonly taskId: string;
  readonly attempt: number;
  readonly emittedBy: string;
}): Promise<WalkLanding> {
  const outcome = await landAccountSwitch({
    ledger: input.ledger,
    invocation: input.invocation,
    route: input.execution.route,
    bindings: cliBindingsOf(input.execution).map((entry) => ({
      accountId: entry.accountId,
      provider: entry.provider,
    })),
    port: input.port,
    checkConformance: input.checkConformance,
    // The one producer of an execution's durable name, closed over the
    // coordinates this walk already holds. The runtime stratum may not import
    // it, and restating the scheme there would be a second naming scheme for
    // one fact, so the answer crosses instead of the function.
    sessionIdFor: (accountId: string): string =>
      executionSessionId(input.taskId, input.attempt, accountId),
    emittedBy: input.emittedBy,
  });

  if (outcome.ok) {
    return { route: outcome.route, generation: outcome.generation, landed: true };
  }
  // Nothing was owed. The task never switched — it has no history yet, or it
  // is not blocked — so the source route stands, the switch port is composed
  // exactly as it was, and the usage rows keep generation zero.
  if (outcome.reason === "NOT_BLOCKED") {
    return { route: input.execution.route, generation: 0, landed: false };
  }
  // A switch WAS owed and could not be finished. The visible stop, by name:
  // the task stays at QUOTA_BLOCKED, the ledger head has not moved, and an
  // operator learns which condition disagreed rather than watching a walk
  // resume on an account nothing authorized.
  throw new StartupError(
    "a played switch could not be landed: " + outcome.reason + " at " + outcome.at,
  );
}

/**
 * Start the daemon, in order, and stop at the first thing that fails.
 *
 * Every acquisition is pushed before the next is attempted, so the unwind
 * releases exactly what was taken. Nothing is retried and nothing falls back:
 * a requested mode that cannot be served is a refusal.
 */
export async function startDaemon(options: DaemonOptions): Promise<DaemonRun> {
  if (!isDaemonMode(options.mode)) {
    throw new ModeError("a daemon mode must be requested explicitly");
  }
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const inspector = options.inspector ?? createPsInspector();
  const startedAt = clock();
  const phases: DaemonPhase[] = [];
  const stack = new UnwindStack();

  // S1.
  const root = resolveDaemonRoot();
  phases.push("ROOTS_VALIDATED");
  const logger = createLogger(root, clock);

  let identity: RecordedIdentity;
  let ledger: Ledger | null = null;
  let leaseStore: LeaseStore | null = null;
  let arbiter: Arbiter | null = null;
  let renewal: NodeJS.Timeout | null = null;
  let reapChildren: (() => Promise<readonly string[]>) | null = null;
  const ledgers = new Map<string, { ledger: Ledger; invocation: DurableInvocation }>();
  let walkOutcomes: readonly WalkOutcome[] = [];
  let serverPid: number | null = null;
  // The identity of the server this daemon spawned, recorded so that a LATER
  // recovery can prove the process holding a pid is still that server before it
  // signals anything (V2-B2-6). Moves with `serverPid` and never separately.
  let serverStartToken: string | null = null;
  let serverArgvDigest: string | null = null;
  let terminal: Promise<string> | null = null;

  const publish = (phase: DaemonPhase, errorCode: DaemonStatusDocument["errorCode"]): void => {
    phases.push(phase);
    // The last phases are published *after* the unwind, and the unwind closes
    // the ledger. Reading it there is not an error condition, it is the normal
    // order of a shutdown, so an unavailable head is simply absent rather than
    // a second failure on top of whatever we were already doing.
    let head: { headSequence: number; headEventSha256: string } | null = null;
    try {
      head = ledger === null ? null : ledger.status();
    } catch {
      head = null;
    }
    // The status is an observation, so failing to publish one must never stop
    // the reverse unwind or the exact lock release. It is recorded and the
    // shutdown continues: losing the note about what happened is bad, and
    // stranding a lock and a running server because of it is worse.
    try {
      writeStatus(root, {
        phase,
        mode: options.mode,
        scenarioId: options.scenarioId,
        pid: process.pid,
        serverPid,
        serverStartToken,
        serverArgvDigest,
        ledgerHeadSequence: head?.headSequence ?? null,
        ledgerHeadSha256: head?.headEventSha256 ?? null,
        errorCode,
        startedAt,
        updatedAt: clock(),
      });
    } catch (error: unknown) {
      logger.log("warn", "status.unpublished", "STATUS", { phase, reason: classify(error) });
    }
  };

  try {
    // S2. The operating system arbitrates, not a check-then-write here.
    identity = await ownIdentity(inspector);
    await acquireSingleton(root, identity, options.mode, startedAt, inspector);
    stack.push(lockResource(root, identity));
    publish("SINGLETON_HELD", null);

    // The pinned addresses are part of the contract, so a collision is a loud
    // failure rather than a quiet move to another port.
    if (options.checkPorts !== false) await assertReservedPortsFree();

    // V2 concurrency C3. Many walks, or one — decided here, once.
    //
    // `RESTATE` accepts exactly one walk and refuses more, in `startDaemon` as
    // well as at the config door: `DaemonOptions` can be built by hand, so the
    // door alone is not the guard. A single walk in either mode runs the path
    // that has always run, so Restate mode is byte-identical to today.
    const scheduled = options.walks ?? null;
    if (scheduled !== null) {
      if (scheduled.length === 0) {
        throw new StartupError("walks was supplied with no walk in it");
      }
      if (scheduled.length > WALK_CONCURRENCY_MAX) {
        throw new StartupError(
          "walks exceeds the concurrency this plane admits (" + String(WALK_CONCURRENCY_MAX) + ")",
        );
      }
      if (options.mode === "RESTATE" && scheduled.length > 1) {
        // Declared, not approximated. The endpoint hosts one task object closed
        // over one walk's ledger, effects and route; feeding it N walks would
        // route N task keys through one walk's machinery and call the result
        // concurrency.
        throw new ModeError(
          "RESTATE supports exactly one walk; this plane was handed " +
            String(scheduled.length) +
            " and refuses to start rather than silently run the first",
        );
      }
    }

    if (scheduled === null || scheduled.length === 1) {
      // S3.
      const scenarioRoot: ScenarioRoot = resolveScenarioRoot(options.scenarioId);
      ledger = openLedger(scenarioLedgerPath(scenarioRoot));
      const openedLedger = ledger;
      stack.push({
        name: "ledger",
        release: (): Promise<string | null> => {
          try {
            openedLedger.close();
            return Promise.resolve(null);
          } catch (error: unknown) {
            return Promise.resolve(classify(error));
          }
        },
      });
      publish("LEDGER_OPEN", null);

      const invocation: DurableInvocation = deriveInvocation(
        options.taskId,
        options.attempt,
        options.submittedAt,
        options.submissionDigest,
      );

      // S3b (V2-B1b, stage 2): the effect the walk performs. The port is built
      // from the resolved route the config carries and the one admitted CLI
      // binding; the request is derived from the invocation and the emitter,
      // never from new config (D5). Both modes receive this same port, and a
      // refused admission stops here, inside the unwind, classified by code.
      // One binding, read twice (V2-B1c). The effect port executes this route
      // and the walk records this route; binding it once is what makes "the
      // route recorded is the route executed" true by construction rather than
      // by two call sites agreeing. It is the value the config door already
      // admitted through `ResolvedRoute` — or, when this attempt has a switch
      // to finish, that same value with the account the switch chose
      // (V2-B1f/F5). Bound below, once the landing has answered: the landing
      // needs the lease, the harness and the port, and none of them exists yet.

      // S3a (V2 concurrency C2). One daemon holds one fenced lease on the
      // worktree it is about to write into, in BOTH modes and before either one
      // starts. Nothing here reads `options.mode`: `SERIALIZED_PER_TASK` is per
      // task key, so two tasks writing one worktree are two keys, and neither
      // driver has ever offered worktree exclusivity.
      //
      // Pushed BEFORE the harness, and the order is the packet. The stack
      // unwinds in reverse, so children are reaped before the lease they were
      // writing under is released; pushed after, the worktree would be handed to
      // a successor while this daemon's provider children were still writing into
      // it — on every clean shutdown, invisibly, and passing any drill that only
      // checks that a release happened. L-C-2b pins it by source order.
      leaseStore = openLeaseStore(leaseStorePath(root));
      const openedLeaseStore = leaseStore;
      stack.push({
        name: "lease-store",
        release: (): Promise<string | null> => {
          try {
            openedLeaseStore.close();
            return Promise.resolve(null);
          } catch (error: unknown) {
            return Promise.resolve(classify(error));
          }
        },
      });

      arbiter = createArbiter({
        store: openedLeaseStore,
        ledger: openedLedger,
        invocation,
        worktreePath: bindingForRoute(options.execution).workdir,
        holder: options.emittedBy,
        identity,
        inspector,
        ttlMs: LEASE_TTL_MS,
        now: clock,
      });
      const acquisition = await arbiter.acquire();
      if (!acquisition.ok) {
        // Refused. The walk never starts, and the refusal is the pure rule's own
        // word at the pure rule's own field — not a sentence invented here.
        logger.log("error", "lease.refused", "STARTUP", {
          reason: acquisition.reason,
          at: acquisition.at,
        });
        throw new StartupError(
          "another writer holds this worktree: " + acquisition.reason + " at " + acquisition.at,
        );
      }
      const hold: LeaseHold = acquisition.hold;
      const heldArbiter = arbiter;
      stack.push({
        name: "lease",
        release: (): Promise<string | null> => {
          try {
            // Stop renewing before releasing, so a beat cannot re-extend a lease
            // this daemon has just given up.
            if (renewal !== null) {
              clearInterval(renewal);
              renewal = null;
            }
            hold.release("RELEASED");
            heldArbiter.flush();
            // Logged so the order is observable at runtime and not only in the
            // source: `harness.reaped` must already be in the log above this
            // line, because the children were writing under this lease.
            logger.log("info", "lease.released", null, { fence: hold.fence });
            return Promise.resolve(null);
          } catch (error: unknown) {
            return Promise.resolve(classify(error));
          }
        },
      });
      logger.log("info", "lease.acquired", null, {
        worktreePath: redactPath(hold.lease.worktreePath),
        fence: hold.fence,
      });

      /**
       * The lease is gone: stop beating, and take the children with it.
       *
       * Reaping is the abort. It is not a second lifecycle mechanism bolted on
       * beside the unwind: killing the provider children makes the in-flight
       * effect fail, and the walk then settles through the classified-failure
       * path V2-B7R already owns. Logging alone would leave this daemon writing
       * into a worktree its successor now holds, which is the exact overlap the
       * fence exists to end.
       *
       * `closeAll` drains its own registry, so the unwind's later call reaps
       * nothing and costs a no-op — the cleanup order is unchanged and the close
       * stays idempotent.
       */
      const abortOnLostLease = (code: DaemonErrorCode, reason: string): void => {
        if (renewal !== null) {
          clearInterval(renewal);
          renewal = null;
        }
        logger.log("error", "lease.lost", code, { fence: hold.fence, reason });
        const reap = reapChildren;
        if (reap === null) return;
        void reap().then(
          (reaped) => {
            logger.log("info", "harness.reaped", null, { sessions: reaped.length });
          },
          (error: unknown) => {
            logger.log("error", "harness.reap.failed", "SHUTDOWN", { reason: classify(error) });
          },
        );
      };

      // The heartbeat re-reads the fence. A moved fence is a lost lease, and the
      // walk is aborted rather than allowed to keep writing beside its successor.
      renewal = setInterval(() => {
        // The beat runs on the timer queue, outside every try in this function.
        // An exception here would end the process without unwinding -- children
        // orphaned and the lease held until its TTL -- so a throwing beat is
        // treated as a lost lease, which is the conservative reading: this
        // daemon can no longer prove it still holds the worktree.
        let outcome: ArbiterRenewal;
        try {
          outcome = hold.renew();
        } catch (error: unknown) {
          // A fixed daemon code with the classified cause in the payload: the
          // code vocabulary is closed, and `classify` returns whatever the thrown
          // object called itself.
          abortOnLostLease("SUPERVISION", classify(error));
          return;
        }
        if (outcome.lost) {
          abortOnLostLease("STARTUP", "LEASE_FENCE_LOST");
        } else if (!outcome.ok) {
          logger.log("warn", "lease.renewal.refused", null, { reason: outcome.reason });
        }
      }, LEASE_RENEW_INTERVAL_MS);
      // Never a reason for the process to stay alive: the walk decides that.
      renewal.unref();

      // V2-B4a. The daemon owns the provider children it spawns, and owning them
      // is what makes the unwind able to reap them.
      //
      // Pushed AFTER the ledger and BEFORE the effect port exists, and the order
      // is load-bearing in both directions. The stack unwinds in reverse, so
      // children are reaped before the ledger they report into is closed; and
      // registering the resource before any port can spawn means there is no
      // window in which a child exists that the unwind would not find. Before
      // this, an abandoned stream left a running child nothing could name --
      // ADR 0010 said abandoning an iteration is not cancellation, and this is
      // where that sentence stops being a leak.
      const harness = createAgentHarness();
      // Bound here rather than passed in: the harness cannot exist before the
      // lease is pushed (that order is L-C-2b), so the heartbeat reaches it
      // through this reference instead of the pushes being swapped to suit it.
      reapChildren = (): Promise<readonly string[]> => harness.closeAll();
      stack.push({
        name: "agent-harness",
        release: async (): Promise<string | null> => {
          try {
            const reaped = await harness.closeAll();
            logger.log("info", "harness.reaped", null, { sessions: reaped.length });
            return null;
          } catch (error: unknown) {
            return classify(error);
          }
        },
      });

      // V2-B1f/F5. Both hoisted out of the literal below, because the landing
      // needs them BEFORE the seam exists: it probes the destination's
      // transport through the port, and it calls this seam's own conformance
      // gate once before its append. Building a second gate here would be a
      // second answer to "did the prestate move"; building a second port would
      // be a second admission of the same bindings. Both are the same values
      // the seam has always been given, named a few lines earlier.
      const port = executionPortFor(options.execution, options.taskId, harness, options.apiClientFor);
      const gate = conformanceGateFor({
        ledger: openedLedger,
        invocation,
        worktreePath: bindingForRoute(options.execution).workdir,
        declaredWriteSet: options.envelope.writeSet,
        lease: hold.lease,
        emittedBy: options.emittedBy,
        onViolation: () => {
          hold.release("WRITE_SET_VIOLATION_DETECTED");
          heldArbiter.flush();
        },
      });

      // The interposition: finish a switch this plane already played, if one
      // is owed, and bind the route from the answer.
      const landing = await landingFor({
        ledger: openedLedger,
        invocation,
        execution: options.execution,
        port,
        checkConformance: gate,
        taskId: options.taskId,
        attempt: options.attempt,
        emittedBy: options.emittedBy,
      });
      const route = landing.route;

      const effects = createExecutionEffects({
        port,
        route,
        request: {
          taskId: options.taskId,
          attempt: options.attempt,
          identity: options.emittedBy,
          instructions: instructionFor(options.envelope),
          reattach: null,
        },
        scenarioRoot,
        // V2-B7T. The port has always reported what it spent and the walk has
        // always thrown the trail away. This closure is where spend becomes a
        // ledger fact: one `TOKEN_USAGE_RECORDED` per trail `usage` entry, under
        // a name derived from the operation and the step so a resumed attempt
        // replays rather than double-counts.
        //
        // A closure and not a new dependency: `openedLedger`, `invocation`,
        // `route` and `options.emittedBy` are all already in scope here, so
        // `execution-effects` still imports no ledger and the runtime still owes
        // nothing new to anyone. Attribution is the elected account's, read from
        // the same `route` the port executes — the value the config door already
        // admitted, never a second reading of it.
        recordUsage: (sample) => {
          recordTokenObservation(openedLedger, {
            invocation,
            kind: "USAGE",
            accountId: route.accountId,
            tokens: sample.tokensUsed,
            // The landing generation leads the name (V2-B1f/F5). A destination
            // re-executes the same operation at the same step indices, so
            // without it the second walk's first usage row would collide with
            // the first walk's under one idempotency key and the ledger would
            // fail closed. An unlanded walk passes zero, uniformly.
            transitionId: usageTransitionId(landing.generation, sample.operationIndex, sample.stepIndex),
            emittedBy: options.emittedBy,
          });
        },
        // V2-B1f. What the provider said about this account, made durable: one
        // row per observed frame, against the account the route elected and the
        // provider the sample carries.
        //
        // `sample.provider`, never `route.provider`. The value resolved in
        // `@acp/runtime` is the adapter's own — the parser that classified the
        // frame — and the resolution belongs there, one layer from the trail
        // that carries it. The daemon spells nothing: this closure receives an
        // already-resolved provider and passes it through, which is why the
        // binding law's second predicate is met by construction here rather
        // than remembered.
        //
        // The transition name is the operation's plan index and the event's own
        // trail position, so a resumed attempt replays instead of appending a
        // second row, and two different frames in one stream stay two rows.
        recordPressure: (sample) => {
          recordProviderPressure(openedLedger, {
            invocation,
            accountId: route.accountId,
            provider: sample.provider,
            pressure: sample.pressure,
            transitionId: pressureTransitionId(sample.operationIndex, sample.trailIndex),
            emittedBy: options.emittedBy,
          });
        },
        // V2 concurrency C4, DT Option B. The legacy singular path is gated
        // exactly as the scheduler path is: same builder, same five steps, its
        // own envelope's declared write-set. A production path without this is
        // the bypass the ruling forbids.
        //
        // The same closure the landing above already called, not a second one:
        // one gate per seam, whoever asks it (V2-B1f/F5).
        checkConformance: gate,
      });

      // V2-B1f/F3. A factory per invocation, not one port: the SQLite leg walks
      // exactly this invocation, and the Restate endpoint serves whatever is
      // submitted to it, so the source is built where the invocation is known.
      // The worktree is the leased one the conformance gate observes, and the
      // store resolves under the ledger this daemon opened.
      const checkpointsFactory = (candidate: DurableInvocation): CheckpointPort =>
        checkpointsFor({
          ledger: openedLedger,
          ledgerPath: scenarioLedgerPath(scenarioRoot),
          invocation: candidate,
          emittedBy: options.emittedBy,
          envelope: options.envelope,
          worktreePath: bindingForRoute(options.execution).workdir,
        });

      if (options.mode === "SQLITE_SUPERVISOR") {
        // S8. No S4-S7: this mode binds nothing and spawns nothing of its own.
        const result = await runSqliteMode({
          ledger: openedLedger,
          invocation,
          effects,
          checkpoints: checkpointsFactory(invocation),
          switchPort: switchPortFor({
            execution: options.execution,
            ledger: openedLedger,
            lease: hold.lease,
            landed: landing.landed,
          }),
          emittedBy: options.emittedBy,
          // Today's behaviour, said out loud. The daemon supervises packets that
          // may commit locally under a receipt; a read-only packet is a policy
          // this process has never been asked to run, and when it is, the policy
          // will arrive with the packet rather than be assumed here.
          commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
          initiativeId: options.initiativeId,
          route,
        });
        publish("RECONCILED", null);
        publish("READY", null);
        logger.log("info", "ready", null, { mode: options.mode, verdict: result.verdict });
        publish("SUPERVISING", null);
        logger.log("info", "supervised", null, { finalState: result.finalState });
      } else {
        const handles = await startRestateMode({
          ledger: openedLedger,
          invocation,
          scenarioRoot,
          emittedBy: options.emittedBy,
          // The same explicit policy as the SQLite site above, for the same
          // reason: one place a reader can find it, and no default anywhere.
          commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
          initiativeId: options.initiativeId,
          effects,
          checkpoints: checkpointsFactory,
          route,
          stack,
          onPhase: async (phase, pid) => {
            // Published where it happens, in the order it happens. Deferring
            // SERVER_UP until this call returned made the recorded sequence
            // disagree with the actual one.
            if (pid !== undefined) {
              serverPid = pid;
              // Recorded at the instant the pid first exists, which is why this
              // callback is awaited (V2-B2-6). Capturing at READY instead would
              // leave a daemon killed during registration -- the window the
              // recorded orphan incident sat in -- with a pid and no identity,
              // and recovery would then refuse to signal it.
              //
              // Asked of `ps`, never digested from `process.argv`: the two are
              // not the same string, and recording one to observe the other
              // would make every live server look indeterminate.
              //
              // A `ps` failure here throws and refuses the start, which is the
              // posture the startup already takes -- `ownIdentity` makes `ps` a
              // startup dependency one phase earlier -- and the stack already
              // holds the server resource, so the unwind stops what was spawned.
              const facts = await inspector.inspect(pid);
              if (facts !== null) {
                serverStartToken = facts.startToken;
                serverArgvDigest = facts.argvDigest;
              }
            }
            publish(phase, null);
          },
        });
        serverPid = handles.server.pid;
        publish("READY", null);
        logger.log("info", "ready", null, { mode: options.mode, verdict: handles.verdict });

        // From here an unexpected death is terminal, never a restart.
        terminal = handles.server.exited.then((exit) =>
          exit.reason === "UNEXPECTED_EXIT" ? "UNEXPECTED_EXIT" : exit.reason,
        );

        await superviseRestate(handles.server, invocation);
        publish("SUPERVISING", null);
        logger.log("info", "supervised", null, { mode: options.mode });
      }
    } else {
      // S3 (V2 concurrency C3): many walks, one plane.
      //
      // One singleton, one lease store and one harness; N ledgers and N leases.
      // The push order is C2's, extended: each walk's ledger then its lease, and
      // the shared harness **last**, so the reverse unwind reaps every child
      // before any worktree is handed back. One harness and not N: N would give
      // the unwind N reapers in an order nothing specifies.
      leaseStore = openLeaseStore(leaseStorePath(root));
      const openedLeaseStore = leaseStore;
      stack.push({
        name: "lease-store",
        release: (): Promise<string | null> => {
          try {
            openedLeaseStore.close();
            return Promise.resolve(null);
          } catch (error: unknown) {
            return Promise.resolve(classify(error));
          }
        },
      });

      const holds = new Map<string, { hold: LeaseHold; arbiter: Arbiter }>();
      const beats = new Map<string, NodeJS.Timeout>();
      let sharedHarness: AgentHarness | null = null;

      /** Stop one walk's heartbeat. Idempotent; an absent walk is not an error. */
      const stopBeat = (taskId: string): void => {
        const beat = beats.get(taskId);
        if (beat === undefined) return;
        clearInterval(beat);
        beats.delete(taskId);
      };

      /**
       * This walk lost its worktree: stop beating and reap **only its child**.
       *
       * `interrupt` and not `closeAll`. Under N walks the shared harness holds
       * every walk's session, so `closeAll` would answer one walk's lost lease
       * by killing its siblings' providers — a correct abort for the loser and
       * an unexplained death for everyone else. `interrupt` walks one session's
       * own signal ladder against the one pid its handle created, so the blast
       * radius is the walk that actually lost.
       *
       * The killed child makes this walk's effect fail, and the walk then
       * settles through the classified-failure path the scheduler already owns
       * — the same mechanism C2 uses, narrowed to one session.
       */
      const abortWalk = (walk: ScheduledWalk, code: DaemonErrorCode, reason: string): void => {
        const { taskId, attempt, execution } = walk.spec;
        stopBeat(taskId);
        logger.log("error", "lease.lost", code, { taskId, reason });
        const harness = sharedHarness;
        if (harness === null) return;
        void harness
          .interrupt(executionSessionId(taskId, attempt, execution.route.accountId))
          .then(
            () => {
              logger.log("info", "walk.reaped", null, { taskId });
            },
            (error: unknown) => {
              logger.log("error", "walk.reap.failed", "SHUTDOWN", { reason: classify(error) });
            },
          );
      };

      const ports: SchedulerPorts = {
        acquire: async (walk) => {
          const walkRoot: ScenarioRoot = resolveScenarioRoot(walk.spec.scenarioId);
          const walkLedger = openLedger(scenarioLedgerPath(walkRoot));
          stack.push({
            name: "ledger",
            release: (): Promise<string | null> => {
              try {
                walkLedger.close();
                return Promise.resolve(null);
              } catch (error: unknown) {
                return Promise.resolve(classify(error));
              }
            },
          });
          const walkInvocation = deriveInvocation(
            walk.spec.taskId,
            walk.spec.attempt,
            walk.spec.submittedAt,
            walk.spec.submissionDigest,
          );
          const walkArbiter = createArbiter({
            store: openedLeaseStore,
            ledger: walkLedger,
            invocation: walkInvocation,
            worktreePath: walk.worktreePath,
            holder: walk.spec.emittedBy,
            identity,
            inspector,
            ttlMs: LEASE_TTL_MS,
            now: clock,
          });
          const acquisition = await walkArbiter.acquire();
          if (!acquisition.ok) {
            logger.log("error", "lease.refused", "STARTUP", {
              reason: acquisition.reason,
              at: acquisition.at,
            });
            return { ok: false, reason: acquisition.reason, at: acquisition.at };
          }
          const hold = acquisition.hold;
          holds.set(walk.spec.taskId, { hold, arbiter: walkArbiter });
          ledgers.set(walk.spec.taskId, { ledger: walkLedger, invocation: walkInvocation });
          stack.push({
            name: "lease",
            release: (): Promise<string | null> => {
              try {
                // Stop this walk's beat before giving its lease back, so a beat
                // cannot re-extend a lease that has just been released.
                stopBeat(walk.spec.taskId);
                hold.release("RELEASED");
                walkArbiter.flush();
                logger.log("info", "lease.released", null, { fence: hold.fence });
                return Promise.resolve(null);
              } catch (error: unknown) {
                return Promise.resolve(classify(error));
              }
            },
          });

          // Every acquired walk beats. Without this the fenced lease degrades
          // to a plain TTL exactly when several tasks run at once: a walk
          // longer than the ttl expires while it runs, a successor lawfully
          // takes the worktree, and the running walk never finds out.
          const beat = setInterval(() => {
            let outcome: ArbiterRenewal;
            try {
              outcome = hold.renew();
            } catch (error: unknown) {
              abortWalk(walk, "SUPERVISION", classify(error));
              return;
            }
            if (outcome.lost) {
              abortWalk(walk, "STARTUP", "LEASE_FENCE_LOST");
            } else if (!outcome.ok) {
              logger.log("warn", "lease.renewal.refused", null, {
                taskId: walk.spec.taskId,
                reason: outcome.reason,
              });
            }
          }, LEASE_RENEW_INTERVAL_MS);
          beat.unref();
          beats.set(walk.spec.taskId, beat);
          return { ok: true, reason: "GRANTED", at: "walk.worktreePath" };
        },
        run: async (walk) => {
          const held = ledgers.get(walk.spec.taskId);
          const harness = sharedHarness;
          const heldLease = holds.get(walk.spec.taskId);
          if (held === undefined || harness === null || heldLease === undefined) {
            throw new StartupError("a walk was run before its ledger, lease and harness existed");
          }
          const walkRoot: ScenarioRoot = resolveScenarioRoot(walk.spec.scenarioId);
          // The same two hoists, per walk, and for the same reason: the
          // landing needs this walk's port and this walk's own gate before the
          // seam that would otherwise build them exists (V2-B1f/F5).
          const walkPort = executionPortFor(walk.spec.execution, walk.spec.taskId, harness);
          const walkGate = conformanceGateFor({
            ledger: held.ledger,
            invocation: held.invocation,
            worktreePath: walk.worktreePath,
            declaredWriteSet: walk.envelope.writeSet,
            lease: heldLease.hold.lease,
            emittedBy: walk.spec.emittedBy,
            onViolation: () => {
              stopBeat(walk.spec.taskId);
              heldLease.hold.release("WRITE_SET_VIOLATION_DETECTED");
              heldLease.arbiter.flush();
            },
          });
          // The same interposition, per walk. One law, two call sites, exactly
          // as the conformance gate and the two recorders already are — and a
          // switched walk under concurrency is landable precisely because this
          // is here rather than only at the single-walk form.
          const landing = await landingFor({
            ledger: held.ledger,
            invocation: held.invocation,
            execution: walk.spec.execution,
            port: walkPort,
            checkConformance: walkGate,
            taskId: walk.spec.taskId,
            attempt: walk.spec.attempt,
            emittedBy: walk.spec.emittedBy,
          });
          const route = landing.route;
          const effects = createExecutionEffects({
            port: walkPort,
            route,
            request: {
              taskId: walk.spec.taskId,
              attempt: walk.spec.attempt,
              identity: walk.spec.emittedBy,
              instructions: instructionFor(walk.envelope),
              reattach: null,
            },
            scenarioRoot: walkRoot,
            recordUsage: (sample) => {
              recordTokenObservation(held.ledger, {
                invocation: held.invocation,
                kind: "USAGE",
                accountId: route.accountId,
                tokens: sample.tokensUsed,
                // The landing generation leads the name at this seam too: one
                // law, two call sites (V2-B1f/F5).
                transitionId: usageTransitionId(landing.generation, sample.operationIndex, sample.stepIndex),
                emittedBy: walk.spec.emittedBy,
              });
            },
            // The same recorder, per walk: this walk's ledger, this walk's
            // invocation, this walk's elected account. One law, two call sites,
            // and `sample.provider` at both.
            recordPressure: (sample) => {
              recordProviderPressure(held.ledger, {
                invocation: held.invocation,
                accountId: route.accountId,
                provider: sample.provider,
                pressure: sample.pressure,
                transitionId: pressureTransitionId(sample.operationIndex, sample.trailIndex),
                emittedBy: walk.spec.emittedBy,
              });
            },
            // The same gate, per walk: this walk's envelope, this walk's lease,
            // this walk's admitted worktree. One law, two call sites — and the
            // same closure the landing above already called, never a second.
            checkConformance: walkGate,
          });
          const result = await runSqliteMode({
            ledger: held.ledger,
            invocation: held.invocation,
            effects,
            // The same composition, per walk: this walk's ledger, this walk's
            // envelope, this walk's admitted worktree. One law, two call sites,
            // exactly as the conformance gate above.
            checkpoints: checkpointsFor({
              ledger: held.ledger,
              ledgerPath: scenarioLedgerPath(walkRoot),
              invocation: held.invocation,
              emittedBy: walk.spec.emittedBy,
              envelope: walk.envelope,
              worktreePath: walk.worktreePath,
            }),
            switchPort: switchPortFor({
              execution: walk.spec.execution,
              ledger: held.ledger,
              lease: heldLease.hold.lease,
              landed: landing.landed,
            }),
            emittedBy: walk.spec.emittedBy,
            commitPolicy: "LOCAL_COMMIT_WITH_RECEIPT",
            initiativeId: walk.spec.initiativeId,
            route,
          });
          return result.finalState;
        },
        release: (walk, cause) => {
          const held = holds.get(walk.spec.taskId);
          if (held === undefined) return;
          stopBeat(walk.spec.taskId);
          held.hold.release(cause);
          held.arbiter.flush();
        },
      };

      // Both gates, in order, for every walk — before any child can exist.
      const admission = await admitWalks(scheduled, ports);
      publish("LEDGER_OPEN", null);

      // The harness is pushed AFTER every lease, so the reverse unwind reaps
      // before it releases; and it is created before any walk runs, so there is
      // no window in which a child exists that the unwind would not find.
      const harness = createAgentHarness();
      sharedHarness = harness;
      reapChildren = (): Promise<readonly string[]> => harness.closeAll();
      stack.push({
        name: "agent-harness",
        release: async (): Promise<string | null> => {
          try {
            const reaped = await harness.closeAll();
            logger.log("info", "harness.reaped", null, { sessions: reaped.length });
            return null;
          } catch (error: unknown) {
            return classify(error);
          }
        },
      });

      const ran = await runAdmitted(admission.admitted, ports);
      walkOutcomes = [...admission.refused, ...ran];
      for (const outcome of walkOutcomes) {
        if (outcome.ok) {
          logger.log("info", "walk.settled", null, { taskId: outcome.taskId, finalState: outcome.finalState });
        } else {
          logger.log("error", "walk.refused", "STARTUP", {
            taskId: outcome.taskId,
            refusal: outcome.refusal,
            reason: outcome.reason,
            at: outcome.at,
          });
        }
      }
      publish("RECONCILED", null);
      publish("READY", null);
      logger.log("info", "ready", null, { mode: options.mode, walks: walkOutcomes.length });
      publish("SUPERVISING", null);
    }
  } catch (error: unknown) {
    const code = classify(error);
    logger.log("error", "startup.failed", null, { at: phases[phases.length - 1] ?? "INIT", code });
    const outcome = await stack.unwindAll();
    logger.log("info", "unwound", null, {
      released: outcome.released.join(","),
      failures: outcome.failures.length,
    });
    clearStatus(root);
    throw error instanceof Error ? error : new StartupError("startup failed: " + code);
  }

  // One unwind, two endings. The stack is idempotent, so a signal arriving
  // during a terminal drain (or the reverse) cannot start a second one.
  const drain = async (
    kind: "SIGNAL" | "TERMINAL",
    errorCode: DaemonErrorCode | null,
  ): Promise<StopResult> => {
    if (kind === "TERMINAL") {
      publish("TERMINAL", errorCode);
      logger.log("error", "terminal", errorCode, { mode: options.mode });
    } else {
      publish("DRAINING", null);
      logger.log("info", "draining", null, {});
    }

    const outcome = await stack.unwindAll();

    if (kind === "TERMINAL") {
      // The TERMINAL document stays. It is the only account of why this
      // process is gone.
      logger.log("error", "terminated", errorCode, { failures: outcome.failures.length });
    } else {
      publish("STOPPED", null);
      logger.log("info", "stopped", null, { failures: outcome.failures.length });
      clearStatus(root);
    }
    return { stopped: outcome.failures.length === 0, outcome };
  };

  const run: DaemonRun = {
    mode: options.mode,
    phases,
    serverPid,
    terminal,
    stop: () => drain("SIGNAL", null),
    terminate: (errorCode: DaemonErrorCode, detail: string) => {
      logger.log("error", "terminal.cause", errorCode, { detail });
      return drain("TERMINAL", errorCode);
    },
  };
  return run;
}

/**
 * Stop a run within the aggregate drain bound.
 *
 * This is the bound the contract declares, and it only means anything if the
 * real entry point goes through it. Per-resource deadlines keep any single
 * release honest; this one keeps the whole shutdown honest, and both are
 * needed — a dozen releases each finishing just inside their own bound would
 * still add up to a hang.
 *
 * The deadline is a parameter so the timeout branch can be proven in
 * milliseconds rather than by a test that sits for half a minute.
 */
export function stopDaemon(run: DaemonRun, deadlineMs = DRAIN_DEADLINE_MS): Promise<StopResult> {
  return bounded(run.stop(), deadlineMs);
}

/** Terminate a run within the same aggregate bound. */
export function terminateDaemon(
  run: DaemonRun,
  errorCode: DaemonErrorCode,
  detail: string,
  deadlineMs = DRAIN_DEADLINE_MS,
): Promise<StopResult> {
  return bounded(run.terminate(errorCode, detail), deadlineMs);
}

async function bounded(work: Promise<StopResult>, deadlineMs: number): Promise<StopResult> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<StopResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ stopped: false, outcome: { released: [], failures: ["drain-deadline"] } });
    }, deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The CLI adapters, by the provider name a resolved route carries. */
const CLI_ADAPTERS: Readonly<Record<string, ProviderAdapter>> = Object.freeze({
  claude: claudeAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
});

/**
 * Build the execution port from the config's resolved route and admitted
 * binding (V2-B1b, D5/D6).
 *
 * The CLI leg only, and exactly one binding, keyed by the route's own account:
 * `apiBindings` and `localBindings` are absent by construction, so a route on
 * another transport is refused by the port with `TRANSPORT_UNAVAILABLE` at
 * `route.transportKind` the first time the walk asks for its effect -- never
 * served from a default. The binary, the configuration root and the working
 * directory pass the providers package's own admissions here (ownership,
 * permissions, canonical path, no product checkout), so a refused path stops
 * the daemon inside its unwind, classified by the adapter's code and never by
 * the path.
 */
/**
 * Build one walk's write-set conformance gate.
 *
 * One function, two call sites — the legacy singular seam and the scheduler's
 * per-walk seam — because under DT Option B they are symmetric: each has an
 * authoritative envelope, a held lease and an admitted worktree, so each gets
 * the same five steps. Gating one and not the other would be the bypass the
 * ruling forbids, and `L-C-4c` fails on it.
 *
 * The five steps, in this order and for these reasons:
 *
 * 1. **Observe.** Read-only, through the one git authority.
 * 2. **An observation that cannot be taken is not a pass.** A failed read
 *    throws `OBSERVATION_FAILED` and appends nothing: silence about a worktree
 *    is not evidence about a worktree.
 * 3. **Record, then revoke.** The verdict's own events are appended first —
 *    `WRITE_SET_VIOLATION_DETECTED`, then `LEASE_REVOKED`. A revocation whose
 *    cause has no event is a lease that vanished for no recorded reason.
 * 4. **Quarantine the task**, with a `TASK_STATE_CHANGED` to the verdict's own
 *    `recommendedTaskState`. This is the step that makes the violation *stick*:
 *    `SUSPECT_WORKTREE` is a terminal state, so the ledger — the authority —
 *    records the quarantine and a restart reconciles a task that will not
 *    resume. Without it the walk stops but the task stays resumable, and the
 *    next start re-runs the provider, re-writes outside the set and re-violates,
 *    indefinitely. The recommendation is **read from the verdict**, never
 *    restated here: `checkWriteSetConformance` decides what a violation means.
 * 5. **Release the hold**, so the worktree is not stranded by a walk that is
 *    about to stop.
 * 6. **Throw**, so the walk stops here rather than continuing to a checkpoint.
 *
 * **Nothing else.** No clean, no restore, no checkout, no stash, no staging,
 * no unlink. The offending bytes stay exactly where the packet put them,
 * because the evidence of what happened is worth more than a tidy directory —
 * and `L-C-4b` asserts this closure contains no way to change one.
 *
 * Coordinates are derived from the operation index, so a retry of the same
 * operation appends nothing new.
 */
function conformanceGateFor(input: {
  readonly ledger: LedgerPort;
  readonly invocation: DurableInvocation;
  readonly worktreePath: string;
  readonly declaredWriteSet: readonly string[];
  readonly lease: Lease;
  readonly emittedBy: string;
  readonly onViolation: () => void;
  /**
   * Structural, not the named `ConformanceGate`.
   *
   * The type is exported from `execution-effects` and deliberately **not**
   * re-exported through the runtime barrel: that barrel's names are pinned by
   * equality in its own mirrored suite, and moving the pin would be a
   * seventeenth path. The shape is identical, the assignment is checked, and
   * nothing is lost but a name this file never needed to say.
   */
}): (operationIndex: number) => void {
  const observer = createGitObserver(input.worktreePath);
  return (operationIndex: number): void => {
    const seen = observeWorktree(observer, input.worktreePath);
    if (!seen.ok) {
      throw new StartupError("OBSERVATION_FAILED: the worktree could not be observed");
    }
    const verdict = checkWriteSetConformance({
      declaredWriteSet: input.declaredWriteSet,
      observation: seen.observation,
      lease: input.lease,
    });
    if (!verdict.ok) {
      throw new StartupError("OBSERVATION_FAILED: " + verdict.reason);
    }
    if (verdict.conformant) return;

    const task = input.ledger.getTask(input.invocation.taskId);
    if (task !== null) {
      let index = 0;
      const append = (
        type: string,
        payload: Readonly<Record<string, string>>,
        toState: string,
      ): void => {
        const transitionId = "conformance." + String(operationIndex) + "." + String(index);
        index += 1;
        const coordinate = deriveEventCoordinate(input.invocation, transitionId, 0);
        input.ledger.append({
          contractVersion: CONTRACT_VERSION,
          eventId: coordinate.eventId,
          taskId: input.invocation.taskId,
          attempt: input.invocation.attempt,
          transitionId,
          idempotencyKey: coordinate.idempotencyKey,
          type,
          fromState: task.currentState,
          toState,
          emittedBy: input.emittedBy,
          occurredAt: coordinate.occurredAt,
          recordedAt: coordinate.recordedAt,
          correlationId: input.invocation.invocationId,
          causationId: null,
          payload,
        });
      };

      // The finding and the revocation ride the task's thread without moving
      // it: they say what happened, not what the task now is.
      for (const event of verdict.events) append(event.type, event.payload, task.currentState);

      // And then the task is quarantined. `SUSPECT_WORKTREE` is terminal, so
      // this is what stops a violated walk from being resumed and re-run — the
      // difference between a walk that stopped and a task that is finished.
      const quarantine = verdict.recommendedTaskState;
      if (quarantine !== null && quarantine !== task.currentState) {
        append("TASK_STATE_CHANGED", { taskId: input.invocation.taskId, toState: quarantine }, quarantine);
      }
    }
    input.onViolation();
    throw new StartupError("WRITE_SET_VIOLATION_DETECTED: the walk wrote outside its declared set");
  };
}

/**
 * The one next safe action a terminal ever names (V2-B1f/F3, §2.4).
 *
 * A module constant, never composed and never varied. Declared here and,
 * identically, in the two drill children, for the reason `DRILL_INSTRUCTION` is
 * declared twice: unifying it would mean widening the runtime barrel, whose
 * names are pinned by equality. The tests quote the literal verbatim rather
 * than importing it, so a drift in any one of the three fails rather than
 * propagating.
 */
const NEXT_SAFE_ACTION = "Await the next owner-authorized action.";

/** The digest of no bytes: what a tracked deletion is worth (§2.3). */
function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The production checkpoint source (V2-B1f/F3).
 *
 * Every field comes from a fact this process actually holds, and none of them
 * is a literal here:
 *
 * - the identity and the instant from `deriveEventCoordinate`, so no clock and
 *   no random source participates and a replayed walk assembles the same bytes;
 * - the last atomic step from the ledger's own `run.outcome` row, read rather
 *   than remembered;
 * - the four git facts from ONE `observeWorktree` over the leased worktree,
 *   plus one further read of the branch through the same `GitReadPort` --
 *   `rev-parse` is in the closed verb set, and `WorktreeObservation` is not
 *   widened to carry a fifth field three other consumers do not need;
 * - the authority digests copied from the envelope, which already holds them as
 *   `PathDigest[]`, never re-derived;
 * - the read-set and write-set digested against the leased worktree.
 *
 * **Two honest refusals, and no third.** `Checkpoint.git.head` is a 40
 * character object id while an observation's head is nullable, so an unborn
 * HEAD refuses `GIT_HEAD_UNBORN`; and an observation that could not be taken
 * refuses `GIT_UNOBSERVABLE` rather than becoming a null, because an
 * observation that could not be taken says nothing at all.
 *
 * **`receipts`, `artifacts` and `pendingWork` are `[]`, and that is the truth
 * rather than a placeholder.** The plane produces no reference at a terminal
 * today and has no pending-work list to draw from; a fabricated entry would be
 * the checkpoint claiming something the plane does not hold, which is the exact
 * defect this packet exists to remove.
 */
function checkpointSourceFor(input: {
  readonly ledger: LedgerPort;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  readonly envelope: TaskEnvelope;
  readonly worktreePath: string;
}): CheckpointSource {
  // Built once, exactly as the conformance gate builds its own: the observer is
  // a closure over the worktree, and the walk observes the tree it writes into.
  const observer = createGitObserver(input.worktreePath);

  const refuse = (reason: CheckpointRefused["reason"], at: string): CheckpointRefused => ({
    ok: false,
    reason,
    at,
  });

  /**
   * The digest of a declared path, or null when the worktree does not hold it.
   *
   * `allowTrackedDeletion` is §2.3's single exception and is passed only for
   * the write-set: a path git reports as changed and the filesystem no longer
   * holds is a deletion, and the observer's own rule digests the empty string
   * for it. Every other absence is a `PATH_MISSING`, because a digest nobody
   * observed is an invented one.
   */
  const digestOfDeclared = (
    path: string,
    observation: WorktreeObservation,
    allowTrackedDeletion: boolean,
  ): string | null => {
    try {
      return sha256Of(readFileSync(join(input.worktreePath, path)));
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code !== "ENOENT") return null;
      if (!allowTrackedDeletion) return null;
      const tracked = observation.trackedChanges.some((entry) => entry.path === path);
      return tracked ? sha256Of(Buffer.alloc(0)) : null;
    }
  };

  return {
    assemble(step: PlanStep): Checkpoint | CheckpointRefused {
      const seen = observeWorktree(observer, input.worktreePath);
      if (!seen.ok) return refuse("GIT_UNOBSERVABLE", "worktree");
      const observation = seen.observation;
      if (observation.head === null) return refuse("GIT_HEAD_UNBORN", "git.head");

      // One further read through the SAME port. The observation is not widened
      // to carry a branch: three consumers share its shape and none of the
      // other two has any use for one.
      const branch = observer({ verb: "rev-parse", args: ["--abbrev-ref", "HEAD"] });
      if (!branch.ok) return refuse("GIT_UNOBSERVABLE", "git.branch");
      const branchName = branch.stdout.trim();
      if (branchName === "") return refuse("GIT_UNOBSERVABLE", "git.branch");

      const recorded = input.ledger.getEventByIdempotencyKey(
        buildIdempotencyKey({
          taskId: input.invocation.taskId,
          attempt: input.invocation.attempt,
          transitionId: OUTCOME_STEP.transitionId,
        }),
      );
      if (recorded === null) return refuse("CHECKPOINT_INVALID", "lastAtomicStep");
      const parsed: unknown = JSON.parse(recorded.canonicalJson);
      const completedAt =
        typeof parsed === "object" && parsed !== null && "occurredAt" in parsed
          ? (parsed as { readonly occurredAt: unknown }).occurredAt
          : undefined;
      if (typeof completedAt !== "string") {
        return refuse("CHECKPOINT_INVALID", "lastAtomicStep.completedAt");
      }

      const readSetDigest: { path: string; sha256: string }[] = [];
      for (const path of input.envelope.readSet) {
        const digest = digestOfDeclared(path, observation, false);
        if (digest === null) return refuse("PATH_MISSING", "readSet:" + path);
        readSetDigest.push({ path, sha256: digest });
      }

      const writeSetDigest: { path: string; sha256: string }[] = [];
      for (const path of input.envelope.writeSet) {
        const digest = digestOfDeclared(path, observation, true);
        if (digest === null) return refuse("PATH_MISSING", "writeSet:" + path);
        writeSetDigest.push({ path, sha256: digest });
      }

      const coordinate = deriveEventCoordinate(input.invocation, step.transitionId, step.index);
      return {
        contractVersion: CONTRACT_VERSION,
        checkpointId: deterministicUuid(
          "checkpoint/" +
            input.invocation.invocationId +
            "/" +
            input.invocation.taskId +
            "/" +
            String(input.invocation.attempt) +
            "/" +
            step.transitionId,
        ),
        taskId: input.invocation.taskId,
        attempt: input.invocation.attempt,
        worker: input.emittedBy,
        createdAt: coordinate.occurredAt,
        lastAtomicStep: {
          index: OUTCOME_STEP.index,
          label: OUTCOME_STEP.transitionId,
          completedAt,
        },
        git: {
          head: observation.head,
          branch: branchName,
          worktreePath: input.worktreePath,
          isDirty: observation.trackedChanges.length > 0 || observation.untrackedPaths.length > 0,
        },
        // Copied, never re-derived: the envelope already carries authority as
        // path-plus-digest, and a second derivation would be a second opinion
        // about what granted this packet its authority.
        authorityDigest: input.envelope.authority.map((entry) => ({ ...entry })),
        readSetDigest,
        writeSetDigest,
        receipts: [],
        artifacts: [],
        pendingWork: [],
        nextSafeAction: NEXT_SAFE_ACTION,
        notes: null,
      };
    },
  };
}

/**
 * The production checkpoint port: one source, one store, one root rule.
 *
 * The ledger path is the one the daemon already opened through
 * `scenarioLedgerPath`, and the artifacts resolve as its sibling through
 * `@acp/ledger`'s own `artifactRootFor`. There is no configurable root and no
 * second helper to reach for.
 */
function checkpointsFor(input: {
  readonly ledger: LedgerPort;
  readonly ledgerPath: string;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  readonly envelope: TaskEnvelope;
  readonly worktreePath: string;
}): CheckpointPort {
  return createCheckpointStore({
    ledgerPath: input.ledgerPath,
    source: checkpointSourceFor({
      ledger: input.ledger,
      invocation: input.invocation,
      emittedBy: input.emittedBy,
      envelope: input.envelope,
      worktreePath: input.worktreePath,
    }),
  });
}

/**
 * The binding that serves this config's route (V2-B1f/F2).
 *
 * **Deliberately local, and the edge to `daemon-child` stays type-only.** That
 * module carries the child's own entry guard -- a module-level
 * `realpathSync(process.argv[1])` that decides whether it was invoked directly
 * -- so importing a *value* from it would load it into this entry's graph and
 * run that guard on import. The package's purity drill catches exactly that:
 * importing `@acp/daemon` must create nothing, bind nothing, spawn nothing and
 * read no argv. A type-only edge is erased at compile time and costs nothing.
 *
 * It is total rather than trusting: `parseExecutionSection` already refuses a
 * config whose route names no entry, but `startDaemon` can be handed a
 * `DaemonExecutionConfig` value directly, so this defends its own door instead
 * of assuming the parser was the only way in.
 */
function bindingForRoute(execution: DaemonExecutionConfig): DaemonExecutionBinding {
  const found = execution.bindings.find((entry) => entry.accountId === execution.route.accountId);
  if (found === undefined) {
    throw new StartupError(
      "the execution route names " +
        execution.route.accountId +
        ", which no entry of execution.bindings serves",
    );
  }
  return found;
}

/**
 * Build the execution port over every account the config binds (V2-B1f/F2).
 *
 * The port layer was already plural -- `createExecutionPort` has always taken
 * `ReadonlyMap<string, CliBinding>`, "one per accountId", and has always
 * refused a route whose account it holds no binding for. The singularity was
 * here: this function built that map and set exactly one entry. A switch
 * therefore had nowhere to land, because the destination account had no
 * binding no matter what the planner decided.
 *
 * Now every entry is admitted **independently**, through the same
 * `admitBinary`/`admitConfigRoot`/`admitWorkdir` route the single binding
 * always took. There is no default, no inheritance and no discovery: an
 * account reaches this map because the operator wrote it down and it passed
 * the same admission as every other, or it does not reach it at all.
 *
 * **The adapter is per entry since V2-B1f/F2b.** F2 gave the entry an account
 * but not a provider, so this function hoisted ONE adapter out of the loop and
 * every admitted binding got the route's -- a codex account declared beside a
 * claude route was admitted under the claude adapter, whose `buildEnv` exports
 * a codex credential root as `CLAUDE_CONFIG_DIR` and never sets `CODEX_HOME`.
 * The entry now carries the provider it speaks, and the port's cross-provider
 * guard stops being vacuous for the maps this function builds.
 *
 * The name and this function's position after `conformanceGateFor` are load
 * bearing for `L-C-4b` and stay exactly as they were.
 */
/**
 * The CLI entries of a config, which are the only ones a switch can name.
 *
 * A destination is identified by the provider it speaks, and an API entry
 * declares none — the injected client does (D3). So the account-switch plane
 * reads this rather than the whole array: an API entry is not a destination
 * missing a field, it is a different shape.
 */
function cliBindingsOf(
  execution: DaemonExecutionConfig,
): readonly Extract<DaemonExecutionBinding, { transportKind: "CLI_SUBSCRIPTION" }>[] {
  return execution.bindings.filter(
    (entry): entry is Extract<DaemonExecutionBinding, { transportKind: "CLI_SUBSCRIPTION" }> =>
      entry.transportKind === "CLI_SUBSCRIPTION",
  );
}

/**
 * The provider the routed entry speaks, for the switch elector.
 *
 * The parser refuses a config whose routed entry disagrees with the route's
 * transport, so a CLI route is served by a CLI entry by the time this runs.
 * The fallback is the route's own provider rather than a throw: this is read
 * only when a switch authorization exists, and an API route reaching it would
 * mean the elector was handed a plan for a transport it cannot switch — which
 * `considerSwitch` refuses on its own terms rather than by crashing here.
 */
function routeProviderOf(execution: DaemonExecutionConfig): string {
  const routed = bindingForRoute(execution);
  return routed.transportKind === "CLI_SUBSCRIPTION" ? routed.provider : execution.route.provider;
}

function executionPortFor(
  execution: DaemonExecutionConfig,
  taskId: string,
  harness: AgentHarness,
  apiClientFor?: (accountId: string) => ApiStreamingClient | undefined,
): ModelExecutionPort {
  const { route } = execution;
  const bindings = new Map<string, CliBinding>();
  // **Built for every route, not only an API one (V2-BE/R6).** The map is
  // always passed, so the port's own `apiBindings === undefined` refusal at
  // `route.transportKind` stops being the daemon's answer and the honest one
  // takes its place: an account nobody gave a client for is unbound, and
  // `admitApiRoute` refuses it at `route.accountId`. Handing an absent map
  // would report "this daemon has no API transport" for an operator who
  // configured one and forgot the factory.
  const apiBindings = new Map<string, ApiKeyBinding>();
  // **The outer guard is the transport, not the adapter (V2-B1f/F2b).** The
  // previous `if (adapter !== undefined)` conflated "this is not a CLI route"
  // with "no adapter exists for this provider" and answered both with an empty
  // map. Keying the branch on `transportKind` keeps the non-CLI behaviour byte
  // for byte -- the map stays empty and the port refuses at
  // `route.transportKind` -- while the missing adapter becomes a refusal, which
  // is what failing closed at admission means.
  for (const entry of execution.bindings) {
    if (entry.transportKind !== "API_KEY") continue;
    // **No factory, no binding, and no substitute.** `apiClientFor` is absent
    // by default (D2a), so this loop leaves the account unbound and the port
    // refuses it. A daemon that invented a client here would be opening a
    // transport nobody asked it to open.
    const client = apiClientFor?.(entry.accountId);
    if (client === undefined) continue;
    apiBindings.set(entry.accountId, { client });
  }

  if (route.transportKind === "CLI_SUBSCRIPTION") {
    for (const entry of execution.bindings) {
      // The CLI arm reads CLI entries only. An API entry in the same array is
      // not a CLI binding that lost its fields; it is a different shape, and
      // the discriminant is what says so.
      if (entry.transportKind !== "CLI_SUBSCRIPTION") continue;
      // `Object.hasOwn` before the index, because `CLI_ADAPTERS` is a plain
      // object typed by string: an entry naming `constructor` would otherwise
      // resolve to an inherited member rather than to `undefined` and slip past
      // the refusal below. The parser refuses such a name outright, so this is
      // a door-only exposure -- and the door is the point, because
      // `startDaemon` accepts a config value that never passed the parser.
      const adapter = Object.hasOwn(CLI_ADAPTERS, entry.provider)
        ? CLI_ADAPTERS[entry.provider]
        : undefined;
      if (adapter === undefined) {
        throw new StartupError(
          "the execution binding for " +
            entry.accountId +
            " names no CLI adapter for provider " +
            entry.provider,
        );
      }
      // The context is the entry's, not the route's. The adapter decides the
      // credential environment variable -- `buildEnv` sets `CLAUDE_CONFIG_DIR`,
      // `CODEX_HOME` or `KIMI_CODE_HOME` from the adapter's own provider -- so
      // an entry admitted under the route's provider would have had one
      // provider's credential root exported under another's variable.
      const context = { provider: entry.provider, taskId };
      try {
        bindings.set(entry.accountId, {
          adapter,
          binary: admitBinary(entry.binary, context),
          configRoot: admitConfigRoot(entry.configRoot, context),
          workdir: admitWorkdir(entry.workdir, context),
          limits: entry.limits,
        });
      } catch (error: unknown) {
        // The account is named, so a refused SECOND binding is distinguishable
        // from a refused first. Without it an operator holding four bindings
        // would be told only that "the" binding was refused, and would have to
        // guess which credential root the daemon objected to.
        //
        // The provider clause is APPENDED to that sentence rather than spliced
        // into it, so F2's assertion on the existing text stays green unchanged.
        // It is the one thing this packet makes observable before a second
        // session is ever opened: a refused second binding now reports the
        // provider it was admitted as, which a route-derived admission could not
        // have said.
        const code = error instanceof AdapterError ? error.code : "UNCLASSIFIED";
        throw new StartupError(
          "the execution binding for " +
            entry.accountId +
            " was refused: " +
            code +
            "; it was admitted as " +
            entry.provider,
        );
      }
    }
  }
  // The harness is the caller's, not the port's own (V2-B4a). A port that
  // built its own would still hold the children correctly; what the daemon
  // would lose is the ability to reap them at its unwind, which is the whole
  // point of owning them.
  return createExecutionPort({ bindings, apiBindings, harness });
}

/** The lock is released last, because everything else was acquired under it. */
function lockResource(root: DaemonRoot, identity: RecordedIdentity): Resource {
  return {
    name: "singleton",
    release: (): Promise<string | null> => {
      try {
        releaseSingleton(root, identity);
        return Promise.resolve(null);
      } catch (error: unknown) {
        return Promise.resolve(classify(error));
      }
    },
  };
}

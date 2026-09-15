/**
 * The composition root of the Agent Control Plane daemon (P-13).
 *
 * This module holds what `startDaemon` orchestrates: the daemon's option,
 * run and stop types, the observation and recovery helpers, the instruction
 * producer, the switch-landing dispatch, and `startDaemon` itself, in
 * acquisition order, with the singular, scheduled and Restate walks. The
 * seams it closes over live in the three sibling modules the escalón-2
 * partition created (structure §2 :109):
 *
 * - `./ports/index.ts` -- the composed ports: the CLI adapter table and the
 *   per-binding execution port, the switch port over the held lease, the
 *   write-set conformance gate, and the checkpoint source and store;
 * - `./walk/index.ts` -- the single walk construction: `buildWalkEffects`,
 *   the one `createExecutionEffects` site, and `runComposedSqliteWalk`, the
 *   one `runSqliteMode` literal both walk forms call;
 * - `./usecases/index.ts` -- the bounded `stopDaemon` / `terminateDaemon`
 *   wrappers and the singleton lock resource, re-exported from here;
 * - `./types/index.ts` -- the two walk context shapes this root fills and the
 *   walk module reads, declared once for both sides.
 *
 * The package barrel (`src/index.ts`) keeps only `startDaemon`, `stopDaemon`,
 * `terminateDaemon` and the public types; the observation and recovery
 * helpers (`readOwnStatus`, `recoverOwnStaleLock`) and the launchd
 * rendering/validation surface are exported from here, where the code they
 * belong to lives.
 *
 * Importing this module has no side effects, exactly as the barrel never did:
 * it parses no argv, creates no directory, opens no database, binds no
 * socket, spawns no child, installs no signal handler and writes no file.
 * Effects begin only inside `startDaemon`.
 *
 * P-13 is a pure extraction: no symbol was renamed and no behaviour changed.
 * The architecture fence re-scoped its composition laws to the module each
 * seam lives in during the same packet, so no law ever reads an empty site.
 */

import { findCredentialViolations } from "@acp/contracts";
import type { ContentBlockKind, ModelExecutionPort, ResolvedRoute, TaskEnvelope } from "@acp/contracts";
import type { Ledger, LeaseStore } from "@acp/ledger";
import { openArtifactPlane, openLeaseStore, openLedger } from "@acp/ledger";
import type { ArtifactBlobLeaseStore, ArtifactPlane } from "@acp/ledger";
import { deriveInvocation } from "@acp/durability";
import type { AgentHarness, ApiStreamingClient } from "@acp/providers";
import { createAgentHarness, executionSessionId } from "@acp/providers";
import type { CheckpointPort, DurableInvocation, ScenarioRoot } from "@acp/runtime";
import type { WalkOutcome } from "../scheduler/index.js";
import { landAccountSwitch, resolveScenarioRoot, scenarioLedgerPath } from "@acp/runtime";

import { createArbiter, leaseStorePath } from "../arbiter/index.js";
import type { Arbiter, ArbiterRenewal, LeaseHold } from "../arbiter/index.js";
import { LEASE_RENEW_INTERVAL_MS, LEASE_TTL_MS } from "../constants/index.js";
import type { DaemonExecutionConfig } from "../daemon-child/index.js";
import type { DaemonErrorCode } from "../errors/index.js";
import { ModeError, StartupError } from "../errors/index.js";
import type { ProcessInspector, RecordedIdentity } from "../identity-probe/index.js";
import { createPsInspector, ownIdentity } from "../identity-probe/index.js";
import type { DaemonMode, UnwindOutcome } from "../lifecycle/index.js";
import { UnwindStack, assertReservedPortsFree, classify, isDaemonMode } from "../lifecycle/index.js";
import { createLogger } from "../log/index.js";
import { existingDaemonRoot, redactPath, resolveDaemonRoot } from "../paths/index.js";
import { startRestateMode, superviseRestate } from "../mode-restate/index.js";
import { WALK_CONCURRENCY_MAX, admitWalks, runAdmitted } from "../scheduler/index.js";
import type { ScheduledWalk, SchedulerPorts } from "../scheduler/index.js";
import type { RecordedServer } from "../singleton/index.js";
import { acquireSingleton, recoverStaleLock } from "../singleton/index.js";
import type { DaemonPhase, DaemonStatusDocument } from "../status/index.js";
import { clearStatus, readStatusFrom, writeStatus } from "../status/index.js";

import { bindingForRoute, checkpointsFor, cliBindingsOf, conformanceGateFor, executionPortFor } from "./ports/index.js";
import type { ComposedSqliteWalkInput, WalkEffectsInput } from "./types/index.js";
import { buildWalkEffects, runComposedSqliteWalk } from "./walk/index.js";
import { lockResource } from "./usecases/index.js";

/**
 * The launchd surface, added by P2E.
 *
 * A rendering and validation surface, not an adoption API: nothing here
 * installs, loads, copies or schedules anything, and the only function that
 * writes refuses any destination outside the ignored local root. The closed
 * export set widens by exactly these names, and the fence is updated to the new
 * size in the same change, so the widening is a decision rather than a drift.
 */
export type { LaunchAgentValues } from "../launchd/render/index.js";
export { renderLaunchAgent, writeLaunchAgent } from "../launchd/render/index.js";
export type { LaunchdRefusal, LaunchdVerdict } from "../launchd/validate/index.js";
export { validatePlist, validateTemplate } from "../launchd/validate/index.js";

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
   * `../daemon-child/index.js` so there is one producer of it and no second
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
 * The lease store an instruction reader hands the plane: it refuses everything.
 *
 * `read` goes by reference and scope and asks the lease store nothing, and opening
 * the real one on a read would create and migrate a coordination file just to
 * compose a prompt. `initiative-registration`'s objective reader is the precedent,
 * verbatim.
 */
const READER_LEASE_STORE: ArtifactBlobLeaseStore = Object.freeze({
  incarnation: refuseInstructionHolding,
  read: refuseInstructionHolding,
  readToken: refuseInstructionHolding,
  acquire: refuseInstructionHolding,
  release: refuseInstructionHolding,
  revoke: refuseInstructionHolding,
  takeOver: refuseInstructionHolding,
  listOverdue: refuseInstructionHolding,
  close: (): void => undefined,
});

function refuseInstructionHolding(): never {
  throw new ModeError("an instruction reader takes no holding: reading a reference asks the blob lease store nothing");
}

/**
 * How the text of several blocks is joined: one blank line, in the list's own order
 * (P-06/C, ADR 0095).
 *
 * The order is the list's because §4.1 calls it an **ordered** list, and a composer
 * that sorted or grouped would be answering a question the contract already answered.
 * A blank line because a block boundary is a paragraph boundary and nothing smaller
 * survives a round trip through a model's tokenizer intact; one rule, no per-adapter
 * variant, so two transports never see different instructions for one envelope.
 */
const BLOCK_SEPARATOR = "\n\n";

/** What the composition produces: the bytes that cross, and the classes they came from. */
export interface ComposedInstruction {
  readonly instructions: string;
  readonly modalities: readonly ContentBlockKind[];
}

/**
 * The credential guard, over ONE block, before it is joined (N-P06-18, E15).
 *
 * Per block rather than over the composed string, although the string contains
 * every block and the session guard scans it again before the spawn. Two reasons,
 * and neither is belt-and-braces: a hit here names WHICH block offended, as a path
 * and never as bytes, and it refuses before the offending text has been joined to
 * anything -- so the value that would have crossed the boundary is never built.
 *
 * Scanned as an object, because the guard's value scan is what has to run over the
 * content. `findTranscriptViolations` is deliberately not called: it scans denied
 * KEYS, so it is vacuous here, and calling it would look like content filtering
 * that is not happening.
 */
function guardResolvedBlock(at: string, text: string): void {
  if (findCredentialViolations({ instructions: text }).length > 0) {
    throw new ModeError(
      at + " carries credential material; it is refused before it is composed, and the bytes travel nowhere",
    );
  }
}

/**
 * The instruction, composed from the content the envelope carries (P-06/C, ADR 0095).
 *
 * The one producer L-B1C-1 names, moved off `envelope.objective` and onto the content
 * contract §4.1 froze. What it does, in order:
 *
 * - **the classes**, distinct and in first-appearance order, which travel to the
 *   adapter so a transport can refuse a class it cannot carry before a process
 *   exists. They are classes, never blocks: no byte leaves this function except
 *   inside the returned string, which crosses exactly one boundary.
 * - **the text**, joined by {@link BLOCK_SEPARATOR}. Only `text` blocks contribute:
 *   every other class is the preflight's to refuse (`MODALITY_UNSUPPORTED`), and it
 *   is refused rather than dropped, because composing an instruction without the
 *   part the caller asked for would send the model something nobody authorized.
 * - **the verification**, for a text block that names a reference: the referenced
 *   bytes are authoritative, and they are read through the plane under this task's
 *   own scope and checked against **both** declared figures — `contentSha256` and
 *   `byteLength` — and against the inline text. A mismatch throws before a single
 *   byte crosses (N-P06-13), and a reference of another scope is refused by the
 *   plane's own `SCOPE_EQUALITY_V1` (N-P06-12). Either way the instruction is not
 *   composed at all: there is no half-composed instruction.
 *
 * Inline text with no reference is used as it stands. Its length was checked against
 * its bytes at the door, and re-deriving it here would be a second policy able to
 * disagree with the first.
 *
 * Exported so the acceptance proof can drive the REAL producer rather than a copy of
 * it (contratos §4.3: "no desde un fixture"). Exporting does not widen L-B1C-1: the
 * law counts sites that ASSIGN an `instructions:` value of their own, and a caller of
 * this function assigns nothing -- it spreads what the one producer returned.
 */
export function instructionFor(ledger: Ledger, envelope: TaskEnvelope): ComposedInstruction {
  const blocks = envelope.content.blocks;
  const modalities = [...new Set(blocks.map((block) => block.kind))];
  const parts: string[] = [];
  // At most one plane, opened only if a block actually names a reference. It is not
  // closed, because an `ArtifactPlane` has nothing to close: it holds no descriptor
  // of its own and reads through the ledger it was handed. The objective reader of
  // `initiative-registration` opens one the same way and leaves it the same way.
  const opened: ArtifactPlane[] = [];
  const openOnce = (): ArtifactPlane => {
    const standing = opened[0];
    if (standing !== undefined) return standing;
    const created = openArtifactPlane({ ledger, leaseStore: READER_LEASE_STORE, ledgerPath: ledger.path });
    opened.push(created);
    return created;
  };
  {
    blocks.forEach((block, index) => {
      if (block.kind !== "text") return;
      const inline = block.text ?? "";
      const at = "envelope.content.blocks[" + String(index) + "]";
      if (block.artifactRefId === null) {
        guardResolvedBlock(at, inline);
        parts.push(inline);
        return;
      }
      const read = openOnce().read({
        artifactReferenceId: block.artifactRefId,
        scopeKind: "TASK",
        scopeId: envelope.taskId,
      });
      if (read.verb !== "READ") {
        throw new ModeError(at + " names a reference the private plane refuses to read: " + read.refusal);
      }
      if (read.reference.contentSha256 !== block.contentSha256) {
        throw new ModeError(at + " names content of another digest than the block declares");
      }
      const bytes = read.content;
      if (bytes.byteLength !== block.byteLength) {
        throw new ModeError(at + " names content of another length than the block declares");
      }
      const resolved = bytes.toString("utf8");
      if (resolved !== inline) {
        throw new ModeError(at + " carries text that differs from the bytes its reference names");
      }
      guardResolvedBlock(at, resolved);
      parts.push(resolved);
    });
  }
  return { instructions: parts.join(BLOCK_SEPARATOR), modalities };
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

      if (options.mode === "SQLITE_SUPERVISOR") {
        // S8. No S4-S7: this mode binds nothing and spawns nothing of its own.
        // The walk is composed by runComposedSqliteWalk — the one walk
        // construction both forms use (P-13, escalón 2) — from this seam's own
        // landing, lease, gate and envelope. The context is named by the type
        // the walk module reads from `./types/index.js`, so a field this seam
        // forgets is a compile error at the seam rather than at the builder.
        const walkInput: ComposedSqliteWalkInput = {
          ledger: openedLedger,
          invocation,
          execution: options.execution,
          envelope: options.envelope,
          scenarioRoot,
          worktreePath: bindingForRoute(options.execution).workdir,
          port,
          route,
          generation: landing.generation,
          landed: landing.landed,
          hold,
          gate,
          ...instructionFor(openedLedger, options.envelope),
          taskId: options.taskId,
          attempt: options.attempt,
          emittedBy: options.emittedBy,
          initiativeId: options.initiativeId,
        };
        const result = await runComposedSqliteWalk(walkInput);
        publish("RECONCILED", null);
        publish("READY", null);
        logger.log("info", "ready", null, { mode: options.mode, verdict: result.verdict });
        publish("SUPERVISING", null);
        logger.log("info", "supervised", null, { finalState: result.finalState });
      } else {
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

        // The effects the SQLite leg builds inside runComposedSqliteWalk,
        // built here for the mode that hands the port to the endpoint itself.
        const effectsInput: WalkEffectsInput = {
          port,
          route,
          ledger: openedLedger,
          invocation,
          taskId: options.taskId,
          attempt: options.attempt,
          emittedBy: options.emittedBy,
          ...instructionFor(openedLedger, options.envelope),
          scenarioRoot,
          generation: landing.generation,
          gate,
        };
        const effects = buildWalkEffects(effectsInput);

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
          // The one walk construction, per walk (P-13, escalón 2): the same
          // runComposedSqliteWalk the singular form calls, over this walk's own
          // ledger, invocation, envelope, lease and gate. One law, two callers
          // — and the same named context type at both.
          const walkInput: ComposedSqliteWalkInput = {
            ledger: held.ledger,
            invocation: held.invocation,
            execution: walk.spec.execution,
            envelope: walk.envelope,
            scenarioRoot: walkRoot,
            worktreePath: walk.worktreePath,
            port: walkPort,
            route,
            generation: landing.generation,
            landed: landing.landed,
            hold: heldLease.hold,
            gate: walkGate,
            ...instructionFor(held.ledger, walk.envelope),
            taskId: walk.spec.taskId,
            attempt: walk.spec.attempt,
            emittedBy: walk.spec.emittedBy,
            initiativeId: walk.spec.initiativeId,
          };
          const result = await runComposedSqliteWalk(walkInput);
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

// The bounded stop and terminate wrappers — and the singleton lock resource
// they unwind beside — live in `./usecases/index.ts`. They are re-exported
// here, without compatibility shims, because the barrel and the suites import
// them from the composition module, which is where the root they wrap lives.
export { stopDaemon, terminateDaemon } from "./usecases/index.js";


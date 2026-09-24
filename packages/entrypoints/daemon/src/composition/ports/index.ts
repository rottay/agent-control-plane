/**
 * The composed ports of the Agent Control Plane daemon (P-13, escalón 2).
 *
 * Every seam the composition root closes over a live dependency lives here:
 * the CLI adapter table and the per-binding admission of the execution port,
 * the switch port over the lease this process holds, the write-set conformance
 * gate, and the checkpoint source and store. Each builder takes its
 * dependencies explicitly and returns the closed surface the walk or the root
 * hands on; nothing here opens a ledger, spawns a child or reads a config.
 *
 * `conformanceGateFor` deliberately precedes `executionPortFor` in this file:
 * the name and that position are load bearing for `L-C-4b`, which slices the
 * region between the two declarations and asserts a violation is recorded and
 * stopped, never cleaned.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Checkpoint, Lease, ModelExecutionPort, TaskEnvelope } from "@acp/contracts";
import { CONTRACT_VERSION } from "@acp/contracts";
import type { Ledger } from "@acp/ledger";
import { createCheckpointStore } from "@acp/ledger";
import type {
  AgentHarness,
  ApiKeyBinding,
  ApiStreamingClient,
  CliBinding,
  LocalBinding,
  LocalChatClient,
  ProviderAdapter,
} from "@acp/providers";
import {
  AdapterError,
  admitBinary,
  admitConfigRoot,
  admitWorkdir,
  claudeAdapter,
  codexAdapter,
  createAnthropicMessagesClient,
  createExecutionPort,
  createLocalChatClient,
  kimiAdapter,
} from "@acp/providers";
import type {
  CheckpointPort,
  CheckpointRefused,
  CheckpointSource,
  DurableInvocation,
  LedgerPort,
  PlanStep,
  SwitchPort,
  WorktreeObservation,
} from "@acp/runtime";
import {
  OUTCOME_STEP,
  checkWriteSetConformance,
  considerSwitch,
  deriveEventCoordinate,
  deterministicUuid,
  payloadCoordinate,
  resolveCredential,
} from "@acp/runtime";

import type { DaemonExecutionBinding, DaemonExecutionConfig } from "../../daemon-child/index.js";
import { StartupError } from "../../errors/index.js";
import { createGitObserver, observeWorktree } from "../../git-observer/index.js";

/** The CLI adapters, by the provider name a resolved route carries. */
const CLI_ADAPTERS: Readonly<Record<string, ProviderAdapter>> = Object.freeze({
  claude: claudeAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
});

/**
 * The CLI entries of a config, which are the only ones a switch can name.
 *
 * A destination is identified by the provider it speaks, and an API entry
 * declares none — the injected client does (D3). So the account-switch plane
 * reads this rather than the whole array: an API entry is not a destination
 * missing a field, it is a different shape.
 */
export function cliBindingsOf(
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
export function bindingForRoute(execution: DaemonExecutionConfig): DaemonExecutionBinding {
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
 * early return; the `runSqliteMode({` literal keeps its `switchPort:` member
 * and the lease beside it, which is the shape the enforcement law reads and
 * the reason it is still able to read it.
 *
 * The destinations are the bindings' own declared providers (V2-B1f/F2b), so
 * the unlandable-destination refusal costs no import and no `describe` call.
 */
export function switchPortFor(input: {
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

/** The digest of no bytes: what a tracked deletion is worth (§2.3). */
function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

      // The OUTCOME's key as the walk derived it: V1's for an inline walk, the V2
      // key under a revision (P-15 escalón D3), from the one coordinate producer.
      const recorded = input.ledger.getEventByIdempotencyKey(
        deriveEventCoordinate(input.invocation, OUTCOME_STEP.transitionId, OUTCOME_STEP.index).idempotencyKey,
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
export function checkpointsFor(input: {
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
export function conformanceGateFor(input: {
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
          // Under a revision the key is V2 and the payload carries the coordinate
          // it names (P-15 escalón D3); under V1 the coordinate is empty and the
          // payload is exactly what it was.
          payload: { ...payload, ...payloadCoordinate(input.invocation) },
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

/** The HTTP clients a config's non-CLI entries are served by, by account. */
export interface TransportClients {
  readonly apiClientFor: (accountId: string) => ApiStreamingClient | undefined;
  readonly localClientFor: (accountId: string) => LocalChatClient | undefined;
}

/**
 * Compose the real HTTP clients a config names (P-15 escalón E, ADR 0108; L-P15E-3).
 *
 * **The one place a credential closure is received.** For an `API_KEY` entry, and a
 * local entry whose `auth` is `CREDENTIAL`, the runtime's resolver reads the
 * account's credential from the owner's credentials file — derived beside
 * `execution.accountsFile`, never configured — once, here, at composition. The
 * admitted closure is handed straight to one factory and kept nowhere else: not on
 * the config, the bindings, the port, the ledger, the status document or a log
 * line. A refusal stops the start before anything is appended, naming the account
 * and the resolver's closed word and path — never a byte of either file.
 *
 * **No accounts file, no credential and no client.** A config the door admitted
 * carries it whenever an entry needs it; a hand-built one without it leaves such an
 * entry unbound, and the port refuses the account (R6's N1, unchanged). An injected
 * `apiClientFor` replaces the composed API clients whole, without a resolver call.
 */
export function transportClientsFor(
  execution: DaemonExecutionConfig,
  injectedApiClientFor?: (accountId: string) => ApiStreamingClient | undefined,
): TransportClients {
  const api = new Map<string, ApiStreamingClient>();
  const local = new Map<string, LocalChatClient>();
  const credentialFor = (accountId: string): (() => string) | null => {
    if (execution.accountsFile === undefined) return null;
    const resolution = resolveCredential({ accountsFile: execution.accountsFile, accountId });
    if (!resolution.ok) {
      throw new StartupError(
        "the credential for " + accountId + " was refused: " + resolution.refusal + " at " + resolution.at,
      );
    }
    return resolution.credential;
  };
  for (const entry of execution.bindings) {
    if (entry.transportKind === "API_KEY") {
      if (injectedApiClientFor !== undefined) continue;
      const credential = credentialFor(entry.accountId);
      if (credential === null) continue;
      api.set(
        entry.accountId,
        createAnthropicMessagesClient({
          models: entry.models,
          maxTokens: entry.maxTokens,
          timeoutMs: entry.limits.timeoutMs,
          credential,
        }),
      );
    } else if (entry.transportKind === "LOCAL_OR_SELF_HOSTED") {
      let credential: (() => string) | null = null;
      if (entry.auth === "CREDENTIAL") {
        credential = credentialFor(entry.accountId);
        if (credential === null) continue;
      }
      local.set(
        entry.accountId,
        createLocalChatClient({
          baseUrl: entry.baseUrl,
          provider: entry.provider,
          models: entry.models,
          timeoutMs: entry.limits.timeoutMs,
          credential,
        }),
      );
    }
  }
  return Object.freeze({
    apiClientFor: injectedApiClientFor ?? ((accountId: string): ApiStreamingClient | undefined => api.get(accountId)),
    localClientFor: (accountId: string): LocalChatClient | undefined => local.get(accountId),
  });
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
export function executionPortFor(
  execution: DaemonExecutionConfig,
  taskId: string,
  harness: AgentHarness,
  apiClientFor?: (accountId: string) => ApiStreamingClient | undefined,
  localClientFor?: (accountId: string) => LocalChatClient | undefined,
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
  // P-15/E: the local transport, on the API map's law -- always passed, and an
  // account nobody composed a client for is unbound, refused at `route.accountId`.
  const localBindings = new Map<string, LocalBinding>();
  for (const entry of execution.bindings) {
    if (entry.transportKind !== "LOCAL_OR_SELF_HOSTED") continue;
    const client = localClientFor?.(entry.accountId);
    if (client === undefined) continue;
    localBindings.set(entry.accountId, { client });
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
  return createExecutionPort({ bindings, apiBindings, localBindings, harness });
}

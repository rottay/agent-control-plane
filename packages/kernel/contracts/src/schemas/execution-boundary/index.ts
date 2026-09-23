/**
 * The owned execution boundary — `@acp/contracts` (P8-T G6).
 *
 * The owned execution port: transports, routes, refusals and events.
 *
 * Subdivided in place from the single `schemas/index.ts`, which is now a pure
 * re-export barrel. Nothing here was rewritten: the definitions are the file's
 * own, moved under the band heading they already carried.
 */

import { z } from "zod";
import {
  CONTENT_BLOCK_KINDS,
  CONTENT_BLOCK_LIST_MAX,
  CONTENT_REQUEST_AGGREGATE_MAX_BYTES,
} from "../content-block/index.js";
import {
  RepoRelativePath,
  Sha256Hex,
  Timestamp,
  Uuid,
} from "../primitives/index.js";
import { ControlPlaneEventType } from "../control-plane-event/index.js";
// The status vocabulary of an operation's result has one home, the result
// contract; the port's `operationResult` reads it rather than restating it
// (P-07 escalón C, ADR 0099, L-P07A-1 amended).
import { RESULT_STATUSES } from "../result/index.js";
import { WorkerIdentityString } from "../worker-identity/index.js";
import type { HealthProbe } from "../worker-slot/index.js";

/**
 * How a route reaches a model.
 *
 * Closed at three, in the owner ruling's own order: the subscription-backed
 * CLI transports the control plane runs on today, provider API calls, and the
 * local or OpenAI-compatible transports that come later. A fourth kind is a
 * contract change, not a configuration value.
 */
export const TRANSPORT_KINDS = ["CLI_SUBSCRIPTION", "API_KEY", "LOCAL_OR_SELF_HOSTED"] as const;

export const TransportKind = z.enum(TRANSPORT_KINDS);
export type TransportKind = z.infer<typeof TransportKind>;

/**
 * The providers a `CLI_SUBSCRIPTION` route may name.
 *
 * Declared here because this package imports nothing from `@acp/*` and every
 * other package imports it: one list, one home, no drift between the router's
 * idea of a provider and an adapter's. The adapters' own `ProviderName` is
 * re-pointed at this vocabulary in the packet that binds them, which is the
 * only lawful direction — adapters already depend on contracts.
 *
 * Sorted, and pinned as a list by a test rather than by membership, so a name
 * cannot be added or dropped without the pin moving.
 */
export const CLI_SUBSCRIPTION_PROVIDERS = ["claude", "codex", "kimi"] as const;

/**
 * What a provider said about its own willingness to keep serving an account.
 *
 * Declared here for the reason the provider list above gives — one list, one
 * home, no drift — and exported as a bare list with no companion type, so each
 * consumer spells the union locally against its own vocabulary rather than
 * importing a second name for the same five strings.
 *
 * The members are an **observation** vocabulary, not a decision one. They say
 * what a provider reported; whether that warrants moving a task is the router's
 * judgement, and `SWITCH_TRIGGERS` stays a separate, narrower set for exactly
 * that reason. `TRANSIENT` and `UNCLASSIFIED` are what make it structurally
 * impossible for a merely-failed or unrecognised frame to arrive at a quota
 * destination.
 *
 * Deliberately absent from the shape: every number. No remaining count, no
 * ratio, no reset instant, no limit, no retry-after — so "never fabricate
 * remaining quota" is a property of the vocabulary rather than a rule someone
 * has to remember. `ACCOUNT_QUOTA_UNPUBLISHED` and `RESET_UNKNOWN` stay the
 * only answers to "how much is left" and "when does it come back".
 */
export const PROVIDER_PRESSURES = [
  "AUTH_REQUIRED",
  "QUOTA_EXHAUSTED",
  "QUOTA_WARNING",
  "TRANSIENT",
  "UNCLASSIFIED",
] as const;

/**
 * The eleven steps a switch is made of, as the plan names them.
 *
 * Declared here because this package imports nothing from `@acp/*` and every
 * other package imports it — the reason the provider list above gives. The
 * decision module owns the same eleven as its own `SWITCH_STEPS`, and the two
 * may never drift: the architecture fence is the only reader of both files and
 * compares them by equality in both directions.
 *
 * A plan is always a prefix-free selection from this list **in this order** —
 * never a reordering, never an invention.
 */
export const SWITCH_STEP_NAMES = [
  "MARK_ACCOUNT_DRAINING",
  "MARK_TASK_QUOTA_BLOCKED",
  "FINISH_CURRENT_ATOMIC_STEP",
  "WRITE_CHECKPOINT",
  "RELEASE_LEASE",
  "SELECT_ACCOUNT",
  "READ_ONLY_HEALTH_PROBE",
  "OPEN_FRESH_SESSION",
  "REVALIDATE_AUTHORITY_AND_PRESTATE",
  "REHYDRATE_CHECKPOINT",
  "CONTINUE",
] as const;

/**
 * A decided switch plan, as a value crossing a process boundary.
 *
 * The decision module's `SwitchPlan` shape, restated here as a schema so a
 * plan an operator wrote into a configuration document can be **admitted**
 * rather than trusted. It is deliberately not a re-declaration of the
 * decision: nothing here decides anything, and the fence pins the two member
 * sets equal so a plan that parses is a plan that module could have produced.
 *
 * Every collection is bounded, because this shape crosses a door an operator
 * authors: eleven steps is the whole vocabulary, and a plan carrying more
 * events than there are steps is not a plan.
 */
export const SwitchPlanShape = z.strictObject({
  kind: z.enum(["DRAIN", "SWITCH", "ESCALATE"]),
  accountStatus: z.enum(["DRAINING", "EXHAUSTED", "COOLDOWN", "AUTH_REQUIRED"]),
  taskState: z.enum(["QUOTA_BLOCKED", "AUTH_REQUIRED"]).nullable(),
  steps: z.array(z.enum(SWITCH_STEP_NAMES)).max(SWITCH_STEP_NAMES.length),
  /** The account the router chose, or null when no selection was made. */
  selectedAccountId: z.string().min(1).max(80).nullable(),
  events: z
    .array(
      z.strictObject({
        type: ControlPlaneEventType,
        /** Bounded, string-valued, and never a transcript or a credential. */
        payload: z.record(z.string().min(1).max(80), z.string().max(200)),
      }),
    )
    .max(SWITCH_STEP_NAMES.length),
});
export type SwitchPlanShape = z.infer<typeof SwitchPlanShape>;

/**
 * A switch that has already been decided, admitted through the same door as
 * the route it applies to.
 *
 * **The walk never decides.** Routing needs an accounts file, a policy
 * document and a `RoutingRequest`, and the process that walks a task holds
 * none of them and is forbidden all three. So a switch reaches a walk exactly
 * as its route does — as data an elector decided, an operator wrote into the
 * configuration document, and the daemon's own door admitted by path. This
 * shape is what that door admits.
 *
 * The audit block is what makes the decision answerable after the fact: who
 * decided, when, against which account, on which trigger, and from which
 * recorded pressure row.
 *
 * **`decidedAt` is audit, not policy.** Nothing expires an authorization on
 * it: how old a decision may be before it stops meaning anything is a routing
 * judgement, and the walk may not make one. What it buys is that a row a
 * reader finds later can be aged.
 */
export const SwitchAuthorization = z.strictObject({
  /** The trigger this plan was decided for. Nothing else may fire it. */
  trigger: z.enum(["QUOTA_EXHAUSTED", "QUOTA_WARNING"]),
  /** The account it was decided against; it must equal the route's. */
  decidedForAccountId: z.string().min(1).max(80),

  /** The elector's own identity — a machine identity, never a person. */
  decidedBy: WorkerIdentityString,
  /** When the decision was taken. The elector's clock, never the walk's. */
  decidedAt: Timestamp,
  /** The recorded pressure row that prompted it, so the decision is traceable. */
  decidedFromEventId: Uuid,
  /** The instant the elector measured pressure from, so the window is legible. */
  observedSince: Timestamp,

  /** The decision module's output, verbatim and admitted. */
  plan: SwitchPlanShape,
});
export type SwitchAuthorization = z.infer<typeof SwitchAuthorization>;

/**
 * Why an execution boundary refused a route.
 *
 * Closed and sorted, like every other refusal vocabulary here. A refusal is
 * the only lawful answer to a route the transport cannot serve: the port never
 * reroutes, never substitutes a model and never invents a fallback, so every
 * way of saying "not this one" has to be a name the caller can exhaust.
 */
export const EXECUTION_REFUSALS = [
  "CAPABILITY_UNSUPPORTED",
  /**
   * A plain start named an execution that is already running.
   *
   * Added by V2-B4a, when a boundary first became able to hold a live session
   * by name. Before it, the case could not arise: the port forgot a session
   * the moment its stream ended, so a second start under the same name found
   * nothing and spawned. Now it finds a child, and none of the other four
   * names is true of what happened — the transport is available, the route is
   * valid, no capability is missing. The alternatives to a refusal are to
   * spawn a second child under one name, or to hand back the live one as if a
   * fresh execution had begun; the first is the duplication this vocabulary
   * exists to prevent, and the second is the silent rejoin that mirrors the
   * silent restart law 3 already forbids.
   */
  "EXECUTION_IN_FLIGHT",
  "REATTACH_UNAVAILABLE",
  "ROUTE_INVALID",
  "TRANSPORT_UNAVAILABLE",
] as const;

export const ExecutionRefusal = z.enum(EXECUTION_REFUSALS);
export type ExecutionRefusal = z.infer<typeof ExecutionRefusal>;

/**
 * A resolved route: provider, model, account, transport and the policy version
 * that chose them.
 *
 * The route is **final**. An adapter executes exactly this and nothing else —
 * it does not default a missing field, pick a neighbouring model when the named
 * one is busy, or quietly downgrade a transport. `capabilityPolicyVersion`
 * records which generation of the capability registry produced the choice, so
 * a route can be explained after the fact without re-running the router.
 */
export const ResolvedRoute = z
  .strictObject({
    provider: z.string().min(1).max(40),
    /** The routing alias the DT scheduled against, not the provider's exact resolution. */
    model: z.string().min(1).max(60),
    accountId: z.string().min(1).max(80),
    transportKind: TransportKind,
    capabilityPolicyVersion: z.string().min(1).max(80),
    resolvedAt: Timestamp,
  })
  .superRefine((value, ctx) => {
    // A CLI route names one of the CLI providers. Other transport kinds carry
    // an opaque provider segment, because a local or API-backed transport may
    // legitimately name something this list has never heard of.
    if (
      value.transportKind === "CLI_SUBSCRIPTION" &&
      !(CLI_SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value.provider)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "a CLI_SUBSCRIPTION route must name one of the CLI subscription providers",
        path: ["provider"],
      });
    }
  });
export type ResolvedRoute = z.infer<typeof ResolvedRoute>;

/**
 * What a running execution said, normalized.
 *
 * This is the transport-neutral superset of the landed provider signal and no
 * richer: every variant is either a signal an adapter already emits or the
 * minimum a non-CLI transport needs to say the same things. A provider utterance
 * this union cannot express is a STOP escalated to the DT, never a reason to
 * widen it quietly.
 *
 * `started` carries the echoed route **and** the provider's own resolution.
 * They are deliberately both present: `route.model` is the alias the router
 * chose, `resolvedModel` is what the provider actually bound, and comparing
 * them is the evidence that no adapter silently substituted a model.
 *
 * **Three facts, never fused** (contratos §4.2; P-07 escalón C, ADR 0099).
 * `completed` is transport success and nothing more. `processExited` is how the
 * child process ended, and `operationResult` is what the operation itself said.
 * Neither of the two is terminal; when present they come in that order, before
 * the one terminal (`completed` or `error`). An absent `processExited` means the
 * exit was not observable — never exit 0 — and an absent `operationResult` means
 * the operation's verdict was not observed.
 *
 * **Output text does not cross here.** The union carries no output bytes: they go
 * to the caller's private `ExecutionOutputSink`, and whatever the sink receives
 * enters no event.
 */
export const ExecutionEvent = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("started"),
    route: ResolvedRoute,
    /** The provider's exact resolution of `route.model`. */
    resolvedModel: z.string().min(1).max(120),
    protocolVersion: z.string().min(1).max(40),
  }),
  z.strictObject({
    kind: z.literal("toolUse"),
    tool: z.string().min(1).max(80),
    /** Bounded, structured, and never the tool's whole output. */
    detail: z.string().max(2_000),
  }),
  /**
   * A write-class action, normalized. Safety-critical: the enforcement plane
   * depends on seeing writes at this boundary, and the landed signal documents
   * it fatal for a reviewer identity.
   */
  z.strictObject({
    kind: z.literal("write"),
    target: RepoRelativePath,
  }),
  /** The session machine's transition, as the transport reports it. */
  z.strictObject({
    kind: z.literal("state"),
    toState: z.string().min(1).max(40),
  }),
  z.strictObject({
    kind: z.literal("usage"),
    /** Step ordering is carried, so usage can be folded in the order it happened. */
    stepIndex: z.number().int().nonnegative().max(100_000),
    tokensUsed: z.number().int().nonnegative().max(100_000_000),
  }),
  z.strictObject({
    kind: z.literal("checkpoint"),
    digest: Sha256Hex,
  }),
  z.strictObject({
    kind: z.literal("authRequired"),
    reason: z.string().min(1).max(200),
  }),
  /**
   * What the provider said about the account's standing, classified.
   *
   * Carries its own `provider` because the value that matters is the adapter
   * that classified the frame, not a second reading taken later at another
   * layer. Only CLI adapters classify pressure, so the member names the CLI
   * vocabulary; a transport that acquires the evidence to classify its own
   * pressure moves this member on purpose.
   *
   * Three closed scalars and nothing else: there is no field a remaining
   * count, a reset instant or a retry-after could occupy.
   */
  z.strictObject({
    kind: z.literal("pressure"),
    provider: z.enum(CLI_SUBSCRIPTION_PROVIDERS),
    pressure: z.enum(PROVIDER_PRESSURES),
  }),
  z.strictObject({
    kind: z.literal("error"),
    /** Classified, never a raw provider message. */
    refusal: ExecutionRefusal,
    detail: z.string().max(400),
  }),
  z.strictObject({
    kind: z.literal("completed"),
    /** The last step the transport reported, for reconciliation against usage. */
    stepIndex: z.number().int().nonnegative().max(100_000),
  }),
  /**
   * How the child process ended, as observed: its exit code **or** the signal
   * that ended it, exactly one of the two. Not terminal. Only a transport that
   * owns a process can observe it; absent, the exit was not observable.
   */
  z
    .strictObject({
      kind: z.literal("processExited"),
      exitCode: z.number().int().min(0).max(255).nullable(),
      signal: z.string().max(16).regex(/^SIG[A-Z0-9]+$/).nullable(),
    })
    .superRefine((value, ctx) => {
      if ((value.exitCode === null) === (value.signal === null)) {
        ctx.addIssue({
          code: "custom",
          message: "a process ends with an exit code or a signal, exactly one of the two",
          path: ["exitCode"],
        });
      }
    }),
  /**
   * What the operation itself said about its outcome, in the result contract's
   * vocabulary and nothing else: no vendor token, no bytes, no digest. Not
   * terminal.
   */
  z.strictObject({
    kind: z.literal("operationResult"),
    status: z.enum(RESULT_STATUSES),
  }),
]);
export type ExecutionEvent = z.infer<typeof ExecutionEvent>;

/**
 * What the caller hands the port besides the route.
 *
 * Task coordinates, the identity the work is attributed to, the instruction the
 * model is to act on, and — optionally — a reference to an execution already in
 * flight. Transport-specific budgets, binaries and working directories are not
 * here: those belong to the adapter that owns the transport, and putting them in
 * the owned boundary would make this contract change every time a transport did.
 */
/** The block kinds a composition may report, from escalón A's closed vocabulary. */
const ContentBlockKindSchema = z.enum(CONTENT_BLOCK_KINDS);

/**
 * How long an instruction may be, in characters (P-06/C, ADR 0095).
 *
 * `4_000` while the instruction was one envelope field, because that is what
 * `TaskEnvelope.objective` carries and a second, looser bound would have been a place
 * for the two to disagree. Since P-06/C the instruction is **composed** from the text
 * blocks of a content list, so the figure that governs is the content contract's own:
 * a list may hold up to `CONTENT_BLOCK_LIST_MAX` blocks, each text block up to
 * `CONTENT_INLINE_TEXT_MAX_CHARS`, and the composition writes them one after another.
 *
 * The bound moves to the aggregate the request contract already admits rather than to
 * the arithmetic product, because tests §9.6 rule 1 governs where these numbers meet:
 * when a policy already in force is more restrictive, the policy in force wins, and
 * `CONTENT_REQUEST_AGGREGATE_MAX_BYTES` is the ceiling a request's content was already
 * held to at the door. Over it is a **contract refusal**, never a truncation.
 *
 * Moving it is not a bump: `ExecutionRequest` carries no `contractVersion` (it is a
 * port shape, not an issued instrument), so no version moves for this number.
 */
export const INSTRUCTIONS_MAX_CHARS = CONTENT_REQUEST_AGGREGATE_MAX_BYTES;

export const ExecutionRequest = z.strictObject({
  taskId: Uuid,
  attempt: z.number().int().positive().max(10_000),
  identity: WorkerIdentityString,
  /**
   * What the model is being asked to do (V2-B1c).
   *
   * Required, and bounded by {@link INSTRUCTIONS_MAX_CHARS} — the aggregate the
   * content contract already holds a request to, for the reason that constant's
   * own docblock gives. It was `TaskEnvelope.objective`'s `max(4_000)` while the
   * instruction was that one field; since P-06/C it is composed from the text
   * blocks of a content list, and the bound follows the value rather than the
   * field it used to come from. Over the bound is a **contract refusal**, never a
   * truncation: an adapter that shortened an instruction would be inventing a
   * policy about what the model was asked, which is the one thing no transport
   * may decide.
   *
   * The field is write-only in the plane's sense. It crosses exactly one
   * boundary — this process to the child — and enters no ledger row, event
   * payload, stream frame, telemetry attribute, checkpoint, status document or
   * log line. Not even as a digest: the plane records that work was asked for,
   * not what was said.
   */
  instructions: z.string().min(1).max(INSTRUCTIONS_MAX_CHARS),
  /**
   * The distinct block kinds the instruction was composed from (P-06/C, ADR 0095).
   *
   * Classes only — never a block, never its bytes, never a digest. It exists so a
   * transport can refuse a class it cannot carry **before a process exists**, which
   * §4.1 `:202-203` and `:228-232` ask for and which a pure `describe` cannot do
   * without seeing something. Handing it the blocks instead would put content on the
   * public side of the adapter boundary, and `:199-201` forbids that.
   *
   * Non-empty, and in practice always containing `"text"`: escalón A's contract
   * refuses a content list with no text block, so an instruction always says
   * something.
   */
  modalities: z.array(ContentBlockKindSchema).min(1).max(CONTENT_BLOCK_LIST_MAX),
  /**
   * An execution to rejoin rather than start. Null is the ordinary case.
   *
   * A transport that cannot honor the reference **refuses**, classified as
   * `REATTACH_UNAVAILABLE`; it never silently starts a fresh execution in its
   * place. Reconnection is exactly where a silent restart would be most
   * expensive and least visible, so the no-silent-fallback law is stated here
   * rather than assumed.
   */
  reattach: z.string().min(1).max(200).nullable(),
});
export type ExecutionRequest = z.infer<typeof ExecutionRequest>;

/**
 * Where an execution's output text goes: the private side of the boundary
 * (P-07 escalón C, ADR 0099).
 *
 * The sink receives output text only, delta by delta and in order. It carries no
 * instruction and no metadata, and whatever it receives enters no event. It is an
 * argument of `start`, never a field of `ExecutionRequest`, because a request is a
 * strict object the ledger may see and output bytes are not.
 */
export type ExecutionOutputSink = (delta: string) => void;

/** A refusal from the boundary, carrying a closed reason and where it failed. */
export interface ExecutionRefused {
  readonly ok: false;
  readonly refusal: ExecutionRefusal;
  /** The field or capability that failed. Never provider output. */
  readonly at: string;
}

/**
 * A live execution, as the boundary exposes it.
 *
 * The event stream is the only channel: a caller learns what happened by
 * reading normalized events, never by inspecting a transport handle.
 */
export interface ExecutionSession {
  readonly ok: true;
  /** Stable for the life of the execution; the value a later `reattach` names. */
  readonly sessionId: string;
  readonly route: ResolvedRoute;
  events(): AsyncIterable<ExecutionEvent>;
}

/**
 * The owned execution boundary.
 *
 * Every transport — subscription CLI, provider API, local model — implements
 * this and nothing wider. The laws it exists to hold:
 *
 * 1. **The route is executed, not interpreted.** `start` runs exactly the
 *    provider, model, account and transport the route names. It never selects
 *    a model, never retries onto another route, and never invents a fallback.
 *    A route it cannot serve is an `ExecutionRefused` with a closed reason.
 * 2. **Events are normalized at the boundary.** What crosses is
 *    `ExecutionEvent`, identical in shape whichever transport produced it, so
 *    the control plane's routing, evidence and recovery never learn a
 *    transport's dialect.
 * 3. **Reattachment is explicit or refused, and so is its mirror.**
 *    `request.reattach` either rejoins that execution or produces
 *    `REATTACH_UNAVAILABLE`. Starting fresh while a caller believes it
 *    reattached is the one failure this boundary must never produce silently
 *    — and the mirror is equally forbidden: a plain start naming an execution
 *    already in flight produces `EXECUTION_IN_FLIGHT`, never a second child
 *    under one name and never the live one handed back as though it were new.
 *    A transport that cannot hold a live execution by name cannot reach the
 *    second case; one that can must refuse it.
 * 4. **The port holds no authority.** Routing, role selection, account and
 *    quota policy, leases, conflict detection, checkpoints and evidence stay
 *    with the control plane. A transport adapter is a mouth, not a mind.
 */
export interface ModelExecutionPort {
  /**
   * Begin, or rejoin, an execution on exactly this route.
   *
   * `sink`, when given, receives the execution's output text, delta by delta,
   * and nothing else (P-07 escalón C, ADR 0099).
   */
  start(
    route: ResolvedRoute,
    request: ExecutionRequest,
    sink?: ExecutionOutputSink,
  ): Promise<ExecutionSession | ExecutionRefused>;
  /** Ask a running execution to stop. Idempotent; never kills a foreign process. */
  interrupt(sessionId: string): Promise<void>;
  /** Read-only reachability, for the transport this port serves. */
  healthProbe(route: ResolvedRoute): Promise<HealthProbe>;
}

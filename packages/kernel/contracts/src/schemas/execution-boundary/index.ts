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
  RepoRelativePath,
  Sha256Hex,
  Timestamp,
  Uuid,
} from "../primitives/index.js";
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
 * Why an execution boundary refused a route.
 *
 * Closed and sorted, like every other refusal vocabulary here. A refusal is
 * the only lawful answer to a route the transport cannot serve: the port never
 * reroutes, never substitutes a model and never invents a fallback, so every
 * way of saying "not this one" has to be a name the caller can exhaust.
 */
export const EXECUTION_REFUSALS = [
  "CAPABILITY_UNSUPPORTED",
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
    kind: z.literal("text"),
    /** One delta, as it arrived. Never an accumulated transcript. */
    delta: z.string().max(16_384),
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
]);
export type ExecutionEvent = z.infer<typeof ExecutionEvent>;

/**
 * What the caller hands the port besides the route.
 *
 * Task coordinates, the identity the work is attributed to, and — optionally —
 * a reference to an execution already in flight. Transport-specific budgets,
 * binaries and working directories are not here: those belong to the adapter
 * that owns the transport, and putting them in the owned boundary would make
 * this contract change every time a transport did.
 */
export const ExecutionRequest = z.strictObject({
  taskId: Uuid,
  attempt: z.number().int().positive().max(10_000),
  identity: WorkerIdentityString,
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
 * 3. **Reattachment is explicit or refused.** `request.reattach` either
 *    rejoins that execution or produces `REATTACH_UNAVAILABLE`. Starting fresh
 *    while a caller believes it reattached is the one failure this boundary
 *    must never produce silently.
 * 4. **The port holds no authority.** Routing, role selection, account and
 *    quota policy, leases, conflict detection, checkpoints and evidence stay
 *    with the control plane. A transport adapter is a mouth, not a mind.
 */
export interface ModelExecutionPort {
  /** Begin, or rejoin, an execution on exactly this route. */
  start(route: ResolvedRoute, request: ExecutionRequest): Promise<ExecutionSession | ExecutionRefused>;
  /** Ask a running execution to stop. Idempotent; never kills a foreign process. */
  interrupt(sessionId: string): Promise<void>;
  /** Read-only reachability, for the transport this port serves. */
  healthProbe(route: ResolvedRoute): Promise<HealthProbe>;
}

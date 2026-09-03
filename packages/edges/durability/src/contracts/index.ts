import type { DurableInvocation } from "@acp/runtime";
import type { Context, WorkflowContext, WorkflowSharedContext } from "@restatedev/restate-sdk";

/**
 * The contracts that belong to the Restate edge, not to the domain (P8-T G5).
 *
 * These four types lived in `domains/runtime/src/contracts` until the split.
 * Every one of them has only Restate-side consumers, and one of them —
 * `DurableStepContext` — is the repository's single type-level coupling to the
 * SDK outside the drivers themselves. Leaving it in the domain is what kept
 * `@restatedev/restate-sdk` in runtime's import surface: a domain package
 * cannot be SDK-free while one of its contracts is a `Pick<>` of an SDK type.
 *
 * The port itself does **not** live here. `OrchestrationDriver`,
 * `DurableInvocation`, the coordinates, beats and probes stay in
 * `@acp/runtime`, because the domain is what declares the shape a driver must
 * satisfy and the edge is what satisfies it. An edge that owned the port would
 * be an edge implementing itself.
 */

/**
 * The Restate context narrowed to what the durability plane is allowed to use.
 *
 * A driver that only ever holds this type cannot reach the rest of the SDK
 * surface by accident. Widening it is a deliberate edit to this line.
 */
export type DurableStepContext = Pick<Context, "run" | "rand" | "date">;

/**
 * The durable gate, and where its names live (V2-B2-5).
 *
 * SIGNAL is a dedicated internal Restate **Workflow**, not a handler on
 * `AcpTask`. The reason is the one the signal-design adjudication gave: a
 * workflow's named durable promise is engine state keyed by the workflow key,
 * so a signal that arrives BEFORE anything waits is still delivered, whereas an
 * awakeable identifier does not exist until a handler has executed to it and a
 * signal arriving first would be permanently lost. In production the resolver
 * and the waiter are independent processes and their order is not ours to
 * guarantee, so a design with that race is a design with a defect.
 *
 * It is also why `AcpTask` is untouched. Waiting inside an EXCLUSIVE object
 * handler would hold the task key for the whole wait, so `advance` for that
 * task would queue behind an unresolved gate — turning the per-task
 * serialization B2-3 certified into something indistinguishable from a
 * deadlock.
 *
 * **Two homes, stated rather than hidden.** The pre-existing `RESTATE_*`
 * constants live in `packages/domains/runtime/src/constants/index.ts`, which is
 * split residue from before P8-T G5 moved this edge out of the domain. These
 * new names are declared HERE, edge-local, because that is the smaller change
 * and the more correct home: a domain package should not name an engine's
 * services. Unifying the two is owed work and is deliberately not this
 * packet's; naming it is.
 */
export const RESTATE_WORKFLOW_GATE = "AcpGate";

/** The gate's blocking handler: it awaits the promise and returns. */
export const RESTATE_HANDLER_GATE_RUN = "run";

/**
 * The gate's release handler, which must be SHARED.
 *
 * Shared so it never holds the key it is releasing. An exclusive resolver would
 * queue behind the very `run` it exists to unblock, which is the same mistake
 * as waiting inside `AcpTask` and fails the same way.
 */
export const RESTATE_HANDLER_GATE_RESOLVE = "resolve";

/** The one named durable promise a gate holds. */
export const RESTATE_GATE_PROMISE = "acpGate";

/**
 * What a release carries: that it happened, and nothing else.
 *
 * A closed literal rather than caller content, so no prompt, transcript, tool
 * argument or provider payload can ride into engine state through this door.
 */
export interface GatePayload {
  readonly released: true;
}

/**
 * The gate's blocking context, narrowed to the one member it uses.
 *
 * A separate narrowing rather than a widening of `DurableStepContext`, because
 * the two have nothing in common: the step context is what the ADVANCE walk may
 * touch, and adding a member for a wait that walk never performs would hand
 * every future step access to a suspension point nothing asked for.
 *
 * `promise` is a named durable promise addressed by the WORKFLOW KEY, which is
 * `deriveInvocation`'s output. Nothing here is engine-minted, so unlike an
 * awakeable identifier there is no value to discover, keep or leak.
 */
export type GateRunContext = Pick<WorkflowContext, "promise">;

/** The release side of the same narrowing, over the shared context. */
export type GateResolveContext = Pick<WorkflowSharedContext, "promise">;

/**
 * The Virtual Object's entire durable state.
 *
 * A CACHE, never a fact. Both fields are copies of something the ledger already
 * knows, and deleting all of it loses nothing: the data-root-deletion drill
 * exists to prove exactly that. Nothing may be added here without an ADR,
 * because a field that is NOT derivable from the ledger would make Restate a
 * second authority, whatever the documents say.
 */
export interface RestateCacheState {
  readonly lastAppliedSequence: number;
  readonly lastAppliedEventSha256: string;
}

/** Everything the Restate driver needs to reach a ledger and a server. */
export interface RestateDriverOptions {
  readonly ledger: LedgerLike;
  readonly invocation: DurableInvocation;
  readonly emittedBy: string;
  /** Loopback ingress base, e.g. `http://127.0.0.1:8080`. */
  readonly ingressUrl: string;
  /** Loopback admin base, e.g. `http://127.0.0.1:9070`. */
  readonly adminUrl: string;
  /** Reads the object's cache through a shared handler, never admin state. */
  readonly readCache?: (() => Promise<RestateCacheState | null>) | undefined;
}

/**
 * The ledger surface the driver reads.
 *
 * Structurally satisfied by `Ledger`; declared here so this file stays free of
 * a value import and the driver cannot reach a mutator it was never given.
 */
export interface LedgerLike {
  status(): {
    readonly headSequence: number;
    readonly headEventSha256: string;
    readonly eventCount: number;
  };
  verifyIntegrity(): { readonly ok: boolean; readonly problems: readonly unknown[] };
  getEventBySequence(sequence: number): { readonly eventSha256: string } | null;
}

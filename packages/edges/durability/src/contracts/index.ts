import type { DurableInvocation } from "@acp/runtime";
import type { Context } from "@restatedev/restate-sdk";

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

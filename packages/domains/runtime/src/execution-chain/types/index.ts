/**
 * The value types of the execution chain (P-15 escalón D3, ADR 0105; decision 140).
 *
 * What the chain is built from and what it hands the effect port: the
 * declarations this concept owns, in the concept's own leaf rather than
 * interleaved with the chain (owner law `docs/audit/architecture/index.md` §7; the
 * recorded-task leaf is the precedent).
 *
 * A pure type leaf: it declares data and nothing else, and imports only types.
 */

import type { ResolvedRoute, UsageSourceClass } from "@acp/contracts";
import type { ArtifactPlane, Ledger } from "@acp/ledger";

import type { DurableInvocation } from "../../contracts/index.js";
import type {
  ChainConfirmation,
  DeliverySink,
  IntentionSink,
  StreamSink,
} from "../../execution-effects/index.js";
import type { ResultSink } from "../../operation-result/index.js";

/**
 * Everything one recorded walk's chain is recorded against.
 *
 * Every field is a value the composition already holds, and nothing is read from
 * a clock: the chain's instants are the invocation's (`submittedAt`, the intake
 * door's instant, ND-D3-3).
 */
export interface ExecutionChainInput {
  readonly ledger: Ledger;
  /** The private plane the result is published through, under the task's scope. */
  readonly plane: ArtifactPlane;
  /** A revision-bearing invocation. A V1 invocation has no chain, and is refused. */
  readonly invocation: DurableInvocation;
  /** The final route: the provider, alias, account and transport the segment records. */
  readonly route: ResolvedRoute;
  /** The model version the intake resolved the task on. The segment is RESOLVED to it. */
  readonly modelVersionId: string;
  /** The routing assignment the intake resolved through, or null. */
  readonly routingAssignmentId: string | null;
  /** The `PRICE_TABLE` document the delivery is pinned against. Named by the config, never defaulted. */
  readonly catalogDocumentId: string;
  /** The adapter's usage source, as it declared it once: the stream's static facts. */
  readonly usageSource: {
    readonly source: string;
    readonly sourceClass: UsageSourceClass;
    readonly normalizationPolicySha256: string;
  };
  /** The composed instruction's digest and length, from the one composer. The bytes never travel. */
  readonly prompt: {
    readonly promptSha256: string;
    readonly promptBytes: number;
  };
  readonly emittedBy: string;
  /** The process holding the publication's blob lease. */
  readonly holderPid: number;
}

/** The chain's hooks, in the shapes `createExecutionEffects` takes them. */
export interface ExecutionChain {
  readonly recordIntentions: IntentionSink;
  readonly recordDelivery: DeliverySink;
  readonly recordStream: StreamSink;
  readonly recordResult: ResultSink;
  readonly confirmChain: ChainConfirmation;
}

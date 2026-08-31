import { CONTRACT_VERSION } from "@acp/contracts";

/**
 * Version of the read-only observation API.
 *
 * This is deliberately a different number from the control plane contract
 * version that `@acp/contracts` stamps on every ledger event. The two version
 * lines move for different reasons and must never be conflated:
 *
 * - `CONTRACT_VERSION` changes when the durable meaning of a ledger event
 *   changes. A change there is a change to recorded history.
 * - `API_CONTRACT_VERSION` changes when the shape a browser or a CLI receives
 *   changes. A change here costs a redeploy of two readers and nothing else.
 *
 * Pinning them together would force a false coupling in both directions: a
 * cosmetic field rename in a DTO would look like a ledger migration, and a
 * genuine ledger migration would look like a UI change. Every response carries
 * both numbers so a reader can tell which one moved.
 *
 * `0.1.0` → `0.2.0` at P8-8A: the initiative data plane adds three routes and
 * their response shapes. **Additive** — no existing route, field or type
 * changed, so a reader pinned to the older shapes still reads every response
 * it read before. The minor moves rather than the patch because new surface is
 * new contract, and a reader that wants to know whether the initiative routes
 * exist should be able to ask this number rather than probe for a 404.
 */
export const API_CONTRACT_VERSION = "0.2.0" as const;
export type ApiContractVersionLiteral = typeof API_CONTRACT_VERSION;

/**
 * The control plane contract version this API surface is pinned to.
 *
 * Re-exported under an explicit name so a consumer never has to guess whether
 * a bare `CONTRACT_VERSION` referred to the ledger or to the API.
 */
export const LEDGER_CONTRACT_VERSION = CONTRACT_VERSION;
export type LedgerContractVersionLiteral = typeof CONTRACT_VERSION;

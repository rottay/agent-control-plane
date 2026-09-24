/**
 * The effect outcome vocabulary — `@acp/contracts` (P-15 escalón F, ADR 0107).
 *
 * How a logical effect turned out: execution §6's `effect_outcome_status`. It was
 * the ledger's, which recorded it and was its only reader. The result read now
 * answers it on the wire, and the protocol that shapes that answer may import
 * contracts but not the ledger. So the set moves down to the one package every
 * consumer can reach, on P-15/D2's mould for the usage vocabularies: one
 * declaration, the ledger re-exports it under the same name, and the SQL CHECK
 * that has always spelled the four words is unchanged (decision 151).
 *
 * `OUTCOME_UNKNOWN` is **not** a failure: it is a recorded uncertain exposure, it
 * does not license a blind retry, and it is never the default of creation — an
 * intention never dispatched carries `null`, which is absence of data
 * (execution §6 `:252`).
 *
 * Data only. The derived union lives in the leaf, `./types/index.ts`.
 */

export type { EffectOutcomeStatus } from "./types/index.js";

/** The four outcomes of a logical effect, in the order the ledger has always listed them. */
export const EFFECT_OUTCOME_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"] as const;

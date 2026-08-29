/**
 * Public surface of the Agent Control Plane accounts domain.
 *
 * This is P5A and P5B: the owner-file loader, the admission law, the read-only
 * registry, and the quota estimator with its reset calendar. The router and the
 * switching policy arrive in P5C and P5D and are not exported yet.
 *
 * Importing this module has no side effects. `loadAccountsFile` reads when it
 * is called, and only then, from a path the caller supplies — there is no
 * default path anywhere in this package and no environment variable is
 * consulted, including `HOME`.
 *
 * Nothing here resolves a credential. `authProfileRef` and `credentialRef` are
 * opaque locators that this package carries and never dereferences; the
 * material they name stays outside this repository in P5 and in every phase
 * this package can reach.
 *
 * Nothing here writes. `@acp/ledger` is a declared dependency because P5D reads
 * quota observations from it; the architecture fence asserts that no production
 * source in this package contains an append.
 *
 * Nothing here reads a clock. The quota estimator takes the current instant as
 * an injected parameter at every entry point, so an estimate depends on what it
 * was given rather than on when it ran.
 */

export type { AccountsRefusal, AccountsRefused } from "./errors/index.js";
export { ACCOUNTS_REFUSALS } from "./errors/index.js";

export type { AccountsFile, AccountsRegistry, LoadOutcome } from "./registry/index.js";
export {
  ACCOUNTS_FILE_KEYS,
  ACCOUNTS_FILE_MAX_BYTES,
  buildRegistry,
  loadAccountsFile,
} from "./registry/index.js";

// P5B: quota estimation and the reset calendar. Pure, clock-injected, and
// refusing rather than defaulting when the data to estimate from is absent.
export type {
  QuotaEstimate,
  QuotaEstimateInput,
  QuotaOutcome,
  QuotaRefusal,
  QuotaRefused,
  ResetCalendar,
  ResetOutcome,
  TokenObservation,
} from "./quota/index.js";
export {
  CONFIDENCE_ORDER,
  OBSERVATIONS_MAX,
  QUOTA_REFUSALS,
  TOKENS_USED_MAX,
  estimateQuota,
  resetCalendar,
  weakerConfidence,
} from "./quota/index.js";

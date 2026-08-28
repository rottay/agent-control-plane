/**
 * Public surface of the Agent Control Plane accounts domain.
 *
 * This is P5A: the owner-file loader, the admission law and the read-only
 * registry. Quota estimation, the router and the switching policy arrive in
 * P5B, P5C and P5D and are not exported yet.
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
 */

export type { AccountsRefusal, AccountsRefused } from "./errors.js";
export { ACCOUNTS_REFUSALS } from "./errors.js";

export type { AccountsFile, AccountsRegistry, LoadOutcome } from "./registry/index.js";
export {
  ACCOUNTS_FILE_KEYS,
  ACCOUNTS_FILE_MAX_BYTES,
  buildRegistry,
  loadAccountsFile,
} from "./registry/index.js";

/**
 * Token accounting bounds — `@acp/contracts` (P8-T G7, D2).
 *
 * One ceiling for a reported token count, shared by every plane that validates
 * one. `@acp/accounts`, `@acp/observation` and `@acp/providers` each declared
 * `10_000_000` locally, and the accounts copy carried a comment explaining that
 * the other two existed and could not be reached — an accurate description of a
 * topology problem, and a durable invitation to drift.
 *
 * `contracts` is the only legal home. Accounts cannot govern it: an
 * `observation → accounts` import would be a domains→domains edge the layer law
 * refuses, so the constant has to sit below all three consumers rather than
 * inside one of them. That is the DRY ruling's "narrowest context that governs
 * every consumer", and here the narrowest such context is the kernel.
 *
 * The bound is a **contract**, not a tuning knob: the same number appears in
 * `.max(10_000_000)` inside the token schemas, and a validator that disagreed
 * with the schema it guards would accept what the ledger then refused.
 */

/** Upper bound on a single reported token count. */
export const TOKENS_USED_MAX = 10_000_000;

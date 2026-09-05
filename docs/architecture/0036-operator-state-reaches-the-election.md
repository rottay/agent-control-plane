# ADR 0036 — A recorded operator action reaches the election

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The roadmap gives the operator four verbs against an account — *"Acciones:
`drain`, `account-ready`, `reauth-required` y override del owner"* — over the
state vocabulary `AVAILABLE | DRAINING | EXHAUSTED | COOLDOWN | AUTH_REQUIRED`
(`docs/ROADMAP.md:257`, `:291`). P8-8G packet 2 built the door that records them
and the fold that derives which source governs, and the gateway's read model
published the result.

The election never read any of it.

`runSubmission` held a query-only `Ledger`, built its registry from the owner
file alone and read the recorded usage V2-B1d taught it to read — and never
touched `account_events`. So an operator could drain an account, watch the read
model report `DRAINING`, and have the very next `acp submission` elect that same
account. The decision was recorded, visible, and inert.

The fold that would have answered the question lived in
`packages/entrypoints/gateway/src/account-actions/index.ts`, typed over
`@acp/ledger`'s row projection. The CLI may not import the gateway, so there was
no lawful route to it: the only way to make the election honour a recorded
action was to write the authority law a second time. Two folds of one law are
two answers to "which state governs", differing on the day one of them is
edited.

## Decision

**The fold moves to `@acp/accounts` and is re-typed to the kernel's event.**
`foldEffectiveState` now lives in `packages/domains/accounts/src/operator-state/`
and takes `readonly AccountActionEvent[]` rather than
`readonly AccountActionRecordRow[]`. The reason is the package's own import law:
`ACCOUNTS_ALLOWED_PACKAGES` is `{@acp/contracts}`, so this package may not name a
ledger. It is the same adjustment `usageObservationsFrom` made in V2-B1d, for
the same reason — arithmetic on one side of the boundary, acquisition on the
other.

**Nothing about the law changed.** Precedence is exactly what it was: the file's
state is the baseline, any recorded action overrides it, `history.at(-1)` wins,
an empty history returns `stateSource: "OWNER_FILE"` with `lastAction: null`,
and a later owner-file edit does not reclaim authority from an earlier action.
`ACCOUNT_ACTION_STATE` is untouched. `resultingState` is **read, never
recomputed** — the event carries the state its action produced, checked by the
contract's own refinement when it was recorded; deriving it again would put one
policy in two places, and `OWNER_OVERRIDE`, whose state comes from the request
rather than from the verb, could not be derived at all.

**The gateway keeps a delegating wrapper, not a copy.**
`gateway/src/account-actions/index.ts` still exports `foldEffectiveState` over
the ledger's row type; its whole remaining body unwraps `row.event` and calls
the domain fold. Both existing call sites — `recordAccountAction` and
`overlayFor` in the accounts read model — keep their signatures, and no wire
schema, route, response field or error code moves.

**The acquisition half is `readAccountActions` in `@acp/runtime`**, sibling to
`readAccountUsage` and there for the same reason. It takes a structural
`ActionEventSource` port, so the real `Ledger` is assignable and a fake can
drive the ceiling without appending ten thousand rows.

**The election overlays the folded state onto `record.status`, and adds no
eligibility rule.** This is the load-bearing choice. A drained account is
already refused by `estimateQuota`'s `ACCOUNT_NOT_AVAILABLE`
(`accounts/src/quota/index.ts:453-454`) and, independently, by the router
(`accounts/src/routing/index.ts:798-800`); both refuse anything whose `status`
is not `AVAILABLE`. Feeding the folded state into the field those checks already
read makes a recorded `DRAIN` bite through the rules that were already there —
which keeps ADR 0035 §3.1a's admission parity true **by construction** rather
than by a second rule that could drift from the first. A bespoke CLI eligibility
check would have been the drift.

**`listAccountActions` shapes the ceiling into a refusal.** The ledger's read is
account-filtered in SQL (`WHERE account_id = ?`), ordered by the per-account
monotone counter (`ORDER BY version ASC`) and **unpaginated**. Exhaustiveness
therefore holds by construction: there is no cursor and no partial-history
state. `ACCOUNT_ACTIONS_MAX = 10_000` is declared in
`accounts/src/operator-state/` beside the fold that consumes the history. Ten
thousand is three orders of magnitude above any plausible operator history and
three orders *below* `OBSERVATIONS_MAX` (100 000); the two numbers differ
because they bound different things — that one bounds a machine-generated usage
stream, this one a hand-written log.

Above the ceiling the reader returns
`{ ok: false, reason: "ACTION_HISTORY_EXCEEDED", at }` — an inline **domain**
refusal, deliberately not a `QuotaRefusal` member, because an action-history
ceiling is not a quota fact and `QUOTA_REFUSALS` stays at thirteen. It is **a
refusal and never a truncation**: folding a prefix would silently resurrect an
older state, and truncating the newest end would be worse, since the newest row
is the one that decides. The CLI maps it fail-closed, mirroring V2-B1d's usage
reader: `failure(EXIT_UNAVAILABLE, "LEDGER_UNAVAILABLE", …, read.at)`.

**Missing, unreadable or corrupt evidence never widens eligibility.** A ledger
that cannot be opened already fails at the existing query-only open above
`runSubmission`; through the CLI black box only `LEDGER_OPEN` and
`LEDGER_MIGRATION` are reachable there, and both map through the existing
`fromLedgerError` table, unchanged. A **corrupt action row** throws a `ZodError`
from `AccountActionEvent.parse` inside the ledger, not a `LedgerError`, and
`fromUnknownError` routes it through `issuePaths` to `EXIT_INTERNAL`. That is
already fail-closed and is **deliberately not reclassified**: inventing a
`LedgerError` for a schema failure would misreport a data defect as a database
one. In every case the election refuses. **No path falls back to the owner
file**, because "the history could not be read" is not the same fact as "the
ledger records no action" — only the second one means the owner file stands.

**One declared asymmetry.** The gateway route reads the ledger directly
(`gateway/src/routes/index.ts:729`, `:775`), not through `readAccountActions`,
so it is not subject to `ACCOUNT_ACTIONS_MAX`. Above the ceiling the CLI
election **refuses** while the read model **reports what the ledger holds**.
That is deliberate, and it sits beside ADR 0035's CLI/gateway asymmetry for the
same reason: the CLI is deciding and must not act on evidence it cannot fully
read, while a read model's job is to show the operator what is recorded.

**The overlaid record is an in-memory view, never re-parsed or persisted.**
`buildRegistry` (`accounts/src/registry/index.ts:279-292`) freezes and indexes
without re-validating, so a `REAUTH_REQUIRED` overlay can sit beside a non-null
published ratio — a combination the contract's own refinement forbids
(`account-record:109`). It is harmless because both admissions refuse on status
first, and it is stated here so that nobody later writes such a record back to a
file.

**The relocation is recorded here rather than in `G1_MOVE_MAP`, and the map
stays at 302.** Two independent reasons. The map "stays frozen, being G1's
record and not G7's" (`check-architecture.mjs:3123`). And law (a) derives retired
prefixes from the first two segments of each pair's old path, so a pair whose
old path is `packages/entrypoints/gateway/src/account-actions/index.ts` would
retire `packages/entrypoints/` and fail every tracked file under it. Besides,
the gateway file does not move: it stays as a delegating wrapper, and a move-map
entry would record a relocation that did not happen. What guarantees no second
copy is `L-V2B1E-1`, a shape predicate over production `src`.

## Why a second fold in the CLI was not chosen

It was the shortest route: the CLI already reads the ledger, and eight lines
would have folded the history in `runSubmission`. It was rejected because the
two folds would answer the same question and only one of them would be edited
next time. The failure would be silent and would show up as the read model and
the election disagreeing about whether an account was drained — which is
precisely the class of defect this packet exists to close, reintroduced one
layer down.

The alternative of leaving the fold in the gateway and letting the CLI import it
is not available: the entrypoint import law does not open one entrypoint to
another, and widening it for this would trade a duplicated function for a
structural hole.

A bespoke eligibility check in the CLI — "refuse an account whose newest action
is a `DRAIN`" — was rejected for a different reason. It would have worked, and
it would have been a *third* statement of the admission rule beside the
estimator's and the router's, free to drift from both. The overlay was chosen
because it adds no rule at all.

## Consequences

- A recorded `DRAIN` makes an account ineligible for the **very next**
  submission. `ACCOUNT_READY` restores it, and `OWNER_OVERRIDE` carries its own
  state, because the newest row wins.
- The CLI election and the gateway read model derive effective state through one
  implementation, so they cannot disagree.
- `ACCOUNTS_PUBLIC_EXPORTS` moves 73 → 76 (`foldEffectiveState`,
  `EffectiveState`, `ACCOUNT_ACTIONS_MAX`) and `RUNTIME_PUBLIC_EXPORTS` 228 →
  230 (`readAccountActions`, `ActionEventSource`). `PATH_SCOPED_LAWS` moves
  93 → 94 for `L-V2B1E-1`.
- `G1_MOVE_MAP` stays at 302, and every other pinned count — `CONTRACT_VERSION`
  2.2.0, `API_CONTRACT_VERSION` 0.13.0, `QUOTA_REFUSALS` 13, `ACCOUNT_ACTIONS`
  4, the route and migration counts — is unchanged.
- An account whose history exceeds ten thousand rows can no longer be elected at
  all until the ceiling is revisited. That is the intended direction of failure,
  and it is reachable only by an operator history three orders of magnitude
  larger than any this plane has seen.

## Not in this record

No new eligibility rule, and no change to `quota/index.ts` or `routing/index.ts`.
No new contract, route, wire field, error code, event type, migration or
persistence path. No `G1_MOVE_MAP` entry. No UI or console change. No capability
leaves `UNKNOWN`, and nothing here spawns a provider, opens a socket or spends.
Plural account bindings, a `quotaPressure` provider signal, per-account
concurrency ceilings and reset-calendar recurrence remain out of scope, as does
Packet C's switch chain.

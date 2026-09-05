# ADR 0035 — The router reads the usage the ledger recorded

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The roadmap's quota-aware routing line says the router weighs *"cuota restante y
proximidad del reset"* and must not start a long packet on an account without
estimated margin. A router weighing a constant weighs nothing, and that margin
rule cannot hold over a figure that is always the full limit.

It was always the full limit. `estimateQuota`'s accumulation loop never ran,
because both production callers passed `observations: []` — the CLI election and
the gateway read model — so `used = 0`, `remaining = limitTokens`, and
`remainingRatio = 1` for every account, from zero evidence. `QuotaObservation`
had no producer anywhere in `src`.

The data was there the whole time. `TOKEN_USAGE_RECORDED` carries
`{accountId, tokens}`, the parsed event carries `occurredAt`, and `listEvents`
filters by type and paginates with an exclusive cursor. Nothing was missing
except the reading.

**The decisive detail, and the one an earlier draft got wrong.** The router does
not read `remainingRatio`. It gates and scores exclusively on
`estimatedTokensRemaining`, and says so in its own source. A fix that moved only
the ratio would have left the router ranking on exactly the constant it always
had, while looking correct.

## Decision

The estimate is **the owner's published baseline minus the spend the ledger
recorded since that baseline was published**, and the field the router actually
reads is the one that moves.

**The anchor is `quotaEstimate.estimatedAt`, and the comparison is strict.** The
window's *start* is not derivable: `resetSchedule` carries an END instant and no
period, `resetCalendar` says as much, and `estimateQuota`'s own docblock already
admitted it "cannot filter to 'this window' because it does not know when the
window began". So the anchor is the instant the owner's published position was
true. A row at exactly that instant is already inside the baseline and is
excluded; only `occurredAt > estimatedAt` counts. Summing from ledger genesis
was the alternative, and it would subtract last window's spend from this
window's limit for ever — the mirror of the defect being closed, and just as
silent.

**Baseline precedence: the exact token count beats the ratio.** When both
published values are non-null and disagree, `estimatedTokensRemaining` is the
baseline. A count is the thing the router spends; a ratio is a rounding of it.

**A published count above the named limit is capped, not trusted.** The contract
bounds `estimatedTokensRemaining` only as a non-negative integer, and nothing
cross-checks it against `knownLimits`, so a contract-valid owner file may claim
more tokens remaining than the limit allows. Taken at face value the derived
ratio then exceeds 1, which the wire contract refuses — `AccountsResponse`'s
`remainingRatio` is `min(0).max(1)` — so an owner's typo became a 500 from the
accounts route rather than a figure anyone could read.

Capping is the fail-safe direction, and refusing was the alternative. An account
reported with at most its own limit remaining can only be elected *less* often,
never more; refusing it outright would take the account out of every election
over a figure the owner may simply have overstated. Exact-token precedence is
preserved wherever the count is within range: the cap is a ceiling on the
baseline, not a replacement for it, and the delta is subtracted from the capped
figure.

**Admission is untouched, and that is load-bearing.** A `null` `remainingRatio`
refuses `ACCOUNT_QUOTA_UNPUBLISHED` **whatever the token count says**. The
estimator and the router refuse on the same field today, and this record
requires them to stay identical by construction: had token precedence been
allowed to *admit*, the gateway would publish a figure for an account the CLI
election refuses. Token precedence is a baseline rule only, applied after
admission. The router's source is deliberately outside this packet's write-set,
so the estimator cannot be relaxed unilaterally.

**The ratio is derived from the post-delta token count**, not computed beside
it, so the two published representations of one fact cannot drift apart.
`overBudget` compares the delta against the baseline and stays truthful
independently of the clamp at zero.

**Zero rows need no special case.** A delta of zero yields exactly the published
position, in both representations. An earlier draft had a separate zero-evidence
rule and it produced a discontinuity: zero rows reported one figure and a single
ten-token row flipped the estimate to nearly the full limit.

**Excluded versus refused, because the directions are not symmetric.** Skipping
a row under-counts spend, which over-reports remaining quota — the one direction
this packet exists to close. So a row for a *different* account is excluded
silently, and a row with a missing or non-string `accountId` is **refused**:
absence of attribution is not attribution elsewhere. A malformed or
out-of-range token count is refused, never skipped.

**The reader is exhaustive or it refuses.** There is no truncated success. It
pages `listEvents` by cursor until `hasMore` is false, and a page that throws
propagates rather than returning a partial sum.

**`OBSERVATIONS_MAX` counts filtered per-account rows, never plane-wide.**
`EventQuery` has no account filter, so a plane-wide ceiling would refuse every
election permanently once the ledger held that many usage rows across all
accounts combined — a monotone, silent, plane-wide failure. The row scan itself
is bounded only by the ledger's size, and that is stated rather than implied:
the cost is one query per thousand usage events, and the correctness bound is on
what is kept.

## Why the reader lives in `@acp/runtime`

`@acp/accounts` may import only `@acp/contracts`, so it cannot read a ledger,
and that boundary is worth keeping: the estimator's job is arithmetic over
evidence, not the acquisition of it. `@acp/runtime` already owns the usage
vocabulary and writes the very events being read, and its import allowlist
already admits both `@acp/ledger` and `@acp/accounts`. So the fold is a pure
function in the domain that owns the vocabulary, and the paging is in the module
that owns the events.

The reader takes a **structural** `UsageEventSource` rather than the `Ledger`
class, so the per-account ceiling and the paging can be driven by a fake without
appending a hundred thousand real rows. Its `type` parameter is the contract's
own closed event-type union rather than a bare string, because a wider parameter
would make the real `Ledger` unassignable to the port a structural seam exists
to accept.

## Why the sixteenth path was needed

The accepted brief authorized fifteen paths. `@acp/accounts` publishes exactly
one entry point and its barrel is an explicit named list with no `export *` — a
form the fence enforces — so the fold was unreachable from `@acp/runtime` until
the barrel named it. Reported at the write-set boundary and authorized before
any edit; the addition is one value export, `usageObservationsFrom`, with the
outcome written as an inline union so the surface grows by exactly one.
`ACCOUNTS_PUBLIC_EXPORTS` moved 72 → 73 and `RUNTIME_PUBLIC_EXPORTS` 226 → 228,
both inside the already-authorized fence path.

## Consequences

**`--database` is now required for `acp submission`.** The verb used to branch
above the `--database` law under a comment saying it opened no ledger, so
requiring one "would require a thing it never touches". This packet makes that
comment false: the election now weighs recorded usage. The branch moved below
the law and takes the ledger that function already opened query-only, rather
than performing a bespoke open — one law, one open. Ledger failures map through
the existing per-subclass table (`LEDGER_OPEN` → 5, `LEDGER_MIGRATION` → 5,
`LEDGER_INTEGRITY` → 6, `LEDGER_QUERY` → 2), not a blanket exit 5.

**Four stale comments were corrected**, each of which this packet or an earlier
one falsified: the CLI's "it opens no ledger"; the CLI's "no observations are
supplied, so the estimate is the record's own published position"; the gateway
reader's "the spend-derived estimate is the ledger's story, told by the
initiative plane"; and the gateway module header's "the one route on this plane
whose source is not the ledger".

That last one was the most misleading of the four, because it had been false
since before this packet. The route has read the ledger for **action history**
since P8-8G, and now reads it for **recorded usage** as well. The header says so:
the owner file is the *baseline*, and the ledger contributes action history and
usage observations on top of it, both through optional sources so a caller with
no ledger still gets the owner file's own position.

**The CLI and gateway are deliberately asymmetric.** Both call one reader and
one fold, so parity is structural rather than asserted. The gateway's source is
**optional** — that read model may be asked without a ledger, and absent means
"file only", the honest answer when nobody asked. The CLI's is **not**: it is
electing an account and must not elect on absent evidence.

**A refusal is never coerced to zero observations.** Zero observations now means
"the published position stands", and a failed scan is not that fact. The CLI
raises a classified failure; the gateway's route lets a real `LedgerClosedError`
reach the classifier, which answers 503 — a plain `Error` would have answered
500, so the fixture constructs the real class.

**A stale `estimatedAt` under-reports, in the fail-safe direction.** If the
owner file's baseline was published before the window rolled over, the delta is
subtracted from a stale baseline and the account reads as having less margin
than it has. The router may decline to elect it; it will never over-elect. The
failure mode is a missed election, never an overrun, which is why no freshness
check is added here.

**The account-actions locator deliberately keeps zero action history.**
`readAccounts` is called without one when locating an account, so it takes the
zero-history path and returns the file's own state. That is correct for
*locating* — a ledger with no recorded action has nothing to add — and a later
packet relies on it.

## Not in this record

- **Packet B** (operator state reaching the election) and **Packet C** (the
  switch chain).
- **Any freshness check on `estimatedAt`**, plural account bindings, a
  `quotaPressure` provider signal, per-account concurrency ceilings, and
  reset-calendar recurrence.
- **Any capability leaving `UNKNOWN`.** Nothing here contacts a provider, spawns
  a process, opens a socket or spends.
- **A new refusal, event type, migration, route, error code or contract
  version.** `QUOTA_REFUSALS` stays at thirteen.

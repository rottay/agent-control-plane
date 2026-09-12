# ADR 0075 — Every coordination store names its own incarnation

- Status: accepted (P-18/protocolo escalón E1, recorded 2026-09-12).
- Supersedes: none.
- Superseded-by: none.
- Amends: nothing. ADR 0074 stated that "the lease and claim stores get their
  metadata and their `store_incarnation_id` in E1" and left N-P18-11 closed by
  half. This record closes the other half and completes that deferral rather
  than revising it.

## Context

Coordination §8.1 says every coordination file carries its own
`coordination_store_meta`: one row, a `store_kind` out of a closed dictionary of
five, an incarnation and the instant that incarnation began. It also says what
the metadata is *for*: the lease token is the pair `(store_incarnation_id,
fence)`, the claim token is the incarnation plus `claim_id`, and "no se acepta
un token viejo porque coincida su número con uno recreado" (§8.1 `:393-394`,
restated in datos §11 `:579`).

Three facts made E1 a different packet from E2, which built the outbox.

**The number always repeats.** A lease `fence` restarts at 1 on a file created
fresh, a claim id is replayed verbatim into a rebuilt file, and an outbox row is
born at version 0. In each case a token held from before a restore matches a
rebuilt record in every term either of them has. §8.1's instrument is the only
thing that separates them, and until this record neither the lease store nor the
claim store had it.

**These two stores were shipped, and they have adopters.** `lease-store` landed
with V2 C1 and was adopted by C2/C3/C4; `tool-claim-store` landed with X1a and
was adopted by X1b at both tool-call doors. Migration 1 of each is immutable —
its checksum is compared against this source on every open, and a file whose
history this build does not carry refuses to open at all. So the metadata cannot
come first here the way it does in the outbox, and the live tables cannot gain a
`NOT NULL` column.

**Nothing in the field supplies an incarnation.** `daemon/src/composition`,
`cli/src/tool-call` and `gateway/src/tool-calls` all open these stores with no
options at all. Whatever this record decides about the signature of `open`, it
decides for callers this escalón is not allowed to touch.

## Decision

**One.** Both stores gain `coordination_store_meta` as **migration 2** in their
own migration list, behind the table it governs, with the five-kind `CHECK` of
§8.1, `CHECK(singleton_id = 1)`, `UNIQUE (store_incarnation_id)` and no default
on either the incarnation or its instant. Neither store touches the ledger's
migration list, which describes a different database.

**Two.** Both stores gain an additive, nullable `store_incarnation_id` on the
live table. The lease store also gains `operation_id` and
`revocation_acknowledged_at` — coordination §3's columns, declared here and
written by **no verb of this module**. Escalón F owns the intention that
correlates a grant and the acknowledgement that answers a revocation; a store
that stamped an operation id would be claiming an intention it cannot read. The
suite asserts the absence over the four statements that mutate the table, not
over the file, so the declaration itself does not read as a write.

**Three.** The incarnation is **stamped by every grant** — the first `GRANT` and
the re-grant, the first `TAKE` and the reclaim — with the value read inside the
write lock. `RELEASE`, the sweep, `MARK_IN_FLIGHT` and `SETTLE` name the column
in no `SET` clause and therefore conserve it: releasing a lease is not granting
one, and a stamp that moved on a state change would make the token a moving
target.

**Four.** `incarnationId` and `createdAt` are **optional** arguments to `open`,
supplied together or not at all, and never generated. Supplied on a file with no
metadata, they are registered. Supplied on a file that already has metadata, the
stored row stands and they are unused: rotating an incarnation is coordination
§8.2's blocked restore, not a side effect of reopening. **Absent, nothing is
registered and nothing is refused** — and refusing at runtime because the
metadata is missing is forbidden by name. That window is declared in the
consequences below.

**Five.** `transact` takes an optional `expectedToken` — `{incarnationId,
fence}` in the lease store, `{incarnationId, claimId}` in the claim store —
compared **inside** the write lock, against the metadata as it stands and the
record as it stands, **before** `decide` is consulted. A mismatch answers
`REFUSE` as a return value. The incarnation is compared first, and `L-P18E1-3`
pins that order over all three stores. No adopter passes a token, and no adopter
changes.

**Six.** A file whose metadata declares another store's kind is refused at
`open`, before a handle exists. A file whose metadata *becomes* another store's
after the handle opened raises `LedgerIntegrityError` on the next read of it.
The refusal is reachable because the `CHECK` carries all five kinds rather than
only the one each file uses.

**Seven.** The lease store adopts X1a's **rule-shaped** wrong-file guard
alongside its existing list. The list alone let a lease store opened on a
sibling's file create `lease_schema_migrations` there with a bare `db.exec`,
fail later in migration 2 on a `coordination_store_meta` that was already there,
and leave the sibling carrying a foreign table its own guard then refuses
forever. Both guards now run **before** anything is written.

**Eight.** `store_kind` is the authority on what a coordination file is, and the
filename is not. Coordination §1 calls the lease file `worktree-leases.sqlite`
and the tree calls it `leases.sqlite`; neither is renamed. ADR 0074 stated this
reading and this record applies it to both live stores.

**Nine.** Three fence laws, scoped to all three coordination stores rather than
to one file each: `L-P18E1-1` (every store carries the metadata, with the whole
dictionary, and registers its own kind and no other's), `L-P18E1-2` (no store
mints an identity), `L-P18E1-3` (every token names an incarnation, and the store
reads it before the number).

## Why the required signature was not chosen

E2's `openOutboxStore` takes `incarnationId` and `createdAt` as **required**
arguments, and the obvious symmetry would be to do the same here. It was not
chosen, and the reason is not style.

`pnpm check` typechecks the whole monorepo. Required options would break
`daemon/src/composition/index.ts` at two call sites, `cli/src/tool-call/index.ts`,
`gateway/src/tool-calls/index.ts`, the `lease-race-worker` fixture inside this
package's own suite, and thirteen further call sites across the daemon, CLI and
gateway suites — none of them in this escalón's write-set. Adopting them is a
packet: it has to decide where a daemon's incarnation comes from, when it
changes, and what a CLI invocation that is not a daemon supplies. That is the
adoption half, and C1→C2 and X1a→X1b are the standing precedent for landing the
substrate first.

A third variant was considered and is **forbidden**: optional arguments, but a
runtime refusal when the file carries no metadata and none was supplied. It
passes the typechecker and stops the daemon the first time it opens
`leases.sqlite`. A cost that a typechecker cannot see and a field deployment can
is the worst of the three.

## Why the metadata was not backfilled into migration 1

Editing migration 1 to include `coordination_store_meta` and a `NOT NULL`
incarnation would give both stores the outbox's shape exactly. It would also
change migration 1's checksum, and every store in the field compares that
checksum on open: every existing `leases.sqlite` and `tool-claims.sqlite` would
refuse to open, naming a migration history this build does not carry. A schema
change is a new version appended to the end — the same law the ledger keeps, for
the same reason — and the suite pins version 1's digest as a literal so that an
edit fails a test rather than a deployment.

## Why the token refusal is a value and not an exception

Zero rows changed is a refusal the caller must act on, so the outbox returns
`CONFLICT`; a token from another incarnation is the same kind of fact, so
`transact` returns `REFUSE`. The ledger README's thirteen error classes do not
move for this escalón, which is the standing rule of this package: everything a
caller must act on is a refusal *value*.

It is also why the gate runs **before** `decide`. A stale token is a
precondition that failed, not a policy that declined — so the caller's decision
is never consulted, and a decision that would have written cannot. The suite
asserts that directly, by failing if `decide` runs at all.

## Consequences

- `PATH_SCOPED_LAWS` is **127**. `assertPathScopedInventory` fails printing both
  numbers if the register and the call sites disagree.
- **§8.1 `:373` is not in force in the field, and this record is where that is
  written down.** The daemon, the CLI and the gateway open these files without
  an incarnation, so grants and claims stamp `NULL` and no token is ever
  compared. What is proven today is proven in this package's suite. The window
  closes when a packet makes those three callers supply an incarnation and its
  instant — which is where "persistida antes de emitir tokens" becomes a fact
  about `leases.sqlite` rather than about `openLeaseStore`.
- Rows written before this escalón read back with `store_incarnation_id IS
  NULL`, are released, swept, marked in flight and settled exactly as before, and
  are stamped with the live incarnation by the next grant or reclaim. §4 `:153`
  wants `NOT NULL` for grants of the active incarnation, and that is what a grant
  writes; a `NOT NULL` **constraint** would have to wait for a packet that can
  prove no legacy row survives.
- **A rollback past this escalón cannot open these files.** A store migrated to
  version 2 is refused by a build that carries only version 1 — "migration 2 is
  applied but this build does not carry it" — which is the fail-closed rule
  working as designed and is nonetheless a real cost. It is the price of never
  editing a shipped migration, and it applies to `leases.sqlite` and
  `tool-claims.sqlite` the moment a build carrying this record opens one. Losing
  either file costs liveness and no evidence, so the remedy is to delete it and
  let the older build create it again — which is exactly the loss §8.2 is about,
  and exactly why the incarnation exists.
- N-P18-11 is closed. The outbox half landed with ADR 0074; the lease and claim
  halves are here, each with the token shape §8.1 gives it — and the claim's
  carries **no fence**, because a claim has no counter and a test that invented
  one would prove something else.
- The full retrofit of coordination §3 `:90-107` is **not** here and is a packet
  of its own: the `BEFORE INSERT` and `BEFORE UPDATE` validators, the fence rule
  with its four cases, and the compare-and-set by expected token per verb. ADR
  0074 already deferred it; this record does not narrow the deferral and does not
  widen it. Nothing about the lease fence's arithmetic changed.
- §8.1's "cada archivo de coordinación" is now satisfied over **three** of the
  five files it names and remains **partial** over `account_reservation` and
  `artifact_blob_lease`, which exist in no escalón of this packet.
- The three laws are scoped to the set of coordination stores rather than to one
  file each, so a fourth store added later inherits them. That is deliberate and
  it has a cost: adding a coordination store now means adding it to
  `COORDINATION_STORES` in the fence, and a store that is not listed is a store
  no law covers.
- Nothing calls the token gate. `expectedToken` is exercised by this package's
  suite and by nothing else, which is the same state `cas` was left in by E2.

## Not in this record

Who mints an incarnation and when it changes — that is the adoption packet named
above. The six-step recovery procedure of coordination §8.2, with its quiescence
proof, which is P-18/recuperación and is blocked; what is here is the instrument
step 5 needs, not the procedure. `operation_id` and `revocation_acknowledged_at`
are declared here and filled by escalón F, along with the events that correlate
a grant with its intention. The fence rule of §3 `:90-107`, as above. Whether
`worktree-leases.sqlite` is ever the filename: `store_kind` is the authority, so
the question is one of tidiness rather than of correctness, and renaming a live
arbiter's file costs liveness to buy nothing.

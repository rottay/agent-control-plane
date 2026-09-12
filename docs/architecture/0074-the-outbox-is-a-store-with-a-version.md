# ADR 0074 — The outbox is a store with a version, before it is a queue

- Status: accepted (P-18/protocolo escalón E2, recorded 2026-09-12).
- Supersedes: none.
- Superseded-by: none.
- Amends: nothing. ADR 0073 listed "the outbox and incarnation (E)" among the
  escalones it was not deciding. This record is the first half of that escalón —
  the outbox and its own incarnation — and leaves the retrofit of the lease and
  claim stores to the second, so it completes a deferral rather than revising it.

## Context

Coordination §6 specifies `outbox_message` and §6.1 specifies how a row moves:
a read returns `(incarnación del outbox, command_id, row_version, state)`, and a
mutation runs inside `BEGIN IMMEDIATE` under an `UPDATE` predicated on the
command, the expected version **and** the expected state, setting
`row_version = row_version + 1`. It must change exactly one row; "cero filas =
CONFLICT y releer, nunca éxito ni reenvío implícito".

Two stores in this package already arbitrate. Neither does it this way, and the
difference is not stylistic. `lease-store` and `tool-claim-store` take the write
lock at `BEGIN` and run the caller's `decide` **inside** it: the decision sees
the state it is deciding against, so there is nothing for a version to protect
against. `row_version` does not appear anywhere in the tree.

An outbox row cannot be decided that way. It is read by one process, carried
across an **external dispatch**, and written back afterwards — and no lock may
be held across a network call. The window between the read and the write is
where another reconciler can move the row, and closing it is what the
compare-and-set is for. This escalón therefore builds mechanism this package has
no precedent for, in a file with no callers.

Three things about that mechanism are not obvious from §6.1 alone.

**`row_version` is born zero on every row.** So restoring this file from a
backup produces rows whose versions repeat numbers that were already issued, and
a token from before the restore matches a rebuilt row exactly. §6.1 names the
consequence — "una fila reconstruida con versión cero no admite un token de una
encarnación anterior" — and §8.1 gives the instrument: each coordination file
carries its own `coordination_store_meta`, and "no se acepta un token viejo
porque coincida su número con uno recreado".

**The outbox holds two incarnations with opposite roles.** Its own, in the
metadata, is what tokens are checked against. `target_store_incarnation_id` is
the **destination's**, carried from the intention in the ledger, and §6 says it
is "nunca se sustituye por la encarnación actual al reconstruir".

**Two of the five files §8.1 names do not exist.** `account_reservation` and
`artifact_blob_lease` appear in no escalón of this packet.

## Decision

**One.** `outbox.sqlite` is a separate database with its own migration list
under its own bookkeeping name, `STRICT` throughout, no clock, no environment,
no `DELETE`, one producer of its path, and the claim store's rule-shaped
wrong-file guard rather than the lease store's list of foreign table names.
Migration 1 is `coordination_store_meta`; migration 2 is `outbox_message` with
four indexes, its CHECKs and three `BEFORE UPDATE` triggers.

**Two.** The metadata comes **first**, before the table it governs, because
§8.1 says it is "persistida antes de emitir tokens" and a file that held rows
before it held an incarnation would have issued tokens nobody could later place.
The incarnation and its instant arrive as arguments with no implicit default, as
§8.1 requires twice. On a file that already carries a metadata row, that row
stands and the argument is unused: rotating an incarnation is a restore, and
coordination §8.2 puts a quiescence proof in front of a restore rather than
making it a side effect of reopening.

**Three.** The `store_kind` CHECK carries all five kinds of §8.1's dictionary,
not just `OUTBOX`, and the module refuses at open when the stored kind is
something else. Narrowed to one value the CHECK would make that refusal
unreachable — and an unreachable guard cannot be drilled, so it is not a guard.

**Four.** `CONFLICT` is a **return value**. Zero rows changed is a refusal the
caller must act on, which is this package's standing rule and the reason the
ledger's thirteen error classes do not move for a packet that adds a whole
database. `changes > 1` is not a refusal but a missing unique index, and throws.
A mutation that would write nothing answers `UNCHANGED` and writes nothing.

**Five.** The mutation type states **every** mutable column rather than patching
some of them, and the immutable ones — identity, destination, fence, the
original anchor — have no field in it at all. The `BEFORE UPDATE` trigger is the
backstop for a writer that reaches the table without passing through the type.

**Six.** There is no `sweep` and no verb of any kind that moves a row by the
clock. `listOverdue` reads, returns and mutates nothing.

**Seven.** The store does **not** derive `command_id`. It imposes uniqueness and
nothing else.

**Eight.** `last_failure_code` is `TEXT` with no CHECK.

**Nine.** The store is **inert**. Nothing writes a row and nothing dispatches
one.

## Why the version is not enough, and the incarnation is not decoration

The compare-and-set has four terms and only three of them are in the row. The
fourth, the incarnation, is not a column of `outbox_message` at all: it lives
once per file, and it is read **inside** the transaction on every mutation.

That placement is the whole of it. A handle that read the incarnation at `open`
would answer correctly for as long as nothing happened, and would carry a stale
answer into the first decision taken after a restore — which is precisely the
decision that matters. The suite drills it directly: a handle is opened, the
metadata is rewritten from another connection, and the compare-and-set that
follows conflicts.

What the check is worth is visible in the shape of the drill it survives. A row
is written at version zero, the file is destroyed, a new file is created under a
new incarnation, and the same row is rebuilt — at version zero, because every
row is born there. The old token's `command_id`, `row_version` and `state` all
match the rebuilt row exactly. Nothing in the tuple separates them except the
incarnation, and with it the set is refused; with the live incarnation
substituted and nothing else changed, the same set applies.

## Why `updated_at` is a stamp and not a change

§6.1 says an effective change "incluidos backoff/handle/owner/timestamps"
increments the version, and that "replay sin cambio conserva la fila". Read with
`updated_at` counted as substance, the second sentence describes a case that can
never occur: every retry carries a fresh instant, so every retry would be an
effective change and no replay would ever conserve anything.

So the replay comparison covers the substantive columns — state, counter,
backoff, deadline, handle, failure code, owner and anchor — and excludes
`updated_at`, which is written only when something else was. A replay writes
nothing at all, including the stamp, and reports `UNCHANGED`.

## Why the transition rule is a trigger and the shape rules are CHECKs

§6.1 names the trigger explicitly — "BEFORE UPDATE valida esas invariantes, la
versión y la transición" — and the three things it names are all facts about a
*change*: what the row was and what it is becoming. A CHECK cannot see `OLD`.

The cross-column invariants are facts about a *row*, so they are CHECKs and
apply on insert and update alike: the fence and its target incarnation are null
together, the attempt anchor is all-or-nothing with the counter following it, an
attempt sits on the intention's own stream, an owner exists exactly in
`INFLIGHT`, a terminal row carries no backoff.

The door validates neither. It refuses **shapes** — empty strings, non-integers,
values outside a closed vocabulary, digests that are not 64 lowercase hex
characters — because a caller can fix those and deserves to be told which field
is wrong. It does not restate the cross-column rules, so each of them is
enforced in exactly one place and every one is exercised against the database
rather than against a copy of itself.

One of those CHECKs was written twice. The fence and its incarnation were first
paired as a disjunction of the two lawful shapes, `(fence IS NULL AND … IS NULL)
OR (fence > 0 AND … IS NOT NULL)`. A comparison against a NULL fence is itself
NULL, a CHECK that evaluates to NULL passes, and the constraint admitted exactly
the row it was written to refuse — an incarnation with no fence. It is now an
equality of two nullity tests. The suite found it; it is recorded here because
the same three-valued trap is available in every CHECK that pairs a nullable
column with a comparison, and there are several in this table.

## Why a terminal row is not mutated at all

§2 makes `DELIVERED`, `FAILED_TERMINAL` and `ABANDONED` terminal, which settles
that no edge leaves them. It does not, on its face, settle whether a settled row
may still take a new response handle.

This record decides that it may not, and §6.1 supplies the reason rather than
the rule: "Si otro reconciliador avanzó la fila, un relay viejo no la cambia a
DELIVERED con su versión anterior: registra el resultado tardío identificado en
el ledger para conciliación." A late outcome already has a place to be written,
and it is the ledger. Writing it over a terminal row in a cache would put it
where it cannot be audited, in the one file the system is allowed to lose.

The claim store's lesson applies at the cube: its `TAKE` on a `SETTLED`
coordinate was unreachable from a correct caller and was found late, and the
comment that landed with the guard says the authority should not depend on its
callers remembering the order. This store has three terminals rather than one.

## Why the producer computes the command identity

§6 makes `command_id` deterministic over `(saga_id, phase, target_kind,
target_id)`. A store that computed it would hold a grammar of sagas — what a
phase is, which targets exist, how the four compose — and would own a key whose
meaning belongs to the thing that emits commands, not to the thing that caches
them.

This is ADR 0072's division at a different rung: a namespace is grammar of the
key, and the key is the contract's. If the composition turns out to be grammar,
escalón F places it in `@acp/contracts`, and nothing here has prejudged that.
What this store does is impose `UNIQUE (command_id)`, and a test fixes that it
derives nothing: a command identity no composition could produce is stored
verbatim.

## Why the failure code is open text

§6 says `last_failure_code` is "código tipado del mapa de contratos §16, no texto
libre", and a CHECK here would be the obvious reading. It would also bind this
file's schema to another package's catalogue, and every growth of that catalogue
would become a migration of this database — a migration that is immutable once
shipped, for a vocabulary that is not.

So the column is `TEXT` and the writer imposes the vocabulary. The cost is
stated rather than hidden: until escalón F writes rows, nothing prevents a
direct writer from storing a code contracts §16 does not define. What that
writer cannot do is anything else — the state, the command kind and both streams
are CHECKed enums — so the exposure is one column, named, with an owner.

## Consequences

- `PATH_SCOPED_LAWS` is 124. Three of the five new laws are the shape the other
  two stores already keep, restated over a third file because a law standing
  over one module says nothing about the next. The other two are pinned by
  equality, because no behavioural test can keep them: a predicate that lost its
  `state` term would pass every drill in the suite, since the version alone
  separates the cases those drills construct.
- `L-X1-4` counts four stores, and the two sentences it prints were rewritten
  with it. They said "three" and named three, and a row added without touching
  them would have left the law green while stating something false.
- The suite spawns real processes. Two handles in one event loop cannot prove
  this store's property: `better-sqlite3` is synchronous, so the second call
  sees the first one's committed row and reports `CONFLICT` correctly without
  the lock ever being contended. The racers therefore read their tokens, block
  on a marker, and are released together, so every one of them is holding a
  token for the same version when the race begins — which is the situation a
  dispatcher is in after it has read a row and before it has finished talking to
  a destination.
- §8.1's "cada archivo de coordinación" is satisfied over the files that exist
  and **partial** over those that do not. `account_reservation` and
  `artifact_blob_lease` are in no escalón of this packet; the lease and claim
  stores get their metadata and their `store_incarnation_id` in E1, and the full
  retrofit §3 `:90-107` describes — the fence rule with its four cases and its
  validators — is a packet of its own. Nothing here claims otherwise.
- N-P18-12 is closed by **half**. A missing outbox answers absence as absence,
  a row may be born `RECONCILING` rather than `PENDING`, and the schema refuses
  one born there without its attempt anchor. The half that rebuilds rows from
  the events needs to read the ledger and is escalón F's.
- N-P18-11 is closed by half for the same reason. The outbox half is here, with
  the outbox's own incarnation; the lease and claim halves need the metadata E1
  adds to those files.
- The file name divergence is not repaired. Coordination §1 calls the lease
  file `worktree-leases.sqlite` and the tree calls it `leases.sqlite`. This
  record states the reading §8.1 `:378` already supports: the authority on what
  a coordination file **is** is its `store_kind`, not its name, and renaming a
  live arbiter's file for tidiness costs liveness to buy nothing.
- Nothing calls this. No producer writes a row, no dispatcher reads one, and
  `outbox.sqlite` does not exist on any ledger in the field. Escalón F owes the
  saga, the command identity and the three event types; escalón G owes the
  producer.

## Not in this record

Whether `CONTRACT_VERSION` moves: still ADR 0072's deferral. The saga, the
matrix of §6.2, `CAPABILITY_UNSUPPORTED` and the three outbox event types are
escalón F's. The recovery procedure of coordination §8.2 — its quiescence proof
and its six steps — is P-18/recuperación and is blocked; what is here is step 4,
an incarnation that changes when the file does, and the refusal in step 5 of a
token minted under the previous one.

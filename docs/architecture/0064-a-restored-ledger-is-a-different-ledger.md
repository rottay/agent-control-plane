# ADR 0064 — A restored ledger is a different ledger, and the path digest cannot say so

- Status: accepted (P-10/id-B, recorded 2026-09-10).
- Supersedes: none.
- Superseded-by: none.
- Extends: `0028-the-resumed-stream-identity.md`.

## Context

ADR 0028 gave the resumed stream an identity to compare. It ruled that the
server cannot detect a foreign resume — `Last-Event-ID` is a bare decimal
sequence and has nowhere to put a ledger identity — and therefore that the
server's obligation is to **restate** identity on every open while the client's
is to **compare** it. That division still holds and is not reopened here.

What 0028 did not say, and what this record corrects, is that the thing being
compared was only half an identity.

`LedgerDatabaseIdentity.id` is `sha256(resolved absolute path)`, computed at the
server boundary by two independent producers —
`gateway/src/database-identity/index.ts` and `cli/src/observation/index.ts` —
neither of which opens the ledger. That is a deliberate and good property: it is
what makes the parity contract cheap, because two clients agree on it without
coordinating. But it answers *which location*, and a location is not a file.

The concrete failure, which was live in the tree until this packet:

> A browser tab holds sequence 3. An operator restores yesterday's backup **over
> the same path**. The tab reconnects with `Last-Event-ID: 3`. `database.id` is
> byte-identical, because the path did not move. The server replays from 3
> forward, the client's `acceptHello` finds nothing changed, and rows from a
> different history are appended to a view rendering the old one. Sequence 4 is
> now a different event, and neither end notices.

`ANCHOR_AHEAD_OF_HEAD` does not catch it: that fires only for a *shorter*
replacement. A restore whose head is at or beyond the anchor produces no
refusal at all. This is finding DB08 of the audit, and `docs/audit/architecture/
database/index.md` §12 states the remedy: a formal restore writes a new random
`restore_id` **before** admitting work, and the client's cursor is
`(instance_id, restore_id, stream, sequence, event_sha256)`.

P-10/id-A put those rows in `ledger_meta` and published them on the ledger's own
`status()`. This record is about the half that closes the defect: putting them
on the wire, and widening the client law to read them.

## Decision

**A sibling field, and a tuple comparison.**

`hello` and the status response each gain one required field, `instance`, beside
`database` and never inside it.

```
instance: { instanceId: uuid|null, restoreId: uuid|null, restoreEpoch: int≥0|null }
```

**Beside and not inside**, for a reason that is structural rather than
aesthetic. `LedgerDatabaseIdentity` is a function of the path and of nothing
else. Folding a ledger fact into it would force both producers to open the
ledger to compute it, and the cheap agreement that the parity contract rests on
would become a thing that has to be arranged. Identity of location and identity
of file are two facts; they travel as two fields.

**All three null together, or none.** The schema refines this rather than
merely documenting it. Three independently nullable fields admit six mixed
shapes, and "an instance with no restore" is a question with no answer — the
ledger writes the three rows in one transaction. The one lawful null is the
whole triple: a ledger written before this identity existed and not yet opened
writably by a build that knows about it.

**The client compares `(database.id, instanceId, restoreId)`, by value.** Not
`restoreEpoch`: it is a monotone integer, informative only, and carries no
uniqueness, so two restores can share one. Not the `instance` object by
reference: every frame is freshly parsed JSON, so a reference comparison would
reset the scope on every reconnection — the failure mode opposite to the one
this closes, and just as silent.

`null` is equal only to `null`, which falls out of comparing `string | null`
with `!==` and is what keeps the pre-upgrade window quiet. A ledger with no
identity yet reconnects without resetting; when the first writable open gives
the file an identity, that **is** a change and resets once. That single reset is
honest: the identity went from unknown to known.

**The gateway reads the identity per open, never at startup.** `#open()` takes
`headSequence` and `instance` from one `status()` call. Caching it beside
`database` on the stream context would be the same defect wearing a subtler
disguise: a restore under a live gateway would be invisible, and no client-side
test would catch it, because the frames would simply never move.

## `API_CONTRACT_VERSION` moves to 0.14.0

Minor, for the mechanical reason 0028 recorded when the same frame gained
`resumedFrom`: every arm of `StreamFrame` is a `z.strictObject`, so a reader
pinned at `0.13.0` parsing a `0.14.0` `hello` rejects it on the unknown key.
That is a shape a `0.13.0` reader has never seen, which is this repository's own
rule for the minor.

Making the key optional to spare that reader was rejected for the reason it was
rejected then: it would make "this server does not know its file identity" and
"this file has none yet" the same wire shape, and telling those apart is the
entire point of the field.

`LEDGER_CONTRACT_VERSION` does not move. No recorded event changes shape, no
history is reinterpreted and no migration is implied — the three rows are
additive keys in a table that has been `(key, value)` since migration 3.

## Consequences

The client law in `console/src/api/stream/index.ts` gains two sibling variables
and a wider condition. Its arm order does not change, and neither does
`resetScope`'s effect: the scope adopts the foreign head, the replay that
follows falls through `acceptEvent`'s duplicate arm, and the view refetches.
That is 0028's mechanism, unchanged; only the condition that triggers it is
wider.

`restoreEpoch` travels and is not compared. That asymmetry is deliberate and is
recorded here because a literal reading of the specification would not predict
it: invariant 7 of the database contract names `instance_id` and `restore_id`
as the fields that travel in the `hello` frame, and `streams/index.md` describes
the epoch as informative only. It travels because the DTO that carries an
identity should carry all of it rather than a filtered view, and it is excluded
from the comparison because comparing it would make a monotone counter into a
uniqueness claim it explicitly is not.

## What this does not close

**A manual copy is still undetectable.** This detects a *formal* restore — one
where the restoring process recorded a new restore id before admitting work. A
file copied by hand, with identical metadata and no new restore id, is
indistinguishable from the original from inside the file, by this mechanism or
any other, without external state. The database contract says so explicitly and
the API reference now says so too.

**Backup itself is another packet's.** Making the ledger, its WAL and the
artifact store consistent under one window is P-36. This supplies the identity
such a mechanism writes, and the ordering rule it must obey.

**The console does not render `instance`.** A strict parse accepts the field
without displaying it, and showing which restore a browser is looking at is a
presentation decision this packet does not make.

## Not in this record

Whether a client should do anything beyond refetching when the identity moves —
warn, or offer to reload. The view refetches; what a human is told about it is
the console's business.

P9, cutover and publication. Untouched, as everywhere else.

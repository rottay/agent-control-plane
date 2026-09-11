# ADR 0070 — One payload-keys projection serves both doors

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

Structure §4.1 (L189–206) names a defect with three live implementations of
one concept that did not agree. The gateway's mapper listed payload keys in
insertion order with no ceiling, so a payload with more than sixty-four keys
produced an item the strict downstream parse refused — one door broke. The CLI
sorted the keys and cut at sixty-four locally, answering truncation where the
gateway answered failure — the other door survived. Only the wire contract
knew the ceiling was sixty-four. The product answered differently depending
on which door was asked, and the suites that should have caught it sorted
both sides before comparing, which is the habit that lets any ordering bug
pass.

The event payload is the one part of an event whose contents the contract
does not fix, so the boundary rule stays: payload values never cross into a
DTO, only key names and the serialized byte size do. What needed an owner was
the *derivation* of the key-name list — order, collation and ceiling — not
the boundary itself.

## Decision

One projection, owned by `domains/observation`: `payloadKeys` in
`model/read-model`, exposed by the `usecases/queries/payload-keys` query
(the name fixed by structure §2 :100), and consumed by both doors. The
gateway's `timelineItem` and the CLI's `toTimelineItem` both delegate; the
CLI's local function and its locally declared ceiling retire, and the CLI
gains the `@acp/observation` workspace edge the gateway already carried.

Order is code-unit order (`Array.prototype.sort`), not locale order: the same
bytes sort the same way on every machine, and the wire schema fixes no order,
so this is a presentation change, not a contract version. It is nonetheless an
**observable wire change**: every gateway response, scoped timeline and stream
frame now lists payload keys in canonical order instead of insertion order.
Clients that assumed insertion order were assuming a bug.

The ceiling stays sixty-four, declared by the projection as
`MAX_PAYLOAD_KEYS`, cutting after sorting so an over-sized payload yields its
first sixty-four names in canonical order and the item parses on both doors.
The agreement with the contract is tested empirically where the contract is
reachable: the gateway's mapper suite derives the ceiling from the schema
(N key names parse, N+1 refuse) and asserts it equal to the constant. The
projection does not import `@acp/protocol` — the gateway's live code may not
name `@acp/contracts` and observation's own law keeps the protocol package
out of the domain — so a test ties the two numbers; nothing duplicates the
literal without that test.

Each door's fixture is independent, with every expected array written by
hand: claves desordenadas, more than sixty-four keys, and characters whose
order changes between locales. Comparing two calls to one helper proves
nothing (§4.1 :205–206), so the two door suites never touch each other.

The fence carries the negative half as L-P12-1: no production source outside
the owner file may derive the list of keys of a payload for a DTO, with the
provider telemetry redaction codified by name as the non-DTO negative. The
duplication §4.1 diagnosed can no longer return silently.

## Why importing the ceiling from the contract was not chosen

The semantic-owner alternative — the projection importing the ceiling from
`@acp/protocol` — requires a new export in the protocol package. Protocol is
outside this packet's write-set, and a new contract export is its own act.
The chosen shape keeps one literal with one named owner and ties it to the
contract by an empirical test at the only door that may reach both sides,
which satisfies §4.2's rule against two equal numbers with no test between
them without touching the contract.

## Why an uncapped projection was not chosen

Listing all keys and letting the strict schema refuse the over-sized item
preserves information but resurrects the gateway's failure: one door errors
where the other answers. The ceiling in the projection is what the healthy
door already did — answer with the first sixty-four names and let the exact
byte size tell the reader the item was larger — made the single behaviour
both doors share.

## Why a record-typed signature was not chosen

The projection takes `Readonly<Record<string, unknown>>`, not a
`LedgerEventRecord`. The concept being projected is the payload alone; typing
the function to the ledger's record would couple a pure read-model function
to the persistence shape and would not stop a caller from passing
`record.event` — the envelope adds nothing to the algorithm.

## Consequences

Both doors answer identically — canonical order, sixty-four names — from one
implementation, and the gateway's over-sized-payload parse failure is gone:
the item that previously broke `TimelineItem.parse` now parses with its
sorted prefix. The wire bytes of every gateway timeline surface change order;
the schema, the contract versions and every consumer that only counts or
displays the keys are unaffected. The CLI gains one workspace dependency,
declared in its manifest, the fence's allowed set, the manifest law and the
lockfile importer block.

The families §4.1 lists beside this one — task and worker DTOs, the event
timeline queue, the portfolio summary, database identity — keep their own
destinations and are not moved by this record; identity in particular remains
E18/P-37, where the instance identity starts being emitted by persistence.

## Not in this record

- The remaining duplicated families of §4.1 :210–215 and the gateway's
  `mappers/`, `aggregates/` and `database-identity/` extraction (E18, P-37).
- `payloadByteSize`: each door keeps computing its own byte count, the
  gateway by `TextEncoder`, the CLI by `Buffer.byteLength`, because §4.1
  does not name it and the gateway may not reach `@acp/contracts` for the
  shared helper.
- Any change to `@acp/protocol`: the schema, its ceiling and its guards are
  untouched.
- The five P-05/B revision keys still cross this projection as opaque
  strings; nothing here reads a payload key by name.

---

Conventions: numbers are unique and contiguous, and the architecture fence
enforces both. The corpus is append-only — never edit a landed record to
reflect a later decision; record the later decision instead.

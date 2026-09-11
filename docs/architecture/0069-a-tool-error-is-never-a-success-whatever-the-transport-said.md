# ADR 0069 — A tool error is never a success, whatever the transport said

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The audited contracts fix a rule in §4.2 (L217–219): a tool result marked as
an error produces a failure **even when the transport answered correctly and
the process exited zero**. The external audit's finding N07 named the exact
defect: `packages/edges/tools/src/client/index.ts` never read the `isError`
indicator, and `packages/edges/tools/src/port/index.ts` converted the result
into `ok: true`, so a server reporting its own tool's failure was recorded as
`outcome: "COMPLETED"` with `refusal: null` — and the row went to the durable
ledger that way. The capability record confessed it:
`MCP_PROTOCOL_RECORD.IS_ERROR_RESULT` read `"UNHANDLED"`, with no fence law and
no drill noticing.

Three facts had to stay separable (§4.2-c): transport success, process
termination and the operation's result. The first two had refusal words of
their own (`PROTOCOL_VIOLATION`, and the child exit code is not read on this
path at all). The third had none: `TOOL_REFUSALS` held nine words, every one a
refusal of the *plane* — arguments, identity, protocol, ceilings, privacy,
admission, liveness, allowlist, descriptor — and no word for "the server
answered and said the tool failed".

Two readings of the §4.2 text were live. It says the outcome is `FAILED`, but
`FAILED` is a member of `effect_outcome_status` (§2 L37), a vocabulary that
does not exist in code and belongs to P-07; and §16.2 (L678) classifies the
case as a **refusal** with `refusal_class` `PRECONDITION_FAILED` and retry
`NONE`. The receipt vocabulary (`COMPLETED`/`REFUSED`) is the one the tree
actually speaks.

## Decision

`TOOL_REFUSALS` gains one member, `RESULT_IS_ERROR`, sorted between
`PROTOCOL_VIOLATION` and `RESULT_UNBOUNDED` (a `RESULT_*` word sorts into the
middle, not the tail). The client — the single parse site, so the change covers
both transports at once — reads `isError` from the `tools/call` result after
the byte ceiling and before content is carried: absence and the literal
`false` complete; `true` refuses as `RESULT_IS_ERROR` at `server.result`; any
other value is a malformed flag and refuses as `PROTOCOL_VIOLATION`, because
nothing may default into success. The receipt stays `REFUSED` with the new
reason; there is no third outcome word. The fence law L-B4B-17 pins that the
capability record and the package README agree field by field.

The error content is **discarded whole** (N-9): the refused arm carries no
content, the error text reaches neither door's response nor the ledger, and the
README declares the discard as a limit — widening the refused arm to carry the
message touches the port, the operation, the runtime and both doors, and is a
later packet.

`refuse()` in the port is widened to accept the real `resultBytes` and
`contentBlocks` when a result was in hand, recording zero only where no result
existed. The nine pre-result refusals keep their zeros; `RESULT_UNSAFE` and
the post-result client refusals now record what actually arrived, because a
zero after a result reached the plane is a false number in a durable row. The
CLI exit code does not change: an outcome was registered — a `REFUSED` call
leaves a durable row — so the invocation is a success of the verb, and exit 0
stays the spelling of that.

The README's claim that every record field "has a drill behind it" was false
for all six record fields, not only this one; it is weakened to what is true
today, and the missing drills are named debt rather than hidden behind the
general sentence.

## Why a third outcome word was not chosen

The literal reading of §4.2 L217 adds `FAILED` to `ToolCallOutcomeName`, which
freezes the wire enum in two schema sites, rewrites the runtime recorder's two
coherence rules, rewrites `isCoherent`, and forces six door assertions to
move. That buys a word whose owning vocabulary (`effect_outcome_status`) does
not exist yet: it would freeze `FAILED` into the cable one packet before P-07
gives it meaning, and when P-07 lands there would be two `FAILED`s with
different scopes in one tree. §16.2 already classifies this case as a refusal,
and the audit's B7 and testing negative 18 are written about the *receipt*,
which the refusal reading satisfies exactly. When P-07 brings the effect
outcome vocabulary and the §16 translation layer exists,
`REFUSED`/`RESULT_IS_ERROR` maps to `FAILED` there — this package does not
mint that word ahead of its owner.

## Why carrying the error content was not chosen

Under MCP the `content` of an `isError` result is the error message — the
thing an agent needs to know what failed. But the refused arm of
`ToolCallOutcome` carries no content by design, the runtime builds refused
content as `[]`, and a partially filtered result is one the caller cannot
distinguish from a whole one — the same law `RESULT_UNSAFE` already holds.
Carrying it honestly means widening the refused arm across the port, the
operation, the runtime and both doors; that is a packet of its own, and until
it lands the limit is declared in the README rather than left implicit.

## Why zero counts after a received result were not chosen

The port's `refuse()` recorded `resultBytes: 0, contentBlocks: 0` for every
refusal, which is honest only when no result existed. For a marked-error
result the bytes and blocks did arrive; recording zero would state a false
fact in a row the ledger keeps. The counts travel with the refusal that had a
result in hand — the client computes them once, before any decline — and the
pre-result refusals keep their zeros, which remain the truth there.

## Consequences

The vocabulary the receipt speaks is unchanged in shape — still two outcomes,
still ten scalar members — and one word longer. The runtime recorder, the wire
schemas, both door sources, `src/receipt/index.ts` and
`src/operation/index.ts` accept the new row without a line of change, which
the door drills now prove rather than assume. A server that reports its own
failure leaves the same durable evidence as any other refusal: outcome, a
legible reason, and real counts, with no content.

The cost is carried openly: `REFUSED` now names two things — the plane
declined, and the server failed — distinguished only by the reason word, until
P-07's vocabulary separates them. The caller cannot see why the tool failed
until a later packet carries the message. Five capability-record fields still
have no drill; the README says so, and L-B4B-17 now forbids the record and the
README from drifting apart in either direction, field by field.

## Not in this record

- The `effect_outcome_status` vocabulary and the `FAILED` it owns are P-07;
  the §16 translation layer (`refusal_class`, retry policy) is a packet of its
  own.
- Carrying the error content to the caller is a later packet, scoped across
  the port, the operation, the runtime and both doors.
- The five record fields without drills (the pagination, stream, resumption,
  batching and origin facilities) owe drills to a later packet; the README now
  names that debt.
- Re-scoring the audit's N07 finding and SEG-7 quality row is the DT's act
  after the receipt, with this packet's evidence; this record does not touch
  `docs/audit/`.

---

Conventions: numbers are unique and contiguous, and the architecture fence
enforces both. The corpus is append-only — never edit a landed record to
reflect a later decision; record the later decision instead.

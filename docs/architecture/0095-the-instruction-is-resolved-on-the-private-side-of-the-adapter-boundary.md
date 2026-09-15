# ADR 0095 — The instruction is resolved on the private side of the adapter boundary, and its prompt occurrence is recorded

- Status: accepted (P-06 escalón C, recorded 2026-09-15).
- Supersedes: none.
- Superseded-by: none.
- Amends: `0080-the-producer-speaks-the-v2-coordinate.md` §7, whose table of
  reassigned debts sent the `PROMPT_OCCURRENCE_RECORDED` producer to the adoption
  packet; the condition it gave for the reassignment is met here, so the row is
  amended and the producer lands in this escalón (Q-C1).
  `0093-an-instructions-content-is-an-ordered-list-of-discriminated-blocks.md` and
  `0094-the-task-envelope-carries-the-instructions-content.md` in their Consequences,
  which named what C owes and is now paid. `L-B1C-1` and `L-P06A-1` are each amended
  in their own fence row rather than replaced.

## Context

Escalón A froze the content contract and held it inert. Escalón B put the content in
the envelope, made it part of `envelope_sha256` by construction, and had both real
doors validate it — while `instructionFor` went on reading `objective`, because B was
forbidden to touch it. So the repository held a validated content list that nothing
read, and a producer that read a field the content list had made a projection of.

Three things were therefore outstanding, and contratos names all three. §4.1 `:199-201`
puts inline data on the **private** side of the adapter boundary: whatever resolves a
reference must do it where the adapter cannot see it. §4.1 E14 and ADR 0077 ask for a
prompt occurrence — the record that an instruction was *used* — whose table, door,
projection, canonicaliser and reader have existed since migration 13 with no producer
in any `src/`. And §4.3 asks for an acceptance proof: a child that returns what it
received, driven from the real door and not from a fixture, with a transport that
cannot carry the content declaring `UNSUPPORTED` in the preflight, before it spends.

## Decision

**One — the producer composes from the content, and there is still exactly one.**
`instructionFor` reads `envelope.content.blocks`. Every `text` block contributes its
text, in the list's own order, joined by one blank line. `BLOCK_SEPARATOR = "\n\n"`,
one rule with no per-adapter variant, so two transports never see different
instructions for one envelope. The order is the list's because §4.1 calls it an
**ordered** list: a composer that sorted or grouped would be answering a question the
contract has already answered. A blank line because a block boundary is a paragraph
boundary, and nothing smaller survives a tokenizer intact.

Non-text classes contribute nothing to the string and are **not dropped**: they travel
as classes to the adapter and are refused there (decision Four). Silently composing an
instruction without the part a caller asked for would send the model something nobody
authorized.

**Two — a reference is resolved through the plane's own verb, under this task's
scope, and verified against both declared figures.** A text block naming an
`artifactRefId` is read with `plane.read({artifactReferenceId, scopeKind: "TASK",
scopeId: envelope.taskId})`. A refusal is the plane's word — `SCOPE_EQUALITY_V1` for a
reference belonging to another task — and not a second opinion formed here. The bytes
are then checked against `contentSha256`, against `byteLength`, and against the
block's own inline text; any disagreement throws **before** a byte crosses. Either way
the instruction is not composed at all: there is no half-composed instruction, and
nothing partial reaches a transport.

The reader is `initiative-registration`'s objective reader, verbatim: the plane is
opened with a lease store that refuses everything, because reading by reference asks
the blob lease store nothing and opening the real one would create and migrate a
coordination file just to compose a prompt.

**Three — the credential guard runs over each resolved block, before the join.** Not
over the composed string, although the string contains every block and the session
guard scans it again before the spawn. Per block for two reasons that are not
belt-and-braces: a hit names **which** block offended, as a path and never as bytes,
and it refuses before the offending text has been joined to anything — so the value
that would have crossed the boundary is never built.

**Four — the modality refusal lives inside the delivery union.** `SessionDescriptor`'s
`delivery` gains a third member, `{kind: "UNSUPPORTED", reason: "MODALITY_UNSUPPORTED"}`,
and `SessionRequest` gains `modalities: readonly string[]` — the distinct **classes**
the instruction was composed from, never a block and never a byte. Classes travel
because a pure `describe` cannot refuse what it cannot see, and handing it the blocks
would put content on the public side of the boundary, which §4.1 `:199-201` forbids.

Inside the union rather than beside it, so it reuses the one refusal point that
already runs before the spawn, and `PROTOCOL_UNSUPPORTED` remains the code, for ADR
0034's reason: the specificity belongs in the descriptor's `reason`, and minting an
error code would move a pinned closed set for no semantic gain. The `never` in
`startSession`'s switch obliges all three adapters to declare: Claude refuses any
non-text class purely, before a process exists; Codex and Kimi keep
`HANDSHAKE_REQUIRED`, because a transport whose protocol cannot take an instruction at
all cannot take a text one either, and stating the modality instead would be a more
specific answer to a less fundamental question.

Naming a modality is not installing one. Nothing multimodal is transported: the text
route works end to end and every other class is refused.

**Five — the bound follows the value.** `ExecutionRequest.instructions` was bounded
`min(1).max(4_000)` because that is what `TaskEnvelope.objective` carried. The
instruction is now composed from a list, so the governing figure is the content
contract's own aggregate: `INSTRUCTIONS_MAX_CHARS = CONTENT_REQUEST_AGGREGATE_MAX_BYTES`.

The aggregate rather than the arithmetic product of the list ceiling and the per-block
text ceiling, because tests §9.6 rule 1 governs where two numbers meet: when a policy
already in force is more restrictive, the policy in force wins — and the aggregate is
the ceiling a request's content was already held to at the door. Over it is a
**contract refusal**, never a truncation: an adapter that shortened an instruction
would be inventing a policy about what the model was asked.

Moving it is **not a bump**, and that is measured rather than assumed:
`ExecutionRequest` carries no `contractVersion`. It is a port shape, not an issued
instrument, so no version line moves for its bound or for its new field.

**Six — the prompt occurrence gains its producer here, and ADR 0080 §7 is amended.**
That record's table of reassigned debts sent the `PROMPT_OCCURRENCE_RECORDED` and
`RESPONSE_OCCURRENCE_RECORDED` producers to the adoption packet, for the reason given
one row above: "they need the real execution port and a provider". That condition is
met **in this escalón** — this is where the instruction crosses to the adapter — so
the prompt occurrence's producer lands here and the row is amended. The response
occurrence stays reassigned: §4.2 and the output contract are P-07's.

`buildPromptOccurrenceEvent` is a **pure builder**, on the invocation's own coordinate,
in the runtime's event module beside `buildEvent`. It refuses by name an invocation
without a revision — an occurrence carries the V2 coordinate, and a V1 invocation
names no attempt to attribute the delivery to — derives the transition id from the
occurrence's own id so a restated occurrence is a replay under the same key, and parses
through `ControlPlaneEvent` so the credential and transcript guards run on the way out.
It records the digest and the length, and `contextSha256` is **null** where there is no
separately addressed context: null rather than a digest of nothing, because an invented
digest is worse than a stated absence — no reader can tell it from a real one.

Appending it is not C's. Every V2 producer of this family has its builder here and its
append site in the adoption packet; putting one append in the daemon would be P-15's
work done early and out of order.

**Seven — the laws.** `L-B1C-1` is amended in its own row: it asserted that the one
producer reads `envelope.objective`, and now asserts that it composes from
`envelope.content.blocks`. What the law protects is unchanged — exactly one site
decides what the model is told — and it would otherwise fail on a producer that is
more correct than the one it was written for. `L-P06A-1` is amended a second time to
admit the execution boundary, which names the content concept for its vocabulary and
its bounds and builds no content list. Neither amendment adds a row.

Two laws are new. **`L-P06C-1`** is N-P06-14 made mechanical: a resolved block reaches
no event, stream frame, checkpoint, telemetry attribute or log line, not even as a
digest. It is enforced as *containment* rather than as a word ban, because a word ban
would catch the artifact plane's own legitimate digests: exactly three tracked `src/`
files may see a block — the envelope's refinement, the door that validates, the one
producer — the function inside the producer that holds resolved bytes names no
recorder, and the sentence the ban is the enforcement of stays where the instruction
field declares it. **`L-P06C-2`** pins the producer's record and the ledger's grammar
to one set of thirteen names, bidirectionally, on `CONTRACTS_SCHEMA_EXPORTS`' mould: the
event contract's `payload` is a record of unknowns for every type, so what keeps a
stray key out of an occurrence is this producer, and "is" is the kind of sentence that
decays unless something checks it.

## Why `objective` is not retired here

ADR 0094 kept the field alive and named its retirement as C's. It is not paid, and the
reason is stated rather than deferred silently: retiring it moves `CONTRACT_VERSION`,
and C moves no version. The field stays bound to the first text block by B's
refinement, so the two spellings of one instruction still cannot disagree, and the
retirement is the next envelope bump's debt. What C does pay is the part that matters:
nothing reads `objective` to decide what the model is told any more.

## Why the acceptance proof is complete on one leg and declared on the other

§4.3 asks for "a child that returns what it received, exercised from the real door —
CLI and API — and not from a fixture". On the CLI leg that is exactly what is proven:
the real producer composes from a two-block envelope over a real ledger, the real
execution port carries the result through the real Claude adapter, and a real child
process writes the bytes it received to a side file, which the drill reads back and
compares. The side file and not stdout, because stdout is adapter-parsed and echoing
an instruction there would turn it into a classified event whose payload can reach a
log — the leak `L-P06C-1` forbids.

On the API leg it is not expressible, and the measurement says why: `ApiStreamRequest`
carries the model, the task, the attempt and the identity, and **no instruction**. So
that leg is driven with the same composed instruction and asserted for what it can
prove — the same terminal state, and none of the content in the request, the trail or
the log — and the gap is recorded here as the API transport's own debt rather than
papered over. It is not a live defect: the shipped capability policy admits no API
transport, which the drill asserts against the real document.

## Consequences

- `PATH_SCOPED_LAWS` 145 → **146** for `L-P06C-1`; `L-P06C-2` is a two-file name-set
  pin and adds no row. `CONTRACTS_SCHEMA_EXPORTS` 150 → **151** for
  `INSTRUCTIONS_MAX_CHARS`. The ADR corpus 94 → 95. No contract version moves, and no
  migration, table, projection or watermark: the occurrence's table has existed since
  migration 13, and a port shape is not an issued instrument.
- `instructionFor` returns `{instructions, modalities}` and is **exported**, so the
  acceptance proof can drive the real producer rather than a copy of it. Exporting does
  not widen `L-B1C-1`: the law counts sites that assign an `instructions:` value of
  their own, and a caller of this function spreads what the one producer returned.
- `SessionRequest` and `ExecutionRequest` both carry `modalities`, so every fixture
  that builds either states it. Six of those are builders that cast a partial object
  and spread their overrides, which is why a sweep keyed on a field name could not see
  them; the write-set was extended by adjudication twice for that class of path.
- The two drill children keep their instruction as a module constant and gain
  `modalities: ["text"]` beside it. They remain `L-B1C-1`'s two named exceptions.
- `prompt_occurrence_read_model` has a producer and no append site. That is the same
  state the other V2 producers are in, and it is P-15's to close.

## Not in this record

- Appending the occurrence event, and the daemon child taking its envelope from a
  recorded reference rather than from its configuration: P-15, as adoption.
- Retiring `objective`: the next envelope bump.
- Any transport of a non-text class, and any capability that would make one supported:
  a class is evaluated and refused here, and nothing is installed.
- The neutral §2.0 capability registry: P-22/P-23.
- Threading an instruction into `ApiStreamRequest`: the API transport's own packet.
- The output contract and the response occurrence: §4.2, P-07.

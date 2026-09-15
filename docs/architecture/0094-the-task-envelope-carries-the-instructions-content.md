# ADR 0094 — The task envelope carries the instruction's content, and both doors validate it

- Status: accepted (P-06 escalón B, recorded 2026-09-15).
- Supersedes: none.
- Superseded-by: none.
- Amends: `0093-an-instructions-content-is-an-ordered-list-of-discriminated-blocks.md`
  in its Consequences, which named what B inherits and is now paid. `L-P06A-1` is
  amended in its own fence row rather than replaced: the law no longer admits no
  caller.

## Context

Escalón A froze the content contract and left it inert: one ordered list of
discriminated blocks, a law holding that nothing names it, and no producer. The
envelope meanwhile still carried the instruction as `objective`, a single string of up
to four thousand characters, which `instructionFor` reads to build an
`ExecutionRequest`. So the contract existed and nothing was held to it.

Contratos §3 `:144-147` makes the envelope's own fields the preimage of
`envelope_sha256`, and §4.1 makes the content the instruction. Those two sentences
together are what B has to make true: the content has to be *in* the envelope, so that
changing a block changes the revision, and both real doors have to hold a submission
to it.

ADR 0093 had already refused one shape in advance. Adding `contentBlocks` beside a
still-authoritative `objective` was rejected as two authorities on one question, "a
reader would have to know whether the instruction is the objective, the blocks, or the
objective followed by the blocks".

## Decision

**One — `content` is required, and imported.** `TaskEnvelope` gains
`content: InstructionContentSchema`, the schema escalón A froze, referenced and never
restated: A is the single authority on a block's shape and a copy here would be a
second one. Required rather than optional, adjudicated: an optional field is the
second authority 0093 refused, and an envelope no door would admit should not be
constructible at all. The price is that every envelope fixture in the repository
states it, and it is paid once.

**Two — it enters the identity by construction, not by an edit.**
`envelopeIdentityPreimageV1` is `PREFIX + canonicalJsonStringify(TaskEnvelope.parse(value))`
— the canonical JSON of the *whole parsed envelope*. So the content entered the
preimage the moment the schema carried it, and `envelope-identity/index.ts` needed no
change. That is E16 satisfied structurally: a field cannot be in the envelope and out
of its identity, because nothing enumerates the fields twice. Changing one block
changes `envelope_sha256`, and a changed digest is a new revision (N-P06-10).

**Three — `objective` stays, bound to the first text block.** The envelope refuses an
`objective` that differs from the text of the first `text` block of its content. Two
spellings of one fact, and they cannot disagree.

This is not the coexistence 0093 refused, and the difference is enforceability. There,
two fields could each say something and a reader had to choose; here a producer that
tried would be refused by name. `content` is the authority §4.1 names; `objective` is
the projection escalón C retires when it moves `instructionFor` to read the content.
It stays in B for one reason, stated plainly: B is forbidden to touch
`instructionFor`, and removing the field it reads would touch it.

**Four — both doors validate, and both is one door.** The CLI and the gateway reach
task intake through the same `intakeTask` in `@acp/runtime`, which parses the envelope
with `TaskEnvelope.safeParse`. So every block rule of A's contract — closed kinds,
unique block ids, media type against class, declared length, the aggregate, the
mandatory text block, `tool_result`'s links — refuses at both doors from the moment
the field exists, with the path reported as `envelope.content.…`. No second validator
was written, and writing one would have been the second authority again.

**Five — the door verifies references; it does not publish them.**
`CONTENT_REFERENCE_UNKNOWN`: every block that names an `artifactRefId` must resolve to
an artifact reference scoped `TASK` to *this* envelope's `taskId`. A reference under
another task's scope earns the same word rather than being admitted because the id
happened to resolve.

Verify and not publish, because an envelope carries a reference and a digest and
**never bytes**: there is nothing at the door to publish. The producer publishes what
it references before it submits — the plane is already open to it, as the envelope's
own `TASK_ENVELOPE` publication shows — and the door's job is to refuse work whose
content points at nothing. Escalón A's contract is silent on whether a reference
resolves, correctly: that is a fact about the plane, not about the payload's shape.

**Six — the bump, and its measured drag.** `CONTRACT_VERSION` `2.6.0` → **`2.7.0`**, a
minor on decision 85's mould: a required field on a shape that is *issued* rather than
re-read, so the rule is `AdmittedContractVersion` and the cost is that an envelope
fixture of the previous cohort no longer parses (consequence V3, N-P06-11).
`SUPPORTED_CONTRACT_VERSIONS` gains `2.7.0` and keeps all five earlier members, so
every stored row still reads. The three envelope-identity vectors were recomputed
**twice** each — once by `envelopeSha256`, once by `node:crypto` over the preimage —
and agree.

`LEDGER_CONTRACT_VERSION` moves too, and is **derived, not decided**: it is
`= CONTRACT_VERSION` at `protocol/src/version/index.ts:211`. Its roughly one hundred
and seventy consumers name it by symbol and follow with no edit; exactly one literal
pin moved. The brief expected it to hold still; the measurement said otherwise and the
measurement governs.

`API_CONTRACT_VERSION` `0.17.0` → **`0.18.0`** (Q3), an independent literal and so a
deliberate decision: the intake route's body carries the envelope, and the envelope
changed shape. A minor, because every field a `0.17.0` caller sent still means what it
meant — but such a caller no longer composes a body this surface admits, and a version
line exists to say that.

**Seven — `L-P06A-1` amended in its row.** The law stops admitting no caller and
admits exactly the two B wires: the envelope's own schema, which carries the content,
and the runtime's intake, which validates it for both doors. Everything else stays
refused — a second producer of a content list is the three formats per client §4.1
forbids, and the resolution that crosses the adapter boundary is still C's. Same row,
same `requireScope`, so `PATH_SCOPED_LAWS` stays **145**.

## Why the content was not carried outside the envelope

A `CONTENT` artifact referenced from the envelope, like the envelope's own bytes are
referenced from a submission, would have avoided the bump and every fixture. It was
rejected because it puts the instruction outside the thing whose digest identifies the
revision: two submissions could then share one `envelope_sha256` and ask for different
work, which is defect N01 restated one level down. The envelope is what
`envelope_sha256` means, so what the model is asked has to be inside it.

## Why the probes that vary `objective` alone were rewritten rather than dropped

Three tests proved N01 by changing only the objective and watching the digest move.
With `objective` bound to the first text block, "only the objective" is no longer a
constructible envelope, and those probes threw instead of comparing. They were
rewritten to move both spellings of the one instruction, which preserves exactly what
they proved — two instructions, two digests — and states more precisely what an
instruction is. Dropping them was the alternative and it was refused: they are the
executable form of the defect the whole identity design exists to fix.

## Consequences

- `CONTRACT_VERSION` 2.6.0 → 2.7.0; `SUPPORTED_CONTRACT_VERSIONS` five → six;
  `API_CONTRACT_VERSION` 0.17.0 → 0.18.0; `LEDGER_CONTRACT_VERSION` follows the first
  by derivation; `TASK_INTAKE_CODES` nine → ten. The ADR corpus 93 → 94; the decision
  register 95 → 98. `PATH_SCOPED_LAWS` stays 145; `CONTRACTS_SCHEMA_EXPORTS` stays
  150; `MIGRATIONS` 21 and `PROJECTOR_VERSION` 1 are untouched. No table, no
  projection, no watermark: a field on an issued shape adds none.
- Every envelope fixture in the repository now states its content. That is twenty-odd
  files, and the reason it is not more is that most consumers name the version by
  symbol rather than by literal.
- A fixture holding a `2.6.0` envelope no longer parses. Declared rather than
  mitigated: the alternative is a producer that may choose between two versions, which
  is what `AdmittedContractVersion` exists to prevent.
- `edges/telemetry/test/testing/index.ts` keeps a comment naming `"2.6.0"`. It is an
  epoch record of P-32/B and its fixture pins `2.2.0`, which is still supported, so
  nothing there breaks and nothing there is rewritten — the same append-only treatment
  the prose of earlier ADRs gets.
- What C inherits is unchanged and now reachable: resolve each reference through the
  plane's read verb with the task's scope, check the digest and the length against
  what was declared, compose what crosses the adapter boundary on the private side,
  record the prompt occurrence, answer `UNSUPPORTED` for a modality the route cannot
  transport — and retire `objective`, which is the field this record deliberately kept
  alive.

## Not in this record

- `instructionFor`, the resolution of a reference, the composition that crosses to the
  adapter, the prompt occurrence and the modality preflight: escalón C.
- The daemon child taking its envelope from a recorded reference rather than from its
  configuration: P-15, as adoption.
- The output contract and the response occurrence: §4.2, P-07.
- Whether a later revision must keep its predecessor's content: neither dictated nor
  invented here.

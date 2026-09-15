# ADR 0093 — An instruction's content is an ordered list of discriminated blocks, contract v1

- Status: accepted (P-06 escalón A, recorded 2026-09-14).
- Supersedes: none.
- Superseded-by: none.
- Amends: none. Two readings of the specification, which is read and not edited.
  Contratos §4.1 `:175-177` describes defect N02 as "el stream termina en
  `completed` sin que la instrucción haya salido"; that was true until V2-B1c and is
  no longer, because the instruction does reach the model — `instructionFor` →
  `ExecutionRequest.instructions` → `SessionRequest` → the child's stdin. What is
  missing is its **shape**, and that is what this record fixes. And §4.1 `:188` makes
  a reference obligatory for "todo lo que no sea texto corto" without giving a
  number; the number is decided here (Four).

## Context

An instruction today is one string. `instructionFor(envelope)` returns
`envelope.objective`, bounded `min(1).max(4_000)`, and the transport carries it to
the child unchanged. That is enough to ask a model for work in prose, and it cannot
express anything else: no image, no document, no result of a tool call, and no way to
name a piece of the instruction in order to refer back to it.

Contratos §4.1 fixes the shape that can. `content_contract_version = 1`, "una **lista
ordenada** de bloques discriminados", and the sentence that explains why the shape is
in this package at all: "No hay tres formatos por cliente." CLI, API and local agree
on one list or they agree on nothing. Each block carries a `kind` from a closed union,
a `block_id` stable within the list so a block can be referenced, an `artifact_ref_id`
that is **authorized por ocurrencia** and obligatory for everything but short text, a
`media_type` validated **against the class**, a `byte_length` validated against the
profile, and the `content_sha256` of the bytes it describes. The aggregate of a request
may not exceed the admitted contract's quota; inline data exists only on the private
side of the adapter boundary, never in an event, the public stream or a trace; the text
is obligatory and an unselected modality is refused at the preflight; a `tool_result`
references its tool call and its `effect_id`; and a variant's fields are strict, with
no vendor fields.

The map cut P-06 into three: the contract (A), the content in the envelope and
published by both real doors (B), and the private resolution with the composition that
crosses to the adapter (C). The DT adjudicated that cut and its six questions. This
record is A, and A is deliberately the smallest of the three: a payload grammar with
no producer and no consumer.

## Decision

**One — a new kernel concept, `content-block`, and one shape for three clients.**
`InstructionContent` is `{ contentContractVersion, blocks }` and nothing else:
`z.literal(1)` for the version, and an ordered `z.array(ContentBlock)` of 1 to
`CONTENT_BLOCK_LIST_MAX` for the list. Strict at every level, so a producer that grows
a field fails at the boundary rather than carrying it. There is no per-client variant
and no escape hatch, which is §4.1 `:182-183` as a type.

**Two — the block, closed, with every key present.** `kind`, `blockId`, `mediaType`,
`byteLength`, `contentSha256`, `artifactRefId`, `text`, `toolCallId`, `effectId` —
each required, none optional, and the ones that do not apply to a kind are `null`
rather than absent. Present-as-null is `effectiveTo`'s standing precedent in this
repository: a key that is sometimes missing is a key two readers disagree about.
`text` is the only place content travels inline, and it belongs to `text` blocks and
to no other kind; `toolCallId` and `effectId` belong to `tool_result` and to no other
(§4.1 `:204`). Both rules are stated in both directions, so a `tool_result` without
its links and an `image` carrying them are each refused.

**Three — the media type is validated against the class, from a table.**
`CONTENT_MEDIA_TYPES_BY_KIND` is data, not a regex: §4.1 `:189` asks for a media type
"validado contra la clase", and that is a relation rather than a format — `image/png`
is a correct media type and the wrong one for an `audio` block. Keeping it as a table
means the schema and the `ContentMediaType` union are derived from one source and
cannot disagree about which pairs exist.

**Four — "short text" is 4.000 characters, and the number is not new.**
`CONTENT_INLINE_TEXT_MAX_CHARS = 4_000` (the DT's Q1). `TaskEnvelope.objective` and
`ExecutionRequest.instructions` both carry `min(1).max(4_000)`, so this **names a
policy a real door already applies** instead of inventing a second one that could
disagree with it. Everything that is not short text carries an authorized reference,
which is how the bytes are reached; knowing a digest grants nothing (artifacts §2, and
execution `:112` for the envelope's own reference).

**Five — the bounds have their unit in their name, and the policy in force wins.**
`CONTENT_ARTIFACT_MAX_BYTES` (8 MiB), `CONTENT_METADATA_MAX_BYTES` (256 KiB),
`CONTENT_TOOL_RESULT_MAX_BYTES` (1 MiB) from tests §9.5, and
`CONTENT_REQUEST_AGGREGATE_MAX_BYTES` (8 MiB) for §4.1 `:196-197`. Tests §9.6 rule 1
governs where a number meets code — if a policy already in force is more restrictive,
the policy in force wins — which is why inline text is bounded at 4.000 characters and
not at the 256 KiB a metadata request may carry.

A consequence worth stating rather than discovering later: the per-block artifact
ceiling and the request aggregate are the **same** number, so an artifact at exactly
8 MiB can never be sent, because the mandatory text block pushes the total past the
aggregate. That is the aggregate rule biting exactly as §4.1 `:196-197` asks — "refused
even though every block fits" — and the suite asserts which of the two words comes
back, because *which rule refused* is the evidence that the two are independent. If a
later packet wants a maximum-size artifact to be sendable, it raises the aggregate
deliberately, with a decision row; it does not discover the interaction in the field.

**Six — the three rules that belong to the list.** A `blockId` names one block, so a
duplicate is refused (§4.1 `:187`: stable *and* referenceable implies unique). At
least one block is `text`, because §4.1 `:202-203` makes the text obligatory and a list
of attachments with nothing said is not an instruction. And the aggregate is checked
across the list, which no per-block rule can see. `CONTENT_BLOCK_REFUSALS` names ten reasons, on
`GLOBAL_ASSIGNMENT_REFUSALS`' and `PRICE_TABLE_REFUSALS`' shape, because a refusal a
caller branches on has to be a word and not a sentence. No value is echoed, and the
package's standing credential guard is attached, so credential-shaped material in a
block fails closed without appearing in the message.

**Eight of the ten travel at the head of an issue's message; two do not, and that is
deliberate.** `BLOCK_KIND_UNKNOWN` and `VENDOR_FIELD_PRESENT` are enforced by the shape
itself — the closed `z.enum` on `kind`, and `strictObject` — so they are refused before
any refinement runs and surface under zod's own codes: `invalid_value` at
`blocks.<i>.kind`, and `unrecognized_keys` at `blocks.<i>` with the offending keys
named. The vocabulary lists them anyway, because **the reason is part of the contract
even when the word rides in no message**: a reader of `CONTENT_BLOCK_REFUSALS` learns
that an unknown kind and a vendor field are refused, and the suite pins each to the zod
code it actually produces, so the reason is checkable in both cases.

No error map is added to translate those two into their words. A custom map would exist
only to make the vocabulary look uniform, at the cost of a second translation layer to
keep in step with zod's codes — and there is no caller yet whose branching could want
it. zod's codes are already precise about which rule refused, and B is where a real
door will say what, if anything, it needs beyond them.

**Seven — over a bound is a refusal, never a truncation.** Stated because the opposite
is the tempting implementation. `ExecutionRequest.instructions` already refuses over
its bound, with the reason written down: "an adapter that shortened an instruction
would be inventing a policy about what the model was asked". A content contract that
clamped a `byteLength` would be doing the same thing one layer earlier.

**Eight — every type of the concept is declared in its type leaf, and the schemas are
renamed so that it can be.** `content-block/types/index.ts` holds all five:
`ContentBlockKind`, `ContentMediaType` and `ContentBlockRefusal`, each derived from a
closed value in the module, plus `ContentBlock` and `InstructionContent`, each `z.infer`
of a schema. That is §7.1's `kernel` row applied literally — "schemas por recurso, con
sus alias de tipo en la hoja de tipos del recurso" — and `price-catalog/types/`'s living
shape for the derivation.

The values are therefore named `ContentBlockSchema` and `InstructionContentSchema`.
**A value and a type may not share one name across two files**, and that is a compiler
fact rather than a preference. Three probes, run with `tsc` and no zod involved:

- the module re-exporting the leaf's type under its const's name →
  `TS2323: Cannot redeclare exported variable`, plus `TS2300` at the barrel;
- only the barrel merging a value from one file with a same-named type from another →
  `TS2300: Duplicate identifier`;
- the merged idiom in one file, this package's current shape → compiles.

And inside the leaf, `import type { X }` beside `export type X` is
`TS2440: Import declaration conflicts with local declaration`.

What those probes demonstrate is precisely bounded, and the first version of this record
over-read them: they are facts about a **merged name**, not about the concept. Renaming
the value dissolves the merge, so the type lands in the leaf where the law puts it and
none of the three errors applies — the leaf imports the schemas type-only, the module
imports no value from the leaf, and there is no runtime cycle. §7.2 governs the
direction of that dependency; it grants no exception to §7.1, and this record no longer
claims one.

**Scope: this concept alone.** The package's other modules keep their 62 merged
`const X` + `type X` names. Renaming them would be a general reform of a frozen surface,
which nobody adjudicated and which C-3 / P-37 deliberately did not open. What the next
kernel resource inherits is the pattern, not a migration: name the schema `…Schema`,
put every type in the leaf, and the question never arises.

**Nine — L-P06A-1, and no caller.** No `src/` outside the concept — the module **and**
its type leaf — and this package's two barrels imports the module's path or names
`InstructionContent`. Scoped over the concept and not over one file, which is C-3 /
P-37 seam 1's adjudicated mould (decision 91). The law admits **no caller at all**,
like L-P33B-1 and unlike L-P32B-1: the envelope carries no content until B, so a caller
today would compose a payload no door validates — and a second producer of a content
list is precisely the three formats per client that §4.1 forbids.
`PATH_SCOPED_LAWS` 144 → 145.

**Ten — no bump.** No table, no migration, no event type, no document kind and no door
is new. `CONTRACT_VERSION` stays `"2.6.0"`: the content enters `TaskEnvelope` in B, and
B is the escalón that moves the version with the three envelope-identity vectors
(consequence V3 of ADR 0076, decision 85's shape), because objective and authority — and
then content — enter the envelope preimage (§3 `:144-147`).

## Why the content was not left as a second field beside the objective

Adding `contentBlocks` next to `objective`, with the objective still carrying the
prose, would have avoided touching the instruction producer at all. It was rejected
because it makes two authorities on the same question: a reader would have to know
whether the instruction is the objective, the blocks, or the objective followed by the
blocks, and the three answers differ. §4.1's "no hay tres formatos por cliente" is
about clients, but the same sentence applies to one client with two fields.

## Why the aggregate was not folded into the per-block ceiling

One number would be simpler, and it cannot express the rule. §4.1 `:196-197` asks for a
refusal of the request "aunque cada bloque quepa": a hundred blocks inside their own
ceiling can still exceed what the admitted contract allows. Folding the two would make
the second sentence unstatable, which is why they are separate constants with separate
refusal words — and why the suite asserts which word comes back.

## Why a hand-written base type with `satisfies` was not chosen

It is §7.1's literal escape for the cycle case — "el tipo base va a `types/` y el schema
lo satisface" — and it would have put every declaration in the leaf. It was rejected
because it creates **two authorities on one shape**: a hand-written type and a zod
schema, tied only partially by `satisfies`, free to drift in everything `satisfies` does
not check. This repository's whole objection to duplication is that two copies of a rule
eventually disagree, and paying that to satisfy a filing convention is more expensive
than the disease. The DT rejected it on the same ground.

## Consequences

- `PATH_SCOPED_LAWS` 144 → 145; the law is amended in its own row rather than joined by
  a second, so the count moves once. `CONTRACTS_SCHEMA_EXPORTS` +18 — eleven values, two
  schemas and five types. The ADR corpus 92 → 93; the decision register 93 → 95. Nothing
  else: a payload grammar adds no schema object, no projection and no watermark.
- **Nothing validates content yet.** That is the intended state and the law enforces
  it. A reader of this package finds the contract, the law and this paragraph, in that
  order.
- What B inherits is specific: put the content in `TaskEnvelope`, accept the bump and
  the three envelope-identity vectors with it, validate the blocks at both real doors,
  publish the artifacts the non-text blocks reference under the task's scope, bind their
  references, and amend L-P06A-1's row to admit the doors it wires.
- What C inherits: resolve each reference through the plane's read verb with the task's
  scope, check `contentSha256` and `byteLength` against what was declared, compose what
  crosses to the adapter on the private side only, record the prompt occurrence, and
  answer `UNSUPPORTED` at the preflight for a modality the route cannot transport.
- A fixture holding an instruction as a bare string keeps working until B, because
  nothing reads this contract yet. From B it does not, and that cost is B's to declare.

## Not in this record

- The content inside `TaskEnvelope`, the `CONTRACT_VERSION` bump and the two doors'
  validation: escalón B (the DT's Q2, Q3).
- Resolution, composition to the adapter, the prompt occurrence and the modality
  preflight: escalón C (Q4, Q5, Q6). The acceptance proof of §4.3 — a child that
  returns what it received, from the real CLI and API — is C's.
- The neutral capability record of §2.0 with `origin_kind` and evidence: P-22/P-23.
- Reading the envelope by reference from the daemon's child, which takes it from its
  configuration today: P-15, as adoption.
- The output contract v1 and the response occurrence: §4.2, P-07.

# ADR 0097 — A result is an ordered list of output blocks under its effect, contract v1

- Status: accepted (P-07 escalón A, recorded 2026-09-22).
- Supersedes: none.
- Superseded-by: none.
- Amends: none. `L-P06A-1` is amended in its own fence row.

## Context

Contratos §4.2 `:208-219` is frozen. An effect's result is its `effect_id`, a
`status`, the **ordered list** of output blocks and a usage reference, and `SUCCEEDED`
demands a valid, recoverable result. The section also asks for three more things:
replay and conflict on the effect's digest; three facts kept apart (transport success,
process termination, operation result); and a tool result flagged as an error to
produce `FAILED`.

The P-07 map cut the packet into four escalones. A freezes the shape and holds it
inert. B gives the effect's outcome the result's reference and digest. C delivers
output bytes to a private sink. D assembles and publishes the document. The DT's
adjudication v2, after Fable's preaudit, fixed the choices A depends on: C3, C4 and
C5, plus the preaudit's D3 and D6. The DT's answers to the brief's Q-A1..Q-A5 close
the rest.

## Decision

**One — the concept `result` has one shape.** `ResultContractSchema` is a
`strictObject` with exactly five keys, all required:

- `resultContractVersion: 1`;
- `effectId`;
- `status`;
- `blocks`;
- `usageReference`.

Its vocabulary values and the schema live in `schemas/result/index.ts`. All three
types are in `schemas/result/types/index.ts`, on the kernel precedent of
`content-block` (ADR 0093 Eight): `ResultStatus`, `ResultRefusal`, and the inferred
`ResultContract`.

**Two — the blocks are the content contract's blocks.** `blocks` is
`z.array(ContentBlockSchema)`. §4.1 says "no hay tres formatos por cliente", and an
output block of its own would be one more format (D3). Every block rule is inherited
and surfaces under `blocks.<i>` with the content contract's words: the kind, the
media type against the kind, a reference for everything but short text, the declared
length, the per-kind ceiling, and the tool-result links. All five kinds are admitted
(Q-A3). Only `text` and `document` have a producer in P-07, and narrowing the kinds
now would force a version move later to widen them again.

**Three — status is two words.** `SUCCEEDED` and `FAILED` (D6). `CANCELLED` and
`OUTCOME_UNKNOWN` are outcomes of an effect, not of a result, and B refuses a result
recorded on either (C2). `SUCCEEDED` carries at least one block
(`RESULT_BLOCKS_REQUIRED`, Q-A2), so an empty answer is `FAILED`. `FAILED` may carry
no block at all.

**Four — the usage reference is the effect's id.** Economy §2.1 settles usage per
effect, so `usageReference === effectId`, and any other value is refused as
`USAGE_REFERENCE_MISMATCH` (C5). The field is kept rather than dropped because §4.2
names it.

**Five — how a long answer is represented (C4).**

- Output text over the inline bound is split into text blocks of at most 4 000
  characters, up to the list's ceiling of 100 blocks.
- Beyond that, the answer is one `document` block by reference.
- It is never truncated: over any bound is a refusal.

The list declares its own ceilings. `RESULT_BLOCK_LIST_MAX` aliases
`CONTENT_BLOCK_LIST_MAX` (a count for a count), and `RESULT_AGGREGATE_MAX_BYTES`
aliases `CONTENT_REQUEST_AGGREGATE_MAX_BYTES` (bytes for bytes, Q-A5). They are
aliased rather than restated, so the two lists cannot drift apart by a number.
Choosing between chunks and a document is the assembler's rule in escalón D, not a
schema invariant. So a result that carries both text and a document is lawful here
(Q-A1).

**Six — the tool-error rule.** The operative rule is (iii): the provider's terminal
flag, downstream in C and D. Rule (i), a `tool_result` output block flagged as an
error, is **inert** in P-07. No tool-call effect with an `effect_id` exists in the
ledger (`EXECUTION_EFFECT_KINDS` is `model_execution`), and a `tool_result` output
block has no producer. So the schema carries no such refinement and no test pretends
it does (C3). Its precondition is named: a producer of tool-call effects and of
`tool_result` output blocks.

**Seven — the laws.**

- **`L-P07A-1`** (new, path-scoped): the result contract is named by its own concept
  and the contracts barrels, and by nothing else. It is inert until D's assembler
  consumes it and amends the law in its row.
- **`L-P06A-1`** is amended in its own row to admit `schemas/result/index.ts` as a
  caller. That module is a **consumer of the one shape and builds no content list**,
  which is D3's reading of §4.1.
- **`L-P06C-1`** is untouched by construction. The result module's code names neither
  a block's reference field nor an instruction's content list, so the containment law
  that keeps resolved blocks out of records has nothing to admit.

**Eight — no bump.** The document carries its own `resultContractVersion: 1`, and no
event, table or preimage carries it yet. So `CONTRACT_VERSION` stays 2.7.0, and
`SUPPORTED_CONTRACT_VERSIONS` keeps its six members: ADR 0093 Ten's reason. B, which
puts the result's reference and digest on the effect's outcome, moves the version
to 2.8.0.

## Why a separate output block was not chosen

A block of its own for output would repeat the content block's kinds, media types,
bounds and reference rule. The first difference between the two would then be a
second format for the same bytes, which §4.1 forbids. Reusing `ContentBlockSchema`
makes that divergence impossible rather than merely discouraged.

## Consequences

- `CONTRACTS_SCHEMA_EXPORTS` 151 → **160**:
  - values: `RESULT_CONTRACT_VERSION`, `RESULT_STATUSES`, `RESULT_BLOCK_LIST_MAX`,
    `RESULT_AGGREGATE_MAX_BYTES`, `RESULT_REFUSALS`, `ResultContractSchema`;
  - types: `ResultStatus`, `ResultRefusal`, `ResultContract`.
- `PATH_SCOPED_LAWS` 146 → **147** for `L-P07A-1`.
- The ADR corpus 96 → 97.
- No version moves: not `CONTRACT_VERSION`, `API_CONTRACT_VERSION`, `MIGRATIONS` or
  `PROJECTOR_VERSION`.

## Not in this record

- B: the effect outcome's result reference and digest, replay and conflict on that
  pair, and the version move.
- C: output bytes to the private sink, and the process and operation facts.
- D: the assembler, the chunk-or-document rule, and publishing the document.
- P-15: coupling the effect's result to the task's terminal state, and wiring the
  sink in the daemon.
- A producer of `tool_result` output blocks, and rule (i) with it.

# ADR 0096 — The API and local legs carry the composed instruction, and the prompt occurrence is closed by construction

- Status: accepted (P-06/CORR, recorded 2026-09-22).
- Supersedes: none.
- Superseded-by: none.
- Amends: `0095-the-instruction-is-resolved-on-the-private-side-of-the-adapter-boundary.md`,
  by an errata section only: its "not a live defect" and its assignment of
  "threading an instruction into `ApiStreamRequest`" to the API transport's own
  packet no longer hold. `L-P06C-2` is amended in its own fence row.

## Context

The Codex audit of the P-06 pause (2026-09-15) found four things, and the
correction map reproduced each of them at `2a9531a` before a line was changed.

**F1.** `buildPromptOccurrenceEvent` built its record as `{ ...occurrence }`.
TypeScript checks excess keys on an object literal, not on a variable, so a value
typed as `PromptOccurrenceRecord` can carry more keys than the record declares,
and a spread copies every one of them. The ledger's reader refuses that event by
name (`payload.promptOccurrence.<key>`), so the producer built an event its own
consumer rejects — the late discovery the `L-P06C-2` docblock warns about. The fence
checked the **declared** names and not the **built** object. No append site exists
yet (P-15), so nothing leaked into a ledger.

**F2.** The execution port's API and local legs built
`{ model, taskId, attempt, identity }` and read neither `asked.instructions` nor
`asked.modalities`. So a request with `["text", "image"]` was admitted and the
client was called, and the instruction reached no client at all. ADR 0095 recorded
the missing instruction as "not a live defect: the shipped capability policy admits
no API transport". That holds for `resolveRoute`, but the daemon executes the route
in its configuration and does not re-resolve it: the R6 drills drive `startDaemon`
with an `API_KEY` route and an injected client through to `CHECKPOINT_WRITTEN`. The
defect was reachable through the composition root.

**F3.** Three declarations were added inline in P-06/C: `PromptOccurrenceRecord`
and `BuildPromptOccurrenceInput` in the runtime's events module, and
`ComposedInstruction` in the daemon's composition module. The owner law in
`docs/audit/architecture/index.md` §7 puts a concept's declarations in its own leaf.

**F4** is about method (a write outside the declared set, and a `git stash`), and
is answered by how this correction was carried out, not by a line of code.

## Decision

**One — the occurrence record is closed by construction.** The builder writes an
explicit literal of exactly the thirteen names, typed as `PromptOccurrenceRecord`,
so a missing or an extra name is a compile error, and a key the input carries beyond
them is never read. The single authority for the thirteen stays the ledger's grammar,
`PROMPT_OCCURRENCE_RECORD_KEYS`: no Zod schema is added in contracts or runtime,
because that would be a second authority for the same set (decision 45's class). The
ledger barrel exports that list, on `TASK_INTAKE_PAYLOAD_KEYS`' precedent, so the
producer's suite compares the produced key set with the door's grammar instead of
restating it. The reader stays internal, so that key equality is the grammar test.
`L-P06C-2` now also reads the builder: the literal's names must be the grammar's,
the payload must carry that literal, and a spread in the builder fails.

**Two — the API and local legs carry the composed instruction.** `ApiStreamRequest`
and `LocalChatRequest` gain `readonly instructions: string` as their fifth member,
and each leg passes `asked.instructions` through verbatim, so `L-B1C-1` still counts
one producer. The `API_CLIENT_SHAPE` and `LOCAL_CLIENT_SHAPE` pins move 4 → 5, which
is the deliberate, reviewed act those pins exist to force. The instruction is content,
not a credential, and the pins' purpose — no field a credential could travel in —
holds because of Three.

**Three — they refuse what they cannot carry, before the client is called.** After
the route is admitted (the reattach refusal stays each leg's first statement, so
`L-B4A-3` is intact) and before any client request is built, one private helper
serves both legs. First, a request naming any class other than `text` is refused.
Then the instruction gets the same `findCredentialViolations` scan `startSession`
runs before it writes to a child, and a hit is refused. Both answers are
`TRANSPORT_UNAVAILABLE` — the `ExecutionRefusal` member the CLI leg already returns
for both conditions — with `at` naming the field: `request.modalities`,
`request.instructions`. No refusal name is added, and a refusal makes zero client
calls.

**Four — only three declarations move.** `PromptOccurrenceRecord` and
`BuildPromptOccurrenceInput` go to `packages/domains/runtime/src/core/events/types/index.ts`,
and `ComposedInstruction` goes to the daemon's existing
`packages/entrypoints/daemon/src/composition/types/index.ts`. Each module imports
them type-only and re-exports them with `export type`, so no importer changes and no
barrel moves. The P-06/C v4 adjudication deferred the two runtime types to P-37;
that deferral is superseded, because an owner law's antecedent is debt, not
permission. `BuildEventInput` stays inline: that one is historical P-37 debt.

**Five — what §4.3 proves at P-06, and what is P-15's.** Contratos §4.3 asks for a
child that returns what it received, driven from the real door, CLI and API. At the
transport boundary and the composition root, that is proven here:

- The port suite drives both non-CLI legs with synthetic recording clients.
- The daemon drill that used to assert the API request carried no instruction now
  asserts it carries exactly the composed one.
- A `startDaemon`-level synthetic API client echoes what it received, which equals
  the instruction `instructionFor` composed. Beside it, a non-text class is refused
  before the client with zero calls.

The path intake door → recorded envelope read by reference → child is **P-15's**, as
the P-14 row, the P-15 row and ADR 0095's "Not in this record" already assign. This
record does not relocate it: the daemon takes its envelope from its configuration,
and nothing reads a recorded intake back into a walk. Real HTTP and local clients,
and the real smoke, are P-15's too.

## Why a runtime pick over the imported keys was not chosen

`Object.fromEntries(PROMPT_OCCURRENCE_RECORD_KEYS.map(...))` would close the record
at run time, but it loses the typing: a renamed field would compile and be emitted as
`undefined`. The typed literal fails at compile time on both a missing and an extra
name, and the fence ties the literal's names to the grammar.

`CAPABILITY_UNSUPPORTED` was the plausible alternative for the modality refusal. It
would make the API and local legs answer differently from the CLI leg for the same
condition, and one condition should get one answer at this boundary.

## Consequences

- The two client request shapes have five members; the fakes in
  `providers/test/testing` ignore the request and are unaffected.
- A credential-shaped instruction is refused on every leg before it reaches a
  process or a client.
- No contract version moves: `ExecutionRequest` already carried both fields, and
  `CONTRACT_VERSION` 2.7.0, `API_CONTRACT_VERSION`, `MIGRATIONS` 21 and
  `PATH_SCOPED_LAWS` 146 are untouched. `@acp/ledger` gains one public name,
  `PROMPT_OCCURRENCE_RECORD_KEYS`. The ADR corpus 95 → 96.
- The drills prove the instruction crosses. They claim no useful result from a
  stream: the output contract is P-07's.

## Not in this record

- The intake-door-to-child path, real API and local clients, the daemon composing the
  local transport, and the real smoke: P-15.
- Appending the prompt occurrence: P-15, as ADR 0095 records.
- Any transport of a non-text class: every one is still refused.
- `INSTRUCTIONS_MAX_CHARS` measuring characters against a byte aggregate, and the
  retirement of `objective`: carried over, not decided here.
- The output contract and the response occurrence: §4.2, P-07.

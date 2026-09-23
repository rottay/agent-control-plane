# ADR 0100 — An effect answers with a published result and its response occurrence

- Status: accepted (P-07 escalón D, recorded 2026-09-23).
- Supersedes: none.
- Superseded-by: none.
- Amends: the "no new name on the ledger's barrel" sentences of ADR 0084
  Consequences and ADR 0098 Consequences, for `effectOutcomeArrival`,
  `EffectOutcomeArrival` and `RESPONSE_OCCURRENCE_RECORD_KEYS` only.
  `L-P07A-1`, `L-P06C-1` and `L-P07C-1` are amended in their own fence rows.

## Context

Escalón A fixed one shape for an effect's result (ADR 0097). Escalón B made the
effect's outcome carry it by reference: `SUCCEEDED` needs a pair naming a
published `RESPONSE` of the task, and the ledger's `effectOutcomeArrival` decides
whether an arriving outcome writes, replays or is refused (ADR 0098). Escalón C
split what the port says into three facts —transport, process and operation— and
moved output text to a private sink that `start` receives (ADR 0099).

Nothing yet joined them. No code decided the operation's outcome from the three
facts, built a result document from the output, published it, or recorded the
answer's occurrence. The P-07 adjudication v2 set the rules (C8–C10, D7–D10), and
the DT's answers to the brief closed the open questions (Q-D1 to Q-D9 and
`OUTPUT_UNREADABLE`).

Four constraints shaped the design:

- A sink that throws fails the provider session as `MALFORMED_EVENT`, and the
  three facts are lost (ADR 0099 Three).
- The ledger door checks a result pair against the published reference, and then
  runs `effectOutcomeArrival`. A copy of that comparison in the runtime would be a
  second authority, which is what B removed.
- A marker makes a step impossible to re-run. A resumed walk that finds a
  verified marker never re-enters `apply` (the L-B7T-3 reason).
- Output bytes may reach the private plane and nothing else: no event, no marker,
  no log and no error (L-P07C-1).

## Decision

**One — the outcome is decided once, over the three facts.** The runtime concept
`operation-result/` reads a trail by `kind` alone. `state.toState` is never a
verdict. A second terminal, exit or verdict is refused rather than overwritten.
Only a `completed` terminal is decided:

| Operation | Process | Outcome | Reason |
| --- | --- | --- | --- |
| `FAILED` | any | `FAILED` | `OPERATION_FAILED` |
| `SUCCEEDED` | exit 0, or not observable | `SUCCEEDED` | `OPERATION_SUCCEEDED` |
| `SUCCEEDED` | another exit code, or a signal | `FAILED` | `PROCESS_ABNORMAL` |
| not observable | any | `FAILED` | `OPERATION_NOT_OBSERVED` |

The crossed pairs are `FAILED` (Q-D1). The reason vocabulary is closed:
`NO_OUTPUT`, `OPERATION_FAILED`, `OPERATION_NOT_OBSERVED`, `OPERATION_SUCCEEDED`,
`OUTPUT_OVER_PROFILE`, `OUTPUT_REFUSED`, `OUTPUT_UNREADABLE` and
`PROCESS_ABNORMAL`. `OUTPUT_UNREADABLE` is its own word, because a sink fault is
not a guard refusal.

**Two — the assembler, under the C4 rule.** The output is cut into chunks of at
most 4 000 UTF-16 units. A surrogate pair is never split: an astral character that
would straddle the boundary moves whole to the next chunk.

- Up to 100 chunks become 100 `text` blocks, `output-001` onwards. Each carries all
  nine keys, and `artifactRefId`, `toolCallId` and `effectId` are null.
- Past 100 chunks, the whole output becomes one `text/markdown` document,
  published first. The result then holds one `document` block that names it by
  reference.
- Never both.

Three cases publish nothing:

- **Too large.** More than 8 MiB is `FAILED` with `OUTPUT_OVER_PROFILE`, and
  nothing is truncated.
- **Credential-shaped.** The credential guard reads the whole output before it is
  cut, so a credential split by a chunk boundary is still caught. A match is
  refused as `OUTPUT_REFUSED`: never published and never redacted (D10). The same
  applies when the result contract refuses the document.
- **Empty.** A `SUCCEEDED` operation with no output is `FAILED` with `NO_OUTPUT`,
  never a `SUCCEEDED` with zero blocks. A `FAILED` operation with no output keeps
  its own reason.

A `FAILED` operation that produced output gets its document, with status `FAILED`
(Q-D9).

**Three — the publisher asks the ledger first, and publishes before anything
references the result.** `publishResult` follows five steps:

1. It reads the effect and refuses `EFFECT_UNKNOWN` if the ledger does not hold it.
2. It builds the candidate arrival. That is the status, the digest just computed,
   and the stored reference if one exists, since a new reference is unknowable
   before publishing.
3. It calls `effectOutcomeArrival`, exported from the ledger barrel and called,
   never mirrored.
4. On `refused`, it raises `CONFLICT` carrying the ledger's own `path` and
   `message`, before a byte moves.
5. On `replay`, it returns the stored pair and publishes nothing. On `write`, it
   publishes the overflow document if there is one, then the result document.

The result is a `RESPONSE` artifact: `INTERNAL`, `TASK` scope, `SCOPE_EQUALITY_V1`,
`PERMANENT` retention with no expiry (the intake precedent, Q-D4), and media type
`application/json`. Its keys are `<effectId>/result|output/<sha256>/intended|succeeded`.

A publication interrupted after its intention resumes the recorded intention: its
reference and command, not the second call's.

Without a document there is no pair. Reference, digest and length are then null
together, and never half of them.

**Four — the execution effects hold a collector whose sink never throws.** When a
result recorder is given, `apply` builds a private collector and passes its sink as
`start`'s third argument. Without a recorder, `start` keeps its two arguments, and
the trail, the marker bytes and `eventCount` are what they were (C9).

The sink's whole body is one `try … catch`:

- past 8 MiB it stops retaining and marks the output `OVER_PROFILE`;
- a delta that is not a string, or a fault inside it, marks the output
  `UNREADABLE`;
- it never rethrows.

The recorder is called once, with the operation index, the three facts, the whole
output and its condition. The call happens on the `completed` branch only, after
the refusal that settles every other terminal (Q-D6), and before the conformance
gate and the marker. A recorder that throws leaves no marker, so the effect
re-executes. That is the usage sink's mould.

**Five — the response occurrence is closed by construction.**
`buildResponseOccurrenceEvent` refuses a V1 invocation by name. It builds its
record as one typed literal of the ledger's five keys:

- `occurrenceId`;
- `promptOccurrenceId`;
- `responseSha256`, which is the published `RESPONSE`'s `content_sha256` (D10);
- `responseBytes`;
- `redactionVerdict`.

A value typed wider than the record yields exactly those five. The builder carries
a present-but-invalid field as given, and the door's grammar judges it. No outcome
builder lands in D (Q-D5): the drills append `DISPATCH_OUTCOME_RECORDED` through
the door with the pair the publisher returned.

**Six — the laws.**

- **`L-P07A-1`**, amended in its row. The runtime's `operation-result/` module and
  its type leaf are full sites: the assembler consumes the contract. The concept is
  named `operation-result` and not `result` so that its own path does not match
  the law's path pattern. `execution-effects` names no contract word.
- **`L-P06C-1`**, amended in its row. `operation-result/index.ts` is the one
  producer of output blocks. It writes `artifactRefId` and never `content.blocks`.
  L-P06A-1 is untouched.
- **`L-P07C-1`**, amended in its row, in three parts:
  - `execution-effects` joins the output sites, which makes eight;
  - `collectOutput`, `assembleResult` and `publishResult`, with their helpers
    `textBlock`, `documentOf`, `publishDocument` and `publicationRequest`, name no
    recorder, no occurrence builder, no append and no usage or pressure sink;
  - **F1** reads the syntax tree of every tracked `src/` file and admits a
    three-argument `.start(` in `execution-effects` alone. It fails if that one
    call disappears while a recorder exists. It checks the call's shape: a `.start`
    or `["start"]` callee in a `.ts` or `.tsx` file with three or more arguments or
    any spread, and an aliased callee (`.bind`, a destructured `start`) is a stated
    limit it does not see.
- **`L-P07D-1`** (new, a name-set pin with no row). The response occurrence's
  declaration, its built literal and the ledger's grammar agree both ways. The
  builder spreads nothing, and no side names `identity`, `dispatchAttemptId`,
  `routeSegmentId` or `accountId`.
- **`L-P07D-2`** (new, path-scoped). The recorder is called once, after the
  refusal and before the gate and the marker. The collector's sink is one
  `try … catch` that names no `throw`.
- **`L-F4E-1`** reads the trail's anchor `await execute(input` as a prefix, since
  the call now also hands `execute` the collector's sink.

## Why a mirror of the ledger's comparison was not chosen

A runtime copy of `effectOutcomeArrival` would decide replay and conflict by its
own reading of the same rows. Two authorities agree only until one of them moves.
The function is exported and called instead. The suite proves where the verdict
comes from: a spy on the ledger barrel's export decides the runtime's answer
(N-P07D-19″).

The door cannot compare the literal candidate. It first checks that the named
reference holds the named bytes, and the stored reference does not hold the new
digest's bytes. So the door is asked about the nearest arrival it can compare: the
new bytes under their own reference. It refuses with the same comparison, at the
first member that differs. The runtime's refusal is the ledger function's own words
for the literal candidate.

## Why the result was not redacted

A credential in model output is refused whole (D10). Redacting would publish a
document that differs from what the model said, under a digest that the response
occurrence would then certify. `REDACTED` stays unreachable in D, and every
recorded verdict is `CLEAN`.

## Consequences

- `PATH_SCOPED_LAWS` 148 → **149** for L-P07D-2.
- The ADR corpus goes 99 → 100, and the decision register gains 113–115.
- These do not move:
  - `CONTRACT_VERSION` 2.8.0 and `MIGRATIONS` 22;
  - `CONTRACTS_SCHEMA_EXPORTS` 161;
  - `RUNTIME_PUBLIC_EXPORTS` 285: the runtime barrel exports nothing new (Q-D8),
    and the suites import the concept relatively.
- The ledger barrel gains three names. It has no equality pin.
- The execution-effects input gains an optional `recordResult`. The three
  construction sites that exist today do not pass it.
- The daemon drill reads the providers' captured streams through a computed
  import. The fixture belongs to a test project that is not composite, and a
  static import outside the daemon test project's root is refused by the compiler.

## Not in this record

The P-15 boundary:

- **Daemon.** The daemon appends no `DISPATCH_OUTCOME_RECORDED`,
  `PROMPT_OCCURRENCE_RECORDED` or `RESPONSE_OCCURRENCE_RECORDED`, and the
  production daemon passes no recorder (C9). The law that the production walk
  passes one is P-15's.
- **Reading and coupling.** There is no CLI or API read verb for the result. The
  task's `COMPLETED` or `FAILED` is not coupled to the effect outcome (C10).
- **Clients.** Real API and local clients, and their operation chunk (Q-C5), are
  P-15's.
- **Usage.** C's per-record usage double count stays P-15's (Q-C7). L-P32C-1 is
  not retired.
- **Recovery.** Crash recovery between publication and outcome is drilled here,
  but it is not boundary certification. That stays with P-18/recuperación.
- **Correspondence.** B15 stays open until P-15.

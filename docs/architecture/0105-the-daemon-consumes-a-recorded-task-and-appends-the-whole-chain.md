# ADR 0105 — The daemon consumes a recorded task and appends the whole chain

- Status: accepted in part (P-15 escalón D, sub-cut D1, recorded 2026-09-23). D is
  landed in four commits, D1 to D4; each adds its own section below, and this record
  is complete when D4 lands.
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0080 §4 and §5, by an errata section in that record (D1). The
  execution dictionary's §3, §4 and §7 are amended in place (D1).

## Context

P-15 escalón D closes the door-to-result case of `parallelism :143`: a task entered
through a real door is run by the real daemon, and the whole chain it produces — the
effect, the delivery and its price pin, the prompt, the usage, the result and the
answer — is read back from the ledger. D is the largest escalón of the program, so the
DT froze it in four sub-cuts, each deployable on its own:

- **D1** — the ledger's hardening, the opening's reuse rule, the recorded-task reader,
  and the intake → opening → discovery continuity with its recovery.
- **D2** — the usage widening and the vocabulary moves.
- **D3** — the chain in the walk, the failure branches, the evidence root, the recorded
  config form and the production wiring.
- **D4** — the door-to-result drill.

## D1 — decisions 132 to 135

### One — the reuse rule, and the three-event continuity (decision 132; C2)

A task the intake entered holds its `TASK_DISCOVERED` at revision 1, attempt 1, under
a flat attempt of its own, before any opening. Until D1 the ledger assigned every
opening `1 + MAX(attempt)`, so the opening of that coordinate would have been pushed
one past the intake, and one attempt would have carried two flat numbers.

- **The ledger door** (`#assertAttemptIdentity`): an opening whose coordinate already
  holds events reuses their flat attempt. Events of one coordinate at two distinct
  flat attempts refuse the opening by name, rather than choosing between them. A
  coordinate with no events keeps `1 + MAX(attempt)`. The fold never recomputed the
  assignment — it stores the flat attempt each event carries — so there is no fold
  mirror; the rule is the door's.
- **The producer** proposes by the same rule. The one producer that writes a
  coordinate before its opening is the intake, so a task whose first event is the
  intake of the invocation's coordinate is proposed the intake's flat attempt; every
  other opening is proposed `1 + latestAttempt`, as before.
- **The opening of an intake-first task** is the same event as the opening of an
  opening-first one — same transition, same index, so the same key and event id, same
  payload — out of `DISCOVERED` instead of out of no state
  (`INTAKE_ATTEMPT_OPENING_STEP`). The contract refuses a same-state event only for
  `TASK_STATE_CHANGED`. `nextStep` returns it for a revision-bearing walk that finds
  the task `DISCOVERED` with no opening under its V2 key, and the discovery after it.
- **Continuity** reads an intake-first task's first event as the intake — through the
  contract and then the fold's own `taskIntakePayloadOf` — because no invocation can
  rebuild it: the door wrote it, with the client's key and the resolution. Every fact
  the intake shares with the invocation is held to it: the task, the flat attempt, the
  instant the submission was taken at, the initiative and the revision record's five
  fields. A difference in any one refuses the resume. Then the opening, which the
  invocation does rebuild, is compared byte for byte, and the discovery as before.
- **Recovery** (`restateInvocation`) reads an intake-first task: the opening is found
  under its V2 key at the intake's coordinate, and its revision record must be the
  intake's, field by field (`DISCOVERY_UNREADABLE` at `attempt.opening.<field>`). B's
  N-B-8, which refused such a task by name until D, is inverted.

ADR 0080 §4 and §5 carry an errata pointing here.

### Two — the recorded-task reader (decision 133; C2)

`readRecordedTask({ledger, plane, taskId, route})`, a new runtime concept with its
type leaf (`runtime/src/recorded-task/`), reads a task the intake recorded back whole,
or refuses by a closed, sorted word: `ENVELOPE_DIGEST_MISMATCH`, `ENVELOPE_UNREADABLE`,
`INTAKE_UNREADABLE`, `ROUTE_DISAGREES_WITH_INTAKE`, `TASK_UNKNOWN`. It opens nothing,
reads no clock and writes nothing; the ledger and the plane are read ports.

1. The first event must be a `TASK_DISCOVERED` under `TASK_INTAKE_TRANSITION_ID` out of
   no state, of this task. The three revision fields a walk carries forward —
   `revisionId`, `envelopeSha256`, `envelopeArtifactReferenceId` — are read by name
   first, so an absent, null, empty or mistyped one is refused at its own path
   (N-D18); the rest is `taskIntakePayloadOf`'s.
2. The plane reads the envelope's bytes by the intake's reference, under the task's
   scope. They must parse as the contract's `TaskEnvelope`, hash with the ledger's one
   encoder to the intake's digest, and name this task and the intake's initiative. The
   plane's refusal is carried by name.
3. The revision is the intake's own; nothing is minted.
4. `submittedAt` is the intake event's `occurredAt`, recorded once and the same on
   every restart, and held to the canonical instant with the ledger's own `isInstant`
   (an offset or a missing millisecond is `INTAKE_UNREADABLE` at `intake.occurredAt`),
   because the catalog pin and the dispatch door downstream compare it as text; `attempt` is the intake's flat attempt; the submission digest is
   `canonicalSubmissionDigest` over the route the caller elected. A restart under
   another route derives another discovery, and continuity refuses it (N-D9).
5. The route must agree with the intake's resolution on the provider, the model alias
   and the transport. The account is the caller's election.

The route is a parameter in D1 and tested directly; D3's recorded config form passes
its own. The reader stays off the runtime barrel until D3, which owns the exports.

### Three — recovery holds the revision to the read model (decision 134; B's note N1)

`restateInvocation` accepted any non-empty text for the opening's `revisionId`,
`envelopeSha256` and envelope reference. It now reads the revision read model through
a new verb, `Ledger.getTaskRevision(taskId, revisionNumber)`, and a new
`LifecycleRecoveryPort` member, and holds the three to it field by field. A missing row
is `DISCOVERY_UNREADABLE` at `attempt.revision`; a difference is `DISCOVERY_UNREADABLE`
at `attempt.revision.<field>`.

**Not `SUBMISSION_DIGEST_MISMATCH`**, which the brief proposed; this record corrects the
brief's word, and the DT confirmed the correction. The submission digest's
preimage is the task, the attempt, the instant, the initiative and the route
(`runtime/src/submission`); no revision field enters it, so a revision the read model
disagrees with is not a digest disagreement. It is an opening this door cannot
attribute — the word decision 119, as corrected, gave an invocation id it cannot
attribute.

### Four — the ledger's hardening (decision 135)

- **The segment's transport** (C Fable (i)). The segment door refused nothing about
  `transportKind`; the fold read it as text. Now one reading, `segmentTransportRefusal`
  in the projection, refuses an absent, null, empty, mistyped or foreign word at
  `payload.segment.transportKind`: the door throws it, and `applyEventToSnapshot` throws
  the same issue, so a rebuild of a stored history holding one refuses by name in the
  door's words rather than projecting no segment and dying later on a foreign key
  (decision 56; Fable's post-audit C1). The segment fold reads the transport as a word
  of `TRANSPORT_KINDS`.
- **The transition's instants** (C Fable v2; the two-operand rule). `acceptedAt` and
  `terminalAt` are compared as text — P-18 orders them — so both are held to the
  canonical instant wherever either is compared: `dispatchOutcomeRecord`, which the
  door and the fold both read through, refuses a present value in any other spelling
  at its key — an offset, no milliseconds, a lowercase `z`, a date that does not
  round-trip, an empty string — and never normalizes it. `terminalAt` may be absent
  or null on a state that is not terminal; `acceptedAt` may be absent.
- **One instant check in the ledger package.** `isInstant` lives once, in
  `ledger/src/projection`, with its grammar private to it: exported for the door and on
  the ledger barrel for the recorded-task reader. Every other instant predicate of the
  package is folded into it: the door's own copy, the projection's outbox and model
  version copies, and — after the verifier's C1 — the usage observation's
  `occurredAt` check and the account-integrity activation instant, which tested the
  shape alone and so admitted a date that does not exist, such as February 30th. A
  grep of `ledger/src` finds no other instant predicate. The home is the projection
  because the door imports it, not the reverse. The claim is scoped to the ledger
  package (see "Not in this record").
- **A stored registry `effective_from` that is not canonical is reported.**
  `verifyIntegrity` already refused such a row: the document shape it reparses holds
  every registry instant to `isInstant`, and the column must equal the document. D1
  adds no second check; it pins the existing one with a planted row, so a later edit
  that dropped it turns a test red.

### Not in this record

- **The instant checks outside the ledger package.** Four sites carry their own
  canonical instant check: `contracts/src/schemas/artifact-record` (`:142`),
  `runtime/src/enforcement` (`:205`), `protocol/src/schemas` (`:2182`, P-15/R's
  `CanonicalInstant`) and `daemon/src/arbiter` (`:78`). They are left for P-37, which owns the seams between
  packages; D1 neither folds nor re-exports them. The final single home must be
  `@acp/contracts`, not the ledger: contracts and protocol cannot import the ledger,
  and everything else can import contracts.

### What D1 does not do

- **`requested_at`.** `listOverdueDispatchAttempts` compares a delivery's `requested_at`
  — its intention's `occurredAt` — with a canonical deadline. A delivery of 2.9.0 or
  later is held canonical by ADR 0103's door; one written under an earlier contract is
  history, and D1 does not re-check it.
- **`resolvePrice`** trusts its caller's instant. That is a note for P-33.
- The walk, the config form, the evidence root, usage and the drill are D2 to D4's.

## D2 — decisions 136 to 138

### Five — the usage report at the port, and never a 0 for UNKNOWN (decision 136; C9, C-D5)

`ExecutionEvent`'s `usage` member was `{stepIndex, tokensUsed}`: one number for every
token class, which is the shape that let a per-record count and a final count be summed
into ADR 0099's double count. It is now one report:

- `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens` and
  `totalTokens`, each a non-negative integer or `null`. `null` is UNKNOWN; a zero is a
  real zero; an absent key is a malformed report, refused by the strict object. When
  all four classes are known, the total is required and is their sum, or the report
  is refused — a known split beside an unknown total is a total the source did know.
  When any class is unknown the total may be unknown; when it is stated it is at least
  the sum of the classes that are known, or the report is refused.
- `reportKind` from `USAGE_REPORT_KINDS`; `isFinal` a boolean at the port, mapped to
  `0 | 1` where the ledger records it; `sourceObservationId`, the source's own id for
  the observation, non-empty.
- `stepIndex` stays, and `completed.stepIndex` carries the last report's (C-D5).

`tokensUsed` is removed. The provider's `step` signal and the API and local usage chunks
carry the same fields, and the port parses the report through the member. The runtime's
`UsageSample` carries them verbatim; the legacy sink records the total when it is
known and **nothing** when it is `null` — never a 0 standing in for a count nobody
reported. The two drill children's scripted reports carry a total of 1 and an unknown
class split, so their legacy rows are unchanged.

`CONTRACT_VERSION` does not move: `ExecutionEvent` is a port shape, not a ledger event.

### Six — the vocabularies move to contracts (decision 137; C-D4)

`USAGE_SOURCE_CLASSES` and `USAGE_REPORT_KINDS` were the ledger's, their only reader
(decision 45). The port now names a report's kind, and contracts and providers cannot
import the ledger, so the sets move to a new contracts capability module,
`usage-measure`, with their derived unions in its type leaf; the ledger re-exports the
constants under the same names, its usage-settlement type leaf re-exports the two
unions rather than declaring them — one declaration each — and its read models' unions
derive from them. Migration
20's CHECK text stays as written, and a test holds it equal to the constants. The
settlement policy's `precedence` stays a literal: its digest is attested, and deriving
it from the set would let a reordering silently move a pinned policy.

### Seven — Claude reports usage once, and the adapters declare their sources (decision 138; C9, C-D5)

- **Claude** reports exactly one usage report per run, from the `result` record's
  `usage`: CUMULATIVE, final, its id `session_id + "/result"`. CUMULATIVE for the whole
  session is what the captures prove, and they are single-run sessions only. A
  `--resume` reuses the session id, so a resumed run yields a second result with the
  **same** `sourceObservationId` and a usage scope — the whole session, or that run
  alone — nobody has observed. That is a D3 obligation: D3 refuses such a second report
  or distinguishes it, and never folds it as a restatement of the first. The policy
  object and its digest do not move; the bound is on the claim. The four classes are
  read by name (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`); a class the record does not carry is `null`, the total the
  sum only when all four are known; a present value that is not a count, a `usage` that
  is not an object, or a report with no session id is refused, never read as absent.
  Assistant records report nothing: one message arrives as several records, each
  repeating its usage. `stepIndex` is the number of distinct assistant message ids,
  carried across chunk splits. Replaying the captured success sample now yields one
  report — 1, 1, 1, 1 and a total of 4 — where it yielded two.
- **Codex and Kimi** report no usage until they execute (ND-D2-1 (b)): no capture shows
  whether their counts are deltas or running totals, or which id would name one.
- **`CLAUDE_USAGE_SOURCE`** declares the measurement stream's static facts once:
  `claude-cli`, `PROVIDER_AUTHORITATIVE`, the normalization policy object and its
  digest. The digest is a pinned literal of SHA-256 over the policy's canonical JSON
  (ND-D2-2 (a)), recomputed by the providers suite: L-P15A-1 admits `node:crypto` in
  providers only for the session name, and it does not move.

### The V1 consequences (decision 138)

The legacy sink keeps writing `TOKEN_USAGE_RECORDED` from D2's reports, so what V1's
quota sees changes now, not in D3:

- **Claude's** recorded tokens change from each assistant record's `output_tokens` —
  a message counted once per record that repeated it, ADR 0099's double count — to one
  row per run carrying the four-class session total (input, output and both cache
  classes).
- **Claude without a `result`** — a run killed, crashed or cut before the CLI writes
  it — records nothing, where it recorded the assistant records seen so far.
- **Codex and Kimi** record nothing from D2 onwards: they emit no usage, so V1's quota
  is blind for them **now**, not only from D3.

### What D2 does not do

- **L-P32C-1** stays: no `src/` names the usage recorders yet. D3 wires `recordStream`
  into the walk, retires it and adds L-P15D-1 in its place.
- **Quota blindness** for a V2 walk is D3's statement, where the walk stops calling the
  legacy recorder; the V1 blindness above for Codex and Kimi is D2's own.
- **A resumed Claude run** (a second `result` under the same `sourceObservationId`) is
  left to D3, which must refuse or distinguish it.
- **The launchd lifecycle fixture**
  (`packages/entrypoints/daemon/test/launchd/lifecycle/index.test.ts`) keeps a stale
  fake Claude stream: an assistant record with usage and a result without it, so its
  walk now spends nothing. It asserts nothing about usage and is left as it is. The
  fallback gate and the daemon drills, whose streams were the same, now carry the
  result's usage and each pin exactly one spend row.

## D3 — to be recorded with D3

## D4 — to be recorded with D4

## Verification (D1)

- `ledger/test/ledger`: N-D7, the reuse rule and a fresh coordinate, the segment
  transport's NULL-per-field and foreign words with the vocabulary as control, the two
  transition instants' spellings at the door with the canonical control,
  `getTaskRevision`, and the planted non-canonical `effective_from`. F-B3's second
  opening now reuses flat 1.
- `ledger/test/projection`: the same instants and transport through the fold.
- `runtime/test/recorded-task`: a real intake read back whole; intake → opening →
  discovery → INTENT on the real ledger at flat 1, then recovery restates the same
  invocation; N-D3 to N-D6, N-D8, N-D9, N-D18, and continuity refused per shared fact.
- `runtime/test/core/events`, `runtime/test/core/step-executor`: the intake-first
  opening and its navigation.
- `runtime/test/lifecycle-operation`: N-B-8 inverted; B-N1 per field.

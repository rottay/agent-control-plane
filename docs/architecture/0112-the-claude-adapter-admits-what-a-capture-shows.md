# ADR 0112 — The Claude adapter admits what a capture shows

- Status: accepted (P-15, cut A2, recorded 2026-09-24).
- Supersedes: none.
- Superseded-by: none.

## Context

S1 (P-15/G, 2026-09-24; decision 160, D-S1-1) failed on a Claude CLI that had
auto-updated from 2.1.280 to 2.1.281 the evening before. Every flag the adapter passes
was unchanged, and the recorded `--help` said so. The stream was not unchanged:
2.1.281 opens with `init` rather than `commands_changed` and sends three
`system/thinking_tokens` records before the first assistant record. The parser refused
the first of them with `UNKNOWN_EVENT` after the request was under way. The session
was killed, and the task ended `FAILED` with usage `UNKNOWN`. Flags are one contract.
The stream is a second one, and only a real call shows it.

The owner authorized one capture of the new version, and it was taken on 2026-09-24:
tools disabled, one turn, exit 0. Its sanitized form (sha256
`a1bd7d8214e337aa4f111e1e5d7ef0a76f8dcd79071d0ab3027713bfd85e095a`, 8 records) is the
evidence for this cut, beside the two 2.1.280 samples of P-07 escalón C (ADR 0099). The
design went through two prestates and a Fable pre-audit (C1–C8, adopted as rulings).

## Decision

### One — the providers contract carries the refusal and the version (decision 178)

- **`ParseOutcome`'s refusal union widens by one word.** It becomes `UNKNOWN_EVENT |
  MALFORMED_EVENT | PROTOCOL_UNSUPPORTED` (ND-A2-12), with no cast and no second
  channel.
  - The word already means, in the descriptor, "a protocol on top of the process this
    adapter cannot speak" (ADR 0034). From `parse`, it means a stream this adapter has
    no evidence for, named by the stream itself. That is the same meaning.
  - The one consumer, `Session.digest`, throws `new AdapterError(outcome.code)`, which
    takes any `AdapterErrorCode`. `ADAPTER_ERROR_CODES` stays 19.
  - Codex, kimi and the test fake produce subsets of the union, which stay assignable.
  - No `switch` over the union exists. `PROVIDERS_PUBLIC_EXPORTS` stays 97.
- **`ParseCursor` gains two optional fields.** Both are written by conditional spread
  and neither is ever module state.
  - `cliVersion` is the version the stream's own `init` named.
  - `preInitRecords` holds the no-signal records seen before `init`, by kind, each with
    the observed versions whose rows admitted it.
  - Each `Session` holds its own cursor, so two sessions over the one adapter object
    hold two versions.

### Two — one admission table for the records that carry no signal (decision 179)

`CLAUDE_NO_SIGNAL_RECORDS` is one `Object.freeze` call in `claude/index.ts`, not
exported (Fable C1). It is keyed by `type` or `type/subtype`, and each row holds the
versions it was observed in and its exact fields in each version.

A record is held three ways:

1. **Version.** The record's version must be one it was observed in (ND-A2-6).
2. **Keys, strict, per version.** A key outside that version's set refuses, and so does
   a missing one. A key lawful in one version and seen in the other refuses. That is
   the only way a changed record could otherwise pass silently.
3. **Values, by gate:**
   - `string`: non-empty;
   - `count`: a reportable token count;
   - `number`: finite and never negative;
   - `boolean`;
   - `array`: its contents are not read;
   - `oneOf`: an observed word;
   - `record`: a nested gate with exact keys.

A key-set miss or an unobserved word is `UNKNOWN_EVENT`, and a wrong type is
`MALFORMED_EVENT`.

The `array` gate is `commands_changed.commands`. v2 §2.3 described that field as an
array, and the ruled gate list lacked the word for it.

| Row | Observed in | Fields (exact) |
| --- | --- | --- |
| `system/commands_changed` | 2.1.280 | `type`, `subtype`, `commands` (array), `uuid`, `session_id` |
| `system/thinking_tokens` | 2.1.281 | `type`, `subtype`, `estimated_tokens` (count), `estimated_tokens_delta` (count), `session_id`, `uuid` |
| `rate_limit_event` | 2.1.280, 2.1.281 | `type`, `uuid`, `session_id`, and `rate_limit_info` per version, below |

The fields of `rate_limit_info`, by version:

- **Both versions:**
  - `status` is `oneOf [allowed, allowed_warning]`. A word observed in either version
    is the event's vocabulary and is admitted in both (ND-A2-9).
  - `resetsAt` is a `number`.
  - `rateLimitType` is `oneOf [five_hour, seven_day]`.
  - `isUsingOverage` is `oneOf [false]` (ND-A2-11).
  - `unifiedWindows` has exactly `five_hour` and `seven_day`, each
    `{utilization, resetsAt}` as numbers.
- **2.1.280 adds** `overageStatus` (`oneOf [rejected]`) and `overageDisabledReason`
  (`oneOf [org_level_disabled]`).
- **2.1.281 adds** `utilization` and `surpassedThreshold`, both numbers.

**No row emits a signal.** So `estimated_tokens`, `estimated_tokens_delta` and the
rate-limit numbers cannot become:

- a step or a usage report;
- a `pressure`, which L-V2B1F4-5 already forbids for Claude;
- a cost or a decision.

`resultUsage` still reads the result's four usage classes and nothing else, and the
result's key set is identical across the two versions. The usage policy is
byte-unchanged, and its digest `14cbb2a3…fb0d` is pinned and recomputed.

**`isUsingOverage: true` is refused under the same code as any unobserved word**
(Fable C8). The parser therefore does not tell "a word never observed" from "a value
the owner forbids": both are `UNKNOWN_EVENT`, and the port folds both into
`TRANSPORT_UNAVAILABLE`. The S1 assert, not the parser, is the owner's instrument for
the no-overage criterion.

**`allowed_warning` is quota pressure information, admitted and not interpreted.**
2.1.281 reported it on the `seven_day` window. Mapping it to a pressure or a throttle
is a capability claim, and it goes to **P-19** as an owner row.

`user`, `assistant`, `result` and `auth_required` keep their explicit arms. After
`init` they read as before; before `init` they refuse (Three, below).
`init` keeps its lenient read, so 2.1.281's `per_turn_effort_active` and `view_mode`
pass as environment inventory.

### Three — the version gate at `init`, and what it guarantees (decision 180)

`init` is read by one function, `readInit`. Its checks run in this order:

1. A second `init` in the session is `MALFORMED_EVENT` (Four, below).
2. `model` must be a non-empty string, or the record is `MALFORMED_EVENT`.
3. If `claude_code_version` is absent, empty or not a string, the record is
   `MALFORMED_EVENT`.
4. A version outside `CLAUDE_OBSERVED_CLI_VERSIONS = [2.1.280, 2.1.281]` (frozen, not
   exported) is **`PROTOCOL_UNSUPPORTED`**.
5. The pre-`init` records are re-judged (Four, below).

There is no default version, and "absent" never means "allowed" (v1.1, the verifier's
B1).

**Before `init`, only a table row a capture shows before `init` is read.** Today that
is 2.1.280's `commands_changed` (the row's `beforeInitIn`).

Each of these, with no version, is `MALFORMED_EVENT`:

- an `assistant`, `user`, `result` or `auth_required` record;
- a table row no capture shows before `init`: `thinking_tokens`, or a
  `rate_limit_event`.

An unrecognized record stays `UNKNOWN_EVENT`, as before. So a stream whose `init` never
arrives is refused at its first record that may not precede `init`, and it is never
read as a success against no version.

v1 missed this. The version was required only inside `readInit`, and nothing required
`init` to come. The verifier drove three such streams through the real port, and each
ended `SUCCEEDED` with a usage report:

- the 2.1.281 body without its `init`;
- the 2.1.280 success without its `init`;
- 2.1.280's `commands_changed` beside 2.1.281's `thinking_tokens`, with no `init`.

Neither observed version emits the third stream. Each of the three is now a negative,
at the parser at every split point and through the port with a spawned child.

**`auth_required` gets no exception** (the DT's ruling with Fable). The frame is
documented (ADR 0041), not observed: the 2.1.280 authentication-failure capture is
`init` → `assistant` → `result{is_error: true}`, with no `auth_required` at all. So its
position is unobserved, and every fixture places it after `init`. Before `init` it is
`MALFORMED_EVENT`: alone, and in front of an `init`, at record 0.

**The refusal names the version only in one grammar** (Fable C4). The detail is
`record <n>, CLI version <v>` when `v` matches `^\d+\.\d+\.\d+$`, and `record <n>`
otherwise, so a value outside the grammar is never echoed.

Where that detail surfaces is **D-S1-3's, owned by P-18** (decision 160):

- `Session.digest` drops `outcome.detail` today;
- health says `PROTOCOL_UNSUPPORTED`;
- the port says `session failed: PROTOCOL_UNSUPPORTED`;
- `TASK_FAILED` carries no closed cause for a parser refusal yet.

A2 changes none of the three. When P-18 carries the detail, it bounds the length it
surfaces.

**The guarantee is after spawn, and it does not prevent spend.** The gate runs in the
parser, on the stream, after the CLI process was spawned and has started writing. It
refuses at the first `init`, and no later record is read. S1 showed the request under
way by record 1, and whether it is under way at `init` is unknown.

So the gate turns a silent mid-stream refusal into a refusal with a cause at the stream's
`init` (record 0 or 1 in the observed orders).
It is not a pre-spawn gate. That gate is **ND-A2-7**, a later cut, and until then the
operator's answer is the executable's sha pin in the S1 kit (`CLAUDE_EXE_SHA256`, exit
84 on drift).

### Four — records before `init` are re-judged, and one session has one `init` (decision 181)

**C2: the hole ND-A2-10 opened, closed.** 2.1.280 sends `commands_changed` before
`init`. So a record that arrives before the version is judged against every version
whose capture shows that row before `init` (`beforeInitIn`), and admitted if any
admits it. Left there, every pre-`init` record would escape the per-version key sets.
For example, 2.1.280's `commands_changed` would pass in front of a 2.1.281 `init`.

The closure works in two steps:

1. The cursor keeps each pre-`init` kind with the versions that admitted it (distinct
   entries only).
2. `init` requires its version to be among them for every kind, and refuses with
   `MALFORMED_EVENT` at the `init` otherwise.

The versions are kept, and not just the kind, because a row may be observed in several
versions under different key sets, as `rate_limit_event` already is. Re-judging the
kind alone would let one version's shape pass in front of another version's `init`,
once such a row is observed before `init`. Since v1.1 no row is read before `init`
unless a capture shows it there, so today the only entry is 2.1.280's
`commands_changed`.

The committed 2.1.280 sample still passes, since `commands_changed` is observed in
2.1.280.

The closure also holds when no `init` arrives (v1.1, Three above). A pre-`init` record
that is never re-judged can only be a no-signal row a capture shows before `init`. The
first `assistant`, `user`, `result` or `auth_required` refuses, so an unjudged record
never stands beside a step, an output, a verdict or a pressure.

**C3: one session, one `init`** (amends ND-A2-13). Any second `init` is
`MALFORMED_EVENT`, whether or not it names the same version. Two reasons:

- A second `init` would emit a second `started`, which normalizes to a second
  `session.started`.
- It re-declares the model, and nothing observed says which of the two to believe.

This is the verdict-once rule applied whole. The S1 assert's own invariant is "exactly
one `init`".

The rule has a consequence in the tests. Three daemon drill fixtures reached the
contract's `resolvedModel` bound in the port through a second `init` (the restamp
table below). Under C3 their failing frame is a `result` whose `subtype` is 60
characters long. That frame parses and normalizes, then fails `state.toState` (at most
40) in the port after the earlier events were yielded, which is the same mechanism.
The drills keep the claim their names make.

Two bites prove it. With the frame removed, each drill fails. With the frame's
`subtype` at exactly 40 characters, each drill fails too, because the stream no longer
reaches the port failure. So the bound is what is proven, not the frame's presence
(Fable).

`F5_SPENDING_UNEXPRESSIBLE_LINES` relies on the parser admitting a **second `result`**
in one session: the result with usage, then the unexpressible one. That is deliberate
for these drills. A future one-result-per-session rule must choose the frame again.

### Five — L-P15A2-1, and the evidence (decision 182)

**L-P15A2-1** (`PATH_SCOPED_LAWS` 165 → 166) reads the comment-stripped
`providers/src/claude/index.ts`:

- (i) `estimated_tokens`, `estimated_tokens_delta`, `utilization`, `surpassedThreshold`
  and `isUsingOverage` each appear inside the span of the one
  `const CLAUDE_NO_SIGNAL_RECORDS … = Object.freeze(…);`, and nowhere else. The span
  runs from the declaration to its closing parenthesis, found by a string-aware count.
- (ii) There is no `let`, `var`, `new Map`, `new WeakMap`, `new Set` or `new WeakSet`
  at module scope, with or without type arguments. A bite found the first matcher blind
  to `new Map<…>(`. The v2 verification found it blind to a destructuring declaration
  with no space after the keyword (`let[…]=`) and to a constructor qualified by
  `globalThis.`; v2.1 widens both matchers, and a bite of each is red.
- (iii) `CLAUDE_OBSERVED_CLI_VERSIONS` is declared once and read once, inside
  `readInit`, which the one `subtype === "init"` arm returns.
- (iv) `PROTOCOL_UNSUPPORTED` appears at exactly two sites: the pre-argv refusal in
  `buildArgv` and the version gate in `readInit`.

Stated limit: a text-level matcher, as the law records. The fence does not see these,
but the behaviour suites catch each one, as the verifier drove them:

- a table split in two, or a literal assembled from pieces or spelled with escapes;
- a module-scope `const` object or array that is mutated;
- a class static field;
- a default version (`??=` a version literal), or a second version list outside
  `CLAUDE_OBSERVED_CLI_VERSIONS`;
- module state behind a helper's closure.

The behaviour is the evidence below.

The adapter suite:

- **T-C1.** The three samples replay whole, in one chunk and at every split point.
  Sample 3 is checked byte for byte against the capture's digest.
- **T-C2 and T-F1.** The version is carried in the cursor, including across split
  records and a split `init`.
- **T-V1 to T-V3.** An unobserved version, the grammar of the refusal detail, a
  malformed version, and a second `init`.
- **T-R\*.** Every row's negatives.
- **T-P1.** Only a row a capture shows before `init` is read there. `thinking_tokens`
  and both rate-limit shapes refuse at record 0. `commands_changed` in front of a
  2.1.281 `init` refuses at the `init`.
- **B1 (v1.1).** The three streams with no `init` are refused at their first record
  that may not precede `init`, at every split point. Before `init`, `assistant`, `user`,
  `result` and `auth_required` refuse: alone, and `auth_required` in front of an `init`
  at record 0. The single-record tests of P-07 C and D2 now read their record after the
  captured 2.1.280 `init`, so each refusal is the one it names. So does the
  `auth.required` drill.
- **T-U1 to T-U4.** No usage comes from estimates, as a property over N thinking
  records with random estimates.
- **Exports.** Neither the table nor the version list is exported.

The session suite has **T-S1**:

- two cursors, one per version, interleaved record by record;
- two live sessions over `claudeAdapter` at once;
- a 2.1.999 session failing beside a 2.1.281 one.

**T-G1** is in the port suite, beside the B1 negative: the three `init`-less streams
through a spawned child each end in `error{TRANSPORT_UNAVAILABLE, "session failed:
MALFORMED_EVENT"}`, with no usage, output or verdict, and the child reaped.

- *What it claims:* the child is spawned, and writes its pid before a byte of stream.
  The child then emits `init{2.1.999}` and a full success stream with a non-empty
  answer. That run ends in `error{TRANSPORT_UNAVAILABLE, "session failed:
  PROTOCOL_UNSUPPORTED"}`, with no `started`, usage, output, `operationResult` or
  `completed`, and the child reaped. The same script stamped 2.1.281 is the positive
  control: one usage, the answer `ok`, `SUCCEEDED`, `completed`.
- *What it does not claim:* that spend was prevented.

**T-D1** is in the daemon drill.

- *What it claims:* the 2.1.281 capture replays through the doors, the recorded
  daemon and the real adapter. It yields exactly one `USAGE_OBSERVATION_RECORDED`
  equal to the result's four classes, no `TOKEN_USAGE_RECORDED`, no quota, pressure
  or authentication row, a `CHECKPOINTED` task, and a `SUCCEEDED` effect whose one
  block is `ok` through both doors.
- *How the answer gets there:* the sanitizer emptied the answer. The drill's child
  restores the `"ok"` that the capture's summary records (`resultEqualsOk`) in the
  assistant text and the result, and changes nothing else. The restoration is
  load-bearing, and a control proves it (Fable C1): the same capture through the same
  child, unmodified and with its answer empty, fails the task with an
  `OperationFailedError` whose reason is `NO_OUTPUT`.
- *What it does not claim:* that the stream proves the answer's text.

### Six — the restamp, and the rows this cut leaves to owners (decision 183)

**The restamp (ND-A2-14).** Every synthetic `init` in the test tree gains the observed
version its stream was modelled on, `claude_code_version: "2.1.280"`. The gate was not
weakened to fit them. Two synthetic children that sent no-signal records in shapes no
capture shows are restamped to the observed 2.1.280 records.

The restamp was done by edit and recomputation, never by lifting an output into a pin.
PC-D3's pinned trail (`D4_V1_TRAIL_SHA256`) did not move.

| File | Sites | Change |
| --- | --- | --- |
| `providers/test/claude/index.test.ts` | 1 (`INIT`) | + `2.1.280`; the no-model negative stays versionless, since the model is checked first |
| `providers/test/execution-port/index.test.ts` | 5 | + `2.1.280` |
| `daemon/test/drills/execution/index.test.ts` | 13 `init` at the prestate: 10 keep `init` (two in `fake-claude` scripts); 3 became the `result` frame two rows below | the 10: + `2.1.280` |
| `daemon/test/drills/execution/index.test.ts` | 3 no-signal records in the two `fake-claude` scripts | `commands_changed` with its observed keys; `rate_limit_event` with the observed 2.1.280 `rate_limit_info` |
| `daemon/test/drills/execution/index.test.ts` | 3 fixtures (`F4E_UNEXPRESSIBLE_LINES`, `F5_SPENDING_UNEXPRESSIBLE_LINES`, `F5_UNEXPRESSIBLE_LINES`) | a C3 consequence: the second `init` becomes a `result` with a 60-character `subtype` (Four above); the docblock and the sweep entry follow |
| `daemon/test/drills/index.test.ts` | 1 | + `2.1.280` |
| `daemon/test/drills/leases/index.test.ts` | 6 `fake-provider` scripts with a bare `result` and no `init` | a v1.1 consequence of B1: the observed 2.1.280 `init` goes in front of the result; no drill's claim changes (DT admission, write-set 17 → 18) |
| `daemon/test/fallback/index.test.ts` | 1 | + `2.1.280` |
| `daemon/test/launchd/lifecycle/index.test.ts` | 1 | + `2.1.280` |
| `daemon/test/bin/acp-daemon/index.test.ts` | 1 (`fake-claude` script) | + `2.1.280` |
| `providers/test/testing/claude-capture/index.ts` | the two 2.1.280 samples | unchanged; sample 3 added |

**Rows left to owners:**

- **P-19:** `allowed_warning` and quota pressure information from `rate_limit_event`
  (Two).
- **P-18, D-S1-3:** the refusal's detail and its closed cause on `TASK_FAILED`
  (Three).
- **ND-A2-7:** the pre-spawn version gate (Three).
- **The S1 kit, the operator's artifact, before the S1 re-run.** Four items:
  - the fourth `s1-assert` fix (Fable C5): the owner-amendment check requires
    `overageStatus === "rejected"`, but 2.1.281 does not emit `overageStatus`, so on
    2.1.281 the observable is `isUsingOverage === false` alone, and `overageStatus` is
    asserted only where the key exists;
  - the rehearsal's fake child replays the 2.1.281 sanitized sample;
  - the S1 re-run is its own owner authorization;
  - an auto-update is a stop condition.

## Why the alternatives were not chosen

- **An unobserved version refused as `UNKNOWN_EVENT`** (ND-A2-12). It needs no change
  to the providers contract, but it reverses the ND-A2-4 ruling and loses "a version
  this adapter has no evidence for" as a cause of its own. `PROTOCOL_UNSUPPORTED`
  already carries that meaning (ADR 0034), and the union widens by one word with no
  cast.
- **The pre-`init` hole declared instead of closed** (Fable C2, option b). A declared
  limit would have let 2.1.280's `commands_changed` pass in front of a 2.1.281 `init`,
  which is the class the per-version key sets exist to refuse. The closure costs one
  cursor field and one negative (Four).
- **A second `init` admitted when it names the same version** (ND-A2-13 as first
  ruled). It still emits a second `started`, and it re-declares the model with nothing
  observed to say which to believe (Four, C3).
- **An `auth_required` exception before `init`.** The frame is documented, never
  captured, and its position is unobserved. An exception would read an unobserved
  position as allowed (Three).
- **The `init`-less stream as a declared limit** (the verifier's alternative to B1).
  The ADR would have had to say that such a stream is read versionless and its
  pre-`init` records are never re-judged. That is the S1 failure class this cut exists
  for: a CLI update that changes the stream would read as a success with a spend
  report and no evidence for it (Three).

## Consequences

- A Claude stream from a version outside the list fails at its `init` (record 0 or 1 in
  the observed orders), with a classified cause, whatever it would have said after.
- The next CLI version is refused until a capture of it is authorized, taken, measured
  and admitted row by row. That is the intended cost.
- A stream the captures did not show, even from an admitted version, is refused rather
  than guessed. A record's key or word the captures did not show is refused too.
- No version, no numbers from the stream, and nothing about quota enter the ledger
  through this cut.

## Not in this record

- **ND-A2-7:** the pre-spawn version gate. Until it lands, the operator's answer is the
  executable's sha pin in the S1 kit (Three).
- **P-18, D-S1-3:** the channel that carries the refusal's detail, the length it
  surfaces, and a closed cause on `TASK_FAILED` (Three).
- **P-19:** quota pressure information from `rate_limit_event`, `allowed_warning`
  first (Two).
- **The S1 kit's four items:** the fourth `s1-assert` fix, the rehearsal's 2.1.281
  child, the re-run's own authorization, and an auto-update as a stop condition (Six).

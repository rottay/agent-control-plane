# ADR 0114 — The Claude adapter keys a shape by what its captures show

- Status: accepted (P-15, cut A3, recorded 2026-09-24).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0112. Its decision stands: the adapter admits what a capture shows and
  refuses the rest. This record corrects the key of its admission table for
  `rate_limit_event`, reverses ND-A2-9, and names two errata in its text. ADR 0112 is
  not edited (ADR 0015, the amendment convention).

## Context

The S1 retry (P-15/G, 2026-09-24, one authorized invocation) ran the pinned private
2.1.281 binary through the daemon and spent one included-quota turn. The model
answered. The adapter refused the stream at its seventh record (`record 6`,
zero-indexed) with `UNKNOWN_EVENT`, the session was torn down, and the task ended
`FAILED`, `NO_RESULT_RECORDED`, as `ExecutionEffectError TRANSPORT_UNAVAILABLE at
events.error`.

The refused record was a `rate_limit_event` whose `status` was `allowed`, on the
`five_hour` window. Its `rate_limit_info` carried exactly 2.1.280's key set: the
overage pair `overageStatus: "rejected"` and `overageDisabledReason:
"org_level_disabled"`, and no `utilization` or `surpassedThreshold`. ADR 0112's table
kept exact keys per CLI version and admitted, for 2.1.281, only the key set of A2's
capture, whose `status` was `allowed_warning` on `seven_day`. The rehearsal replayed
that one capture, so it could not see the other shape.

Three observations of `rate_limit_info` exist:

| # | Capture | CLI | `status` | `rateLimitType` | Key set |
| --- | --- | --- | --- | --- | --- |
| 1 | sample 2, sha256 `01132951…d312` | 2.1.280 | `allowed` | `five_hour` | overage pair |
| 2 | sample 3, sha256 `a1bd7d82…e095a` | 2.1.281 | `allowed_warning` | `seven_day` | utilization pair |
| 3 | sample 4 (S1 retry), sha256 `21a6d56e…5749` | 2.1.281 | `allowed` | `five_hour` | overage pair |

Rows 2 and 3 share a version and differ in shape. The shape did not follow the
version; in every capture so far it followed `status`.

Sample 4 is the S1 retry's stream, sanitized once by a recorded script
(`.acp-local/evidence/p15/A3/sanitize-s1.mjs.txt`) under sample 3's rules: seven
records, `init`, three `thinking_tokens`, two `assistant` and the `rate_limit_event`,
no `result`. Its six other records have sample 3's key sets exactly; its `init` carries
`tools` with five names, which `init` reads leniently. The design went through a Fable
pre-audit (C1–C7, N1–N9) and a Fable stop-ruling, both adopted as rulings.

## Decision

### One — the table is keyed by every field the captures show the shape varying on (decision 189)

**The rule.** A closed admission table is keyed by every field the captures show the
shape varying on, and each row cites its capture. ADR 0112's table was keyed by the
version alone; its `rate_limit_event` row admitted, for each version, one key set,
and a pooled vocabulary of status words in both (ND-A2-9).

`CLAUDE_NO_SIGNAL_RECORDS` stays one unexported `Object.freeze` call. Each row now
holds, per version, a list of observed shapes, and each shape names the capture that
shows it and holds its exact keys and gates. A record is admitted if one shape of its
version admits it. If none does, it is `MALFORMED_EVENT` when a shape found a value of
the wrong type (the key set of every level read up to that value, and every word read
before it, matched), and `UNKNOWN_EVENT` otherwise. Key sets are checked one level at
a time: a wrong-typed top-level field such as `uuid` is `MALFORMED_EVENT` before the
nested `rate_limit_info` key set is read, as it was under ADR 0112's table. `commands_changed` and `thinking_tokens` keep one shape
each; they now cite their captures.

`rate_limit_event` is keyed by (version, status) for its `rate_limit_info`:

| (version, status) | Key set | Verdict |
| --- | --- | --- |
| 2.1.280, `allowed` | overage pair | admitted, sample 2 |
| 2.1.280, `allowed_warning` | any | `UNKNOWN_EVENT`: no capture (ND-A2-9 reversed) |
| 2.1.281, `allowed` | overage pair | admitted, sample 4 (new) |
| 2.1.281, `allowed` | utilization pair | `UNKNOWN_EVENT`: cross-pair |
| 2.1.281, `allowed_warning` | utilization pair | admitted, sample 3 |
| 2.1.281, `allowed_warning` | overage pair | `UNKNOWN_EVENT`: cross-pair |
| any, `status` missing, `null`, not a string or another word | any | `UNKNOWN_EVENT` (unchanged) |
| an admitted row, a gated value of the wrong type | — | `MALFORMED_EVENT` (unchanged) |

Unchanged: `isUsingOverage` is `oneOf [false]`; `overageStatus` is `oneOf [rejected]`
and `overageDisabledReason` `oneOf [org_level_disabled]` wherever the overage pair is
admitted; `unifiedWindows` is exactly `five_hour` and `seven_day`, each
`{utilization, resetsAt}`; `rate_limit_info` absent is `UNKNOWN_EVENT` and not an
object is `MALFORMED_EVENT`; a `rate_limit_event` before `init` is `MALFORMED_EVENT`.

**ND-A2-9 is reversed by observation.** ADR 0112 §Two said "a word observed in either
version is the event's vocabulary and is admitted in both". A word is admitted only
with the version and key set it was captured with. Five assertions in the adapter
suite encoded the pooled vocabulary and flip with this record: `allowed_warning` on
the 2.1.280 record and both cross-pairs now refuse, and sample 2's `allowed` record
under a 2.1.281 `init` is now admitted, because it is the observed (2.1.281, allowed)
shape. T-U3's rows become the three observed shapes; the other pairs refuse.

### Two — the confound, and the pooled window (decision 190)

`status` and `rateLimitType` are confounded in the captures: `allowed` came with
`five_hour` twice and `allowed_warning` with `seven_day` once. That the shape varies
with `status` is shown (rows 2 and 3: one version, two shapes). That it does not vary
with the window is not shown, only unobserved.

This record keys by (version, status) and keeps `rateLimitType: oneOf [five_hour,
seven_day]` pooled inside each shape, as before. That admits one thing no capture
shows: an observed key set on the other window, for example (2.1.281, `allowed`,
`seven_day`) with the overage pair. It is bounded: the exact key-set check still
refuses every key set no capture showed in that version, so a wrong attribution of the
discriminator is a wrong label on an observed shape, never an admitted unobserved one.

**The alternative, not chosen:** rows keyed by the triple (version, status, window).
Its cost is another S1 run that fails closed after spend on an `allowed` `seven_day`
record carrying an observed key set, and no evidence gained by refusing it.

### Three — sample 4 and the drills, and what each claims (decision 191)

Sample 4 joins the capture fixture beside sample 3 as its seven sanitized lines, byte
for byte, and its digest test. Its "Exit" is "none observed": the adapter tore the
session down; it never exited on its own.

- **Parser (T-C1 extended).** Sample 4 replays whole, in one chunk and at every split,
  with no refusal: `started` and nothing else, since it has no `result`. Against ADR
  0112's table it refused `UNKNOWN_EVENT`; that red run is recorded in the A3
  evidence (`red-sample4.log`) before the table changed. The log shows the code only,
  since vitest elides the detail; the position, `record 6`, is the S1 retry's parser
  replay of the same table over the raw stream (`G/retry/run/parser-replay.txt`).
- **Parser (T-R\*).** The verdict table above, row by row, after each version's
  captured `init` (sample 2's; sample 3's and sample 4's), plus the negatives of every
  observed shape: other status words, an unobserved window word, `isUsingOverage:
  true`, a wrong-typed `resetsAt`, a third window, a key of one status's shape added to
  the other's.
- **Port (T-G2, T-G1's mould).** A spawned child that writes its pid first replays
  sample 4 with `"ok"` restored into its one text block and exits 0: exactly
  `started`, `processExited{0, null}` and `completed`, the output `"ok"` in the sink,
  no `error`, no `usage`, no `operationResult`, the child reaped. Positive control: the
  same child with record 6's status set to an unobserved word ends in
  `error{TRANSPORT_UNAVAILABLE, "session failed: UNKNOWN_EVENT"}`, no `completed`. The
  main drill was red against ADR 0112's table.
- **Daemon (T-D2).** The same stream through the packaged daemon and both doors:
  `runPackagedEntry` rejects with `OperationFailedError` (the no-terminal class,
  D-F-7), not `ExecutionEffectError{TRANSPORT_UNAVAILABLE at events.error}` (the S1
  retry's outcome); both doors show `FAILED`, `hasResult: true`, blocks `["ok"]`; no
  usage observation, no legacy usage, no quota, pressure or authentication row. It
  claims that the failure moved from record 6 to the end of the stream. It does not
  claim that a 2.1.281 `allowed` stream reaches `CHECKPOINTED`: no capture shows one
  with a `result`.
- **Daemon (T-D3), composed, no capture shows it.** Sample 4's seven records followed
  by sample 3's `result`, both answers restored to `"ok"`: `CHECKPOINTED`, one usage
  observation of the four classes, blocks `["ok"]` through both doors, no quota row. It
  is the in-tree twin of the second rehearsal fixture the S1 operator will need; it is
  a composition, and is named so wherever it appears.

L-P15A2-1 holds unchanged: the table is still one `Object.freeze` named
`CLAUDE_NO_SIGNAL_RECORDS` with its five fenced literals inside its span, no
module-scope `let`, `var`, `Map` or `Set`, and `readInit` untouched. Its docblock names
the new keying. No new law: `PATH_SCOPED_LAWS` stays 167.

### Four — errata in ADR 0112, and the rows left to owners (decision 192)

**Erratum 1 (ADR 0112 §Six, decision 183, the P-15 packets row).** The sentence "2.1.281
does not emit `overageStatus`, so on 2.1.281 the observable is `isUsingOverage ===
false` alone" is refuted by sample 4's record 6: 2.1.281 emits `overageStatus:
"rejected"` under `allowed`, and not under `allowed_warning`. The assert's rule —
`overageStatus` asserted only where the key exists, `isUsingOverage === false` always
— survives; the sentence's reason does not. The P-15 packets row is a living row and
is corrected in place; decision 183 and ADR 0112 are corrected by this erratum.

**Erratum 2 (ADR 0112 §Two, decision 179).** "2.1.280 adds `overageStatus`… 2.1.281
adds `utilization` and `surpassedThreshold`" is restated: the overage pair travels with
`allowed` and the utilization pair with `allowed_warning`, in every capture so far; the
version is not what they vary on.

Unchanged and not edited: the P-19 row (`allowed_warning` on `seven_day`, admitted
without signal) and the P-18 rows (D-S1-3).

## Why the alternatives were not chosen

- **An in-place edit of ADR 0112.** ADR 0015 forbids it: an amendment is a new record.
- **Rows keyed by (version, status, window).** See Two: it refuses observed key sets on
  a label the evidence cannot separate, at the price of a spent run.
- **One key set per status, pooled across versions.** That would admit (2.1.280,
  `allowed_warning`) with the utilization pair, which no capture shows; the version
  stays in the key because the captures do not show it irrelevant either.
- **An open key set or a passthrough for `rate_limit_event`.** It would admit a record
  no capture shows. Fail-closed on the unobserved stays the law.

## Consequences

- The S1 retry's stream is admitted whole; a 2.1.281 `allowed` stream that ends in a
  `result` is expected to reach `CHECKPOINTED` (T-D3, composed), and only a new S1 run
  can show it.
- `CLAUDE_OBSERVED_CLI_VERSIONS` stays `[2.1.280, 2.1.281]`. The account's updater
  rewrote the global install to 2.1.282 at 18:26 on 2026-09-24; there is no capture of
  it, so it is refused by design, and the S1 kit pins the private 2.1.281 binary
  (`a922981f…f626`).
- ADR 0112 §Four's reason for keeping `admittedIn` versions in the cursor stays true
  and is untouched. §Two's no-signal guarantee is unchanged: no rate-limit number
  becomes a step, a usage report, a pressure, a cost or a decision (T-U1, T-U2, T-U4
  unchanged; only T-U3's rows moved).
- The refusal's detail grammar is unchanged: `record <n>`, the version only for
  `PROTOCOL_UNSUPPORTED`.
- No contract, API, migration, export, error code, usage-policy digest or trail pin
  moves. The ADR corpus is 114.
- No kit change in this cut. The kit's second rehearsal fixture (the `allowed` shape,
  from sample 4 or the composed stream) and the re-read of its fourth assert fix
  against Erratum 1 are the S1 operator's step at the re-pin, under a new owner
  authorization.

## Not in this record

- **ND-A2-7:** the pre-spawn version gate.
- **P-18, D-S1-3:** the channel that carries the refusal's detail.
- **P-19:** quota pressure information from `rate_limit_event`, `allowed_warning`
  first.
- **The S1 kit's re-pin and second rehearsal fixture**, and the S1 re-run's own
  authorization.
- **A capture of 2.1.282.**

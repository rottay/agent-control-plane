# ADR 0119 — A Claude reviewer is not started in plan mode

- Status: accepted (P-15, cut A4, recorded 2026-09-25).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0101. Its decision stands: the Claude adapter speaks the observed CLI,
  flag by flag. This record removes one flag pair from the reviewer's argv and names
  the sentences of ADR 0101 and of decision 117 it supersedes. ADR 0101 is not edited
  (ADR 0015, the amendment convention).

## Context

S1 attempt 3 (P-15/G, 2026-09-25, one authorized invocation) ran the pinned private
2.1.281 binary (`a922981f…f626`) through the daemon as a reviewer, with
`claude-haiku-4-5-20251001`, under the approved config `6020b516…eeed`. It failed
closed. The daemon exited 1 with `ExecutionEffectError TRANSPORT_UNAVAILABLE at
events.error`; the task ended `TASK_FAILED`, with no usage observation, no response
and no checkpoint.

The raw stream is private (sha256 `b983cc26…c8a9`) and holds 11 records:

- record 1 is `init`, with `permissionMode: "plan"` and `tools` holding the five
  allowlist names;
- records 2–8 are seven `system/thinking_tokens`;
- records 9–11 are three `assistant` records sharing one `message.id`: a `thinking`
  block, then a `text` block of 53 characters, then a `tool_use` block named `Write`,
  `caller.type: "direct"`, input keys `file_path` and `contents`, whose target is under
  `<configRoot>/plans/` and ends in `.md`: the CLI's plan-mode plan file;
- there is no `rate_limit_event` and no `result`.

The parser admitted every record (the operator's offline replay: `PARSES`, chunked
equals whole). This was neither attempt 1's CLI drift (ADR 0112) nor the S1 retry's
`rate_limit_event` key (ADR 0114). The chain was the adapter's own:

- `writeToolTarget` (`providers/src/claude/`) returned `"Write"`, because `Write` is not
  in `READ_ONLY_TOOL_ALLOWLIST`, and the parser signalled `{kind: "write", target}`;
- the session (`providers/src/session/`) threw `AdapterError("READ_ONLY_VIOLATION")`
  for a read-only (reviewer) session and killed the child;
- the port reported `error{TRANSPORT_UNAVAILABLE}` at `events.error`.

The read-only layer worked: the plan file was not created, and the workdir's status
was 0. The cause is in the argv. Since ADR 0101 every reviewer was started with
`--permission-mode plan --restricted --tools Glob,Grep,Read,WebFetch,WebSearch`. Plan
mode is a CLI mode whose own affordance is a plan file and an exit-plan step. A
reviewer can use neither, and the session must kill it on the attempt. The failure is
stochastic: samples 3 and 4, also taken in plan mode, did not emit it.

An observation, not a finding this record rests on: the `tool_use` names a tool absent
from `init.tools`, with an input key (`contents`) that the model composed from the
mode's instructions rather than from an offered tool schema.

The design went through a pre-audit by Kimi K3 (`ACCEPT_WITH_CORRECTIONS`, text-only
corrections), whose corrections and rulings on ND-1 to ND-8 were adopted.

## Decision

### One — a reviewer is started with the tool allowlist and no permission mode (decision 214)

The reviewer argv is the implementer's, followed by `--restricted --tools
Glob,Grep,Read,WebFetch,WebSearch`, and names no `--permission-mode`. That is ADR
0101's reviewer argv minus the two tokens `--permission-mode` and `plan`; the
implementer argv is byte-identical to before. The provider-native layer is the tool
allowlist. Plan mode is dropped because its own affordance is a write that the session
must kill, so keeping it makes the kill a reachable outcome of an honest reviewer.

**Rejected: option (a), `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,ExitPlanMode`
under plan mode (ND-1).** The session kills on the **emission** of a `tool_use` in the
stream (`writeToolTarget` over the assistant message), not on its execution.
`--disallowedTools` is a CLI-side execution filter; it cannot stop a model from writing
a `tool_use` into its message. Attempt 3's `Write` was already absent from `init.tools`
and was emitted anyway, so a second CLI-side denial of a tool the CLI did not offer
changes nothing the stream carries, and the failure would stay reachable. Doing both
would put two unobserved changes into one spend-bearing attempt and make its outcome
unattributable.

**Not adopted in this cut:**

- `--permission-prompts none` (ND-2). The recorded 2.1.281 `--help` states it ("anything
  that would prompt is denied automatically"), but the S1 instruction reaches no
  permission prompt, so it would be a second unobserved variable in the next attempt,
  and it is not needed for safety: the session layer holds whatever the CLI decides. It
  is the next candidate if a reviewer's allowlisted tool (`WebFetch`, `WebSearch`) is
  ever observed to stall on a prompt.
- A parser gate on `init.permissionMode` (ND-3). `init` is read leniently by design (ADR
  0112), and L-P15A2-1 pins `readInit` untouched. The argv is the adapter's own and a
  unit test pins it. The S1 kit's assert may check the field as a run invariant; that
  is the operator's.
- A prompt-side mitigation (ND-4), such as an instruction not to write a plan file or
  `--append-system-prompt`. It is stochastic, it adds a flag, and it treats a symptom of
  the mode this record removes.

### Two — the layers, unchanged (decision 214)

- **Layer 1**, the pre-spawn scan: `descriptorEnablesWrites` and `PAIR_FLAG_SAFE_VALUES`
  are byte-unchanged, and `PAIR_FLAG_SAFE_VALUES` still admits `--permission-mode plan`
  as a safe pair. The new reviewer argv passes no pair flag, so the scan answers false.
- **Layer 2**, the kill during the stream: `READ_ONLY_VIOLATION` is byte-unchanged.
- `READ_ONLY_TOOL_ALLOWLIST` is still the one list, read both for `--tools` and by the
  kill.

`packages/edges/providers/src/session/index.ts` is outside this cut's 11-path
write-set, and that is what holds both layers unchanged here: the DT's and the
verifier's check of the diff's paths against `P15A4_WRITE_SET`, together with the
unchanged tests. T-G3 with its controls A and B pins the layer-2 kill; the session
test's pair matrix pins `plan` as safe and `acceptEdits`, `bypassPermissions` and a
missing value as unsafe; it does not pin `plan` as the only safe value (a widening to
`dontAsk` stays green, verification v1 C1), which is the declared limit whose negative
rows are owed below; and
`descriptorEnablesWrites` fails closed, so `dontAsk`, `auto` and `manual` are refused
today. The fence does not hold it. Its write-set conformance is union membership (every
tracked file must be in some packet's write-set), and `session/index.ts` is already
admitted by P4A, V2B1C, P06C and P07C, so the fence cannot refuse an in-place edit to it
under this cut. A bite on a disposable clone measured it
(`.acp-local/evidence/p15/A4/bite-r1.log`): the unmutated control was green, a one-byte
edit to `session/index.ts` was green, `PAIR_FLAG_SAFE_VALUES` gaining `dontAsk` was
green, and the positive control (`P15A4_WRITE_SET` dropped from the union) was red. No
new fence law is added (ND-6): `PATH_SCOPED_LAWS` stays 174; the argv is pinned by
tests, and a text law over one literal would be a law for the fence, not for the code.

### Three — sample 5 and the drills, and what each claims (decision 215)

**Sample 5** is attempt 3's stream, sanitized once by a recorded script
(`.acp-local/evidence/p15/A4/sanitize-s1a3.mjs.txt`). The script refuses unless the raw
file's sha256 equals the pin above, applies ADR 0114's grammar, and adds rules for the
`tool_use` block: its `id` is renumbered on the same counter, its `name` (`"Write"`, the
fact under test) and `caller.type` are kept, `input.file_path` becomes
`/fixture/config-root/plans/fixture-plan.md` and `input.contents` is emptied. Record 11
also carries a top-level `wire_tool_inputs` object, which the brief did not anticipate.
It is keyed by the `tool_use` id and mirrors that input, so its key takes the same
fixture id and its values the same two replacements. The leak sweep, with a positive
control, logged 0 hits. The sanitized file's sha256 is
`476aba4fbbbdd0146e6fce90ef29bba19ab06f6ed4b20ea5f8b4a4674d65e0a5`. It joins the
capture fixture as `CAPTURED_2_1_281_PLAN_WRITE`, embedded byte for byte with its digest
test. Its "Exit" is "none observed (killed by the session)". Its one text block stays
`""` (ND-7): the captured text was 53 characters, not `"ok"`, so there is nothing
observed to restore, and no drill's claim depends on output. The name (ND-8) names the
capture's own conditions and stays true now that plan mode has left the argv.

Sample 5 proves that a reviewer started in plan mode can emit, in one assistant message,
a non-allowlisted `tool_use` that is absent from its own `init.tools`. It does not prove
that any argv without plan mode prevents one.

- **Adapter (P-1, N-1, B-1).** P-1 pins the reviewer argv element for element, and
  `descriptorEnablesWrites` of it is `false`. N-1: no reviewer argv element, over every
  reviewer request shape the suite builds, is `plan`, `--permission-mode`,
  `--permission-mode=…`, `--disallowedTools`, `--disallowed-tools` or
  `--permission-prompts`. B-1: the implementer argv is the pinned list, and the reviewer's
  is it plus exactly `--restricted --tools <allowlist>`. `READ_ONLY_TOOL_ALLOWLIST` is
  module-private, so the list is pinned as its literal. All three were red before the
  change and are recorded in the A4 evidence.
- **Parser (T-C1 extended).** Sample 5 replays whole, in one chunk and at every split,
  with no refusal. Its signals are `started` then `write{target: "Write"}`: the emptied
  text yields no output, and a write is a signal, never a parse refusal. The parser is
  unchanged, so this was green before and after.
- **Port (T-G3, with controls).** A spawned child that writes its pid first replays
  sample 5 as a reviewer. The trail is `processExited` (by a signal, exit code null)
  and `error{TRANSPORT_UNAVAILABLE}` whose detail contains `READ_ONLY_VIOLATION`, with
  no `completed`, `usage` or `operationResult`, and the child is reaped. This is
  attempt 3's outcome, reproduced. `started` comes first when it comes, and it may
  not: the session builds a read's events before it queues any, and a digest that
  throws discards them all, so when the pipe hands `init` and the `Write` over in one
  read no `started` is emitted. How the pipe splits the child's writes is the
  operating system's, so the drill and T-V1's error row compare the trail without
  `started` and hold it to at most once, and first. The session is unchanged. The
  single-read case surfaced in one live run of the r3 drill, which had asserted
  `started` first (A4 evidence `r4-providers-single-read-red.log`).
  - Control A: the same stream as an implementer is not killed; the trail is `started`,
    `processExited{0, null}`, `completed`.
  - Control B: the same stream as a reviewer, with the tool renamed to `Read`, is not
    killed, with control A's trail.
  - Together they show that the kill keys on role plus tool name, not on parsing.
  - All three are green before and after: they pin layer 2, which must not change.
- **Port (T-V1), the closed verdict table.** Every observed stream is replayed under
  each role: 5 captures × 2 roles = 10 rows, keyed by `(capture, role)`. Each row states
  its trail and terminal, cites its sample's digest (which the table checks), and takes
  its verdict from the drill that already pins it (OBS samples 1 and 2, T-G1, T-G2,
  T-G3 and control A). Samples 3 and 4 restore `"ok"` as T-D1 and T-G2 do; samples 1, 2
  and 5 replay as captured. The verdict varies on role only for sample 5. One row per
  role is kept for every capture anyway, so a future capture with a non-allowlisted
  `tool_use` cannot slip in under a pooled row. The error row's trail leaves out
  `started`, for T-G3's reason. The table fails when a `CAPTURED_*`
  export has no row, or when a row names a capture that does not exist.
- **Daemon (T-D4), through the real doors.** The task goes through `acp intake`, runs
  in the packaged daemon, and is read back through both result doors. It is routed and
  emitted as a reviewer, on the S1 kit's `prepare.json` mould: the model admits the
  reviewer role, the routing, intake and envelope name it, and the worker is
  `…/reviewer/01`. A child replaying sample 5 makes `runPackagedEntry` reject with
  `ExecutionEffectError{TRANSPORT_UNAVAILABLE at events.error}`, attempt 3's
  `daemon.stderr` class. The task has `TASK_FAILED`, and no usage observation, response
  or checkpoint. There is one spawn. Both doors read `FAILED`, `hasResult: false` and
  `NO_RESULT_RECORDED`, which are attempt 3's own observed values. The child's
  `argv.log` records `permissionMode: false`, `restricted: true` and the allowlist; that
  half was red before the change.
- **Daemon (T-D5), composed, no capture shows it.** T-D3's composition (sample 4's seven
  records and sample 3's `result`, `"ok"` restored), run as a reviewer. It reaches
  `CHECKPOINTED`, with one usage observation of the four classes and blocks `["ok"]`
  through both doors. The child's `argv.log` is as in T-D4 (red before the change). It
  is the in-tree twin of the operator's rehearsal c4 under the new argv, and a
  composition.

`d4ThroughTheDoors` gains a `role` option defaulting to `"implementer"`, and
`d4ConfigFile` an `emittedBy` defaulting to D4's operator. With the defaults every
document they build is byte-identical, so D4's trail pin and every existing row are
unmoved. Every synthetic child also writes the separate `argv.log`, while `spawns.log`
stays one `spawned` line per spawn.

### Four — errata, and the rows left to owners (decision 216)

**Superseded for the reviewer argv:**

- ADR 0101 §Two, "A reviewer adds `--tools Glob,Grep,Read,WebFetch,WebSearch` after the
  unchanged `--permission-mode plan --restricted`". The reviewer adds
  `--restricted --tools Glob,Grep,Read,WebFetch,WebSearch`, and no permission mode.
- ADR 0101's unproven item 9, first bullet, "the reviewer's `--permission-mode plan`
  with `--restricted` and the `--tools` list, together". It is now "`--restricted` with
  the `--tools` list, together, and no permission mode"; see Unproven below.
- Decision 117's reviewer clause, likewise.

Unchanged and not edited: ADR 0101's other items, and the P-16, P-18 and P-19 rows.

## Unproven

- **That the model stops emitting a non-allowlisted `tool_use` without plan mode.** No
  rehearsal can prove this. Only the next real call can show it, and even then only as
  one sample.
- **That 2.1.281 accepts this argv without `--permission-mode`.** The recorded 2.1.281
  `--help` (sha256
  `06f5c4560d04939252e707e0bdee9c047e50aeb81ad8926a7ba74ec27f2432cd`, cited here for the
  first time, beside 2.1.280's `cafad5b3…e3de0` that ADR 0101 cites) states that the
  flags exist. It says nothing about this combination's behaviour.
- **What `init.permissionMode` reads when the flag is omitted under 2.1.281.** 2.1.280's
  samples 1 and 2 read `"default"`. 2.1.281's `--help` lists the choices `acceptEdits`,
  `auto`, `bypassPermissions`, `manual`, `dontAsk` and `plan`, with no `default`. The
  parser does not read the field (ADR 0112).
- **The billing criteria attempt 3 left unobserved:** `isUsingOverage` and
  `overageStatus` from a `rate_limit_event`, `modelUsage` first-party, `result.usage` and
  the text read back.

## Why the alternatives were not chosen

- **An in-place edit of ADR 0101.** ADR 0015 forbids it: an amendment is a new record.
- **Option (a), a tool denylist under plan mode.** See One: it does not act on what the
  session kills on.
- **Relaxing layer 2** (for example admitting a `Write` under `<configRoot>/plans`). It
  would open a write path in a reviewer session. Forbidden.
- **Widening layer 1** (for example admitting `dontAsk` as a safe pair value). It is not
  this cut's, and it needs its own ruling and record.

## Consequences

- The reviewer argv no longer invites a write that the session must kill. Whether the
  model still emits one is the next real call's question.
- No contract, API, migration, export, error code, usage-policy digest or trail pin
  moves: `CONTRACT_VERSION` 2.10.0, `API_CONTRACT_VERSION` 0.24.0, `MIGRATIONS` 27,
  `PROVIDERS_PUBLIC_EXPORTS` 97, `ADAPTER_ERROR_CODES` 19, `CLAUDE_OBSERVED_CLI_VERSIONS`
  [2.1.280, 2.1.281], `PATH_SCOPED_LAWS` 174. The ADR corpus is 119.
- No kit change in this cut.

## Not in this record

- **The next real S1 call.** The workflow's three-attempt budget is spent, so a fourth
  attempt needs a new owner authorization. That call is the only evidence that the plan
  file `Write` stops, and it carries the unobserved billing criteria. Owner: P-15/G,
  then M2.
- **The kit:** the re-pin to this commit with a fresh clone and build; a rehearsal
  replaying attempt 3's shape and expecting the `READ_ONLY_VIOLATION` class; the fake
  child's argv check; the assert's optional `init.permissionMode !== "plan"`; and
  `s1-parse-replay` gaining sample 5 and its missing positive-control source. Owner:
  P-15/G.
- **Any change to** `descriptorEnablesWrites`, `PAIR_FLAG_SAFE_VALUES`,
  `READ_ONLY_VIOLATION` or `READ_ONLY_TOOL_ALLOWLIST`.
- **Negative rows for the unlisted 2.1.281 modes**, the owner of Two's declared limit.
  A later cut whose write-set includes
  `packages/edges/providers/test/session/index.test.ts` adds
  `descriptorEnablesWrites(["--permission-mode", "dontAsk"]) === true`, and the same for
  `auto` and `manual`: green at HEAD today, red only after a widening of
  `PAIR_FLAG_SAFE_VALUES`. That path is outside this cut's write-set.
- **`--permission-prompts none` and `--disallowedTools`**, only on new evidence.
- **ND-A2-7**, the pre-spawn CLI version gate (P-15). **D-S1-2**, the lawful `NO_COMMIT`
  path (P-16). **D-S1-3**, the refusal detail's channel (P-18). **`allowed_warning` as
  pressure** (P-19). **A capture of 2.1.282** (P-15/G, only if the pinned binary
  changes).

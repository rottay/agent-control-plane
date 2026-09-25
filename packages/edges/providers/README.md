# `@acp/providers`

Read-only provider adapters for the Agent Control Plane: one process boundary,
one normalized event taxonomy, and three provider descriptors that cannot spawn
anything themselves.

## Scope

P4 is complete: the shared contract, the session controller, the spawn
authority, the admissions and the taxonomy, plus the Claude, Kimi and Codex
descriptors, all exported from `src/index.ts` behind a closed surface the
architecture fence pins by equality.

What "complete" means here is narrow, and the narrowness is the point. Each
parser is built against the best recorded material there is for its provider —
a pinned protocol schema for Kimi and Codex, a documented command surface for
Claude — and **not one of them has been pointed at a running provider.** No
handshake was performed, no account or credential touched, no real session
created. Every negative in the suite is driven by a scripted fake. The package
is therefore correct as a control-plane observer and makes no warranty about
any provider's behaviour — see the capability section below, where that
distinction is enforced by the contract rather than by prose.

No adapter writes product, for any role. No adapter opens, appends to or even
names a ledger. Accounts, credentials and quotas are P5; leases and writes are
P6. Importing this package has no side effects — `startSession` spawns when it
is called, and only then.

## The three provider descriptors

Each provider is a directory `src/<name>/` holding `index.ts` — the
descriptor and its parser — and `index.test.ts` beside it. The package index
re-exports from the directory index, so the public surface does not know or
care about the layout, and the fence requires the retired flat files to stay
absent so one cannot come back alongside its directory.

| Provider | Surface | Framing | Built against |
| --- | --- | --- | --- |
| `claudeAdapter` | `claude -p --output-format stream-json --verbose` | line-delimited records | the headless `stream-json` surface, and three captured runs of two CLI versions (ADR 0099, ADR 0101, ADR 0112) |
| `kimiAdapter` | `kimi acp` | NDJSON, stable ACP v1 | a pinned ACP v1 schema |
| `codexAdapter` | `codex app-server --listen stdio://` | **UNKNOWN** | the offline schema the Codex CLI generates for its own protocol |

Codex's wire framing is recorded as `UNKNOWN` rather than assumed: neither the
schema nor `--help` documents it, proving it needs a handshake P4 was not
authorized to perform, and the parser's frame-splitting seam is therefore
exercised only by fixtures under a declared test framing. `CODEX_PROTOCOL_RECORD`
exports that gap deliberately — what the evidence fails to establish is part of
the surface a caller has to read, not a footnote.

A descriptor is pure. It builds argv and an environment, and turns bytes into
signals. It imports neither the session controller nor any process module nor
`node:child_process`, so it cannot participate in the boundary it is kept
outside of. The fence asserts it: the first two per provider file, the third as
the package-wide single-spawn-site law.

**The Claude argv, flag by flag (P-15 escalón A, ADR 0101).** Every session is
`-p --output-format stream-json --verbose --model <alias> --session-id <name>
--no-session-persistence --strict-mcp-config --mcp-config {"mcpServers":{}}`:

- `--verbose` because `stream-json` under `-p` requires it;
- `--session-id` is `claudeSessionId(taskId, attempt)`, a version 5 UUID per attempt,
  from `src/session-name/`, the one providers file admitted to `node:crypto`;
- nothing is persisted to resume;
- no MCP server of the account reaches a worker.

A reviewer adds `--permission-mode plan --restricted --tools
Glob,Grep,Read,WebFetch,WebSearch`. A `--resume` is admitted only with the
attempt's own name; any other value is refused before a spawn with
`PROTOCOL_UNSUPPORTED`, and the port never asks for one. The smoke profile's
flags (`--tools ""`, `--max-turns`, `--safe-mode`, `--max-budget-usd`) are not
worker defaults. The two captures passed `--verbose`, `--no-session-persistence`
and the empty MCP configuration. What they did not observe — this exact argv,
`--session-id` with persistence off, the reviewer's `--tools` list — is listed
as unproven in ADR 0101.

**The environment.** Built key by key, never inherited: `HOME`, `LC_ALL`, `PATH`
and the provider's configuration variable, four for every provider, plus
`PROVIDER_EXTRA_ENV`. That adds `USER` for Claude alone, since without it the CLI
reports "Not logged in" under a valid configuration root; Kimi and Codex get
nothing extra. An extra the parent does not have stays absent and is never
invented.

Every parser is an **allowlist**: it claims an exact set of methods or record
types and answers everything else with a classified refusal — `UNKNOWN_EVENT`
for a well-formed message outside the claim, `MALFORMED_EVENT` for a frame that
contradicts its own envelope. Absence from a table is refusal, so a method a
future provider release adds is refused rather than silently mishandled. For
Codex the claim is checked mechanically against the vendored schema: the tests
extract every method the protocol defines and prove the tables partition it
with nothing left over, so a regeneration that changes the surface fails the
suite rather than leaving a stale claim standing.

**What the Claude parser admits, and on what evidence (P-15 escalón A2, ADR 0112;
escalón A3, ADR 0114).** The Claude parser admits exactly what four authorized
captures show: two of CLI 2.1.280 (2026-09-22), one of 2.1.281 (2026-09-24), and the
S1 retry's 2.1.281 stream (2026-09-24, seven records, no `result`). Its `init` reads
`claude_code_version`:

- a version outside the observed list is `PROTOCOL_UNSUPPORTED`, and the refusal names
  the version only when it has the `x.y.z` grammar;
- an absent or empty version is `MALFORMED_EVENT`;
- a second `init` in one session is `MALFORMED_EVENT`;
- before `init`, only a table row a capture shows there is read (today 2.1.280's
  `commands_changed`). An `assistant`, `user`, `result` or `auth_required` record with
  no version is `MALFORMED_EVENT`, and so is any other row. So a stream without `init`
  is never read as a success.

The records that carry no signal are one table, unexported:

- `system/commands_changed` (2.1.280);
- `system/thinking_tokens` (2.1.281);
- `rate_limit_event` (both versions), keyed by (version, status).

Each row is keyed by every field the captures show its shape varying on, holds exact
keys and a gate per field for each observed shape, and cites the capture that shows
it; only the words the captures show are admitted. `rate_limit_event` is keyed by
(version, status) for its `rate_limit_info`: `allowed` carries the overage pair
(`overageStatus`, `overageDisabledReason`) on 2.1.280 and 2.1.281, `allowed_warning`
carries the utilization pair (`utilization`, `surpassedThreshold`) on 2.1.281, and a
(version, status) pair no capture shows is refused, whichever key set it carries. The
window (`rateLimitType`) is pooled inside each shape: in every capture so far it moved
together with `status`, so which of the two the shape follows is not observed, and
an observed key set on the other window is admitted. A key, word or record no capture
of that version shows is refused.

The version and the no-signal records seen before `init` travel in the parse cursor,
never in module state, and `init` re-judges those records against the version it
names. No row emits a signal, so neither the thinking-token estimates nor the
rate-limit numbers become usage or pressure. `allowed_warning` is admitted and not
interpreted; mapping it is P-19's. `isUsingOverage: true` is refused like any
unobserved word.

**The gate fires after spawn.** It refuses at the stream's first `init`, after the CLI
is running, so it names the cause of a failure but does not prevent spend. A pre-spawn
version gate is a later cut. A new CLI version is refused until a capture of it is
authorized, taken and admitted row by row.

## Three transports, not one

A provider descriptor is the CLI leg. The execution port this package builds
serves **three** transports, and the other two are real, exported and easy to
miss because they have no descriptor: they take an injected client interface
this repository owns rather than spawning a binary.

| Export | Transport | What it does |
| --- | --- | --- |
| `CLI_TRANSPORT_KIND` | CLI | the kind literal for the spawned-binary leg |
| `admitApiRoute` | API_KEY | admit a route onto a provider's HTTP API |
| `apiExecutionEvents` | API_KEY | turn that stream into normalized events |
| `LOCAL_TRANSPORT_KIND` | LOCAL_OR_SELF_HOSTED | the kind literal for the local leg |
| `admitLocalRoute` | LOCAL_OR_SELF_HOSTED | admit a route onto an OpenAI-compatible chat surface |
| `localExecutionEvents` | LOCAL_OR_SELF_HOSTED | turn that stream into normalized events |
| `createExecutionPort` | all three | one factory, three legs |

One factory, not three. `createExecutionPort` was renamed from
`createCliExecutionPort` in P8-3 precisely because a factory named for one
transport invites the second and third factory the design refuses.

Both non-CLI legs bind through an interface **this repository declares**
(`ApiStreamingClient`, `LocalChatClient`), injected by the caller, with no
member able to carry a credential. That is what keeps law 6 true by
construction rather than by discipline: the SDK binding stays optional, no
client library is imported here, and nothing on the CLI path can reach an API
key. A port constructed for CLI only refuses the other two kinds with a
classified refusal. Both non-CLI clients receive the composed instruction, and the
port refuses a non-text class and a credential-shaped instruction before calling
either one (ADR 0096). Their `text` chunks go to the caller's output sink, never
to the trail, and an `operationResult` chunk is held and emitted in order before
the terminal; they never report a process exit, because they own no process
(ADR 0099).

**The two real clients (P-15 escalón E, ADR 0108).** Each interface now has one
implementation in this package, and they are the only two files here that call
`fetch`:

| Export | Transport | What it is |
| --- | --- | --- |
| `createAnthropicMessagesClient` | API_KEY | the Anthropic Messages client, provider `claude`, one `https://` endpoint |
| `createLocalChatClient` | LOCAL_OR_SELF_HOSTED | an OpenAI-compatible chat/completions client over the binding's base URL |
| `ANTHROPIC_MESSAGES_USAGE_SOURCE` | API_KEY | the Messages API's usage source, `PROVIDER_AUTHORITATIVE` |
| `LOCAL_CHAT_USAGE_SOURCE` | LOCAL_OR_SELF_HOSTED | a local server's usage source, `PROVIDER_AUTHORITATIVE` |

Each factory takes its credential as a closure the daemon's composition builds from
the runtime's resolver (the local one takes `null` when its server needs none). The
closure is called only at the client's one fetch site, into the one header the leaf
names, and nothing on the client, its requests or its errors holds the value. Both
send `redirect: "manual"` and their own timeout, and read the stream through one
shared SSE reader (`src/sse/`) that decodes UTF-8 strictly across reads.

A response is classified by its status and content type before a byte of its body is
read: a redirect is `REDIRECT_REFUSED`, a 401 or 403 is an `authRequired` chunk, a 429
or 529 is `PROVIDER_RATE_LIMITED`, any other failure status is `PROVIDER_HTTP_ERROR`,
and a 2xx that is not an event stream is `PROTOCOL_UNSUPPORTED`. A failure `fetch`
raises is `REQUEST_TIMEOUT` by its name, otherwise `PROVIDER_UNREACHABLE`; its message
and cause are never read, because a header API quotes a value it refuses. The five
words joined `ADAPTER_ERROR_CODES` for this (14 → 19). Provider text that becomes a
chunk field — the model word, a message or completion id — is bounded first, and
anything else is `MALFORMED_EVENT`. L-P15E-1 and L-P15E-2 hold each fetch site to
this shape.

## One process boundary

`src/process/spawn/index.ts` is the only file that imports `node:child_process`, and
`src/session/index.ts` is its only caller. In the same way,
`src/session-name/index.ts` is the only file that imports `node:crypto`, for the
one SHA-1 a version 5 UUID is defined over (L-P15A-1). Both facts are asserted by the
architecture fence, not merely intended. Two spawners drift, and the drift is
discovered only when they disagree about how to stop something.

Spawning is shell-free with array argv, an environment built key by key from an
allowlist, and explicit `stdio`, `timeout` and `killSignal`. There is no
`maxBuffer`: that is an `exec`/`execFile` option which `spawn` silently
ignores, so the output bound is a manual byte count taken across stdout **and**
stderr, on raw bytes *before* decoding. Decoding is stateful, because a UTF-8
codepoint can be split across two chunks and a per-chunk decoder would corrupt
exactly the boundaries a busy stream produces.

A `ProcessHandle` owns exactly one PID, refuses to act on any other, and stops
it through a ladder: an optional provider-native cancel, then SIGINT, SIGTERM
and SIGKILL, each with its own grace window. The sweep only ever asks whether
*its own* PID is gone; it never scans, never matches a pattern, and never
signals a process group it did not create.

A terminal failure — a reviewer write violation, a byte-budget overrun, a parse
failure — tears the child down itself, so `FAILED` means the kill has already
been initiated rather than that a caller still owes one. On the success path
the caller must consume `events()` to completion and then call `close()`, or
use structured cleanup. **Abandoning iteration is not cancellation**: a
`break` out of the loop leaves the child running until `close()`.

## Capabilities are claims, and claims need evidence

`CapabilityState` is `CONFIRMED | UNKNOWN | REFUSED`, and evidence records its
subject. `CONFIRMED` requires protocol evidence, or a runtime drill whose
subject is a **real** provider. A drill against the fake proves our parser and
our machinery; it proves nothing about whether a real provider streams,
resumes or cancels, and the model refuses to let it pretend otherwise. CLI
`--help` text is adjacent observation and is never evidence.

The consequence, stated plainly: **`STREAMING`, `RESUME`, `SESSION_ID`,
`MODEL_PIN` and `PROTOCOL_CANCEL` enter and leave P4 as `UNKNOWN` for all three
providers.** That is not a gap in the adapters. Interruption still works for
every provider, because the signal floor is ours: it is a property of the
process handle rather than a provider feature, and it needs no protocol to be
true.

## Read-only roles

Two layers, and only one of them is load-bearing.

The provider's own read-only setting is the polite layer, and it is set only
where one actually exists on the surface being used. Claude has one, and a
reviewer descriptor carries it. **Kimi's `acp` surface has none**, and its
approval toggles are not a read-only mode, so claiming one would be a false
native-flag claim. **Codex has none on the App Server's listen surface**: its
sandbox and approval settings live on `exec` and on per-thread start
parameters, neither of which this adapter reaches. For those two the reviewer
descriptor is byte-identical to the implementer's, and that is stated plainly
here rather than papered over with a flag that would protect nobody.

The load-bearing layer is local and structural, and it holds for all three. A
`reviewer` descriptor carrying a write-enabling flag never becomes a process —
the pre-spawn scan is pair-aware, so `["--sandbox", "workspace-write"]` is
caught exactly as `--sandbox=workspace-write` is, and it lists the *safe*
values rather than the dangerous ones so a newly invented permissive mode is
refused by default. And a reviewer session that emits a write-class signal is
killed with `READ_ONLY_VIOLATION` whatever the provider's settings claimed,
with the teardown initiated by the failure path itself rather than by a
`close()` the caller might never reach.

## Normalized events

Adapters emit **normalized** events, each mapped onto a type the frozen 21-type
vocabulary in `@acp/contracts` already declares. The **caller** constructs any
full `ControlPlaneEvent` — idempotency key, attempt, `fromState`/`toState` and
the change-of-state law — so no contract refinement is ever an adapter's to
satisfy.

A provider signal that cannot be expressed under the frozen vocabulary is a
**STOP**: the packet halts and escalates. It is never grounds to widen the
contract, and never grounds to press an unrelated event type into service.

Payloads are bounded and pass through the credential and transcript guards
`@acp/contracts` already owns — one privacy vocabulary, not two. Redaction is
absence rather than blanking, because a blanked field still names the secret
that belongs there. No transcript and no credential is ever persisted.

What a provider hands us is exactly where a secret would travel if anyone let
it, so nothing a request carries is forwarded: not a command line, a working
directory, a patch body, an absolute path, an elicitation prompt, a tool
argument, an account identifier or an error message. Only classified tokens
drawn from closed, schema-derived sets travel, and a refusal detail names a
frame position rather than quoting what it failed on. Output text never becomes
an event: the normalized vocabulary has no content event, and these adapters are
control-plane observers rather than transcript pipes. Since P-07 escalón C (ADR
0099) the Claude parser reads the `text` blocks of each assistant record as a
private `output` signal, and the session hands them to the caller's
`ExecutionOutputSink` and nowhere else; without a sink they are dropped. The
parser also reads `is_error` on the captured `result` record as the operation's
verdict, a private `operation` signal the session holds once. Codex and Kimi
claim neither.

## Usage, reported once and never invented

Since P-15 escalón D2 (ADR 0105; decisions 136-138) a usage signal is one report in
the execution port's own fields: the four token classes and the total, each a count
or `null` for UNKNOWN — never a 0 standing in for a count nobody reported — the
report's kind from `USAGE_REPORT_KINDS`, whether it is final, and the source's own
id for the observation. The port parses it through its `usage` member and refuses a
report the member refuses.

- **Claude** reports exactly one per run, from the `result` record's `usage`:
  CUMULATIVE and final, the CLI's own total for the session, its id
  `session_id + "/result"`. That total is proved only for single-run sessions, the
  only ones captured: a `--resume` reuses the session id, so a resumed run yields a
  second result with the same `sourceObservationId` and a usage scope — the whole
  session or that run alone — nobody has observed. D3 must refuse or distinguish it.
  The
  assistant records report nothing — one message arrives as several records, each
  repeating its usage, and summing them was ADR 0099's double count. A class the
  record does not carry is `null`, and the total is the sum only when all four are
  known; the port's `usage` member refuses four known classes beside an unknown or
  different total, and a total below the known classes' sum. `stepIndex` is the number of distinct assistant message ids, and the port's
  `completed` carries the same number.
- **Codex and Kimi** report no usage until they execute. No capture shows whether
  their counts are deltas or running totals, or which id would name one, and a report
  built on that guess would be one invented.
- **The Messages client** reports one CUMULATIVE final report at `message_delta`:
  input and cache classes from `message_start`, output from `message_delta`, the id
  the message's own, a missing class `null`. **The local client** reports the
  server's one `usage` object, requested with `stream_options.include_usage`, with
  both cache classes `null`. Neither reports anything when the stream carries no
  usage.
- **`CLAUDE_USAGE_SOURCE`** declares the Claude CLI's measurement stream once:
  `claude-cli`, `PROVIDER_AUTHORITATIVE`, and its normalization policy with the
  policy's digest. The digest is a pinned literal the suite recomputes, since this
  package hashes nothing in `src/` outside the session name (L-P15A-1).

## Testing

Every negative is driven by `test/testing/index.ts`: a scripted child
with no auth, no network, no account and no product path. The two HTTP clients
are driven by its `fetch` substitute, installed after the client module loads and
answering real `Response`s over byte streams cut inside events and inside multibyte
characters; every credential there is a synthetic canary built by concatenation. It is deliberately
**not** part of the public surface — tests import it by relative path — because
a fake on the public surface would eventually be mistaken for evidence.

Config roots live under a disposable, ignored base that drills create and
remove; the adapter itself creates nothing, and an absent root is refused
rather than created.

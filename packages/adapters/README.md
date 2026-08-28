# `@acp/adapters`

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

Each provider is a directory `src/providers/<name>/` holding `index.ts` — the
descriptor and its parser — and `index.test.ts` beside it. The package index
re-exports from the directory index, so the public surface does not know or
care about the layout, and the fence requires the retired flat files to stay
absent so one cannot come back alongside its directory.

| Provider | Surface | Framing | Built against |
| --- | --- | --- | --- |
| `claudeAdapter` | `claude -p --output-format stream-json` | line-delimited records | the documented headless `stream-json` surface |
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

Every parser is an **allowlist**: it claims an exact set of methods or record
types and answers everything else with a classified refusal — `UNKNOWN_EVENT`
for a well-formed message outside the claim, `MALFORMED_EVENT` for a frame that
contradicts its own envelope. Absence from a table is refusal, so a method a
future provider release adds is refused rather than silently mishandled. For
Codex the claim is checked mechanically against the vendored schema: the tests
extract every method the protocol defines and prove the tables partition it
with nothing left over, so a regeneration that changes the surface fails the
suite rather than leaving a stale claim standing.

## One process boundary

`src/process/spawn.ts` is the only file that imports `node:child_process`, and
`src/session.ts` is its only caller. Both facts are asserted by the
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
frame position rather than quoting what it failed on. Content deltas are
deliberately **unclaimed** by every parser: they carry content, the normalized
vocabulary has no content event, and these adapters are control-plane observers
rather than transcript pipes.

## Testing

Every negative is driven by `src/testing/fake-provider.ts`: a scripted child
with no auth, no network, no account and no product path. It is deliberately
**not** part of the public surface — tests import it by relative path — because
a fake on the public surface would eventually be mistaken for evidence.

Config roots live under a disposable, ignored base that drills create and
remove; the adapter itself creates nothing, and an absent root is refused
rather than created.

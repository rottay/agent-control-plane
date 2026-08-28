# `@acp/adapters`

Read-only provider adapters for the Agent Control Plane: one process boundary,
one normalized event taxonomy, and three provider descriptors that cannot spawn
anything themselves.

## Scope

This is P4A: the shared contract, the session controller, the spawn authority,
the admissions and the taxonomy. The Claude, Kimi and Codex descriptors arrive
in P4B, P4C and P4D and are not exported yet.

No adapter writes product, for any role. No adapter opens, appends to or even
names a ledger. Accounts, credentials and quotas are P5; leases and writes are
P6. Importing this package has no side effects — `startSession` spawns when it
is called, and only then.

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

Two layers. The provider's own read-only setting is the polite one. The
load-bearing one is local and structural: a `reviewer` descriptor carrying a
write-enabling flag never becomes a process, and a reviewer session that emits
a write-class signal is killed with `READ_ONLY_VIOLATION` whatever the
provider's settings claimed.

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

## Testing

Every negative is driven by `src/testing/fake-provider.ts`: a scripted child
with no auth, no network, no account and no product path. It is deliberately
**not** part of the public surface — tests import it by relative path — because
a fake on the public surface would eventually be mistaken for evidence.

Config roots live under a disposable, ignored base that drills create and
remove; the adapter itself creates nothing, and an absent root is refused
rather than created.

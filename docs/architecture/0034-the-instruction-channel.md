# ADR 0034 — The instruction channel: what the plane asks a model, and the two transports it may not ask yet

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The plane could start a model and could not tell it anything.

That is not a figure of speech. Measured at the commit before this record:
`ExecutionRequest` carried `{taskId, attempt, identity, reattach}` and no
content. `SessionRequest` had no content field. Claude's argv was `-p
--output-format stream-json --model <alias>` — `-p` **with no positional
prompt**, which is exactly the shape a real `claude` reads stdin for — and a
`grep` for `stdin` across every provider source returned **zero hits** against a
`stdio: ["pipe","pipe","pipe"]` spawn. The pipe was opened, never written, never
closed. `TaskEnvelope.objective` was reached by two console views and one row
mapper, and by nothing on the execution path.

The evidence could not have caught it. The drill subject wrote a pid file,
emitted canned stdout and exited, reading neither argv nor stdin — so every
green execution drill in the repository would have been byte-identical if the
channel had carried nothing, because it did.

## Decision

`ExecutionRequest` gains a required `instructions`, bounded `min(1).max(4_000)`
exactly as `TaskEnvelope.objective` is bounded. `SessionRequest` carries it.
`SessionDescriptor` declares **how** — or **that it cannot** — the transport
delivers it. `startSession` performs the delivery or refuses.

**Adapters declare; only `startSession` performs.** `describe` stays pure and
does no I/O, and the providers README's claim that a descriptor "imports neither
the session controller nor any process module" stays true. The `delivery` field
is an inline union rather than an exported type, so the package's pinned public
surface does not move for it.

**Claude only, and this reverses an earlier ruling by name.** The earlier
adjudication was that all three adapters land together. That is withdrawn.
Codex pins `FRAMING: "UNKNOWN"` in its own source and records that it never
sends `initialize`; writing bytes there would assert a wire framing the plane
calls unknown and perform a handshake it calls unauthorized. Kimi's instruction
frame needs the `sessionId` the server returns to `session/new`, so it cannot
exist before the process does and cannot be built purely in `describe` — it is a
client-side conversation driven by parse results, not one frame. Both therefore
declare `{ kind: "UNSUPPORTED", reason: "HANDSHAKE_REQUIRED" }`.

**The refusal is before the spawn, and it is fail-closed.** A request carrying
an instruction against an `UNSUPPORTED` descriptor throws before
`spawnAdmitted`: no process is created, no byte is written, no frame reaches a
server the plane has not handshaken. Never a silent skip, and never a
spawn-then-discard, which would have started a model with no instruction and
charged for it. The union is handled by an exhaustive `switch` with a `never`
guard, so a third kind added without a branch fails the build rather than
falling through to a spawn that quietly delivered nothing.

**Order is the fail-closed story:** read-only argv scan → delivery-support check
→ credential scan → spawn → write → **close**. The close is not optional. The
pipe is opened by the spawn either way, so a write without a close would convert
today's silent no-op into a silent block until the step's timeout — a worse
failure and a harder one to see.

**The channel is write-only.** No instruction byte enters a ledger row, event
payload, stream frame, telemetry attribute, checkpoint, status document or log
line. **Not even a digest**: the plane records that work was asked for, not what
was said. Prompt and response lineage is deferred by name.

**One producer.** `L-B1C-1` pins that within the daemon, the runtime and the
edges exactly one site produces an `instructions:` for an `ExecutionRequest`,
and that it reads `envelope.objective`.

## Why the refusal reuses `PROTOCOL_UNSUPPORTED`

Minting a code for it would have moved a pinned closed set and pulled a further
path into the packet for no semantic gain. `PROTOCOL_UNSUPPORTED` already means
"the protocol on top of the process", was never thrown as an `AdapterError`
before this, and so collides with nothing. The specificity a caller needs lives
in the descriptor's own `reason`, not in a second code.

## Why a credential refusal did earn a new code

`CREDENTIAL_MATERIAL` was added, and the set moved 13 → 14. This is the opposite
call to the one above, and the difference is that no existing member said it. An
instruction carrying credential-shaped material is refused before the write and
before the process exists — content the plane will not transmit. Reusing
`PROTOCOL_UNSUPPORTED` would have collapsed it into the delivery refusal, and
every other member names a different failure. A closed vocabulary whose words
are approximately right is not closed, so the set grows visibly rather than
having a word borrowed to mean two things.

The guard is invoked as `findCredentialViolations({ instructions })` — the
**object**, not the bare string — so the guard's value scan actually runs over
the content. `findTranscriptViolations` is deliberately **not** invoked: it
scans denied *keys*, so it is vacuous on this content, and calling it would look
like content filtering that is not happening.

## Why the law is scoped to the execution path, not to `.objective`

An earlier draft pinned "exactly one function reads `.objective`" and failed at
HEAD by its own inventory, because three lawful readers render an initiative's
objective on a page. Rendering an objective is not producing an execution
instruction, and a law that caught them would be a law its author had to keep
explaining. So `L-B1C-1` is scoped to the execution path and to the **produced
field**: a type member, a pass-through that assigns from another
`.instructions`, and a guard-call argument are all carrying rather than
producing, and the law says so.

## Why the drill children carry a fixed constant

`sqlite-supervisor-child` and `restate-child` build their request from a config
that has no envelope and no objective. Widening those configs would have pulled
four further suites into the packet for no gain, and a varying instruction would
move drill ledger digests for a reason unrelated to what a drill proves. Each
child therefore carries one deterministic module-level constant, and `L-B1C-1`
names both files explicitly as drill-only exceptions, asserting of each that the
value is a module-level constant and that no envelope is read. An unnamed third
producer fails the law.

## Why the echo is a side file and never stdout

The drill subject now writes back what it received, which is what makes the
claim falsifiable. It writes to a file it owns, following the pid-file pattern
already in the generator. Not stdout: stdout is parsed by the real adapter, and
an unrecognised line becomes a classified event whose bounded payload can reach
a log line — so proving the instruction arrived by printing it would create the
exact leak this record forbids. The file also proves the *close*: the subject's
`end` handler never fires on an open pipe, so the file existing at all is
evidence that stdin was closed as well as written.

## Consequences

**The port no longer normalizes three CLI transports.** Every execution now
carries an instruction and only Claude's transport can take one, so driving all
three through the port produces one trail and two classified pre-spawn refusals.
The three-way parser-normalization claim did not disappear — it moved to each
adapter's own unit suite, where a parser can still be proved against a fake
subject without a port first deciding whether the transport may be spoken to at
all. The acceptance count in the dual-transport test moved with it rather than
being quietly reinterpreted.

**Three type-only touches outside the packet's own subject matter.** Adding a
required `delivery` to `SessionDescriptor` broke every literal that builds one:
three Claude fixtures in the spawn suite, and two `describe` implementations in
the package's shared scripted stand-in. Each was authorized as its own path and
edited minimally. In the stand-in, `scriptedAdapter` derives delivery from
`base.describe(request).delivery` rather than restating a provider table — a
copied table would drift the moment an adapter changed its declaration, and a
Codex- or Kimi-shaped fake would then accept an instruction the real adapter
refuses, proving the pre-spawn refusal against a fixture that disagrees with
production.

**A `ps`-shaped hazard this record does not have, and one it does.** Nothing
here reads a real provider: every test runs against generated fake subjects
behind real adapters, with no binary, network, account or spend. **Every
provider capability stays `UNKNOWN`**, and declaring `UNSUPPORTED` delivery is a
statement about a transport's protocol, not about a capability. Driving a real
CLI is a separate packet requiring the owner's explicit authorization, and it is
the only thing that can move a capability off `UNKNOWN`.

## Not in this record

- **Codex and Kimi delivery.** A named follow-up. For Codex it is gated on an
  owner authorization to perform the handshake and settle framing.
- **Prompt and response lineage**, and any instruction digest in any payload.
- **The successor lane**: the quota fold, the two false estimator comments,
  effective state in the election, plural account bindings.
- **Any real provider execution**, and any capability moving off `UNKNOWN`.

# ADR 0020 — The explicit tool operation: the plane calls a tool because something asked it to, through one operation and two doors

- Status: accepted (V2-B4b, recorded 2026-09-04). Supersedes: none.
  Superseded-by: none.
- Amends: ADR 0003. The read-only observation plane recorded there stands for
  every read verb and every read route. Its **route** half was already narrowed
  by ADR 0013, which opened the write table for the plane's first write route;
  this record narrows its **CLI** half for the first time, naming the one CLI
  verb that writes, and adds a third route to the table 0013 opened.

## Context

The plane could describe a tool call before it could make one. `@acp/tools`
held an admission gate, a stdio transport, an allowlist, a refusal vocabulary
and a receipt; `@acp/runtime` held a recorder that could put a receipt in the
ledger. Neither had a caller. The event type `TOOL_CALL_RECORDED` existed in
the contract with no producer, and the protocol package said so in a comment
that named the packet owing it one.

What forced a decision was not the missing wiring but the shape of it. Anything
that joins a tool port to a ledger is deciding, at the same time, **who may
start a child process**, **what of that child's answer becomes durable**, and
**what happens when the same request arrives twice**. Those are not
implementation details of a feature; they are authority, redaction and
idempotence, and a repository that lets them be settled incidentally by whoever
writes the wiring has settled them badly.

Three constraints were already fixed. The V2 objective requires equivalent
CLI, API and local execution — so whatever shape this took had to exist at more
than one door, and the doors had to be demonstrably the same. The DT refused
a daemon-side tool policy. And the plane's redaction rule was already that a
ledger row carries scalars a reader can audit, never content a producer
returned.

## Decision

**The plane calls a tool because something explicitly asked it to, through one
operation, reachable by exactly two doors.**

The operation is `runToolCall` in `@acp/runtime`. It is the single behaviour
authority: it validates the request, judges the coordinate, calls the scope,
records the outcome, and answers. Nine checks run before any port is reachable
and every one raises the plane's existing refusal type; after the port is
touched, **every** outcome is recorded, refusals included. A throw means the
request never became an operation — no row, no child. A return means it did,
and a row exists.

The doors are `taskToolCalls` in `@acp/gateway` (bearer-guarded, `POST`) and
`acp tool-call` in `@acp/cli` (authorised by the owning uid). Both compose an
operation scope over `@acp/tools` and reach the tool only through
`runToolCall`; neither calls the port directly, because the port builds a
refusal receipt from raw caller input and the operation's prechecks are what
make every refusal recordable. **The CLI is not an HTTP client of the
gateway.** It reads the same ledger and parses the same `ToolCallExecuteRequest`
schema, independently.

Five fence laws hold the shape mechanically rather than by review:
`L-B4B-8` (one composition site for the protocol port), `L-B4B-9` (the gateway
reaches a tool only through the operation), `L-B4B-10` (content never becomes
durable or broadcast), `L-B4B-11` (the CLI holds exactly one writable ledger
open, in the tool-call verb), and `L-B4B-12` (exactly two doors name
`runToolCall`, and no third exists).

**A coordinate is spent once, and it is the caller's.**
`(taskId, attempt, operationIndex, callIndex)` derives the transition id and
the idempotency key. The operation reads that key before it does anything else;
a hit returns the recorded row with `replayed: true`, empty content, and no
child spawned. Both doors observe this, and each replays a coordinate the other
spent.

**Content is the caller's, never the record's.** A ledger row carries nine
scalars — the account, the server, the tool, the transport, the outcome, the
refusal, and three byte counts — written field by field from named members. The
tool's answer reaches exactly one response body and nothing else: not a row,
not a stream frame, not a log line. A replay returns none, and that is a fact
about what was stored rather than a filter applied on the way out.

## Why a daemon-side tool policy was not chosen

The obvious shape was a daemon that lists a server's tools at readiness and
calls one when a walk seems to need it. It was refused, and the reason is worth
keeping.

An automatic tool plane is a capability claim — "this system chooses and uses
tools" — and this repository cannot confirm that claim against anything real.
Every tool fixture here is a fake server this project wrote; the drills prove
the framing, the ceilings, the allowlist and the receipt, and they deliberately
prove nothing about any third-party MCP implementation. A policy that selected
tools automatically would be a mechanism whose most important property — that
it selects *well* — is untested by construction, sitting behind a daemon that
starts it without anyone asking.

An explicit operation makes the claim smaller and true: something asked, the
plane refused or did it, and there is a row either way.

## Why one shared projection between the doors was not chosen

The equivalence proof compares what the two doors answer. The cheap way to
guarantee agreement is to have both call one function.

That would make the proof a tautology. What the V2 objective asks for is not
that two doors share code but that two independent implementations over one
ledger agree — which is a claim about the ledger being the authority, not about
a helper being reused. So the CLI folds its own page, the gateway folds its
own, and the fence carries a `DUPLICATION_ADJUDICATED` entry saying in writing
that this duplication is the point rather than an accident tolerated.

The cost is real: two projections can drift, and only the parity suite would
notice. That is the trade, made deliberately.

## Why a per-request tool document was not chosen

Both doors load their tool document once, at start, and a rotation is a
restart. Re-reading per request would be more convenient for an operator and
was rejected: a document edited mid-flight would let two calls of one batch be
answered under two different configurations, and neither the caller nor the
record would show which.

## Consequences

- **`API_CONTRACT_VERSION` moved to `0.10.0`.** One route now makes the server
  start a child and speak a protocol to it. A reader pinned at `0.9.0` was
  right that nothing this plane served started another process, and that is no
  longer true.
- **The CLI is no longer structurally read-only.** Its narrowed law is that
  every read verb opens the ledger query-only and exactly one named verb
  writes; `L-B4B-11` enforces it. The README, the banner and the manifest
  description all state the narrowing rather than the old absolute.
- **Replay is serialized only within one process.** The API door closes the
  same-coordinate race inside a gateway process with an in-flight registry. Two
  gateway processes, two CLI invocations, or a CLI against a gateway can each
  still both execute one coordinate. The ledger admits one row per coordinate
  either way, so history stays truthful; what is not guaranteed is that the
  tool ran once. **Closing this needs a lock the ledger itself arbitrates,
  covering both doors, and it is owed by a later packet.** Both doors say so
  where an operator meets them.
- **A body that differs under a spent coordinate is undetectable.** Stage 1
  refused an argument digest, so the operation cannot tell a repeat from a
  different request at the same coordinate. It returns the recorded row, which
  is the fail-safe reading: never a second real effect.
- **Two admission ladders exist.** `@acp/tools` decides admissibility, but each
  door reads and parses the document itself, because the tool edge may not read
  a filesystem outside its admission site. The parity suite asserts the two
  agree; the duplication itself is not removed.
- **The proof costs a third deep alias.** The gateway's parity suite reaches the
  CLI's tool-call door through a deep alias resolved only in that project and
  only for that file — the specifier is deliberately not spelled here, because
  the fence asserts that exactly one file names it and a record that named it
  would become a second. Both packages' entry points stay byte-untouched, which
  is the property the alias mechanism exists to preserve.

## Not in this record

- **Agent-mediated tool use.** The plane is the MCP client. Nothing here puts a
  proxy in front of a provider child or lets a model choose a tool; ADR 0019
  owns the session boundary that would have to move first.
- **Loopback and remote MCP.** stdio only. Loopback is stage 4's question and
  remote is not authorized at all.
- **The cross-process lock.** Named as owed above; its design, and which
  authority arbitrates it, are a later record's.
- **Adoption.** Nothing here is in service. Stage 3 closing is not P8
  certification and not P9 authorization, and no packet in this sequence
  claimed either.
- **ADR 0017's no-producer claim.** It was true of what it recorded and stays
  untouched; the protocol package's own comment carries the current count.

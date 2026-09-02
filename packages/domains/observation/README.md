# `@acp/observation`

The shadow-mode observation boundary of the Agent Control Plane, and the
baseline measured across it.

## Scope

Shadow mode observes **only** passive artifacts already emitted, or synthetic
scenarios, under two ignored roots. It never attaches to, inspects credentials
of, signals, or writes into any live session. Every measurement this package
has produced came from synthetic lifecycles or from artifacts already written
down — never from a running session, and never from any product repository.

Importing this package has **no side effects**. One entry point,
`buildShadowLedger`, writes when it is called, and what it writes is a
throwaway fixture; everything else only reads.

This is **no product adoption**. Adoption is a separate owner decision that
nothing here anticipates or authorizes.

## The boundary

Two allowlisted roots, `.acp-local/shadow/artifacts` and
`.acp-local/shadow/scenarios`. No entry point accepts a path — a caller supplies
a *name*, and the package resolves the root itself. A caller that could name a
directory could name someone else's.

One rule is stricter than its predecessors in this repository: **an absent root
is refused, never created.** A collector that can create the directory it reads
from can be aimed anywhere and will report, truthfully and uselessly, that it
found nothing. Observation admits what already exists.

Nine classified refusals: `PATH_SUPPLIED`, `BAD_ARTIFACT_NAME`,
`PATH_NOT_ABSOLUTE`, `PATH_NOT_CANONICAL`, `OUTSIDE_ALLOWLIST`, `ROOT_ABSENT`,
`NOT_OWNED_FILE`, `UNSAFE_PERMISSIONS`, `TOO_LARGE`.

## Passive collectors

`collect/` turns admitted bytes into frozen `ControlPlaneEvent` values, and
does nothing else: no ledger, no baseline, no interpretation of a chain. The
collectors are structurally read-only and the architecture fence asserts it.

They hold exactly one file descriptor, and it is the reason the rule is an
exception rather than a ban. An admitted **path** can stop meaning what
admission approved — deleted, replaced by a symlink, grown past its bound — so
the file is opened once with `O_RDONLY | O_NOFOLLOW`, re-validated by `fstat`
on that opened inode before anything is allocated, read under a bound of one
byte past the maximum, and closed with the close failure classified rather than
discarded. A bound applied to something already in memory is not a bound. Both
the fence and a test pin that call exactly, and every other open and every
write-capable flag stays forbidden.

## The baseline

`baseline.ts` is a pure function over a ledger-ordered chain: no clock, no
filesystem, no ledger, no randomness. It carries five measures — routing,
tokens, time, rework and acceptance — each expressed with the frozen 21-type
event vocabulary, each artifact-supplied rather than estimated.

Where the number is not there, it stops. A missing classification reason, a
step with no token count, a timestamp that runs backwards, a verdict outside
the closed set: each throws one `BaselineStopError` carrying a closed reason
code and never the payload that caused it. A measure that cannot be expressed
under the frozen vocabulary is a STOP escalated to the DT, never a reason to
widen the contract. The mapping and that law are in
`docs/architecture/0009-shadow-observation-boundary.md`.

## Token rollups

`rollups/index.ts` folds the task stream into token totals per task and per
initiative: `TOKEN_USAGE_RECORDED` accumulates, because spend is history, and
`TOKEN_RESERVATION_RECORDED` supersedes, because a reservation is a hold that
is current rather than a history that sums. An initiative is the sum of its
tasks for both.

It is pure, like the baseline: the caller pages the events and folds the
task-to-initiative mapping out of the task projection, so nothing here opens a
ledger — this module may not even name `@acp/ledger`, and it defines its own
bounded value shapes rather than reaching for another package's. A task with no
initiative folds into an explicit unscoped bucket instead of being dropped, and
a payload the convention does not name is skipped and counted in
`skippedMalformed`. This is a read model, not an authority: it may not refuse,
and it may not lie by silence.

## The disposable shadow ledger

`shadow-ledger.ts` is the package's **sole writer**, and the fence permits the
`@acp/ledger` import in that file and nowhere else. It builds a throwaway
ledger under `.acp-local/shadow/ledgers/` from a name it admits — never a path
a caller chose — writes only through the public `@acp/ledger` API, and names no
database driver and no SQL. It creates no directory and deletes nothing: drills
own their roots and remove only their own, after an exact realpath and prefix
check.

What it proves is that a measurement is a property of the chain rather than of
the run: append every event and require each to be genuinely inserted, page the
authoritative chain back from the ledger instead of reusing the input, verify
integrity, measure, rebuild the read model, measure again, and compare digests.
A divergence is refused, not reported. The receipt carries digests, counts and
rebuild facts only — no path, no username, no run date, no wall clock.

## Neutral telemetry, and the optional exporter

Law 9 fixes an order of dependence: observability emits **neutral events
first**, shaped to the OpenTelemetry and OpenInference conventions, and **no
observability vendor is ever required** for routing, recovery or evidence.
`emitTelemetry` is the neutral half — a pure projection from ledger events to
OTel-shaped values, with no clock, no filesystem and no ledger of its own, so
two runs over the same events are byte-identical.

Where a convention already names a thing, its name is used
(`gen_ai.usage.output_tokens`, `gen_ai.request.model`,
`openinference.span.kind`); everything else is namespaced under `acp.`.
Inventing a `gen_ai.*` key the convention has never defined would look
standard while being ours alone. Only allowlisted payload keys become
attributes: a projection that mirrored whatever a payload carried would export
tomorrow's new field without anyone deciding to.

**The redaction gate is structural, not procedural.** Every record passes the
contracts' credential and transcript guards *inside* `emitTelemetry`, and a
record that trips either is refused and **counted** rather than emitted. There
is no path around it, because `TelemetryEvent` is branded and `emitTelemetry`
is its only producer — so anything typed on a gated event, the Langfuse
translator above all, is structurally incapable of receiving one that was not
gated. Refusal diagnostics carry coordinates and counts only: the task, the
attempt, the transition, the JSON paths, and a classified reason. Never the
payload, never a fragment, never the matched content. A redaction report that
quoted what it caught would be the leak it exists to prevent.

Langfuse is permitted as the first **optional** exporter and taken at exactly
that width: `toLangfuseTrace` is one pure translator that returns a
Langfuse-shaped value. It imports no SDK, sends nothing and opens nothing, and
nothing in this package calls it. So "disable the exporter" is not a flag that
could be set wrong — it is the absence of a call, and removing Langfuse is
deleting one file. The trace carries a refused **count** so a reader of the
vendor surface can see that something was withheld without the vendor surface
being told what.

## Capability is removed, not declined

The roadmap forbids attaching, signalling and reaching out. Rather than promise
restraint, the package has no means: no `node:child_process`, no network
builtin, no signal API, no `process.env`. Tests read the sources and the
architecture fence asserts the same, so a later edit cannot quietly reintroduce
what was deliberately left out.

## Parity

The ledger-to-client parity contract lives in `@acp/protocol` and is
proven in the server package: the ledger projection, the server response, the
CLI rows and the UI rows agree exactly across all nine frozen routes. The CLI
builds its answer independently from the same ledger; the UI is proven to
project the served response unchanged; `health` is the contract's named
non-ledger exception; and ordering and pagination are part of the equality.

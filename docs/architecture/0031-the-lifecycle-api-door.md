# ADR 0031 — The API cancels through the same operation the CLI does

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0029 opened the lifecycle door on the CLI: `cancel` and `attach`, recovering
everything they need from the ledger and asking the operator for nothing but
coordinates. That left the plane with a verb an operator could reach from a
terminal and a program could not reach at all — and the programs are the callers
that most need it, because a supervisor deciding to cancel a run is not a person
at a keyboard.

The obvious way to close that gap is also the wrong one. A second implementation
of cancellation behind an HTTP handler would be a second place that recovers an
invocation, a second place that decides which driver to construct, and a second
place that could be wrong about which attempt is being cancelled. The plane
already had the answer to that shape: the tool-call door proved at V2-B4b stage
3E that two doors can compose one operation and answer byte-identically, and the
comparison is what makes the claim checkable rather than aspirational.

Three things about the API make the CLI's arrangement not simply transferable.
A request body is attacker-controlled in a way an operator's argv is not. A
server is started once and serves many callers, so anything the CLI takes per
invocation has to be startup configuration or nothing. And an HTTP status is a
contract with retry loops: a caller that cannot distinguish "try again" from
"this can never succeed" will do the wrong thing forever.

## Decision

`POST /api/v1/tasks/:taskId/lifecycle` runs one lifecycle verb through
`runLifecycleOperation` in `@acp/runtime` — the same operation
`packages/entrypoints/cli/src/lifecycle/index.ts` calls — and answers the same
seven-field document. `API_CONTRACT_VERSION` moves `0.12.0` → `0.13.0`, and
`API_WRITE_ROUTES` from three routes to four.

**The document is the parity subject, and where both doors answer a document the
equality is total.** Seven fields — `verb`, `mode`, `taskId`, `attempt`, `ok`,
`finalSequence`, `refusal` — with no contract-version envelope on the write arm,
because the CLI document has never carried one and a field on one door only is
where an exclusion list begins. The equivalence suite drives both doors over two
identically-seeded ledgers and compares with `toEqual`, no field excluded.

**One outcome is deliberately outside that equality, and it is worth naming
rather than leaving to a reader to discover.** The equivalence holds for every
accepted document and for every driver refusal the doors both render —
`TASK_TERMINAL` and `POSTCONDITION_UNKNOWN` are documents on both sides. It does
not hold for `CAPABILITY_UNSUPPORTED`, and the divergence is chosen twice over:
by D1 the API answers it as a `501` error envelope with no document at all,
because no operation occurred and a retry can never succeed; by ADR 0029 the CLI
prints the seven-field document with `refusal: "CAPABILITY_UNSUPPORTED"` and
exits `8`. Both are right for their own surface — an exit code is a shell's
branch and an HTTP status is a retry loop's — and neither is going to be bent to
match the other. What the two doors share is the operation and the recovery; how
a capability gap is *presented* is each surface's own contract, and this is the
one place where the presentations part.

**A body may name only coordinates.** `TaskLifecycleRequest` is a strict object
of `verb`, `mode`, `taskId` and `attempt`. A body naming a scenario root, a
database path, a route or a commit policy is refused on the unknown key, before
any ledger is opened. Each of those is an authority this plane holds and the
caller does not, and `strictObject` refuses all four by refusing everything —
which means the refusal cannot rot as fields are added later.

**The scenario is startup configuration.** `--scenario` on the server, resolved
through `resolveScenarioRoot` and compared with the served ledger through
`realpathSync`, so a symlink cannot make two names look different. A server
started without one answers `SCENARIO_UNCONFIGURED`, and serves every other
route exactly as before.

**Two verbs, and the omission is enforced.** `CANCEL` and `ATTACH` only; a
strict enum makes `signal` and `timer` a `400` naming the field rather than an
unrecognised string that falls through to something. The negative is a test, not
an absence.

**The GET half is a read, unguarded, and opens nothing writable.**
`TaskLifecycleResponse` carries `taskId`, `latestAttempt` and `currentState`
from the read-only source every other GET uses, bound in `PARITY_BINDINGS` as a
`LEDGER` read. Only the POST passes the bearer. That asymmetry is the plane's
existing design and not an oversight — and the read earns its place: a caller
deciding whether to cancel would otherwise have to issue a write to find out.

**501 for a capability gap, 503 for everything an operator can fix.**
`CAPABILITY_UNSUPPORTED` is its own code at `501`. `SCENARIO_UNCONFIGURED` is
`503`, reachable only after the bearer.

## Why 503 for a capability gap was not chosen

It was the cheaper option and it is wrong. Every code already answering `503`
here — `LEDGER_UNAVAILABLE`, `STREAM_CAPACITY`, `TOOL_SERVERS_UNCONFIGURED` —
describes something an operator can fix and a caller can usefully retry: a
ledger that could not be reached, a process at its ceiling, a document that was
never supplied. Nothing an operator does makes a SQLite supervisor cancel a
running invocation. A retry loop told `503` would spin forever against an answer
that cannot move, and the loop would be behaving correctly. `501` is the status
for a request this server does not implement on this engine, and the distinction
is the whole reason the code exists rather than being folded into the 503 family.

## Why reusing `TOOL_SERVERS_UNCONFIGURED` was not chosen

`SCENARIO_UNCONFIGURED` is shaped exactly like it — an operator problem, after
the bearer, `503` — and reusing it would have added no code and moved no count.
It would also have told a caller something false. A closed vocabulary whose
words are approximately right is not closed, and "this server has no tool
document" is not what happened when a lifecycle verb cannot address its
scenario. The count moves `13 → 15`, not `13 → 14`, and a writer who bumps it by
one gets a red suite rather than a plane that answers the wrong word.

## Why a request-supplied scenario was not chosen

It is the natural REST shape and it hands the caller an authority the plane
holds. The evidence a cancellation probes lives under a scenario's own directory
and is addressable only through the brand `resolveScenarioRoot` mints; a caller
that could name one would be choosing which ledger's evidence this process
reads. ADR 0029 already refused derivation in either direction between a
scenario and a database for the CLI, and a door that reintroduced it over HTTP
would have made the CLI's refusal decorative.

## Why a second implementation behind the handler was not chosen

Recovering an invocation is the part of this verb that is easy to get subtly
wrong: which attempt is latest, which route was recorded, whether the digest
agrees with the events. `restateInvocation` does it once, verifies the digest,
and refuses by field path. A handler that re-derived any of that would be a
second authority for values the log already holds, and the two could disagree
about which attempt is being cancelled — with a real cancellation as the
consequence of the disagreement.

## Consequences

**The gateway now depends on `@acp/durability`**, declared in the manifest, the
P1B law, the lockfile and both project references. The direction is lawful — an
entrypoint composing an edge — and it is the same edge the CLI door already
reaches for the same reason.

**`ATTACH` blocks until the invocation completes, and no request timeout is
imposed** (O1). A caller that attaches to a long run holds an HTTP connection
open for the length of that run. This is the honest consequence of a verb whose
meaning is "rejoin and wait", and it is stated in `docs/api-reference.md` rather
than left for a caller to discover: a client that cannot hold a connection
should poll the `GET` instead. Imposing a timeout would have meant answering
about an invocation whose outcome this process no longer knows, which is the
one thing the lifecycle verbs exist to avoid.

**`resolveScenarioRoot` creates the scenario directory before validating it**
(O3, first recorded as D1 of the L2 post-audit). A mistyped `--scenario` at
startup therefore leaves an empty directory under the git-ignored drill root.
No ledger, event or output surface is affected, and this packet does not fix it:
the smallest fix is a non-creating resolver in `toy/repository`, which is
outside this write-set. It is recorded here so a reader who finds the directory
can find the reason.

**`packages/kernel/protocol/README.md` said two write routes while there were
three** (O2). `taskToolCalls` landed at V2-B4b stage 3C and the count was not
moved with it. Corrected to four here, and recorded as pre-existing drift rather
than as this packet's doing.

**The write-set grew from 29 paths to 32 after the brief was accepted**, in
three separate authorizations, each opened by a stop at the write-set boundary
and closed by an acceptance report rather than by the writer's judgement:

- `packages/kernel/protocol/src/index.ts`, authorized as `ACCEPT_PATH_30`.
  `@acp/protocol` publishes one entry point and its barrel is an explicit named
  list with no `export *`, so the new schemas and the path helper were
  unreachable from the gateway until the barrel re-exported them. The authorized
  edit is the re-export lines and nothing else.
- `packages/entrypoints/gateway/test/build-server/index.test.ts`, authorized
  with path 32. Three assertions pin `API_WRITE_ROUTES` by deep equality, and
  this record's own decision takes that table from three routes to four. One
  string appended to each of the three arrays.
- `packages/entrypoints/gateway/src/start/index.ts`, authorized with path 31.
  The bin parses `--scenario` and `startServer` hands `buildServer` an
  enumerated object, so without two lines here the operator's flag would have
  parsed and been silently dropped. `makeDriver` is deliberately not threaded
  through it.

The third is the one worth remembering, because **no gate caught it**: the
fence, lint, typecheck and the whole suite were green while the flag did
nothing, since every suite reaches `buildServer` directly. It was found by
reading the hand-off rather than by a red check, and the propagation is now
proved by a test that walks the operator's path. The first two were forced
mechanically — an unresolvable import and a red assertion — and are the class a
pre-audit can enumerate; the third is not, and a packet that adds an operator
flag should check by hand that the flag arrives somewhere.

**The parity claim over this route is deliberately partial.** `PARITY_BINDINGS`
binds the GET and not the POST, on the `initiativeRoadmap` precedent: parity is
an equality over what clients *render* from one ledger, and the POST answers a
document about a side effect this process performed. The document's equality
across the two doors is a different claim, proved by its own suite, and the two
are kept apart so neither borrows the other's authority.

## Not in this record

- **`signal` and `timer` at the API.** Two verbs are exposed; the other two
  exist on the driver and are refused by a strict enum. Exposing them is a
  packet with its own tests, not an omission to be quietly closed.
- **A typed status on `DriverOutcome`.** `attach` still cannot distinguish "no
  such invocation" from "unreachable" at the driver seam, so the door pre-checks
  the task and the attempt and maps every driver throw to `LEDGER_UNAVAILABLE`.
  Deferred by name in ADR 0029 and still deferred.
- **Cancelling before `RUN_STARTED`.** An attempt with no recorded route has
  nothing to recover; widening that is a change to what step 0 carries.
- **A UI leg for lifecycle parity.** The console holds no version literal and
  gains no route here.
- **Every audit-derived remediation.** The backend-V2 audit's proposed ordering
  is a frozen dated record (ADR 0030) and reorders nothing; the original V2
  roadmap continues unchanged.

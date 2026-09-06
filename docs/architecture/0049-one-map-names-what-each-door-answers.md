# ADR 0049 — One map names what each door answers

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

The V2 draft states that the CLI and the API are equivalent
(`.acp-local/v2-roadmap-draft.md:83-86`, `:112`). Nothing checked it. The claim
was an assertion in a planning document, and the two doors had been growing
apart for several packets in ways no test and no law could see.

**Nothing named the relation.** `API_ROUTES` names twenty routes and
`API_WRITE_ROUTES` names the four that also answer POST, so the plane has
twenty-four arms. `COMMANDS` names fourteen CLI commands. No artifact anywhere
said which command answers which arm, which arms no command answers, or which
commands answer no arm — so "equivalent" could be neither confirmed nor
refuted, and the two `CLI_ONLY` verbs were invisible to every check in the
repository.

**The prose that described the tables had gone stale, repeatedly and silently.**
Five measured instances, each a cardinal in a comment describing a table that
had since grown:

- `parity/index.ts:84` said "every one of the **twelve** frozen routes" over
  twenty. It held that sentence for eight packets.
- `routes/index.ts:95` said a widening would "reclassify all **nine** reads"
  over sixteen read-only routes.
- `routes/index.ts:100-127` carried two stacked docblocks over one array: the
  first said "**One** route is in this table" and the second, added later
  without deleting the first, said "now **three**". The array held four.
- `gateway/src/routes/index.ts:143` said "`API_WRITE_ROUTES` stays **two**".
- `gateway/src/routes/index.ts:853` said "The **one** write route."

None of them could fail. The function the first one describes,
`bindingCoversAllRoutes()`, reads `API_ROUTES` itself, so no test can hand it a
table that disagrees with its own docblock — the sentence and the subject could
never be separated far enough for anything to notice.

**Two documents over-claimed what the parity suite proves.**
`docs/api-reference.md:12-14` and the architecture fence's own rationale both
said the suite "proves the gateway, the CLI and the console agree route by
route". Measured at `cf1f0a1`: eleven of the twenty-four arms are compared in
full against an independently built CLI-side producer, `eventStream` GET is
compared in part on one frame's `item`, `health` has no ledger content and so
has no CLI build to compare against, and the remaining eleven arms —
`taskLifecycle` GET plus the ten belonging to the eight initiative and account
routes — have no CLI-side comparison at all.

## Decision

**A single registry, `SURFACE_MAP`, declares the relation between CLI commands
and route arms, and it is the only place that relation is written down.**

It lives in `packages/kernel/protocol/src/surface-map/index.ts`, the one package
both doors may name: the gateway may not reach `@acp/contracts`, the CLI does
not depend on it either, the gateway may not import the CLI, and the CLI naming
the gateway is a stop in its own right.

**This is old-roadmap R1 under a non-colliding name.** The word `verb` is not
reused. It already has two live referents — `API_LIFECYCLE_VERBS`
(`protocol/src/schemas/index.ts:2196`) and `LIFECYCLE_VERBS`
(`runtime/src/lifecycle-operation/index.ts:315`), both meaning a lifecycle
operation, not a CLI entry point. Overloading it would have made "verb" mean two
unrelated things in one package. The CLI side is spelled `command` everywhere,
matching `CommandSpec`, `COMMANDS`, `commandName` and `SUBMISSION_COMMAND`.

**Twenty-seven entries: twelve paired, thirteen `API_ONLY`, two `CLI_ONLY`.**
The relation is **many-to-many, not a bijection.** `cancel` and `attach` both
reach `taskLifecycle` POST, distinguished only by the `verb` field of
`TaskLifecycleRequest`, so eleven distinct arms carry twelve paired entries. The
checker admits an arm reached by two commands provided they agree on the
equivalence, and refuses it when they do not.

**The asymmetry is recorded, not smoothed.** Thirteen arms answer no command and
two commands answer no arm, and every one of the fifteen carries a non-empty
`because`. `submission` and `switch-decision` plan and decide, and the plane
serves no route that plans or decides. `health` is liveness of a server process.
The ten initiative and account arms are a console surface for which no CLI verb
was ever specified. Nothing was promoted into an equivalence class it cannot
back: `surfaceDefects` refuses a `PROJECTION` or `DOCUMENT` entry with a null on
either side, which is the rule that mechanically forbids the easy lie.

**`surfaceDefects` takes the tables it measures as arguments.** This is the
load-bearing decision of the record and not a convenience. A checker that
reached for `API_ROUTES` itself could never be handed a different one, so no
test could prove it reads a table at all — which is exactly how the docblock
above `bindingCoversAllRoutes()` came to describe twelve routes over twenty
while the function stayed green. Because the tables are injected, a fixture can
add a route the map has never seen and demand the new arm be named.

**The registry has no runtime role, and that is a decision rather than an
omission.** No dispatch, no help output and no request handling reads it; it is
imported by exactly two test files and read as text by the architecture fence,
which runs before any build and cannot import it. Two reasons: a documentation
contract that becomes a request-path dependency stops being cheap to change, and
a machine-readable list of every write door emitted by a running process is an
attack aid.

**The five stale cardinals are removed rather than corrected.** The doctrine the
fence already records (`scripts/check-architecture.mjs:7581-7586`) is that the
honest cure for a sentence that counted is to state the property instead and let
a law fail on the underlying drift, which is stronger than pinning the sentence
that described it. Each of the five now names its table rather than its size.

**The two over-claims are corrected to the measured arm counts**, in
`docs/api-reference.md` and in the fence law's own rationale.

**`docs/api-reference.md` gains a seventh `CLI` column, appended last**, and the
existing bijection law gains a CLI half that checks it against `SURFACE_MAP` in
both directions: a registry pairing the document omits fails, a documented
pairing the registry does not carry fails, and a cell that is neither an em dash
nor a well-formed `` `command`:METHOD `` list fails rather than passing in
silence. The column is appended rather than inserted because the law's row regex
matches a three-column prefix and asserts no column count, so a trailing column
is transparent to the machinery that was already there.

## Why not reuse `verb` for the CLI side

It is the shorter word and the draft uses it. But `verb` already means "a
lifecycle operation" in two frozen tables, one of them in this very package. A
reader meeting `SurfaceEntry.verb` would have to know which of two vocabularies
was in play, and a later author would eventually get it wrong. The cost of
`command` is one extra syllable; the cost of the collision is a class of bug
that type-checks.

## Why not a bijection

A one-to-one table would have been simpler to check and simpler to read. It was
not available honestly. `cancel` and `attach` reach the same route and the same
method, and the only thing distinguishing them is a field inside the request
body. A bijection would have forced one of two lies: invent a second lifecycle
route that the plane does not serve, or drop one of the two commands from the
map. Both make the artifact agree with itself by disagreeing with the system.
The many-to-many shape admits the truth, and the duplicate rule is written over
the key that makes the distinction — the same `(command, route, method)` triple
twice is a defect, one command carrying two different arms is a defect, one arm
carrying two equivalences is a defect, and two commands agreeing on one arm is
not.

## Why not a runtime lookup

A registry that maps commands to routes is one `find()` away from being the
thing `run()` dispatches on, and that would have made this table load-bearing on
the request path. Two costs follow. A documentation contract that a running
process depends on stops being cheap to correct — every fix becomes a behavioral
change. And a process that can emit a complete, machine-readable list of every
write door it serves has published a map of its own attack surface. The refusal
is recorded here so that a later author reads a decision rather than an
oversight, and `SURFACE_MAP` is imported by tests and read as text by the fence,
by exactly two callers, both of them checks.

## Why not a spelling-only scan of the parity suite

The stronger claim — that every `PROJECTION` arm has a live behavioral
comparison behind it — is worth having, and a text scan of
`gateway/test/parity/index.test.ts` for route names would have looked like
evidence for it. It is not: a route name appears in that file for many reasons
other than being compared, and a law that counted mentions would have been
satisfied by a comment. The classification here is a recorded claim backed by
the measured arms table, and computing it belongs to the closure gate that can
observe the comparisons actually running.

## Consequences

**A command added to `COMMANDS` now fails three checks until it is admitted.**
`CLI_COMMAND_NAMES` is derived from `COMMANDS` rather than restated, so the
banner assertion follows it automatically; the map's CLI half then names the new
command as missing, and the api-reference law names the missing pairing. That is
the intended cost: a new door is now a deliberate edit in three places rather
than a silent arrival in one.

**A route added to `API_ROUTES` fails the map before it fails anything else.**
The arms are derived from the injected tables, so the new arm is named as
missing and must be classified — including the case where the honest answer is
`API_ONLY` with a reason.

**The `CLI` column is a fourth thing to keep in step**, and the law is what
makes that cheap: it is checked both ways on every fence run, so the column
cannot drift the way the five docblocks did.

**Two of the removed cardinals were load-bearing to a reader**, and their
replacements are less specific. A reader who wanted to know how many write
routes there are must now read the array. That is the trade the doctrine makes
deliberately: a number that cannot be wrong is worth less than a sentence that
cannot go stale.

**This record makes no claim about behavioral equivalence.** That a command and
an arm are paired here says they answer the same question, not that a test
compares them. The eleven-of-twenty-four figure above is the measured state, and
it is recorded so that no reader mistakes the map's completeness for the parity
suite's coverage.

## Not in this record

**R1b — the CLI's total answer to every API error code.** `STATUS_BY_CODE`
(`gateway/src/errors/index.ts:44`) is `Record<ApiErrorCode, number>` and total by
type. `refusalExitCode` (`cli/src/cli/index.ts:486-510`) covers six of the
fifteen `API_ERROR_CODES` explicitly and sends the rest to `EXIT_USAGE` through
a `default:` arm, so a new error code silently becomes a usage error at the CLI.
`refusalExitCode` is untouched here. Owed as `R1b`, before backend closure.

**Whether every `PROJECTION` arm has a live behavioral comparison.** Owed to the
computed closure gate, which can observe the comparisons rather than scan for
their names.

**Two adjacent claims in the CLI README, left exactly as they are.**
`cli/README.md:122-131` says nothing serializes two runs of `tool-call`;
`:133-140` says every printed document is parsed by the schemas in
`@acp/protocol`, which `submission`, `switch-decision`, `cancel` and `attach`
do not satisfy. Both are recorded as measured debts with their own successors;
neither is this packet's to fix.

**The console.** The criterion here is CLI/API. As a measured fact for the later
UI wave: the console client reaches seventeen of the twenty routes
(`console/src/api/client/index.ts:277-578`, plus `api/stream/index.ts`), and the
parity suite compares its row model on nine.

**One authority discrepancy, recorded rather than absorbed.** The DT
adjudication that authorized this packet cites its source measurement at SHA-256
`38d2e80f3ecab8a052a2b23731ee25d57a728da112441b2f1911f660df219dc5`. The document
at that path digests to `9357f06c…`, and no artifact of that session carries the
cited digest. The differences between the drafts were confined to the totals
paragraph, three restated counts and two widened evidence cells; every question
the adjudication rules on is present unchanged, and the packet boundary it
states — the proposed list minus `scripts/architecture/roots.test.mjs`, fourteen
paths — matches. The rulings therefore apply, and the discrepancy is written
here rather than left in a private report.

# The V2 backend certification record

The backend acceptance criterion asks for a **computed** gate over seven
clauses, derived and **withheld-is-failure**. This is the record that gate reads.

It is not a report. `scripts/check-architecture.mjs` §22b re-reads this file on
every run and refuses to print `V2_BACKEND_CERTIFIED` unless all seven criteria
are stated, each carries a verdict from a closed vocabulary, every proven one
names evidence whose path resolves and whose anchor is still in that file, and
every withheld one carries a reason, a destination and an authorization the
fence holds by name. Rename a suite that proves a clause, delete a law, move a
file, and the gate is red on the next run.

## The standing of this document

**This record is live.** Its neighbour `p8-matrix.md` is a dated record: it was
written against one HEAD, it is anchored there, nothing re-reads it, and this
packet neither amends it nor cites it as current state. The two are different
instruments and the distinction is the point. A dated record tells you what was
true when somebody wrote it down; this one is re-derived on every run, and the
only way it can be wrong is for the fence to be red.

For the same reason **it pins no tracked file by digest.** A digest over a file
that is meant to change is a pin that goes stale silently — the class already
settled at ADR 0054. The evidence here is `(path, anchor)` pairs, which cannot
go stale without failing. Digests appear only where a document is outside the
repository, and there they buy mutation detection, not durability.

The clause text this record certifies against lives outside the tree, in the V2
roadmap draft at `:83-86`. It is cited by anchor and **not** by digest, which is
a deliberate choice rather than an omission: that document is ignored by git and
still being written, and it moved twice while this record was being drafted. A
digest over it would buy mutation detection, not durability, and would read as a
falsehood the first time somebody edited a paragraph this record does not
depend on. The anchor has been stable across every revision. No law reads it
either way: a law that read an ignored file would pass or fail depending on
something a fresh clone does not have.

## A. The seven criteria

| Criterion | Status | Reason | Destination |
| --- | --- | --- | --- |
| `BE-1-SERVICE-INDEPENDENCE` | `PROVEN` | — | — |
| `BE-2-DOOR-EQUIVALENCE` | `PROVEN` | — | — |
| `BE-3-KILL-WITHOUT-DUPLICATION` | `PROVEN` | — | — |
| `BE-4-RESUMABLE-STREAM` | `PROVEN` | — | — |
| `BE-5-NO-PAYLOAD-ON-RECORDED-SURFACES` | `PROVEN` | — | — |
| `BE-6-REMOTE-MCP-REFUSED` | `PROVEN` | — | — |
| `BE-7-POLICY-ONLY-MODEL-SWITCH` | `PROVEN` | — | — |

Seven `PROVEN` verdicts and no owed criterion is a strong claim, so here is
what it does and does not say. It does **not** say the backend is finished or
that nothing is owed — table C below carries five disclosures. It says that for
each of the seven clauses there is a named law, suite or drill in this tree that
would go red if the clause were false, and that the fence has just confirmed
every one of those names still resolves. What R19 added was never a proof of the
clauses; it was the aggregate, and the refusal to certify from a record that is
incomplete, unclassified, unresolvable or dishonestly owed.

## B. The evidence

Every row is checked on every run: the path must resolve in the tree, and the
file must still contain the anchor. The comparison is whitespace-normalised and
case-insensitive, so a reflowed paragraph does not break a citation, but a
renamed suite does.

**In a code file the anchor must be in the code.** The file is parsed and its
comments are removed before the comparison, so a `describe` title, a refusal
string, a computed note or a declaration satisfies a pointer and a docblock
never does. A file the parser reports a syntactic diagnostic for states no code
at all, and every pointer into it is refused by name. This is not a detail of the comparison; it is
what makes the sentence at the top of this page true. A law in the fence is a
block of code under a header comment that names it, and until R19b six of the
rows below quoted the comment. Deleting such a law entirely, header left
standing, was measured to leave this gate green and still printing "39 resolving
pointers" — so the six were re-anchored to literals the laws themselves compute,
and prose stopped counting as evidence. `.md` and `.json` sources are still read
whole, because in those the prose or the key is the content rather than a
description of it. ADR 0059 records the finding.

**And an anchor that states nothing resolves against nothing.** R19b's removal
was line-oriented, which left three ways to satisfy a citation with no evidence
at all: an empty anchor, which every file in the tree contains; an anchor
written as the em dash this table uses for a blank cell, which is read as empty;
and an anchor quoted from the interior line of a block comment, which opens no
comment and continues none and so was taken for code. Each now fails with its
own sentence, as does a row citing a file whose extension the scanner cannot
read. The scanner also ended a failure in the opposite direction — the old cut
at `//` deleted real code inside a regular expression shaped like a URL, and
refused honest citations. No row below moved: all 39 resolve unchanged under the
stricter rule. ADR 0060 records this one, including what an anchor does not
prove — it is evidence of location, not of conduct or reachability.

| Criterion | Path | Anchor |
| --- | --- | --- |
| `BE-1-SERVICE-INDEPENDENCE` | `packages/entrypoints/daemon/test/fallback/index.test.ts` | `the runtime fallback gate: SQLite mode operates with Restate disabled` |
| `BE-1-SERVICE-INDEPENDENCE` | `packages/entrypoints/daemon/test/fallback/index.test.ts` | `P8-6-FALLBACK-GATE` |
| `BE-1-SERVICE-INDEPENDENCE` | `packages/edges/durability/test/drivers/drills/index.test.ts` | `D4 server unavailable fails closed and never fails over on its own` |
| `BE-1-SERVICE-INDEPENDENCE` | `packages/entrypoints/daemon/test/fallback/index.test.ts` | `checkpoints a toy scenario over SQLITE_SUPERVISOR with the full plan trail, the pinned Restate ports unbound throughout` |
| `BE-1-SERVICE-INDEPENDENCE` | `scripts/check-architecture.mjs` | `no production source names the telemetry edge` |
| `BE-1-SERVICE-INDEPENDENCE` | `scripts/check-architecture.mjs` | `ROOT_DEV_DEPENDENCIES` |
| `BE-1-SERVICE-INDEPENDENCE` | `packages/edges/tools/src/port/index.ts` | `ToolProtocolPort` |
| `BE-2-DOOR-EQUIVALENCE` | `packages/kernel/protocol/src/surface-map/index.ts` | `entry("overview", "overview", "GET", "PROJECTION")` |
| `BE-2-DOOR-EQUIVALENCE` | `packages/entrypoints/gateway/test/parity/index.test.ts` | `ledger, CLI and UI agree, route by route` |
| `BE-2-DOOR-EQUIVALENCE` | `packages/entrypoints/gateway/test/parity/index.test.ts` | `agrees on taskById and workerByIdentity` |
| `BE-2-DOOR-EQUIVALENCE` | `packages/entrypoints/gateway/test/parity/index.test.ts` | `agrees on taskToolCalls, with the CLI folding the ledger itself` |
| `BE-2-DOOR-EQUIVALENCE` | `scripts/check-architecture.mjs` | `API_ROUTES parsed as empty; the API reference law would pass vacuously` |
| `BE-2-DOOR-EQUIVALENCE` | `scripts/check-architecture.mjs` | `API error codes answered by name at both doors, agreeing between the CLI's EXIT_BY_CODE and the gateway's STATUS_BY_CODE both ways` |
| `BE-2-DOOR-EQUIVALENCE` | `packages/entrypoints/gateway/src/errors/index.ts` | `STATUS_BY_CODE` |
| `BE-2-DOOR-EQUIVALENCE` | `packages/entrypoints/cli/src/cli/index.ts` | `EXIT_BY_CODE` |
| `BE-3-KILL-WITHOUT-DUPLICATION` | `packages/edges/durability/test/drivers/drills/index.test.ts` | `recovers from a SIGKILL` |
| `BE-3-KILL-WITHOUT-DUPLICATION` | `packages/entrypoints/daemon/test/drills/execution/index.test.ts` | `a restart over the real adapter performs no second execution` |
| `BE-3-KILL-WITHOUT-DUPLICATION` | `packages/domains/runtime/src/submission/index.ts` | `deriveInvocation` |
| `BE-3-KILL-WITHOUT-DUPLICATION` | `packages/persistence/ledger/src/errors/index.ts` | `LEDGER_IDEMPOTENCY_CONFLICT` |
| `BE-3-KILL-WITHOUT-DUPLICATION` | `packages/domains/runtime/test/submission/index.test.ts` | `LEDGER_IDEMPOTENCY_CONFLICT` |
| `BE-3-KILL-WITHOUT-DUPLICATION` | `packages/domains/runtime/test/drivers/sqlite-supervisor/index.test.ts` | `kill and restart, 3/3` |
| `BE-4-RESUMABLE-STREAM` | `packages/entrypoints/gateway/test/stream/index.test.ts` | `a reconnect loses nothing and repeats nothing` |
| `BE-4-RESUMABLE-STREAM` | `packages/entrypoints/gateway/test/stream/index.test.ts` | `a resumed connection is told which ledger it resumed into` |
| `BE-4-RESUMABLE-STREAM` | `packages/entrypoints/gateway/test/stream/index.test.ts` | `a malformed anchor is refused before anything is hijacked` |
| `BE-4-RESUMABLE-STREAM` | `scripts/check-architecture.mjs` | `the stream has exactly one id producer, and it is String(sequence)` |
| `BE-5-NO-PAYLOAD-ON-RECORDED-SURFACES` | `scripts/check-architecture.mjs` | `TOOLS_RECEIPT_FORBIDDEN_MEMBERS` |
| `BE-5-NO-PAYLOAD-ON-RECORDED-SURFACES` | `packages/edges/providers/src/redact/index.ts` | `hasPrivacyViolation` |
| `BE-5-NO-PAYLOAD-ON-RECORDED-SURFACES` | `packages/domains/observation/src/telemetry/index.ts` | `PAYLOAD_ATTRIBUTES` |
| `BE-5-NO-PAYLOAD-ON-RECORDED-SURFACES` | `packages/entrypoints/gateway/test/stream/index.test.ts` | `redaction is absence, over the wire as well as in the body` |
| `BE-5-NO-PAYLOAD-ON-RECORDED-SURFACES` | `packages/entrypoints/gateway/test/parity/index.test.ts` | `carries no credential- or transcript-shaped key on any route` |
| `BE-6-REMOTE-MCP-REFUSED` | `packages/edges/tools/src/admission/index.ts` | `TOOL_LOOPBACK_HOSTS` |
| `BE-6-REMOTE-MCP-REFUSED` | `packages/edges/tools/test/admission/index.test.ts` | `an unknown transport is the remote refusal` |
| `BE-6-REMOTE-MCP-REFUSED` | `packages/edges/tools/test/admission/index.test.ts` | `a URL-shaped descriptor is parsed, then refused field by field` |
| `BE-6-REMOTE-MCP-REFUSED` | `packages/edges/tools/test/admission/index.test.ts` | `the loopback leg is admitted, and the refusal finally has a sibling` |
| `BE-7-POLICY-ONLY-MODEL-SWITCH` | `scripts/policy-version-digests.json` | `2026-09-06.1` |
| `BE-7-POLICY-ONLY-MODEL-SWITCH` | `scripts/check-architecture.mjs` | `the policy version pin establishes no version, so it pins nothing` |
| `BE-7-POLICY-ONLY-MODEL-SWITCH` | `packages/domains/accounts/test/policy/index.test.ts` | `a policy update changes the chosen model with no source change` |
| `BE-7-POLICY-ONLY-MODEL-SWITCH` | `packages/domains/accounts/test/policy/index.test.ts` | `versions are immutable, and there is exactly one registry` |
| `BE-7-POLICY-ONLY-MODEL-SWITCH` | `packages/entrypoints/daemon/test/drills/execution/index.test.ts` | `the route is resolved over the repository's real policy` |

### Notes on three of the seven

**`BE-1` — optionality is proved by never being wired.** The fallback drill
spawns the real daemon child with the pinned server ports genuinely unbound and
drives a real execution port, so this is the assembled path rather than a driver
substitution. The telemetry edge is stronger than optional: a path-scoped law
forbids any production source from naming it, so a dead collector is outside the
walk's import graph rather than merely tolerated by it. The vendor-absence half
is pinned from the other side — the root manifest declares no runtime
dependency at all, and the tool protocol port is hand-rolled.

**`BE-2` — the door equivalence is behavioural, not structural.** The surface
map is total in both directions and the fence checks the reference documentation
against the route table both ways, but a map that agrees with itself proves
little. What closes the criterion is the parity suite, where the CLI builds its
rows from the ledger having never seen the server's answer. ADR 0049 left one
question open to this gate by name — whether every `PROJECTION` arm has a live
behavioural comparison. Measured here: all nine do. Six are covered by the
route-by-route loop, two by the detail-route test, and the ninth by the tool-call
read. There is no owed row for it.

**`BE-3` — the claim is proved in two halves, and the split is a law rather
than an omission.** One half kills a real process at a genuine `SIGKILL` with a
scripted subject; the other proves no second execution over the real adapter
across a restart. They are separate because neither the runtime nor the
durability package may import the providers edge, which is itself what keeps
that edge optional. The suites refuse to skip: a drill that skipped would be
indistinguishable from one that passed.

### The record of the ledger's refusal

The consequence of a `(taskId, attempt)` collision is **not** a silent replay
with the content discarded. Every event payload carries a `submissionDigest`, so
an append under the same key with different content fails closed on
`LEDGER_IDEMPOTENCY_CONFLICT` and the first run stands. A true retry — the same
key with the same content — replays without appending. Reusing an attempt's
coordinates for different content is a caller defect, and it is not silent.

### B4 — the harness port

**B4 — `AgentHarnessPort`: absent as a kernel port, by adjudication, and the
MCP dependency ask is moot.** The draft names an `AgentHarnessPort`; ADR 0019
adjudicated that it is realized as `AgentHarness` at the edge in
`@acp/providers`, where its only agreeing party — the daemon — already reaches
it, and that placing it in `@acp/contracts` would be speculative surface
(`docs/architecture/0019-the-owned-session-lifecycle.md:76-83`). Moving it to
contracts is the declared signal that a domain or driver has begun taking it by
injection; no such consumer exists. B0's enumerated dependency ask for an MCP
client (`v2-roadmap-draft.md:55-58`) is moot: `ToolProtocolPort` is hand-rolled
in `@acp/tools` and this repository declares no `@modelcontextprotocol`
dependency in any manifest or in `pnpm-lock.yaml`. The criterion is met by a
written disposition and no code.

## C. The disclosures

These are the rows the acceptance claim would overstate itself without. Each is
held by an authority outside this packet, each names where it is discharged, and
the fence authorizes each one by name: an owed row it does not authorize is a
failure, and an authorization whose row this record later proves is a failure
too, so the register shrinks as the rows close.

| Row | Status | Reason | Destination |
| --- | --- | --- | --- |
| `OWED-R11-PHOENIX-DRILL` | `OWED` | The collector drill needs a real subject and law 8 reserves that authorization to the owner; until one runs, the fence pins the socket and live-conformance results at NONE and the capabilities at UNKNOWN. | `OWNER_GATED` |
| `OWED-R15-BENCHMARK-CUT` | `OWED` | No real benchmark has fed the evaluation producer and no registry version has been cut from it; restriction 5 keeps capabilities UNKNOWN until a drill with a real subject confirms one, and the owner refused the hosted runner. | `OWNER_GATED` |
| `OWED-R18-CI-LINUX` | `OWED` | CI runs the subset its runner can run: two projects are excluded because the pinned server binary is darwin-arm64 only and their drills refuse to skip, so green-on-Linux is unproven and cannot be produced on this machine. ADR 0057 records it. | `POST_AUDIT_FOLLOW_UP` |
| `OWED-R11B-EXPORTER-WIRING` | `OWED` | The telemetry exporter has no production caller, by a law that makes that the point; wiring the walk to it would weaken the service-independence criterion, so the reconciliation decides the wiring rather than this record. | `RECONCILIATION` |
| `OWED-GOVERNANCE-RECEIPTS` | `OWED` | Receipt coverage per commit belongs to the closure debrief: the evidence lives in an ignored directory, and a law may not read what a fresh clone does not have, so this gate does not attempt to compute it. | `CLOSURE_DEBRIEF` |

### R18 — what CI actually runs

The workflow declares the subset it can run and owes the rest by name. Two
vitest projects are excluded on the hosted runner because the server binary this
repository pins is published for `darwin-arm64` only, the runner has no
acquisition step, and the drills in those projects refuse to skip — a skipped
drill would be indistinguishable from a passing one. The exclusion is computed
against the vitest topology in both directions rather than pinned as a list, so
a project added to the topology and not to the workflow fails the fence. That
green-on-Linux is unproven is stated here rather than implied, with destination
`POST_AUDIT_FOLLOW_UP`; ADR 0057 carries the decision and its reasoning.

## What this record is not

It is not the closure declaration. That is a separate act, taken against the
draft's own text and the fence's write-set roster, and it belongs to the single
closure debrief rather than to this packet. It is not a matrix of the P8 kind,
and it does not restate one. And it is not authority for anything outside the
backend: the presentation wave and the deployment phase stay excluded exactly as
they were.

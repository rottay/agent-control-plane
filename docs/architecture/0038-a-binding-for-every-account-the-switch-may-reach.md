# ADR 0038 — A binding for every account the switch may reach

- Status: accepted.
- Supersedes: none.
- Superseded-by: none.

## Context

ADR 0037 stopped the switch from claiming work it had not done. It left the
switch with nowhere to go.

The planner can decide that a task should move from account A to account B. The
executor can record that decision. But when the daemon actually runs the work,
the account it can reach is fixed at startup — and there was exactly one.

**The port layer was never the problem.** `createExecutionPort` has always taken
`readonly bindings: ReadonlyMap<string, CliBinding>` — "one per `accountId`" — and
has always refused a route whose account it holds no binding for:
`bindings.get(route.accountId)` returning `undefined` yields
`TRANSPORT_UNAVAILABLE` at `route.accountId`, on both the session and the
streaming leg. A binding whose adapter disagrees with the route's provider is
`ROUTE_INVALID`. The plural contract was there, unused.

**The singularity lived in the daemon.** `DaemonExecutionConfig` carried one
`binding`; `parseExecutionSection` parsed exactly one `execution.binding`; and
`executionPortFor` built the map and set **one** entry, keyed by
`route.accountId`. So a switch to account B produced a route the port refused,
for the entirely correct reason that nobody had bound B.

**And the binding's `workdir` was also the packet's worktree** — four production
reads: the arbiter's lease path, the conformance gate, the child's absolute-path
requirement, and each walk's own `worktreePath`. That coupling is what makes the
plural shape a design question rather than a widening.

## Decision

**`execution.bindings` is an array of entries**, each
`{accountId, binary, configRoot, workdir, limits}`, and every entry is admitted
independently through the same `admitBinary` / `admitConfigRoot` / `admitWorkdir`
route the single binding always took. **No default, no inheritance, no
discovery**: an account is reachable because the operator wrote it down and it
passed the same admission as every other, or it is not reachable at all.

### An array, not a keyed object

A keyed object — `bindings: {"acct-a": {...}}` — reads better and cannot work.
The config is `JSON.parse`d, and `JSON.parse` **keeps the last duplicate key
silently**. A repeated account would therefore never reach the parser: last-wins
would be the real behaviour, the duplicate refusal could never fire, and the test
asserting it would be unfailable. With an array the duplicate is visible, and it
is refused naming **the index of the repeat**.

### One worktree per packet

**A switch must not lose context, so a switch must not move the checkout.**
Every entry must declare the same `workdir` as the entry for `route.accountId`;
a disagreement is refused at parse, naming **both** account ids. All four
worktree derivations read `bindings[route.accountId].workdir`.

The alternative — a `workdir` per binding — was rejected because it is precisely
the context loss the objective forbids: switching from A to B would relocate the
packet's checkout mid-flight, and the work in progress would be somewhere else.

Hoisting a single `execution.worktree` above the bindings was also rejected, for
a narrower reason: it would change `CliBinding`'s shape in the providers edge,
which this packet otherwise leaves completely untouched. Keeping `workdir` on the
entry and constraining it keeps the port's contract unmoved.

**If the route's account has no entry, the config is refused**, naming
`execution.route.accountId`. There is no fallback to "the first entry" — a daemon
that quietly ran the route on somebody else's binding would be the cross-account
leak this packet exists to prevent.

### `MAX_EXECUTION_BINDINGS = 8`

Eight covers a primary plus backups across the three CLI subscription providers,
and bounds the credential roots and processes one daemon can reach. **Nine or
more is refused, never truncated**: silently dropping the ninth would leave a
route naming it unservable for a reason nothing reported.

It is deliberately **independent of `WALK_CONCURRENCY_MAX` (4)**. That bounds how
many walks run at once; this bounds how many accounts are *reachable*. Tying them
would mean a daemon could not hold a backup account for a walk it is not
currently running — which is exactly what a switch needs.

### A clean break, not a compatibility layer

`binding` and `bindings` are **never both accepted**. The singular key is refused
by name, and the message names the exact rewrite.

This is safe to do without a version because `DaemonChildConfig` is an
**internal artifact**: it carries no `contractVersion`, crosses no wire, has no
producer outside this repository, and no operator document describes
`execution.binding`. A dual-read would mean two spellings of one fact, and the
day they disagreed the daemon would have to pick a winner silently.

**A one-entry `bindings` is exactly the fact `binding` was**, which is why the
refusal can name the precise rewrite rather than gesturing at a document. **The
refusal is the migration.**

### The refusal names the account

`executionPortFor`'s failure becomes *"the execution binding for `<accountId>`
was refused: `<code>`"*. With four bindings, an operator told only that "the"
binding was refused would have to guess which credential root the daemon
objected to.

## Why the route stayed singular

Making the route plural would mean running one task on two accounts at once,
which is not what a switch is. F2 gives a switch a **destination**; it does not
make the work concurrent. What became plural is the set of accounts the daemon
may reach, not the work it does.

## Why the producer was not changed here

The CLI's `runSubmission` spreads the operator's config and rewrites only the
route; it validates `config.execution.route` and never reads `binding`. So it
carries the plural section through untouched already, and no CLI `src` path is in
this packet. The component that will *produce* a plural section is the landing
that opens the fresh session — a later packet. Until then an operator writes the
array by hand, which is the honest state: the daemon can reach several accounts,
and nothing yet decides to use the second one.

## Consequences

- A switch to an admitted account now has somewhere to land: the port holds a
  binding for it, admitted the same way as every other.
- The config is a clean break. Every existing daemon document must rewrite
  `execution.binding` as a one-entry `execution.bindings`, and the refusal says
  so precisely.
- Eight suites and the CLI suite moved to the plural shape. The CLI suite is
  test-only: it authors and asserts the passthrough, and left singular it would
  pin a document the daemon refuses.
- `L-B1F2-1` forbids any daemon `src` file from naming the singular member
  shapes, so the break cannot be quietly undone.
- No public pin moves: `DaemonExecutionConfig` is not a public export, the
  providers edge is untouched, and `G1_MOVE_MAP` stays at 302.

## Not in this record

The plural **producer** — the landing that opens a fresh session, appends the
completion and writes the bindings — is a later packet, as are the checkpoint
producer and the quota-pressure trigger. No switching decision is implemented
here. No new wire schema, ledger row, event type or capability state; no
credential material enters the config, which names a `configRoot` directory and
never a token, key or profile body. No capability leaves `UNKNOWN`, and nothing
here spawns a real provider, opens a socket or spends.

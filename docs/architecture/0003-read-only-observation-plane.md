# ADR 0003 — The read-only observation plane

- Status: Accepted
- Date: 2026-08-27
- Phase: P1B
- Deciders: `kimi/k3/coordinator/01` (DT), `claude/opus/implementer/01` (integrator)
- Audited by: `claude/fable/reviewer/01`
- Supersedes: nothing
- Refines: `docs/architecture/0002-sqlite-event-ledger.md`
- Authority: `docs/ROADMAP.md`

## Scope, stated first

This ADR covers the shared foundation of the P1 observation surface: the
contract package `packages/api-contracts`, and the package boundary, dependency
direction, test topology and lint coverage of the three lanes that will build on
it (`packages/cli`, `packages/server`, `packages/ui`).

**P1B is not P1 completion.** P1 also requires a working read-only server, a
minimal CLI and a local UI that actually renders ledger state. None of those
exist. The three lane packages are scaffolds that report
`NOT_IMPLEMENTED_P1B_SHARED_FOUNDATION` and implement nothing.

P1B is also **no product adoption**. Nothing here observes, connects to or is
used by any real operation. Adoption still happens exactly once, after the P8
certification and under a separate P9 authorisation. There is **no partial
cutover**: a subsystem that works in isolation is not thereby in service.

## Context

P1 finishes with a CLI and a local UI over the ledger. That work splits cleanly
into three lanes which can run as isolated writers in separate worktrees, and
the roadmap's parallelisation criterion allows exactly that split.

It also warns what happens if the split comes first. Three lanes started against
an unshared foundation produce three answers to the same questions: what a task
looks like on the wire, which version number a reader checks, what an error
looks like, whether the UI is allowed to open a database. Those answers are
cheap to agree once and expensive to reconcile three times, and reconciling them
later is exactly the integration cost that is supposed to be avoided by not
parallelising prematurely.

So the shared foundation lands first, as one writer, before any lane starts.

## Decision

### 1. One contract package, and a dependency direction that is asserted

`@acp/api-contracts` describes what a reader of the control plane may see. It
depends on `@acp/contracts` and `zod` and on nothing else. It imports no `node:`
builtin, opens no file, links no database driver and does not depend on
`@acp/ledger`.

The permitted direction is:

| Consumer | May depend on |
| --- | --- |
| `@acp/ui` | `@acp/api-contracts` only |
| `@acp/server` | `@acp/api-contracts` and `@acp/ledger` |
| `@acp/cli` | `@acp/api-contracts` and `@acp/ledger` |

This table is not documentation. `scripts/check-architecture.mjs` asserts the
exact dependency set of all four packages, and separately asserts that neither
the UI manifest nor any UI source file names the ledger or a database driver.
The browser bundle cannot acquire a native module by accident, and cannot
acquire one on purpose without changing a shared file that this lane's writers
are not authorised to touch.

A second, narrower assertion lives in the contract package's own test suite: it
parses its own source files and fails if any module specifier is a `node:`
builtin, the ledger or anything sqlite shaped. That check reads specifiers
rather than prose, so a comment that names a forbidden dependency in order to
forbid it does not trip the check that enforces it.

### 2. Two version lines, both on the wire

`API_CONTRACT_VERSION` is the shape a reader receives. `LEDGER_CONTRACT_VERSION`
is the durable meaning of a recorded event, re-exported from `@acp/contracts`.
They are deliberately different values and every top level response carries
both.

Pinning them together would create a false coupling in both directions. A
cosmetic field rename in a DTO would present as a ledger migration, and a real
ledger migration would present as a UI change. Carrying both lets a reader say
which one moved, and lets the server reject a mismatch with a specific code
rather than a generic parse failure.

### 3. The absolute database path is redacted, and the redaction is structural

The ledger's own status object carries the absolute path of the database file.
That path names a home directory, a user account and a machine layout, and it is
of no use to a browser. It never crosses this boundary.

What crosses instead is `LedgerDatabaseIdentity`: a digest of the path, computed
server side, the bare file label, and a literal `pathRedacted: true` marker. The
label schema rejects separators, parent traversal segments, home directory
shorthand and dotfile fragments, so the field cannot be widened back into a path
by a later edit.

Because every response schema is strict, forwarding the raw ledger status by
accident is a parse failure rather than a leak. That is the reason the redaction
is encoded in the contract and not left to a mapping function: a mapper that
forgets a field is a bug, and a strict schema that meets an unexpected field is
a refusal.

### 4. Read-only, and GET only

Every route in P1 is a `GET` under `/api/v1`. There is no mutating DTO in the
contract package, because P1 has no write surface to describe. The method set is
data (`API_ALLOWED_METHODS`) so the server lane can assert it instead of
remembering it, and every other verb is answered with the `METHOD_NOT_ALLOWED`
envelope.

Dynamic routes are built by helpers that validate before they encode. A worker
identity contains slashes by construction, so it is percent-encoded as exactly
one path component; a caller that passes a traversal segment, a query string or
a malformed identifier gets a thrown validation error rather than a request to
somewhere else.

### 5. The listener binds loopback, and that is a constant

When the server lane arrives, it binds `127.0.0.1`. The observation surface
shows every task, worker and transition with no authentication in front of it,
so a bind address is not a deployment preference: `0.0.0.0` would publish the
whole control plane to the local network. The host is therefore a constant in
`@acp/server`, not a configuration value, and the same is true of the UI dev and
preview servers.

Authentication is deliberately out of scope. Adding a login to a loopback-only
read surface would buy nothing and would introduce the first credential handling
path in a repository whose whole point is that it has none.

### 6. One error envelope, with a closed code set

Every failure is the same shape: the API version, a closed `code`, a bounded
`message` and a nullable `detail`. A closed code lets a reader branch on the
cause without parsing prose or inferring meaning from an HTTP status.

The envelope is guarded by the same credential scanner the ledger contract uses.
An error message is the classic way for a path or a token to escape a boundary
that is otherwise careful, so the escape route is closed at the schema rather
than at each call site.

### 7. Event payload contents do not cross

A timeline item carries an event's coordinates, its chain digests, the number of
bytes its payload serialises to and the names of its payload keys. It does not
carry the payload.

Payloads are the one part of an event whose contents the ledger contract does
not fix. Everything else in an event is a closed enum, an identity, a digest or
a timestamp. Sending the one unbounded part to a browser would put the weakest
link at the widest boundary. The key names that do cross are themselves scanned
with the ledger's credential and transcript guards, so a payload key named
`apiToken` or `messages` fails the contract even though the value never leaves
the server.

A later phase that genuinely needs payload values will argue for a per-type
projection, which is a narrower decision than opening the whole field.

### 8. Emptiness is not degradation

The overview reports one of four states: `UNAVAILABLE`, `EMPTY`, `ACTIVE`,
`DEGRADED`. A dashboard that only counts rows renders "no ledger" and "no events
yet" identically, and they mean opposite things.

The schema enforces the distinction rather than trusting the server: an
unavailable overview may not carry ledger facts or counts and must say why, an
empty one must have read a ledger in order to know it is empty, an active one
must be backed by at least one event and may not carry a failing integrity
verdict, and a degraded one must carry a checked and failing verdict and an
explanation. Breakdowns must sum to their totals.

The same response states in data what this phase does not have:
`capabilities.routing`, `capabilities.accounts` and `capabilities.leases` are
literal `false`. A UI reading those flags cannot grow an affordance for a
subsystem that does not exist, and a later phase that adds one has to change
this contract to say so.

### 9. Cursors are opaque, and numbers use a decimal grammar

Pagination is cursor based and the cursor is a string even where the underlying
ledger cursor is an integer. A reader hands it back unmodified. The moment a
reader does arithmetic on a cursor, changing the pagination strategy becomes a
breaking change to every reader.

Numeric query parameters are parsed with an explicit decimal grammar rather than
`Number()`. `Number()` accepts `0x10`, `1e3`, surrounding whitespace and
`Infinity`, any of which would silently become a page size or a cursor the caller
never wrote. Out of range values are rejected rather than clamped, so a caller
never believes it asked for a thousand rows and quietly got fifty.

### 10. Scaffolds are honest

The three lane packages compile, expose their boundary and refuse to work.
`@acp/server` `start()` throws rather than returning an inert handle, the CLI
implements only `--help` and `--version` and exits non-zero on anything else,
and the UI renders an intentional shell with no fetch, no client and no
placeholder counts.

A shell showing plausible zeroes is indistinguishable from a control plane that
has lost its ledger, and telling those two apart is the entire purpose of the
surface being built.

## Test topology

`vitest.workspace.ts` is replaced by `vitest.config.ts` using `test.projects`.
`defineWorkspace` is deprecated in Vitest 3, and the replacement keeps one file
as the single place a reader looks for how the suite is composed. The contracts
and ledger projects are preserved exactly, including the ledger's source alias
and its extended timeouts; `api-contracts` is added with the same alias.

At P1B there was no project for the cli, server or ui packages: a project that
collects zero test files reports a green suite for code nobody has written,
which is a worse signal than an absent one. P1 integration added all three,
each together with the suite that justifies it.

Each lane necessarily built its suite behind a package-local config, because
the root config is integrator owned and outside every lane write-set. Those
configs were deleted at integration and their projects moved here. That
sequence is the rule, not an accident of this phase: a suite that runs only
under a command nobody types is not a gate, so a lane's tests are not
considered delivered until the root config executes them.

Type-aware lint coverage widens from `.ts` to `.ts` and `.tsx`, so the UI is
linted under exactly the same strict rule set as everything else. The only
concession is a browser global set scoped to `packages/ui/src`. No rule is
relaxed anywhere.

## Dependency and build policy

The install-time native build allow-list still names exactly `better-sqlite3`.
The browser toolchain added here contributes nothing to it, and that was
verified rather than assumed: no package added by Vite, Rolldown or React
declares a `preinstall`, `install` or `postinstall` script. The one package in
the graph that does, `esbuild`, arrives through Vitest and was already present
before this phase.

Versions are pinned exactly, in the workspace catalog for anything more than one
package could share, and the packages stay private. This repository publishes
nothing.

An HTTP framework was deliberately **not** installed at P1B: the scaffold did
not serve, so a framework in the graph would have been a dependency nothing
used and a claim nothing backed. The server lane added `fastify` in P1,
together with the fence change that authorises it, which is the point: a lane
cannot widen its own dependency surface without an integrator edit to a shared
file. The same rule produced the `vitest` devDependency each of the three lane
packages now declares.

Raw SQLite access remains forbidden to these packages. Where a test must
corrupt a database on purpose to prove the surface fails closed, it uses the
`node:sqlite` builtin rather than a second driver dependency, so no package
acquires a native module it does not otherwise need and no test resolves a
dependency it has not declared.

## Ownership and the lane envelope

The integrator owns every shared path: the contracts, the ledger, the fence, the
root manifests, the test topology and the authority documents. The three lanes
own the interiors of `packages/cli/`, `packages/server/` and `packages/ui/` and
nothing else.

The fence encodes this as a phase envelope rather than as a general permission.
A path outside the cumulative exact write-set is tolerated only if it sits under
one of those three prefixes, and only while `docs/ROADMAP.md` still says
`P1_INCOMPLETE`. When P1 completes, the envelope closes by itself and the exact
write-set is again the only thing that passes. Files inside the envelope are
still scanned for credential material and for any reference to the product
environment; the envelope widens where a lane may write, never what it may
write.

## What this does not decide

- how the server reads the ledger. Whether it holds one read-only handle or
  opens per request is the server lane's decision, bounded by the contract;
- streaming. The timeline is paginated, not pushed. Live updates would need a
  second transport and a second ADR;
- payload projections, per the decision above;
- the port. Loopback is a law; the number is not.

## Consequences

Positive:

- three lanes can start in isolated worktrees without negotiating shapes;
- the browser cannot reach a database, and that is checked rather than trusted;
- the absolute ledger path cannot leak, because the schema has no field for it;
- an empty control plane and an unreadable one are distinguishable from the
  first screen;
- every response is validated on the way out, so a projection bug is a server
  error rather than a browser mystery.

Negative, and accepted:

- the DTOs are a second shape beside the ledger's read models, and a mapping
  layer has to exist. That is the cost of the browser not linking the ledger;
- the integrity problem kinds are restated rather than imported, so a kind added
  to the ledger must be added here too. The server lane is where both are in
  scope and where the divergence surfaces, loudly, as a parse failure;
- payload contents are unavailable to a reader in P1;
- a browser toolchain is now in the graph, which is a large dependency surface
  for a small UI. It adds no install-time script, and the UI is the only package
  that depends on it.

## Compliance

`scripts/check-architecture.mjs` verifies that this document still states the
decision, that the P1B write-set is exact, that the lane envelope is scoped to
three named prefixes and expires with the roadmap status, that the four new
packages depend on exactly what they were authorised to, that the UI names
neither the ledger nor a database driver anywhere, that the retired Vitest
workspace file is gone and the new config is present, and that no file outside
the authority documents references the product environment.

P1 continues with the three lanes. P1 is complete when the server serves the
contract, the CLI reads it and the UI renders it, and not before.

# `@acp/gateway`

The loopback HTTP front of the observation plane. One Fastify application that
serves every frozen route `@acp/protocol` declares, over a ledger handle it
opens read-only.

## Scope

This package serves the contract; it does not define it. Route patterns,
methods, query shapes and response DTOs all come from `@acp/protocol`, and
every response is validated against its DTO before it is sent. A projection
that grew a field server-side fails at the boundary rather than leaking it.

Nothing here is adopted into real operation. Adoption is a single explicit
decision that happens after P8 certification and a separate P9 authorization.

## Loopback is titular, not configurable

`SERVER_BIND_HOST` is `127.0.0.1` and is not a deployment preference. The
observation surface shows every task, worker and transition with no
authentication in front of it, so `0.0.0.0` would publish the whole control
plane to the local network. The reasoning is recorded in
`docs/architecture/0003-read-only-observation-plane.md` §5, which also states
plainly that authentication on the read plane is deliberately out of scope.

`SERVER_DEFAULT_PORT` is `7517`. The port is not a law; a caller may choose
another. The bind address is.

## Reads are free but one; every write is guarded

Every route was a read through P8-8C, and `API_ALLOWED_METHODS` still says
`["GET"]` because that describes the read plane, which did not change. The
routes that also accept a write are named in a separate frozen table,
`API_WRITE_ROUTES`:

| Write route | Method | What it records |
| --- | --- | --- |
| `initiativeRoadmap` | `POST /api/v1/initiatives/:initiativeId/roadmap` | a roadmap version |
| `accountActions` | `POST /api/v1/accounts/:accountId/actions` | an account action |
| `taskToolCalls` | `POST /api/v1/tasks/:taskId/tool-calls` | one explicit tool call — the only route that starts a child process |
| `taskLifecycle` | `POST /api/v1/tasks/:taskId/lifecycle` | one lifecycle verb against an attempt already running — `CANCEL` or `ATTACH`, through the same operation the CLI door calls |
| `initiatives` | `POST /api/v1/initiatives` | one initiative, under the caller's own id, through `registerInitiative` — the orchestration `acp initiative` calls too; its objective goes to the private artifact plane and the stream records the digest and the reference |
| `tasks` | `POST /api/v1/tasks` | one task intake, under the caller's client key and task id, through `intakeTask` — the orchestration `acp intake` calls too; its envelope goes to the private artifact plane, revision 1 names it by reference, and nothing executes the task |

**One read is not free (P-15/F, ADR 0107).** `taskEffectResult`
(`GET /api/v1/tasks/:taskId/effects/:effectId/result`) answers model output — one
effect's result, read back by reference through the runtime's `readEffectResult` —
so it is named in the closed table `API_PRIVATE_READ_ROUTES` and registered through
`registerPrivateGet`, the read-side twin of the write guard: no bearer configured is
`403 PRIVATE_READ_UNCONFIGURED`, a missing or wrong one `401 AUTH_REQUIRED`, and
every answer on the path carries `Cache-Control: no-store`. The same bearer file
authorizes writes and this read until P-36's read policy. Its sibling
`taskEffects` (`GET /api/v1/tasks/:taskId/effects`) is a plain read: a task's effect
ids, coordinates and outcome words, never a reference, a digest or a byte. Both
live in `effect-result`, which logs nothing and publishes nothing (L-P15F-1).

The fifth (P-14/B) is the portfolio route's own POST: the GET beside it is
unchanged and unguarded. Its seam, `initiative-write`, decides nothing — it
opens a writable ledger, the blob lease store and the plane for one
registration, hands them to `registerInitiative` with the identifiers the route
minted, and closes them. A body the schema refuses is `400`; a registration the
recorded state refuses — `CONFLICT` for the same id with other content,
`REQUEST_INVALID` for a slug outside the contract's grammar, `CONTENT_REJECTED`
when the plane declines — is `409 WRITE_REFUSED` with the field as the detail.
The same body again is `200` with `replayed: true`. The initiative read model
serves the objective back from the plane, by reference and under the
initiative's own scope; bytes the plane cannot produce are `LEDGER_INTEGRITY`,
never a null objective.

The sixth (P-14/C) is the task list's own POST, on the same terms: the GET beside
it is unchanged and unguarded, and its seam, `task-intake`, decides nothing — it
opens the writable ledger, the blob lease store and the plane for one intake,
hands them to `intakeTask` in `@acp/runtime` with the identifiers the route minted,
and closes them. A body `TaskIntakeRequest` refuses, the envelope's own contract
included, is `400`. An intake the recorded state refuses is `409 WRITE_REFUSED`,
its message carrying the class — `CONFLICT` for the same client key with another
request or a task that already entered, `REQUEST_INVALID` for an initiative, a
roadmap version or a role that does not hold, `AUTHORITY_REFUSED` for a role the
registry does not resolve, `CONTENT_REJECTED` when the plane declines — the code,
and a retired model version's proposal, and its detail the field. The same body
again is `200` with `replayed: true`. The task reads it `DISCOVERED` and nothing
more: an intake takes no lease and runs nothing.

All are registered through the same guarded registrar, so the bearer check is
**structural rather than remembered**: a future write route registered through
that registrar is guarded because of where it is registered, and a contributor
cannot forget the guard because there is nowhere to forget it from.

The guard is fail-closed. With no token file configured every write answers
`403` rather than proceeding — an unconfigured door is shut, never open. The
comparison is constant-time over digests: the token is hashed and the hashes
compared with `timingSafeEqual`, so neither the token's bytes nor its length
leaks through timing.

Reads are never guarded, and that is a design statement rather than an
omission. The data is already on the operator's own machine behind loopback.

## The contracts boundary

This package may not name `@acp/contracts` — not in live code, not in its
manifest, not in its tsconfig. The fence enforces all three, and the source
check is a fail-closed substring test rather than a match on an import
statement, because `require(…)`, a dynamic import, a type-only import and a
dependency-injected identifier all reach the package while sliding past a
specifier regex.

Kernel material this package needs arrives through `@acp/protocol`, which
re-exports it for exactly this reason.

## Public surface

| Export | Purpose |
| --- | --- |
| `buildServer` | build the application without listening — for tests and embedding |
| `BuildServerOptions` | type: how the application is built |
| `startServer` | the only function here that opens a socket, and only when called |
| `StartServerOptions` | type: how the server is started |
| `RunningServer` | type: the listening server |
| `openLedgerSource` | open the read-only ledger handle the routes read through |
| `LedgerSource` | type: that handle |
| `computeDatabaseIdentity` | the redacted database identity a response may carry |
| `SERVER_BIND_HOST` | `127.0.0.1`, not configurable |
| `SERVER_DEFAULT_PORT` | `7517`, a default rather than a law |

Importing this module has no side effect. Nothing listens until `startServer`
is called with an explicit ledger path.

## Redaction

The absolute ledger path never crosses the boundary: a digest of the path and
the bare file label do. No response carries an event payload — a timeline item
carries the event's key names and serialized size only. The parity suite
asserts the absence of credential-shaped and transcript-shaped keys on every
route in every client, so redaction is proven as absence rather than described
as intent.

## Tests

`pnpm test` runs the `gateway` project. The parity suite is the behavioral
authority for agreement between the ledger, the CLI and the console: it
asserts route coverage against the live server and three-way agreement route
by route, including ordering, pagination, cursors and redaction.
`docs/api-reference.md` is the readable form of the same route table, and the
fence asserts it against `API_ROUTES` in both directions.

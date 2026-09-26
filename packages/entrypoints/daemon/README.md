# `@acp/daemon`

The supervised process around the durability plane.

## Scope

**This is P2E: process lifecycle, plus an inert launchd template.** The daemon
starts one invocation under an explicitly chosen driver, supervises it, and
stops cleanly when signalled. It can also render a launch agent — an artifact,
not an installation. There is no observation route, no provider adapter and no
product adoption.

**P2F Stage A supplies what was missing.** There is now a packaged entry,
`acp-daemon`, which takes the config-file path launchd passes, and one real
disposable launchd lifecycle drill. **P2 still closes in Stage B**, after an
independent verifier reproduces that drill — the status line lands behind the
evidence, never beside it.

Importing this package has **no side effects**. It parses no argv, creates no
directory, opens no database, binds no socket, spawns no child, installs no
signal handler and writes no file. Effects begin only inside `startDaemon` or
the internal child entry. A fresh-process drill proves it: a same-process
snapshot could not tell an effect that never happened from one that happened
before the check.

**P2E is not product adoption**, and adoption is a separate owner decision at P9
that nothing here anticipates.

The package keeps its two roles in two files. `src/index.ts` is the closed
public surface only — `startDaemon`, `stopDaemon`, `terminateDaemon` and the
public types, re-exported and never declared there. Everything `startDaemon`
composes lives in `src/composition/`, partitioned into five modules (P-13, ADR
0071): the root itself in `src/composition/index.ts` — the observation and
recovery helpers, the launchd rendering/validation surface and the singular,
scheduled and Restate orchestration — the composed ports in
`src/composition/ports/`, the single walk construction in
`src/composition/walk/`, the bounded stop/terminate wrappers in
`src/composition/usecases/`, and the two walk context shapes both the root and
the walk module read in `src/composition/types/`. Tests import the relative
modules directly; that is deliberate, and the mirror suites sit beside the
sources they prove — except `types/`, which declares data and no conduct and
therefore has none to mirror.

## The daemon adds no authority

`packages/persistence/ledger` remains the only one. The daemon opens it, and
`@acp/runtime` drives it in `SQLITE_SUPERVISOR` mode while `@acp/durability`
drives it in `RESTATE` mode — since P8-T G5 those are two packages, and this one
depends on both. The edge from here to the ledger is deliberate and the graph
stays acyclic.

The lock file and the status document are **observations**. Nothing in the
lifecycle, the modes or the singleton reads the status to make a decision, and
the architecture fence forbids the import rather than trusting the convention.
The moment a decision depends on it, it stops being an observation and becomes a
second authority that can disagree with the ledger.

## Two modes, chosen explicitly

`SQLITE_SUPERVISOR` and `RESTATE` are inputs, never inferences. There is no
auto-detection, no retry and no failover. A requested `RESTATE` whose pinned
binary is absent or unverified is a refusal; a requested `SQLITE_SUPERVISOR`
never starts a server. A silent failover would make the mode flag a lie, and an
operator would learn which driver actually ran only by reading the ledger.

`SQLITE_SUPERVISOR` binds zero sockets and spawns zero children. That is not an
incidental property: it is the mode that still works when the external server is
unavailable, so anything it needed from the network would defeat it.

## Startup order, and where readiness is

```
S1  roots validated       owner-only, verified by stat rather than requested
S2  singleton held        exclusive create; the OS arbitrates, not this process
S3  ledger open           and its integrity verified
S4  binary verified       pin, receipt and actual digest must all agree
S5  server up             the pinned server, on loopback
S6  endpoint up           127.0.0.1 only
S7  deployment registered
S8  reconciled            <- readiness is HERE
S9  ready
S10 supervising
```

Readiness is **S8, not S5**. A server that is listening but has not been
reconciled against the ledger is not ready, and calling it ready is exactly how
a derived driver quietly becomes an authority.

Acquisition order defines release order. Every resource is pushed onto an unwind
stack as it is taken and released in strict reverse, each with its own deadline,
so a failure half way through startup leaves nothing behind. The endpoint closes
before the server it is connected to — reverse order gives that for free, and it
matters in itself, because Restate holds persistent HTTP/2 sessions open and
closing them the other way round is what P2C proved will hang.

An unexpected server death after readiness is **terminal**: the status is
classified, the endpoint closes, owned resources unwind and the process exits
nonzero. It never restarts and never falls back.

## The singleton, and why the probe is asymmetric

One daemon per canonical checkout, held by an exclusively created lock file, so
two racing daemons are arbitrated by the operating system rather than by a
check-then-write in either of them. The fixed loopback ports are the machine-wide
backstop behind it: a second checkout passes its own lock and then fails the port
precheck, before readiness and without disturbing the first.

A stale lock is never silently reclaimed. Deciding whether a recorded process is
still *this* daemon is the one question here where being wrong is dangerous, so
the probe is deliberately asymmetric:

- **NOT_SAME** only when it can be proven — no such process, or a start time
  later than the one recorded, which is what a recycled pid looks like;
- **INDETERMINATE** whenever it cannot — including a start time that matches
  while the argv digest does not, and a probe that could not run at all;
- **UNSUPPORTED_PLATFORM** off Darwin.

Only `NOT_SAME` permits removal, only of the exact owned pidfile, and only with
an explicit `adoptStale` decision. **No signal is ever sent on an ambiguous
result**, because the ambiguous case is precisely the one where a signal would
land on a process that is doing its job.

Identity is recorded from `ps`, not from `process.argv`. The two are different
strings — `process.argv` is what this runtime parsed, `ps` is the operating
system's own rendering of the command line — and recording one while later
observing the other would make every live daemon look indeterminate.

## The transports it composes

`execution.bindings` is one array whose every entry declares the transport it
speaks. A `CLI_SUBSCRIPTION` entry carries a binary, a credential root, a
provider, a workdir and limits; an `API_KEY` entry carries a workdir and limits
and **refuses** the other three rather than ignoring them — an operator who
wrote a binary for an API binding believed this transport spawns something, and
a refusal is the correction. The discriminant is required on every entry, so
neither a reader nor the compiler ever infers which shape it is holding.

An `API_KEY` entry declares no provider: the client declares it, and the port
refuses the route against it. Since P-15 escalón E (ADR 0108) it declares the
`models` its client serves and the `maxTokens` it may ask for, both required and
never defaulted, and it is served by the Anthropic Messages client. A
`LOCAL_OR_SELF_HOSTED` entry declares the provider word, a `baseUrl` on a loopback
literal (`http://127.0.0.1:…` or `http://[::1]:…`, no userinfo, query or fragment),
its `models`, and `auth`: `NONE`, or `CREDENTIAL` for a server that takes a bearer.
Every field another transport carries is refused by name.

**A credential never enters the config.** `execution.accountsFile` names the owner's
accounts file, exactly when an entry needs a credential — an API entry, or a local
entry with `auth: "CREDENTIAL"` — and is refused otherwise. At composition the
daemon asks the runtime's resolver for each such account's credential, read from the
`credentials.local.json` beside that file, and hands the closure straight to one
client factory (`transportClientsFor`, the one receiver, L-P15E-3). A refused
credential stops the start before anything is appended, naming the account and the
resolver's word — `CREDENTIAL_ENTRY_ABSENT at credentials.<name>` — and never a byte
of the file. Nothing of the credential reaches the config, the bindings, the port,
the ledger, the status document or the log.

**No accounts file, no client.** A config built by hand without one leaves such an
entry unbound, refused at `route.accountId` — never served from a sibling's binding.
`DaemonOptions.apiClientFor` still exists for tests: a factory given there replaces
the composed API clients whole, and no credential is resolved for them.

Composing a transport is not probing one. The daemon performs no discovery, no
health check and no capability claim at startup: capabilities stay UNKNOWN, and
what a client can serve is answered when the route is admitted. ADR 0052 records
the whole of it.

## The recorded form

Since P-15 escalón D3 (ADR 0105, decision 139) the daemon also runs a task the
intake already recorded. The config names it by `databasePath` — the operator's
ledger, absolute and canonical — its `taskId`, and the `PRICE_TABLE` its delivery
is pinned against in `execution.catalogDocumentId`, which has no default. The form
is exclusive with every inline coordinate (`envelope`, `walks`, `scenarioId`,
`attempt`, `submittedAt`, `submissionDigest`, `initiativeId`), each refused by
name: the envelope, the revision, the attempt, the instant and the initiative are
read back from the ledger, never restated. It runs one walk under
`SQLITE_SUPERVISOR`, through `startRecordedDaemon`.

The start creates the evidence directory beside the ledger — `executions/`, mode
0700, only if it is absent — and the runtime admits it or the start is refused.
The walk's markers go one level deeper, at
`executions/executions/<operationId>.json`, because the evidence port writes under
its root's own `executions/`.
The walk records its whole chain through the runtime's execution chain: the price
pin, the effect, the delivery, the prompt, the usage stream, the result and the
response. A recorded walk writes no `TOKEN_USAGE_RECORDED`, so V1 quota does not
see its spend until P-19. Codex and Kimi declare no usage source yet, so a
recorded walk on them is refused at the start.

A task recorded under a superseded contract version is refused at the start by
name, before any walk, lease, dispatch or provider spawn (P-16/A1, ADR 0120): the
recorded-task reader reads the stored envelope's `contractVersion` before its
shape, and the start fails with `the recorded task is refused:
ENVELOPE_VERSION_SUPERSEDED at envelope.contractVersion`, or
`ENVELOPE_VERSION_MISMATCH` when the envelope's version is not the one its
hash-chained intake event carries. The path for a superseded task is
re-submission under the version in force, through `acp intake` or
`POST /api/v1/tasks`. The E3/E4 tests prove zero spend through `runDaemonChild`
over a planted ledger; that one test file is the only daemon file the fence lets
import `node:sqlite`, to plant it.

## Bounds

Logs are capped three ways: total bytes, file count, and a single line. All
three are needed, and each is tested past its limit. A byte cap alone lets
rotated files accumulate; a file cap alone lets each one grow; a line cap stops
one enormous message defeating both at once.

The status document is bounded, shape-checked and written atomically. It carries
process ids deliberately — they are not secrets, and an operator or a drill
needs them to end exactly the right process instead of pattern-matching across
the machine. It carries no absolute path, payload, environment value, credential
or raw exception text, because there is nowhere in its shape for one to sit.

## Tests

The drills use real processes and real signals: SIGTERM, SIGINT, SIGKILL
followed by explicit recovery, a partial start refused on a held port, and the
external server killed by the exact pid the daemon published. A shutdown
demonstrated by calling a function in-process proves nothing, because the file
handles, the page cache and every object survive it, which is precisely what
losing a process does not do.

The P-15/E rows run the real HTTP clients from the doors to the result. The API leg
calls a `fetch` substitute installed on `globalThis` for the packaged run alone —
restored in `finally`, then armed to refuse a late call — and no socket; the local leg
talks over a real loopback socket to `test/testing/loopback-sse-server/index.mjs`, a
tracked fixture spawned by path, the one socket these drills open. Every credential is
a synthetic canary written into a disposable directory and swept from every sink.

## The packaged entry

`acp-daemon` (`src/bin/acp-daemon/index.ts`, exposed as the one `bin`) is what launchd
executes. It takes **exactly one positional argument: an absolute config-file
path** — not a flag, because the tracked template fixes
`ProgramArguments` at `[PROGRAM_PATH, CONFIG_PATH]`, exactly two strings, and
the validator refuses a third. The committed artifact dictates the contract,
which is what "no caller wrapper" means: launchd runs the built form of a file
in this repository, with nothing an operator wrote in between.

The config file is held to the same law as a rendered path — absolute,
canonical, a regular file, owned, not group- or world-writable, size-bounded on
the `stat` before it is read — and its content is validated by the **existing**
child schema, so the file and argv contracts cannot drift apart. Refusals are
classified exit codes (`2` usage, `3` path, `4` content) and never echo content.
The entry reads **no environment**: launchd controls a job's environment, and an
entry that read from it would take instructions nobody reviewed.

The tracked source keeps the portable `#!/usr/bin/env node`. The build
materializes the real interpreter into the ignored `dist/` artifact, because a
launchd gui job runs with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and a Node
installed outside it would never be found. Host-specific bytes stay in build
output, never in a tracked file.

The internal child entry remains for the signal drills; it is not the bin.

## The launchd template

`launchd/com.rottay.agent-control-plane.plist.template` is a tracked,
path-neutral template: no account, home directory, repository path or machine
value appears in it. Because its placeholders sit inside `<string>` elements it
is a valid plist exactly as tracked, so the artifact a reviewer reads is the one
the linter checks.

`RunAtLoad` and `KeepAlive` are present and false — present rather than omitted,
because a document that relies on a default no longer states what it does. Every
automatic start trigger is refused by name.

The validator **parses** rather than scanning text, and the reason is concrete: a
document carrying `RunAtLoad` twice, once false and once true, satisfies any
substring check and passes `plutil -lint` outright, while launchd resolves the
duplicate on its own rules. Only a parser can refuse both orderings. Truncated
documents are classified as truncation at every cut point, including cuts inside
a tag.

`plutil` runs in the drills and never in production: the two allow-listed
subprocess sites established for the daemon stay two, and a lint is not a reason
to make it three. One drill asserts the TypeScript reader and the system parser
agree on all six values and both booleans.

Rendering is pure and writing is separate. `writeLaunchAgent` writes only under
`.acp-local/launchd/`, owner-only and atomically. **Nothing invokes `launchctl`
and nothing writes under `~/Library/LaunchAgents`** — see
`launchd/README.md` for the manual command an operator may choose to run, which
is recorded there precisely so that "never automated" refers to something
concrete.

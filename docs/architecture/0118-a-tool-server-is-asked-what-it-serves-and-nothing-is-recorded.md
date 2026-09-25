# ADR 0118 — A tool server is asked what it serves, and nothing is recorded

- Status: accepted (P-24, cut B(a), recorded 2026-09-25).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0109, by reference: its §Three sentence "`port.listTools` … has no
  production caller until the daemon composes the port" and its alternative "A discovery
  verb at the doors". ADR 0109's text is not edited, and its decision stands.

## Context

Requirement J4 says a tool "se **descubre** y se autoriza por schema versionado; un
mismatch rechaza", and integrations row 6 gives `ToolProtocolPort` "discover, execute,
result, schema, versión". The composition operation catalogue names the operation
**`acp.tools / LIST | ToolProtocolPort.listTools | ninguno; sólo consulta`**, and states
that **"consultas no crean efectos ficticios"**.

Measured at `20c46c2`, `port.listTools` existed and was exported, and no production code
could reach it: `openToolOperation` exposed only `callTool` and `close`, and L-B4B-8
forbids any other composition site. An operator could ask the plane which of the
allowlisted tools a server serves under the pinned schemas only by making a real
`tools/call` and reading a `SCHEMA_MISMATCH`. J4's "se descubre" held inside the port
only. ADR 0109 carried the discovery verb as a later cut: "a new entrypoint needs its own
e2e and parity at both doors". This record is that cut.

A second, latent defect became reachable with the verb, and this cut closes it.
`callTool` prefers the loopback leg's out-of-band transport refusal
(`transportRefusalOf(connection.transport)`) and drops the connection when one was
recorded. `listTools` dropped the connection only on `PROTOCOL_VIOLATION` and never read
the carried refusal. So a refused loopback redirect during a listing reached the caller as
the client's `PROTOCOL_VIOLATION` at `server.response`, not as `TRANSPORT_REFUSED` at the
redirect's field path. The connection was already dropped: recording the refusal ends the
loopback connection, which settles the client's pending request with `PROTOCOL_VIOLATION`.
Brief v1 said the word was timeout-class and the connection kept; the correction round
v2.1 measured the client's word on the drilled redirect and corrects both.

This cut uses fixtures only: the stdio fake and the scripted loopback peer of this
repository. It uses no real server, spends nothing, and needs none of the twelve owner
permissions of the P-24 map. It was briefed read-only (brief v1). Kimi K3 pre-audited it
under the owner's order of 2026-09-25, while Fable was over its usage limit. Its five
blocking and six non-blocking corrections were adopted as the DT's rulings. The writer's
stop on two write-set questions was ruled the same way (stop-ruling 1). **Fable's audit
of this cut is pending**, and is never simulated.

## Decision

### One — the discovery scope, at the one composition site (decision 208)

`openToolDiscovery({servers, serverLifetimeMs?}): ToolDiscoveryScope` is declared in
`packages/edges/tools/src/operation/index.ts`, beside `openToolOperation`. That file stays
the only place outside the package's suites that calls `createToolProtocolPort(`
(L-B4B-8, unchanged). The scope:
- composes its own port with a **constant, internal** scope id, `"tool-discovery"`. The
  id never crosses a boundary and holds no slash. It therefore cannot collide with an
  execution scope (`tool/<taskId>/…`) or an execution session (three segments led by a
  task id). Liveness follows the operation scope's rule: true for this id until
  `close()`;
- exposes `listTools(serverId)` and `close()`, and **no `callTool`**. A discovery scope
  cannot call a tool by construction;
- `close()` drops liveness first and then reaps, and is idempotent.

A door opens one scope, lists once and closes it in a `finally`, so the child is gone
before the answer leaves. `TOOLS_PUBLIC_EXPORTS` 48 → **51** (`openToolDiscovery`,
`ToolDiscoveryScope`, `ToolDiscoveryInput`).

### Two — two corrections to `listTools` (decision 208)

1. **The carried transport refusal.** After `trustedListing` fails, `listTools` applies
   `callTool`'s rule. It reads `transportRefusalOf(connection.transport)` and drops the
   connection when the refusal is `PROTOCOL_VIOLATION` **or** a carried refusal exists.
   The carried word and `at` are preferred. The loopback suite drills it: a redirect
   answered to the first `tools/list` yields `TRANSPORT_REFUSED` at the redirect's field
   path, promptly, and the connection is dropped. Its positive twin, the same peer
   without the redirect, lists twice on one connection. What the row pins, stated
   (verification v2, N-1): its drop half is red when the drop is removed, because a kept
   connection answers the next listing with the stale carried word, and it counts a
   second `initialize`. The drop it observes comes from the `PROTOCOL_VIOLATION`
   disjunct, since the client's own word on that path is `PROTOCOL_VIOLATION`. Removing
   only the `|| carried !== null` disjunct (the verifier's mutant M2) leaves every row
   green: no row can drive a carried refusal with any other client word, because the
   recording ends the connection. That disjunct is `callTool`'s rule copied for symmetry
   and is carried by code reading, not by a row.
2. **The mismatched tool's name.** The `SCHEMA_MISMATCH` arm of `ToolListingOutcome`
   gains `toolName`: the first allowlist entry, **in allowlist order**, whose pin the
   advertisement did not match. The mismatch is on the input schema
   (`server.tools.inputSchema`) or, since ADR 0117, on the output schema
   (`server.tools.outputSchema`); `at` still says which. The name is a field of its own
   and never a segment of `at`, because a bounded name of up to 120 characters spliced
   into the path would overflow the protocol's 120-character `at` (ADR 0109 §Four). The
   other refusal arms carry no `toolName`.

Unchanged and stated: the allowlist is the authority; the first mismatch refuses the
whole listing (P-24/A ND-6); an allowlisted tool that is not advertised is **omitted**,
not refused; an advertised tool that is not allowlisted is never named. That omission is
where `listTools` and `callTool` part: `callTool` refuses an allowlisted tool that is not
advertised as `SCHEMA_MISMATCH` at `server.tools`. The port suite's coherence row asserts
agreement on every advertised tool and the parting on the omitted one. It does not claim
"completes iff".

### Three — one route, a private read, and API 0.24.0 (decision 209)

- `API_ROUTES.toolServerTools = "/api/v1/tool-servers/:serverId/tools"`. Its builder
  `toolServerToolsPath(serverId)` validates `BoundedIdentifier`, whose grammar has no
  slash, and then applies `encodeURIComponent`, following `taskPath`'s rule.
- `API_PRIVATE_READ_ROUTES` becomes `["taskEffectResult", "toolServerTools"]`. The
  table's meaning widens from "answers model output" to **"is not free"**: a read either
  answers model output, or starts a child to ask a peer about the operator's tool
  document. The write table's sentence that process-start authority exists only on the
  write routes is restated. It now exists in exactly two places, both behind the bearer:
  `taskToolCalls` POST, which acts and records, and `toolServerTools` GET, which asks and
  records nothing.
- **`ToolDiscoveryResponse`** (strict, guarded) has these fields: `apiContractVersion`,
  `ledgerContractVersion`, `serverId`, `outcome` (`COMPLETED` or `REFUSED`), `refusal`
  (the refusal grammar, nullable), `at` (≤ 120, nullable), `toolName` (bounded
  identifier, nullable), `tools` (strict `DiscoveredTool` `{name, writes}`, at most
  `MAX_DISCOVERED_TOOLS` = 256) and `count`. Its refinements:
  - `COMPLETED` holds exactly when `refusal`, `at` and `toolName` are all `null`;
  - `REFUSED` requires an empty `tools` and a zero `count`;
  - `count` equals the length of `tools`;
  - `toolName` is non-null exactly on `SCHEMA_MISMATCH`;
  - `tools` is sorted by name.

  The response carries **no `transport` field and no schema byte**. `MAX_DISCOVERED_TOOLS`
  is the protocol's own bound, because the protocol may not import `@acp/tools`. The one
  gateway test that sees both constants asserts it equals `TOOL_LIST_TOOLS_MAX`: the
  answer is a subset of one advertisement.
- **Sorted by name at the doors.** The port answers in allowlist order. Each door
  projects its answer to `{name, writes}` sorted by name, so two producers over one
  advertisement print the same bytes whatever order an operator wrote. Row D12 at both
  doors answers two tools, allowlisted and advertised in reverse order.
- **A port refusal is a 200** (`EXIT_OK` at the CLI) with `outcome: "REFUSED"`. The
  request was valid and the plane answered it truthfully about the peer. Mapping the
  words to status codes would add error codes and a second vocabulary for the same twelve
  words. `SERVER_NOT_ADMITTED` follows the same rule, as at the tool-call door.
  `API_ERROR_CODES` stays at 16.
- No query schema: an empty query is asserted, and any query parameter is `400`.
- Parity: a new non-ledger source, **`TOOL_SERVER`**, follows the `ACCOUNTS_FILE`
  precedent. Every field except the versions binds to it, each with its `because`.
  `ParitySource`/`NON_LEDGER_SOURCES` 5/4 → 6/5; `PARITY_ROUTES` 26 → 27.
- `SURFACE_MAP` gains `tool-servers` → `toolServerTools` GET `DOCUMENT` (38 → 39), on the
  `result` → `taskEffectResult` precedent.
- `API_CONTRACT_VERSION` moves 0.23.0 → **0.24.0**. The move is minor because the route
  surface moves; `API_ALLOWED_METHODS`, `API_WRITE_ROUTES` and `API_ERROR_CODES` do not.
  Ten live test literals in four files were restamped by recomputation from the constant.
  **ADR 0116 and decision 200 had assigned 0.24.0 to P-16/A1.** This cut took it first,
  so P-16/A1 re-takes the next minor from the real HEAD when it lands.
  `CONTRACT_VERSION` (2.10.0) and `LEDGER_CONTRACT_VERSION` do not move, because a query
  records nothing.

### Four — the two doors (decision 210)

**API.** The route is registered through `registerPrivateGet` (L-P15F-2 now sees two
private reads). The bearer is checked before `serverId` is read and before any child
exists. With no bearer configured the answer is `403 PRIVATE_READ_UNCONFIGURED`. The
handler runs `parseServerIdParam`, which is declared in the new
`gateway/src/tool-discovery` module and uses the builder's own grammar: an id outside
the grammar is `400` at `serverId`. It then asserts the empty query and calls
`discoverTools`. That function refuses `503 TOOL_SERVERS_UNCONFIGURED` before any child
when the startup load of the tool document did not admit one, naming no path. Otherwise
it opens the discovery scope, lists, closes it in a `finally` and projects the answer. It
opens, reads and touches no ledger. Every answer carries `Cache-Control: no-store`;
POST, PUT, PATCH and DELETE are `405`. `HEAD` is not: the framework registers it beside
every GET, so behind the bearer a `HEAD` runs the same handler, starts and reaps a child,
records nothing and drops only the body, as it already did on `taskEffectResult`. The
`401` message is `registerPrivateGet`'s shared wording from P-15/F, "a valid Bearer
credential is required to read this result"; on this route "this result" means the
listing. The wording is left as it is: changing it is a change to the shared registrar
and to `taskEffectResult`'s answer (verification v2, N-3).

**A stated limit, and why the root fix was not taken.** Fastify's router refuses a path
parameter longer than its default `maxParamLength` of 100 before any handler runs. A
server id of 101 to 120 characters is a valid bounded identifier and admissible in an
operator document, but at the API it is the framework's `400`
(`FST_ERR_MAX_PARAM_LENGTH`), not the port's answer, and it comes before the bearer
check, so an unauthenticated caller sees that `400` rather than `401`; it carries a closed
word and nothing about the document. **Such an id can be asked only at
the CLI door**, where D9 admits 120 characters. The gateway suite measures 101, 120 and
121 with no child started, and the API reference states the limit. Raising
`maxParamLength` to 120 in `buildServer` was rejected by stop-ruling 1 (Q2): it is a
global change to every route's parameter handling. Parameters of 101 to 120 characters
on routes this packet does not own would start reaching their handlers' own validators,
which is outside this packet's authority.

**CLI.** The verb is `acp tool-servers --tool-servers <doc> --server <id>`. The name
`tools` would read as a local catalogue, and `tool-call` and `tool-calls` are taken.
It is **the one verb that opens no ledger**. It branches above the `--database` law and
**refuses `--database`** as a usage failure naming it, rather than accepting a flag it
would silently ignore. The steps, in order:
1. `--server` is judged first, against the builder's grammar (a usage failure at
   `server`).
2. The document goes through the tool-call verb's ladder, `readOperatorDocument` with
   `secret: true`, the bearer file's `0600` rule.
3. The document is admitted all or nothing; an unadmitted one is `BAD_REQUEST` at
   `tool-servers`.
4. The verb opens the scope, lists, closes it in a `finally`, and prints the
   `ToolDiscoveryResponse` as JSON regardless of `--format`.

**The rows, through the real doors.** Each door suite has its own stdio fake, which logs
its pid and every method it is asked:

| Row | Scenario | Both doors |
| --- | --- | --- |
| D1 | pins equal; one allowlisted tool advertised beside one nobody allowed | `COMPLETED`, that tool alone, `count` 1; the other name is never printed; one listing, no call |
| D2 | the tool on page 3 of 3 | three listings, no call; `COMPLETED` |
| D3 | one nested input key differs | `SCHEMA_MISMATCH` at `server.tools.inputSchema`, `toolName` named |
| D3o | an output schema advertised against a pin of none | `SCHEMA_MISMATCH` at `server.tools.outputSchema`, `toolName` named |
| D4 | allowlisted, not advertised | `COMPLETED`, omitted, `count` 0 |
| D5 | a cursor cycle | `PROTOCOL_VIOLATION` at `server.tools.nextCursor`; child reaped |
| D6 | pages past `TOOL_LIST_PAGES_MAX` | `RESULT_UNBOUNDED` at `server.tools` |
| D7 | a server the document does not admit | `SERVER_NOT_ADMITTED` at `request.serverId`; no child |
| D12 | two tools, in reverse order in the allowlist and the advertisement | both, sorted by name |

At the CLI, D8–D11 refuse before any listing and start no child. D8 is an unpinned tool
in the document; D9 an id out of grammar, with 120 characters admitted; D9b a missing
`--server`; D10 a supplied `--database`, after which no file appears at that path; D11
the document ladder. At the API, the guard rows cover `403`, `401` on a missing or wrong
bearer (also for an id out of grammar), `405`, `503` naming no path, `400` at `serverId`,
`400` on any query, and the 100-character limit above.

**Nothing is recorded (A-4).** At the API the ledger's status, its event page and the
bytes and mtimes of its files are identical before and after D1–D7. At the CLI a ledger
beside the run keeps its bytes and mtime, and no database file is created. **No
`tools/call` is ever sent**, and every child is reaped before the answer.

**Parity.** The parity suite reaches the CLI verb through a fifth deep alias to the
CLI's discovery door, named with the `-door` suffix of the two door aliases before it.
Following stop-ruling 1 (Q1), it is declared in `vitest.config.ts` and in the gateway
test `tsconfig.json`, and pinned by the fence's alias law, which lets only the parity
suite name it. For D1, D2, D3, D3o, D5, D6, D7 and D12 it asserts that the CLI document is
deep-equal to the API body over one operator document and one fake. It also asserts that
each door drove the fake through the same listing sequence with no call, and that every
child is reaped.

### Five — the laws (decision 211)

- **L-P24BA-1, "discovery is asked from two doors, through the discovery scope, and
  never at readiness"** (new, path-scoped). The law reads every `packages/*/*/src` `.ts`
  file outside `packages/edges/tools/`, tracked or in the write-set, with comments
  stripped, every call matched with whitespace or `?.` before the parenthesis.
  `openToolDiscovery(` must appear in exactly the two door files. Under
  `packages/entrypoints/`, `.listTools(` must appear only in those two files. Neither
  door may name `runToolCall`, `openToolOperation` or `createToolProtocolPort`. The
  gateway door's `discoverTools(` is called exactly once, in `gateway/src/routes`,
  inside the `registerPrivateGet(` call that registers `API_ROUTES.toolServerTools`, so
  an unguarded route calling the door is red; the CLI door's `runToolDiscoveryVerb(` is
  called exactly once, in `cli/src/cli`.
- **L-P24BA-2, "a query records nothing"** (new, path-scoped). The two door files must
  call none of `openLedger(`, `openForWrite(`, `openToolClaimStore(`, `.append(`,
  `requireOpen(` or `getTask(`, and must name neither `@acp/ledger` nor `@acp/runtime`
  (nor a subpath) in any quote, so an aliased import is seen by its specifier. The body
  of `openToolDiscovery`, found by brace matching, must not name `callTool`.
- `PATH_SCOPED_LAWS` 171 → **173**. L-B4B-8, L-B4B-9, L-B4B-11, L-B4B-12 and L-P15F-2 are
  unchanged and green. The parity alias law grows from four specifiers to five.

Stated limits: both are text-level matchers. They do not see an alias of a function
(`const f = discoverTools; f(...)`), a computed member (`scope["listTools"](`), a re-export
under another name, a `registerPrivateGet(` call that names the route through a variable,
a helper in another file that opens a ledger and is called from a door, a specifier
assembled at run time, or a `callTool` reached through a variable the scope body does not
name. Two more are named by verification v2 (N-2), both harmless in effect: a
parenthesised callee, `(discoverTools)(…)`, is not counted as a call, so an unguarded
route could call the door that way; and the guard clause matches
`API_ROUTES.toolServerTools` by a regular expression over the whole `registerPrivateGet(`
argument span, string literals included, so the one call could sit inside the
`taskEffectResult` registration if that span held the text `"API_ROUTES.toolServerTools"`
in a string. In that second case the call is still behind the bearer. The door suites'
A-4 rows and the scope's `"callTool" in scope === false` row carry the behaviour.

## Why the alternatives were not chosen

**A write route with a GET half.** Every GET half is unguarded by design, so it would
either leak the document or be an empty read invented to satisfy the table. The
catalogue names the operation a query.

**A fourth route table for "process reads".** A new table and a new law for one member.
Widening the private table's meaning costs two docblock sentences and is stated above.

**A recorded `TOOL_LISTING_RECORDED` row and a contract bump.** "Consultas no crean
efectos ficticios." A later packet that needs an audit trail of listings reopens this
with the owner.

**Answering the advertised schemas, or every advertised tool, for pin authoring.** That
hands up to about 2 MiB of untrusted peer bytes per listing to an operator output, and
wants its own bounds. It may also need the live conformance run first. It becomes owner
row **(h)** of P-24.

**A query parameter instead of a path segment.** The server is the resource asked, and a
path segment is validated and encoded by the builder like every other id.

**The CLI verb requiring `--database` and ignoring it, or opening it as a probe.** A flag
a verb silently ignores is a claim it does not keep. A probe would be a ledger open for a
query that has no ledger fact to read.

**Mapping port refusals to 4xx/5xx codes.** That would be a second vocabulary for the
same twelve words and would grow `API_ERROR_CODES`.

**`maxParamLength: 120` in `buildServer`.** A global change to every route, outside this
packet's authority (§Four).

## Consequences

- An operator can ask, through either door and behind the bearer at the API, which of
  one server's allowlisted tools are served under their pins, and which tool broke a pin.
  No call is sent, no row is written, and no child survives the answer.
- `port.listTools` has two production callers, and both go through the discovery scope.
  ADR 0109's "a tested surface without a consumer" no longer holds.
- A refused loopback redirect during a listing is `TRANSPORT_REFUSED` with the connection
  dropped, as it already was during a call.
- Server ids of 101 to 120 characters are asked at the CLI door only, and at the API they
  are the router's `400` before the bearer check.
- The implicit `HEAD` on both private reads runs the handler behind the bearer; a `405`
  for it is left to a later cut.
- Pins that move: `API_CONTRACT_VERSION` 0.24.0; `API_ROUTES` 27;
  `API_PRIVATE_READ_ROUTES` 2; `SURFACE_MAP` 39; `PARITY_ROUTES` 27;
  `ParitySource`/`NON_LEDGER_SOURCES` 6/5; `TOOLS_PUBLIC_EXPORTS` 51; the CLI's
  `COMMANDS` gains one; `PATH_SCOPED_LAWS` 173; the parity deep aliases go from four to
  five; the ADR corpus 118; one more epoch-frozen record (244).
- Pins that do not move: `CONTRACT_VERSION` 2.10.0, `MIGRATIONS` 27, `API_WRITE_ROUTES`
  8, `API_ERROR_CODES` 16, `API_ALLOWED_METHODS` `["GET"]`, `TOOL_REFUSALS` 12,
  `MCP_PROTOCOL_RECORD` and L-B4B-17's table 20.

## Not in this record

- (h) **Pin authoring**: answering the advertised schemas so an operator can write a pin.
  It is a new owner row of P-24.
- Window B, and any listing at daemon readiness (P-24 (c), or P-21 if the composition
  moves); L-P24BA-1 forbids a readiness listing until then.
- The real profile and its permissions (P-24 (d)); several pins per tool (P-24 (e));
  structured content as a field of its own (P-24 (f)), which will take its own API minor
  from the real HEAD; one word for a conformant result this client does not carry
  (P-24 (g)).
- A recorded listing: no owner row is proposed.
- Exposing tools to a model session (A2's file family); `READ_ONLY`/`workspaceMode`
  (P-17); UI, P9 and cutover.
- Fable's audit of this cut, pending its quota.

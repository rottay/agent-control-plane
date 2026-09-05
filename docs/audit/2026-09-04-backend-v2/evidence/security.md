# acp-security — audit report (snapshot 4569478)

Scope: every path by which a secret, a prompt or a tool argument could leave the
process, plus the harness/MCP boundary. Probes under `scratchpad/probes/`; three
tools test files re-run (77 passed). Snapshot left clean at HEAD 4569478.

## Scores + justification

**Seguridad operacional: 9/10.** The leak-relevant surfaces are closed by
construction, not by discipline: the child environment is built key-by-key from a
four-name allowlist; `AdapterError` has no free-text member at all; the daemon
status document is ten fields of closed vocabulary; the durable tool receipt is
nine scalars written out by name with a grammar check on each; the bearer guard
holds a digest and the token string leaves scope at load; the console token lives
in a module-scope variable with no storage API in the package. Provider `text`
deltas, `toolUse.detail` and `error.detail` never reach the ledger, the log or the
wire — the walk reduces the whole event trail to one `trailSha256` and records only
`usage`. The point off is that the last line of defence, the contract guard, is
heuristic, and one heuristic (`scrub`) catches the wrong class.

**Harness/MCP fail-closed: 9/10.** Two transports, both bounded. Loopback is two
string literals, not a range; `localhost` is refused *because* it is a name.
Redirects are `manual` and refused visibly. The allowlist is consulted upstream of
the wire, so a refused tool costs the server no traffic. Write authority is set
membership over `TOOL_WRITE_ROLES`, and an out-of-grammar identity is refused for
every call. Each of those is asserted, not stated. The point off is the
tool-identity check: names only, no schema digest.

## Findings

### SEC-1 — the ledger payload is an open map; its only contract guard is heuristic
**Class 2 (improvement).**
Evidence: `packages/kernel/contracts/src/schemas/control-plane-event/index.ts:132`
declares `payload: z.record(z.string().max(80), z.unknown())`, refined at :137 by
`attachGuards(value, ctx, { transcript: true })`. The scanner
(`.../credential-guards/index.ts:113-123`) anchors its JWT pattern `^ey…$`, so a
token embedded in any longer string escapes. Probe against the built contract
(`scratchpad/probes/sec-event-probe.mjs`), a real `ControlPlaneEvent.safeParse`:

```
REFUSED  | payload.apiKey (denied key)
REFUSED  | payload.note = bare jwt
ACCEPTED | payload.note = jwt inside a url
ACCEPTED | payload.note = jwt inside prose
ACCEPTED | payload.note = base64 provider key
ACCEPTED | payload.note = aws secret access key
ACCEPTED | payload.stdout = full provider prompt
ACCEPTED | payload.notes = an array of turns
REFUSED  | payload.messages (denied transcript key)
```

Impact: bounded today because every producer builds a closed payload by hand —
`.../runtime/src/tool-receipt/index.ts:281-291` writes nine named scalars and says
why it never spreads. The contract will not catch the first producer that stops.
No test covers the embedded-token case; the contracts suite asserts only the bare
form (`.../contracts/test/schemas/index.test.ts:503`). Minimal fix: replace the
`^…$` JWT anchors with a `\b`-bounded pattern, and add per-type payload schemas
where the shape is fixed. Phase: next contracts packet.

### SEC-2 — the value patterns never run over key names
**Class 2.** Evidence: `credential-guards/index.ts:176-186` tests a key only with
`isDenied(normalized)`; `SECRET_VALUE_PATTERNS` is reached only from the string
branch at :154. Probe confirms `{ "ghp_AAAA…": "x" }` passes. Already known and
patched at exactly one call site — `.../accounts/src/registry/index.ts:234-253`
runs `findCredentialViolations` over `knownLimits` key names, and its comment says
the traversal fix "belongs in `@acp/contracts`, once, for every consumer". Impact:
any future `z.record` in a guarded schema reopens it silently. Minimal fix: in
`scan`, test key names against the value patterns too. Phase: with SEC-1.

### SEC-3 — the daemon log's only redaction is a path-shaped denylist
**Class 2.** Evidence: `packages/entrypoints/daemon/src/log/index.ts:53-57`.
`scrub` replaces `/[^\s]{2,}` runs with `<path>` and truncates at 200 characters,
so a credential with no slash is untouched. The one free-text field is
`terminal.cause`'s `detail` (`.../daemon/src/index.ts:986`, from `terminateDaemon`
at :1010). Impact: not reachable today — the sole caller passes the literal
`"UNEXPECTED_EXIT"` (`.../daemon-child/index.ts:567`) — so the type permits what
the code does not do. Everything else logged is a count, a fence number, a mode, a
task id, or `classify(error)`, which returns only `error.code` or `error.name`
(`.../lifecycle/index.ts:99-105`). Minimal fix: type that detail as a closed
vocabulary. Phase: hardening.

### SEC-4 — the advertised tool list is joined by name, never by schema digest
**Class 2.** Evidence: `packages/edges/tools/src/port/index.ts:184-188` intersects
`server.allowlist` with `new Set(listed.value)`, and `listed.value` is only the
`name` strings (`.../client/index.ts:232-241` discards `inputSchema` and
`description`). Impact: an admitted server that changes what an allowlisted name
*does*, or what arguments it takes, is indistinguishable from the reviewed one.
The `writes` bit is the operator's declaration rather than the server's, which is
the right direction, but it means a server can make a declared-read tool write and
the plane still routes to it. Minimal fix: digest `inputSchema` at first
`tools/list`, store it beside the allowlist entry, refuse when it moves. Phase:
next tools stage.

### SEC-5 — `HOME` is on both env allowlists, so the allowlist is not the blast radius
**Class 3 (preference), correctly disclaimed.** Evidence:
`.../providers/src/config-root/index.ts:44` (`BASE_ENV_KEYS = ["HOME","LC_ALL","PATH"]`)
and `.../tools/src/contract/index.ts:174` (`TOOL_SERVER_ENV_KEYS`, same three). A
provider child or tool server therefore reaches the operator's whole home
directory, including the owner accounts file, whatever the config-root variable
points at. `SECURITY.md:199-202` names sandboxing out of scope and says the
allowlist "bounds the blast radius; it is not a sandbox" — honest, but the four
variables bound what is *handed* to the child, not what it can *reach*. Fix:
reword. Phase: doc.

### SEC-6 — `AgentHarnessPort` is an edge interface, and deliberately
**Class 4 (planned and correctly absent).** No `AgentHarnessPort` exists in
`@acp/contracts`. `AgentHarness` is an interface in the providers edge
(`.../providers/src/harness/index.ts:84`), and ADR 0019:76-83 records the decision
by name: the roadmap's port is "realized where its consumers are… Moving it to
contracts is the signal that the durable boundary below is being crossed." The
neutral port that does exist is `ModelExecutionPort`
(`.../contracts/src/schemas/execution-boundary/index.ts:268`), and the domain sees
only that. Nothing to fix.

## Leak-surface table

| Surface | What can cross | Guard | Structural / heuristic | Test |
|---|---|---|---|---|
| Child env (provider) | `HOME`, `LC_ALL`, `PATH`, one config dir | `buildEnv`, config-root:105-116 | structural (key-by-key, never spread) | yes — `providers/test/config-root/index.test.ts:99-140`, with a planted variable |
| Child env (tool server) | same three | `buildToolServerEnv`, admission:182-189 | structural | yes — fence pins the set; contract suite pins the literal |
| argv | claude: model alias, `--session-id <taskId>` / `--resume`; codex/kimi: fixed words | adapters' `buildArgv` | structural (array form, no shell, no prompt) | yes — descriptor equality per adapter |
| Ledger event payload | anything under an 80-char key | `attachGuards` + producer discipline | **heuristic** at the contract, structural at each producer | producer yes (`tool-receipt`); guard bypasses untested |
| Tool receipt (durable) | nine scalars: ids, vocabulary words, byte counts | `requireIdentifier`/`requireVocabularyWord`/`requireCount`, tool-receipt:218-226 | structural | yes — `tools/test/receipt/index.test.ts`, 19 assertions |
| Tool result content | text blocks, ≤4096 B each, ≤65536 B total | `toolResultIsUnsafe`, then the caller's body only | heuristic filter, structural non-persistence | yes — `port/index.test.ts:270-283`, no fragment in the outcome |
| SSE frames | `TimelineItem` = payload **key names** + byte size | `StreamFrame` strictObject, protocol:1304-1350 | structural | yes — `gateway/test/stream/index.test.ts:784,968,1022` |
| API DTOs | `AccountDto` with no `credentialRef`, no `authProfileRef` | `.strictObject` omission, protocol:1813-1852 | structural (growing the field fails parse) | yes — sweep over 8 real route bodies, `gateway/test/parity/index.test.ts:590-608`, positive control at :612 |
| Daemon log | event name, closed code, scalar fields | `SAFE_EVENT` + `scrub` + three caps | **heuristic** (path-shaped only) | caps tested past their limit; scrub tested for paths |
| Daemon status doc | ten fields, closed vocabularies | `status/index.ts:38-51` validators | structural | yes |
| Console DOM | token in one `type="password"` input, cleared on submit | module-scope variable | structural | zero `localStorage`/`sessionStorage`/`cookie` in console src |
| Telemetry | allowlisted attributes only | `emitTelemetry`, telemetry:247-289 | structural allowlist | yes |

## Verified claims that hold

- **`process.env` is read in two files repo-wide**: `config-root/index.ts:111` and
  `tools/src/admission/index.ts:185`. The fence pins both by exact path
  (`check-architecture.mjs:13526`, `:14403`) and bans `shell:`, `...process.env`
  and `maxBuffer` at each spawn site (`:13516`, `:14291`).
- **A remote MCP server is refused, by assertion.** `tools/test/admission/index.test.ts:84-95`
  pins ten refusals field-exactly: `https:`, `ws:`, credentials in the URL,
  `10.0.0.5`, `0.0.0.0`, `example.com`, `localhost`, no port, port zero, port
  70000. `::ffff:127.0.0.1` normalizes outside the two literals and is refused too,
  which is the safe direction. A stdio descriptor carrying a well-formed loopback
  URL stays refused (:347-362).
- **A redirect cannot move the endpoint.** `http-loopback/index.ts:267` sends
  `redirect: "manual"`; :277-280 turns any 3xx into `TRANSPORT_REFUSED` at
  `server.response.redirect`, carried out of band so it reaches the receipt with
  the right reason rather than as a timeout.
- **Write authority is membership, non-vacuously.** `port/index.ts:257` reads
  `holdsToolWriteAuthority`. `port/index.test.ts:275-338` refuses reviewer,
  consultant, verifier and coordinator against a writing tool *and* asserts the
  server was never contacted, then proves the predicate is not blanket-refusing by
  letting a reviewer drive a reading tool.
- **The write door is fail-closed and constant-time.** `routes/index.ts:305-315`
  throws `WRITE_BEARER_UNCONFIGURED` with no token file, and answers missing and
  wrong identically. `bearer/index.ts:133,144` hashes at load, compares digests.
- **Tool arguments never reach argv.** The CLI verb takes `--request <path>`
  (`cli/index.ts:1136`), so nothing a caller supplies enters the process table.

## SECURITY.md's anchors: meaningful or literal?

The mechanism is `anchored.includes(literal)` (`check-architecture.mjs:16590`), a
substring grep with a floor of 12 anchors. Of 19, five examined:

| Anchor | Verdict |
|---|---|
| `constants/index.ts` — `SERVER_BIND_HOST = "127.0.0.1"` | **Near-behavioural.** The literal contains the value, so changing the bind address fails the check. It does not prove the constant is the one `listen` uses, nor catch a second listener. |
| `bearer/index.ts` — `timingSafeEqual` | **Weak.** Identifier presence. Removing it fails; misusing it on raw strings passes. |
| `bearer/index.ts` — `Fail-closed` | **Literal-only, and it anchors a comment** (`bearer/index.ts:22`). Deleting the 403 branch would not fail the check. |
| `accounts/src/registry/index.ts` — `Exactly 0600` | **Literal-only, and it anchors a comment** two lines above the code (`:341`). Loosening `0o600` to a write-only mask passes. |
| `parity/index.ts` — `hasObservationPrivacyViolation` | **Weak.** A body rewritten to `return false` passes. |

Three of five are name-presence, two anchor prose; none is behavioural. The
behaviour is proven elsewhere — the fence *executes* the pre-push hook against
fifteen cases, and the parity sweep runs a real server — so the anchors are a
rename tripwire, not a security check. The document reads as though they prove
the mechanisms, and should say which they are.

## Open questions

1. `emitTelemetry` has no caller and no egress. If an exporter lands it must not
   forward `TelemetryRefusal.paths`, which are attacker-influenced key names.
2. `Checkpoint` carries `notes` ≤2000, `nextSafeAction` ≤1000, `pendingWork`
   100×400 and `git.worktreePath: AbsolutePath` — the largest heuristic-guarded
   free-text surface in the repo, with no producer today. Does its producer land
   before SEC-1's fix?
3. `ApiError.detail` is ≤2000 free text under `attachGuards` alone; every caller
   today passes a zod field path. Narrow the type to a path grammar?

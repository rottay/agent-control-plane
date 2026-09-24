# ADR 0108 — A client reaches its model with a credential it never holds outside the boundary

- Status: accepted (P-15 escalón E, recorded 2026-09-23).
- Supersedes: none.
- Superseded-by: none.
- Amends: decision 60, at one point and inside one boundary (owner authorization C4,
  2026-09-23; decision 155). Decision 153's stated limit gains Fable's R4 sentence, and
  ADR 0107 carries it as a dated errata (decision 158).

## Context

P-15 is the real composition of the API and local clients. Contracts §4.3 accepts the echo
only "desde la puerta real —CLI y API—", and ADR 0107 left E an obligation: E is not
acceptable without D-F-4 (`API_KEY`) and D-F-5 (`LOCAL_OR_SELF_HOSTED`), each entering by a
real door and reading back through `acp result` and the private GET.

Two things stood in the way.

- **No client existed.** The `API_KEY` and `LOCAL_OR_SELF_HOSTED` legs drove an injected
  client through an interface this repository owns (`ApiStreamingClient`,
  `LocalChatClient`, pinned member by member by `API_CLIENT_SHAPE` and
  `LOCAL_CLIENT_SHAPE`). No implementation of either reached a model, and the packaged
  daemon had no way to build one: an API route there was `TRANSPORT_UNAVAILABLE`.
- **No credential could be resolved.** Decision 60 put the real `CredentialResolverPort`
  in P-19, and P-19 depends on P-15. A real API client needs a credential. Leaving all of it
  in P-19 was a circular dependency that would either block P-15's acceptance or turn a
  mandatory criterion into debt.

The owner resolved the second with two decisions, recorded verbatim by the DT in
`.acp-local/evidence/p15/adjudication-v2.md`:

- **C4 (2026-09-23), Option A.** In the owner's words: "Read only the authorized file
  outside the repo (~/.rottay-agent-control-plane/accounts.local.json), owner and
  permissions checked; no arbitrary paths, reference escapes or symlinks." Only a minimal
  resolver advances to P-15/E, reusing the existing neutral credential contract. Consumers are bounded, every proposed negative and leak canary is required, and
  rotation, multi-account, reservations and the rest stay in P-19. The PRECISION clause
  binds this record's central claim: *the secret necessarily exists as a string in memory
  to authenticate; the guarantee is that it stays inside the private boundary of the
  resolver and HTTP client and never propagates to domain, events, persistence, errors or
  logs.* "Never a string" is withdrawn. The authorization covers implementation and
  synthetic tests only: no commercial API call, and not smoke S2.
- **E-ND-1 (2026-09-23, night), authorized.** In the owner's words: "resolver extendido a
  /Users/daniel/.rottay-agent-control-plane/credentials.local.json, ruta hermana DERIVADA del
  archivo de cuentas autorizado; 0600, dueño verificado, sin symlinks, contractVersion; sin
  rutas arbitrarias ni sobrescritura de credenciales." No credential file is ever written or
  overwritten. Development and tests use synthetic
  credentials only; C-E7 and the canaries are mandatory; no commercial API and no other
  smoke is authorized.

Fable's pre-audit v2 (C-E7..C-E11) measured the one sharp edge on Node 22.17: `new Headers`
refuses a value with an interior line feed or NUL by throwing a `TypeError` **whose message
quotes the whole value**, and it silently trims leading and trailing whitespace. A secret
that reaches a validating API before this boundary has refused every byte that API refuses
is a secret the first error names.

## Decision

### One — one resolver, one sibling file, one closure (decision 155)

`CredentialResolverPort` is declared in `@acp/runtime`'s contracts, beside
`OrchestrationDriver` (C-E1): `(request: { accountsFile; accountId }) => CredentialResolution`.
Its one implementation is `resolveCredential` in `runtime/src/credentials/`.

- **What it reads.** The accounts file, through `loadAccountsFile`, so the account's record
  and its `credentialRef` are admitted by the account contract before the resolver looks at
  them: an `env://` or inline reference never gets this far (N-E-3). The account must
  declare `authMode: LOCAL_CREDENTIAL_FALLBACK`, the stored-credential mode; a
  `PREAUTHENTICATED_PROFILE` or `DEVICE_AUTHORIZATION` account is
  `CREDENTIAL_NOT_DECLARED`, whatever reference its record also carries (Fable C2, v2).
  The composition asks only for an `API_KEY` entry or a local entry whose auth is
  `CREDENTIAL`, so the mode governs the CLI's path and the stored credential serves only
  the HTTP leaves. The reference must be
  `file://<name>`, one entry name of the reference class, 1..128 characters, never `.` or
  `..`; `keychain://` is `CREDENTIAL_SCHEME_UNSUPPORTED` and `profile://` is
  `CREDENTIAL_NOT_A_SECRET`. The reference is judged before the credentials file is touched,
  so an escaping reference is refused without reading it.
- **Where it reads.** `join(dirname(accountsFile), "credentials.local.json")`, derived and
  never configured. The accounts path must be absolute and named `accounts.local.json`
  (C-E6). Both files climb one ladder, which `@acp/accounts` now exports once as
  `admitOwnerFile` and `loadAccountsFile` is built from: supplied, absolute, canonical (no
  symlink), a regular file, owned by this uid, mode exactly `0600`, 256 KiB twice, JSON.
- **What the sibling is (E-ND-11).** Strictly `{ "contractVersion", "credentials" }`, with
  `contractVersion` equal to `CONTRACT_VERSION`: a versioned owner document has the
  evolution path P-19 will need. The entry is read only if `Object.hasOwn(section, name)`,
  so `file://constructor` and `file://__proto__` are `CREDENTIAL_ENTRY_ABSENT`, the true
  word (C-E11(b); the reference class does admit `_`, so `__proto__` is nameable and
  own-property lookup is what answers it).
- **The value grammar (C-E7.1).** 1..4096 code units, every one in 0x21-0x7E: visible
  ASCII, no whitespace. CR, LF, NUL, a leading, trailing or interior space, a tab, a code
  unit ≥ 0x80 and the U+FFFD a lenient decode leaves behind are `CREDENTIAL_ENTRY_INVALID`,
  refused before any `Headers` object exists. `"Bearer " + value` stays a token68.
- **What it answers.** A frozen `{ ok: true, credential: () => string }`, or a closed word
  and a path that names a file or an entry, never a byte of either. The resolver reads no
  environment variable, takes no path but the accounts file's, and writes nothing.

**Where the accounts file is, and what is not pinned (DT ruling V4, v2).** The accounts
file is the one the operator's own daemon config names in `execution.accountsFile`, held to
the full ladder and the basename; the credentials file is only ever its derived sibling, so
the resolver can never be pointed at an arbitrary credential path **by a reference or by
data** — the operator's config chooses the directory, within the ladder (Fable C6, v3). The
owner's text is "ruta hermana DERIVADA del archivo de cuentas autorizado".
- (a) Production deploys it at the owner-named
  `/Users/daniel/.rottay-agent-control-plane/credentials.local.json` by configuring
  `accountsFile` as `/Users/daniel/.rottay-agent-control-plane/accounts.local.json`.
- (b) The config file is operator-authored: the owner writes it and the packaged entry reads
  it from a path launchd passes. It is not data from the ledger, a request or the network.
- (c) The directory is **not** pinned: the operator's config chooses it. Pinning it to the
  home path would put the owner directory in code for the first time, which ADR 0011 and the
  accounts token law forbid ("no default path"), so it would need an ADR 0011 change. That
  alternative is recorded as proposal P1: the daemon derives
  `<homedir>/.rottay-agent-control-plane/accounts.local.json` in one function, the config no
  longer carries `accountsFile`, and one programmatic `DaemonOptions` seam serves the drills.
  If the owner requires the hard pin, P1 is its own follow-up cut.
- (d) "Outside the repo" is **not** enforced by the ladder: a `0600` owner-only
  `accounts.local.json` under the repository or under a temp root is admitted, and the drills
  use temp roots by design. What keeps a credential out of the tree is law 9 and the
  repository's credential scans, not this ladder.

**The precision, as tested.** The value is a string in two places: the resolver's closure
and the HTTP client's fetch site, where the closure is called into the one header the leaf
names. It is not a field of the resolution (whose JSON is `{"ok":true}`), the client, the
config, a binding, the port, an event, the ledger, the private plane, a marker, the status
document, a log line, the daemon's standard streams, a refusal or a thrown error. Each of
those is swept for a canary in §Five.

**The point modification of decision 60.** Decision 60 said the real resolver is P-19's.
It still is, except for exactly this: one `file://` implementation over one derived sibling,
for the two HTTP leaves. `keychain://`, rotation, several credentials per account, caching,
revocation, reservations and the pressure member for the non-CLI transports stay in P-19,
whose packet row carries them.

**A named deviation from E-ND-2.** The prestate proposed a closure of type
`() => readonly [string, string]`, header name and value. Fable's C-E2 then made the header
name the leaf's own constant, so a closure that also named the header would be a second
source for it. The factories take `() => string`.

### Two — two leaves over one reader, and the words a failure may carry (decision 156)

`@acp/providers` gains two files that may call `fetch`, each exactly once, at call time:

- `api-key/http`: `createAnthropicMessagesClient({ models, credential, maxTokens,
  timeoutMs })`, provider `claude` — the registry's word by law, the only one
  `admitApiRoute` composes (E-ND-7). One URL literal, `https://api.anthropic.com/v1/messages`;
  headers `content-type`, `anthropic-version: 2023-06-01` and `x-api-key` from the closure.
- `local/http`: `createLocalChatClient({ baseUrl, provider, models, credential | null,
  timeoutMs })`. No URL literal: the endpoint is the binding's base plus
  `/chat/completions`. Headers `content-type`, and `authorization: Bearer …` only when the
  binding's auth is `CREDENTIAL`.

Both send `redirect: "manual"` and `AbortSignal.timeout(timeoutMs)`, and the request's
`model` is exactly `route.model`. Every option is required and checked; none is defaulted.

Both read their streams through one shared module, `providers/src/sse`, so what the
loopback drill proves over a real socket for one leaf — frame boundaries, a multibyte
character split across reads, CRLF line ends — holds for both (C-E9). The reader decodes
UTF-8 fatally across chunks (a byte that is not UTF-8 is `MALFORMED_EVENT`, never U+FFFD),
bounds each event at 1 MiB, and cancels the body when its consumer stops early.

**The status table (C-E7), from the status and content type alone; a non-2xx body is never
read, only cancelled.** 2xx `text/event-stream` → stream; other 2xx →
`PROTOCOL_UNSUPPORTED`; 3xx → `REDIRECT_REFUSED`, never followed; 401 → an `authRequired`
chunk, reason `AUTHENTICATION_ERROR`; 403 → reason `PERMISSION_DENIED`; 429 and 529 →
`PROVIDER_RATE_LIMITED`, no retry; 408, any other 4xx and every 5xx →
`PROVIDER_HTTP_ERROR`. `ADAPTER_ERROR_CODES` gains five words, sorted in, 14 → 19:
`PROVIDER_HTTP_ERROR`, `PROVIDER_RATE_LIMITED`, `PROVIDER_UNREACHABLE`, `REDIRECT_REFUSED`,
`REQUEST_TIMEOUT`.

**Named deviations from the prestate's table.** (a) The prestate's third `authRequired`
reason, `UNCLASSIFIED`, for a 401/403 "whose type cannot be classified", is not reachable:
the reason comes from the status, and the body that would carry a type is never read. N-E-22c
therefore proves the vendor's text never becomes the reason, rather than that `UNCLASSIFIED`
is emitted. (b) The failure classifier reads the caught value's **name only**:
`TimeoutError` or `AbortError` → `REQUEST_TIMEOUT`, an `AdapterError` keeps its code, and
everything else → `PROVIDER_UNREACHABLE`. A table of `cause.code` values would have mapped
every member to the same word, so it was dead logic, and dropping it removes the one read of
`cause` the law would otherwise have to permit. The caught value's `message`, `cause` and
string form are never read, and `AdapterError` takes no cause.

**The mapping (C-E3, E-ND-3, E-ND-8).**
- Messages: `message_start` gives `started` with the provider's model verbatim; a
  `text_delta` gives text; `input_json_delta`, `thinking_delta`, `signature_delta`, `ping`
  and the block start and stop are ignored; `message_delta` gives one CUMULATIVE final usage
  report — input and cache classes from `message_start.message.usage`, output from
  `message_delta.usage`, a missing class `null`, the total their sum only when all four are
  known, `sourceObservationId` the message id, `stepIndex` 1 — and no report at all when
  neither frame carries usage; `message_stop` gives the operation fact from the stop reason:
  `end_turn`, `stop_sequence` → SUCCEEDED, `max_tokens`, `tool_use` → FAILED, any other word
  → none. An `error` frame is `PROVIDER_RATE_LIMITED` for `rate_limit_error` and
  `overloaded_error`, otherwise `PROVIDER_HTTP_ERROR`. An unknown frame is
  `MALFORMED_EVENT`.
- Local: the first frame's model gives `started`; `delta.content` gives text;
  `finish_reason` `stop` → SUCCEEDED, `length`, `tool_calls` → FAILED, other → none;
  `[DONE]` is the terminal. Both tables are read by own entry only, so a word such as
  `constructor` decides nothing, like any word outside them (verifier V3, v2). The request asks `stream_options.include_usage`; a `usage`
  object gives one CUMULATIVE final report with both cache classes `null` and the server's
  `total_tokens` only when it covers the known classes. A server that sends no usage object
  yields no report.
- A stream that ends without its terminal frame states no operation fact: NOT_OBSERVABLE,
  decider row 5, never SUCCEEDED.

**A named deviation from E-ND-3.** The local `sourceObservationId` is the completion id when
present; the contract requires a non-empty string, so a server that sends none gets the run's
coordinates, `taskId/attempt/final`, which a replay of the same run reproduces. The prestate's
"else `null`" is not expressible. `PROVIDER_AUTHORITATIVE` qualifies the counts, which are the
server's, not the id; and the synthesized form contains `/`, which `OBSERVATION_ID` excludes,
so no server id can collide with it (Fable C4).

**Provider text is bounded at the leaf (C-E8; Fable C3, v2).** `resolvedModel` 1..120
characters of `[A-Za-z0-9._:@/-]`, the observation id 1..200 of `[A-Za-z0-9._:-]`, and both
held to the contracts' privacy guards (`hasPrivacyViolation`) at the leaf: a
credential-shaped word inside the charset is `MALFORMED_EVENT` there. The ledger's append
guard stays the second line. A local server that echoes its own bearer as **answer text**
puts it in the private output sink and the private plane, the declared private side
behind the authorized read; that is a stated limit, and the drills' canary sweep walks the
plane and would catch a fixture that did it. Both legs also check that a text delta is a string
before the private sink (the P-07/C note).

Each leaf declares its usage source beside `CLAUDE_USAGE_SOURCE`:
`ANTHROPIC_MESSAGES_USAGE_SOURCE` (`anthropic-messages-api`) and `LOCAL_CHAT_USAGE_SOURCE`
(`openai-compatible-local`), both `PROVIDER_AUTHORITATIVE`, each with a pinned digest of its
policy's canonical JSON that the providers suite recomputes (L-P15A-1).

### Three — the daemon names what its clients serve, and composes them once (decision 157)

The config door admits a third binding shape, `DaemonLocalExecutionBinding` in a new types
leaf (E-ND-10): `provider`, `baseUrl` on a loopback literal (`127.0.0.1` or `[::1]`, `http`
or `https`, no userinfo, query or fragment), a non-empty `models`, and `auth` `NONE` or
`CREDENTIAL`. The API entry gains a non-empty `models` and a positive `maxTokens`.
`execution.accountsFile` is required exactly when an entry needs a credential — an API entry,
or a local entry whose auth is `CREDENTIAL` — and refused otherwise, since no field is
ignored; it is admitted canonical and named `accounts.local.json`. Every field another
transport carries is refused by name on each shape.

`transportClientsFor` in the daemon's composition ports is the one receiver of a credential
closure. It calls `resolveCredential` once per entry that needs one, at composition, before
anything is appended, and hands the closure straight to one factory. A refusal stops the
start naming the account, the resolver's word and its path — `CREDENTIAL_ENTRY_ABSENT at
credentials.e-main` — and no request is made and no run begins. A hand-built config without
an accounts file leaves such an entry unbound, and the port refuses the account at
`route.accountId` (R6's N1, unchanged). An injected `apiClientFor` replaces the composed API
clients whole, and no credential is resolved for them. The local map is always passed to the
port, on the API map's law. The usage source is chosen by transport, then provider.

### Four — the laws (decision 158)

- **The network amendment** of "adapters reach no network". `fetch` is a global, so the
  builtin ban never reached it. In providers `src` (v2, verifier V1): no file names the
  global object or a dynamic evaluation — `globalThis`, `global`, `self`, `window`,
  `Reflect`, `eval(`, `Function`, `import(`, and since v3 any `.constructor` member (the
  verifier's `(() => undefined).constructor("return f" + "etch")`) — so no alias, member
  access or evaluated string can reach `fetch` (`const g = globalThis; g.fetch(…)`,
  `global.fetch(…)`); no file names a network global that is not `fetch` (v3: `WebSocket`,
  `EventSource`), a native-binding door as a member of anything (`.dlopen`,
  `._linkedBinding`, a `.binding(` call — a cast hides the receiver), or `process` except
  for its two read members `.env` and `.getuid` (a `process:` field is a name, not the
  global), nor any of these by a bracket string; and no file but the two leaves names `fetch` at all, as a call,
  a member or a value (quoted strings are set aside). The admitted fixture is held to the
  same list. The shared SSE module imports no builtin and names no `.message` or `.cause`.
  `OWNED_CLIENT_MODULES` keeps both interfaces pinned and unchanged.
- **L-P15E-1 and L-P15E-2**, one per leaf, on L-B4B-15's mould: `fetch` named exactly
  once, as the bare call-time call — never a member (`.fetch`) or a value, so a load-time
  capture cannot exist (C-E9.1; v2); `redirect: "manual"` and
  `AbortSignal.timeout(`; no `dispatcher`, `process.env`, `credentials:` or cookie; every
  header key — double-, single- or back-quoted, or unquoted (v2) — in the leaf's allowed
  set and the one computed key `CREDENTIAL_HEADER`, declared as the literal the leaf sends
  (C-E2); the closure invoked only inside the fetch-site function; that function's `catch`
  names no `.message`, `.cause`, `String(`, `inspect(`, `JSON.stringify(` or template
  interpolation, classifies through `classifyTransportFailure`, and throws nothing but the
  classified `AdapterError` (no raw rethrow, v2) (C-E7.4); the Messages leaf carries exactly
  one URL literal, `https://`, and the local leaf none.
- **L-P15E-3, "a credential lives in the resolver and the composition, and reaches only the
  two factories"**: over every `packages/*/*/src/` file, only the resolver names the
  credentials file — whole, or in a quoted piece starting `/credentials` or
  `credentials.` (v2) — or reads its section; only the composition ports call
  `resolveCredential`; only they call the two factories; and the resolver names no logger,
  console, telemetry, event builder, append, environment read or file write.
- **The admitted fixture (E-ND-12).** The mirrored-topology law admits exactly one basename
  it otherwise refuses: `daemon/test/testing/loopback-sse-server/index.mjs`. Its segments
  are still checked; the admission fails if the file is not tracked; and the file must
  import `node:http`, import nothing from `@acp/`, and listen on the literal `"127.0.0.1"`.
  Since v2 it also creates and listens exactly once, imports only `node:buffer`,
  `node:fs`, `node:http`, `node:process` and `node:timers`, and names no `fetch`,
  `globalThis`, dynamic import, `"0.0.0.0"`, `"::"` or `"localhost"`; since v3 it is held
  to the same global-reach and network list as providers `src`.
  The mirror law reads `.ts` and `.tsx` only, so the fixture is not a test-only domain.

**The ban's cost: it is a naming law (Fable C7, v3).** Since v2 and v3, providers `src` —
the two leaves included — can no longer use `global`, `self`, `window`, `globalThis` or
`Reflect` as an identifier, a parameter, a dot-property name (`x.self`) or in
`declare global`; `Function` at all, even as a type; a `.constructor` member; `WebSocket` or
`EventSource`; a `.dlopen` or `._linkedBinding` member, or a `.binding(` call, on any
receiver; `process` except as `process.env`, `process.getuid` or a field name; a bracket
string naming any of them or `fetch`; `typeof fetch` outside the leaves; and `eval(` or `import(`. A vendor field
so named is read by a bracket string under another spelling, or not in this package. The
cost is accepted because each is a way to reach the network or the global object without the
word `fetch`, and none is needed by a provider adapter.

Stated limits: text-level matchers. Since v2 the named remaining forms are: a closure
invoked through an alias; a catch body that hands the caught value to a helper; the
resolver reached through an alias; the credentials file named in pieces that do not start
a literal (`"cred" + "entials"`); a global reached through a value some allowed import
exposes (none is known), which since v3 also covers a network API reached that way; a
constructor reached by a bracket string built from pieces (`x["con" + "structor"]`); and a
network word inside a template literal's text, which fails closed rather than hiding. None is
seen; the leaves' unit tests assert what a
substitute receives and every error's renderings, and the composition's test serializes every
composed record, which is where those would show. The daemon's own network law is
import-statement-level over `.ts`: the loopback server is a child process outside it,
declared as the one socket, and that law's blind spot — a dynamic `import()` in a daemon
test — is a stated limit, not used (C-E10).

**R4, carried.** Decision 153's stated limit gains Fable's sentence, and ADR 0107 §Four
carries it as a dated errata: clauses (iii) and (v) of L-P15F-1 count call sites, so a
closure capturing the one lawful call inside the door's body and escaping it by assignment to
module-level state is one site inside the body and is not seen.

`PATH_SCOPED_LAWS` 156 → **159**.

### Five — the drills, and what the substitute does and does not prove (decision 159)

The daemon's execution drill gains P-15/E's rows, on F's harness, each entering by a real
door and reading back through both doors of ADR 0107:

- **D-F-4 (`API_KEY`).** `POST /tasks` on a spawned `acp-server`; the recorded daemon
  through its packaged entry; the Messages leaf over a fetch substitute. The substitute is
  installed immediately before `runPackagedEntry`, restored in `finally`, and then armed so a
  later call is counted and refused; any URL but the Messages endpoint is a recorded stray.
  It answers with a real `Response` over bytes cut in several places, one inside an event,
  echoing the instruction as a Messages stream. The drill asserts the request — `POST`,
  `redirect: "manual"`, a signal, exactly `anthropic-version`, `content-type` and
  `x-api-key`, the canary once, the exact body — one CUMULATIVE final observation with the
  four classes, a checkpoint, integrity, and `RESULT`/`SUCCEEDED` through both doors.
  SOCKET_EXERCISED: NONE, stated.
- **D-F-5 (`LOCAL_OR_SELF_HOSTED`), twice.** `acp intake`; the local leaf over a real
  loopback socket served by the admitted fixture, which echoes the instruction in events it
  writes in halves across socket writes, with no usage frame. With auth `CREDENTIAL` the
  fixture's header log shows `authorization: Bearer ` and the canary exactly once; with
  `NONE` it shows no authorization header. No usage observation is a zero. `RESULT`/
  `SUCCEEDED` through both doors. The header log lives outside every swept root, asserted.
- **Refusals.** A sibling without the entry stops the start naming `CREDENTIAL_ENTRY_ABSENT`,
  with no request, no lease and no effect. A 401 records the account's `AUTH_REQUIRED`
  pressure and settles `FAILED`. A 429 and a substitute that throws a `TypeError` carrying
  the canary each settle the effect `FAILED` with one request and no retry.

Every run sweeps its canary from the matrix's sinks, after the detector's positive control
on the canary and on `"Bearer "` + the canary: every file under the ledger's directory (the
ledger, WAL and shared memory, the coordination stores, the evidence root and the private
plane's objects), the daemon's root (status document and log), the daemon's standard streams,
the thrown error walked through `cause` and `errors[]`, the gateway's accounts read (the
server started with the accounts file), the event stream, the public GETs, the result reads,
the CLI's output, `health()`, and the spawned server's own output. The sentinel is swept as
F swept it.

**What the substitute does not prove (C-E9.5):** TLS, DNS, redirect semantics on a real
socket, HTTP/2, and the timeout on a live connection. The shared SSE reader is proved over a
real socket by D-F-5, which carries to the Messages leaf's parsing; request building and the
Messages mapping are proved over the substitute only. The Messages URL is fixed and https, so
the leaf cannot be pointed at loopback without a second URL, which L-P15E-1 forbids.

**Measured, and stated:** the leg's closed word (`PROVIDER_RATE_LIMITED`,
`PROVIDER_UNREACHABLE`) is the port's `error` event detail. The daemon settles the effect on
the event's refusal (`TRANSPORT_UNAVAILABLE` at `events.error`) and keeps the trail only as a
digest, so no door reads the word; the providers suite proves it through the port. The
client objects themselves (sink 8) are not reachable from the drill; the composition's unit
test serializes the composed clients, config and port for the canary. No CLI verb lists
accounts, so sink 10 is the gateway's read.

## Why the alternatives were not chosen

**Keeping the resolver entirely in P-19 (option B).** P-15 would have closed with synthetic
servers only, §4.3's echo from the real API door undemonstrated, and P-15 could not be
accepted whole because P-19 depends on it.

**A variable or a `.env` file (option C).** Law 9 and the owner's credential rule forbid it,
and a variable is exactly the ambient input the resolver's decoy test proves it never reads.

**A credential in the accounts file (E-ND-1 (a)).** It would have put the secret in the
document the registry, the gateway and the CLI read and project, and it would have changed
ADR 0011's two-key envelope. The sibling keeps the accounts file as it was.

**A client library (the AI SDK, `openai`, `undici`).** Law 6 keeps the binding optional;
`OWNED_CLIENT_MODULES` forbids those families in the owned interfaces, and one owned leaf
per transport over the global `fetch` needs none of them.

## Consequences

- The `API_KEY` and `LOCAL_OR_SELF_HOSTED` legs reach a model, and a recorded task runs on
  either from its door to its result.
- A credential exists as a string in the resolver's closure and one fetch site, and nowhere
  else that the sweep reaches; three laws keep where.
- Pins: `ADAPTER_ERROR_CODES` 19, `PROVIDERS_PUBLIC_EXPORTS` 97, `RUNTIME_PUBLIC_EXPORTS`
  303, `ACCOUNTS_PUBLIC_EXPORTS` 98, `PATH_SCOPED_LAWS` 159. `CONTRACT_VERSION`,
  `MIGRATIONS`, `API_CONTRACT_VERSION`, `CONTRACTS_SCHEMA_EXPORTS`, `API_CLIENT_SHAPE` and
  `LOCAL_CLIENT_SHAPE` do not move.
- An API config now needs its accounts file and the sibling beside it; an API entry without
  `models` and `maxTokens` is refused at the door.
- Inherited limits of the ladder, stated (C-E11(d)): stat-then-read is a same-user race only,
  and the threat model is the owner's own uid; the directory's mode and owner are not
  checked; an undefined `process.getuid` is `OWNER_FILE_NOT_OWNED` (non-POSIX is P-38's);
  lenient UTF-8 decoding leaves U+FFFD, which the grammar refuses. A sibling reached
  through a symlinked directory is unreachable because the accounts file is admitted
  canonical, which is why it is stated here rather than tested.
- The runtime tests have no `node:util`, so sink 7's `util.inspect` is replaced there by a
  walk of every own property, enumerable or not, through `cause` and `errors[]`.

## Not in this record

- Keychain, rotation, several credentials per account, caching, revocation, reservations and
  the non-CLI pressure member: P-19.
- A commercial API call, and smoke S2: not authorized; each needs its own owner decision.
- Smoke S1 runs on the CLI subscription and is its own authorization.
- A second remote provider behind the API transport: a new leaf, and a new row of the
  network amendment.

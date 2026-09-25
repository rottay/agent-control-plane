# `@acp/tools`

The tool protocol edge. One MCP client the control plane operates **itself**,
over stdio, behind a two-level allowlist, returning a bounded receipt for every
call it makes and every call it refuses.

## Scope

A live execution scope is the scope of the plane's authority to call a tool,
the allowlist is the boundary of it, and the receipt is the record of it.
Today that scope is an explicit **open tool operation**; it becomes a harness
session when a true in-execution caller exists.

**The composer is a door, not the daemon** (V2-B4b stage 3C). There is still no
`DaemonOptions.tools`, no drill and no unwind resource, and there deliberately
is no daemon tool policy: the plane calls a tool because an operator asked it
to, over an authenticated route, and never because a walk decided to. The one
composition site is `src/operation/index.ts` — inside this package, and no
longer only in its suites — and the callers are the gateway's tool-call route
and the CLI's `tool-call` verb (V2-B4b stage 3D). Two doors, one operation:
that independence is what the stage's equivalence proof compares.

Nothing here is adopted into real operation. Adoption is a single explicit
decision that happens after P8 certification and a separate P9 authorization.

## The plane is the client, not a proxy in front of the agent

The wide reading of "a harness with bounded MCP" — the plane interposing
between a provider child and its tool servers, enforcing the allowlist on the
*agent's* tool traffic — is not what this package does, and saying so is the
point.

That reading needs provider-side MCP configuration, which is a provider
protocol capability; every capability in this repository is `UNKNOWN` and the
capability model refuses to confirm one against a fake subject. It also needs
the provider adapters to acquire a transport they are structurally forbidden
from having. So this package builds the leg that is honest today: **the plane's
own authority to call a tool.** Agent-mediated tool use is a later boundary,
named here and left there.

## Why a package of its own

Neither of the two obvious homes could take it without repealing a standing
law. `@acp/providers` forbids every network builtin outright and pins exactly
one spawn site with exactly one caller — a tool server is a second kind of
child with a different lifetime, and admitting it would cost the property that
keeps three provider adapters honest. `@acp/durability` is the Restate edge and
carries a durable-execution dependency graph a tool client has no use for.

The port does **not** live in `@acp/contracts`, for the reason the kernel's
barrel diet states: a kernel port earns its place when an independent party
must agree with it, and this port's only agreeing party will be the daemon,
which takes a direct dependency on this package once stage 3 lands. Nothing
depends on it today. When a domain takes it by injection, that is the trigger
to move the type.

## Two transports, and each one is implemented

`TOOL_TRANSPORT_KINDS` is exactly `["STDIO", "HTTP_LOOPBACK"]`.

MCP defines two standard transports: **stdio** — newline-delimited JSON-RPC on
a spawned child's stdin/stdout — and **Streamable HTTP**. This package now
implements both, and the union grew only when the second one existed: a member
nothing can produce is a vocabulary entry pretending to be a guarantee, so
stage 1 held it at one member and said the second would "arrive with the
transport rather than before it". It did. Every member has an admission that
can emit it and a connection that can speak it, and the suite asserts that
rather than the README claiming it.

**`HTTP_LOOPBACK` says its own bound.** The leg reaches `127.0.0.1` and `::1`
and nothing else, over plaintext, on one endpoint. A URL is judged field by
field at admission — `protocol`, `credentials`, `hostname`, `port` — and every
one of those refusals predates this leg and still fires. `localhost` is refused
with everything else: resolving a name means DNS, and a name that resolves
on-box today is a remote server tomorrow. `https:` is refused too, because a
loopback TLS endpoint needs a trust decision this package cannot make honestly.

The admitted URL is stored exactly as the descriptor wrote it and used verbatim:
one endpoint serves every method, so there is nothing to join and nothing to
construct. A `mcp-session-id` the server issues is echoed on the requests that
follow, as the revision's Streamable HTTP transport prescribes; one endpoint
serving every method is also what keeps the session header the only piece of
connection state this client holds. The transport is the only file in this
package permitted to name `fetch`, it uses the platform global rather than a
socket library — `node:net`, `node:http`, `node:https` and `node:tls` stay
banned in every file including that one — and it can carry no credential of any
shape. The architecture fence asserts each of those by name.

## What conformance is claimed

**None that was measured against a third party, and none against protocol bytes
on disk.** The client is hand-rolled — this repository already hand-rolls two
provider wire protocols the same way, and this package adds no dependency
either — and it is drilled against fakes this repository owns: a spawned fake
server for stdio, and a scripted responder substituted for the platform `fetch`
for the loopback leg.

`MCP_PROTOCOL_RECORD` is the machine-readable half of this section, and the
fence asserts the two cannot disagree. Read together:

- **The revision was cited, not vendored.** `SPEC_MANIFEST_DIGEST` is `NONE`
  because no protocol bytes were placed on disk, so there is nothing to digest
  and the client's constants are asserted against no manifest.
  `SPEC_CITATION` names the revision, the specification URL and the
  retrieval date (2026-09-04) instead — the three facts a reader needs to
  re-derive the citation without the bytes. This leg is therefore built
  against a **cited** revision rather than against reviewed bytes, and that
  is the weaker of the two footings the plan defines.
- **No socket was ever opened.** `SOCKET_EXERCISED` is `NONE`: the drills
  substitute `globalThis.fetch`. `LIVE_CONFORMANCE` is `NONE`: no third-party
  server is contacted anywhere in this repository.
- **Every unimplemented facility is a refusal or an absence, not a gap.** The
  server-initiated stream is never opened, resumption is not implemented,
  batching is refused, no `origin` header is sent, and redirects are refused
  rather than followed. `nextCursor` is followed since P-24, every page bounded
  (below). Every field of the record has
  the claim it stands behind stated here, and the fence asserts the two agree
  **field by field** (L-B4B-17) — a record key nobody explains, or a claim no
  key backs, fails the fence rather than drifting. A drill stands behind each
  field where one is stated; the fields that do not have a drill yet are named
  debt on this page rather than hidden behind a general sentence that would
  claim one for all of them.
- **A result the server marks `isError` is a refusal, not a success.** A server
  may answer a perfectly well-formed frame, inside the timeout, with a result
  whose `isError` is `true` — that is the server reporting that the tool
  itself failed, and a failed tool is a refused call: the receipt reads
  `outcome: "REFUSED"` with `refusal: "RESULT_IS_ERROR"`, and both doors
  answer it as the recorded outcome they answer every refusal with. **The
  error content is discarded whole.** The `content` of an `isError` result is
  the server's error message, and the refused arm carries no content at all —
  a partially filtered result is one the caller cannot tell from a whole one,
  which is the same law `RESULT_UNSAFE` already holds. Reaching the caller is
  a later packet, declared here instead of left implicit. The receipt records
  the counts of the result that actually arrived; a zero there would be a
  false number in a durable row.
- **Only `text` content blocks are carried.** An image, audio or embedded
  resource block is refused rather than dropped, because omitting what cannot
  be represented would hand the caller a shortened answer it has no way to
  recognize as shortened.

## A tool is called only under the schema it was allowed with (P-24, ADR 0109)

**The pin.** Every allowlist entry carries a required `inputSchema`, never
defaulted: the interface the operator reviewed. Admission refuses a pin that is
absent or not an object, whose `type` is not `"object"`, deeper than
`TOOL_SCHEMA_DEPTH_MAX` or larger than `TOOL_SCHEMA_BYTES_MAX`, and names the entry
and field it refused (`descriptor.tools[i].inputSchema`). The schema is
pinned per tool by value: the port compares the advertised `inputSchema` with the
pin by JSON value equality — key order is free, arrays are ordered, `0` and `-0`
are one number, `$ref` is a literal never resolved, a changed `description` or an
added key is a difference — and a difference is `SCHEMA_MISMATCH` before any
`tools/call` is sent. **The plane never validates a call's `arguments` against
either schema**: the pin binds the allow decision to the interface the operator
reviewed, nothing more. A tool has no version in the revision this client speaks,
so the pin is the version, and a changed schema is a re-pin: a reviewed change to
the operator's document, never a rewrite the plane makes from what a server says.

**The listing.** `nextCursor` is followed to the end. A `null`, a non-string or an
empty cursor is `PROTOCOL_VIOLATION` (the reference SDKs type it optional and not
nullable; the empty cursor is this plane's rule), and so is a repeated cursor or a
tool name advertised twice (this plane's rule: the allowlist is keyed by name). A
cursor over `TOOL_CURSOR_BYTES_MAX`, a page past `TOOL_LIST_PAGES_MAX`, a tool past
`TOOL_LIST_TOOLS_MAX` and a listing past its deadline are `RESULT_UNBOUNDED`,
refused and never truncated. Which bound binds what: a page's **bytes** are bound
by the frame ceiling (`TOOL_FRAME_BYTES_MAX`) before any listing bound applies, the
listing's **count** by pages and tools, its **shape** by cursor bytes and schema
depth. The deadline, `TOOL_LIST_DEADLINE_MS`, is one timer that sets a flag read
between pages — never mid-request — so an expired listing keeps its connection; each
page keeps its own call timeout, so the worst case is the deadline plus one page.

**The two windows.** A `notifications/tools/list_changed` invalidates the listing
a connection has cached. One arriving while a listing is assembled restarts it,
once; the port reads it again after obtaining a listing and before sending, and
re-lists once — a guard, which on stdio nothing can reach (the chain to the call's
write yields to no I/O) and on loopback only microtask interleaving can; a second
change in either place is `RESULT_UNBOUNDED`. What this
guarantees is a precondition, not a transaction: no `tools/call` is sent on a
connection whose last listing did not advertise the pinned schema. A change after
that listing — while a call is in flight, or from a server that never sends
`list_changed` — is not seen by that call. At the doors today one operation is one
connection is one call, so the second window collapses into the first; the daemon
composition, with long-lived connections, owns the choice between re-listing per
call and trusting the notification.

**What is not read.** A tool's `title` and `annotations` are not read: hints a
server offers are not authority, and `writes` stays the operator's.

## A tool server is asked what it serves, and nothing is recorded (P-24/B(a), ADR 0118)

**The discovery scope.** `openToolDiscovery({servers})` is declared beside
`openToolOperation`, so the operation module stays the one place outside this
package's suites that constructs a port. It exposes `listTools(serverId)` and
`close()`, and no `callTool`: a discovery scope cannot call a tool by
construction. Its scope id is constant and internal (`tool-discovery`, no slash,
so it cannot collide with an execution scope or session); liveness is the
operation scope's boolean rule, and `close()` drops liveness before it reaps.
The CLI verb `tool-servers` and the private read `GET
/api/v1/tool-servers/:serverId/tools` are its two consumers, so `port.listTools`
now has production callers; neither records anything in a ledger.

**Two corrections to `listTools`.** It now applies `callTool`'s step-7 rule to a
failed listing: a transport refusal the loopback leg recorded out of band is
preferred, word and `at`, and the connection is dropped, as it is on
`PROTOCOL_VIOLATION`. A `SCHEMA_MISMATCH` listing now names the first mismatched
allowlist entry, in allowlist order, in a `toolName` field of its own; `at` still
carries no name (`server.tools.inputSchema` or `server.tools.outputSchema`), and
every other refusal names no tool.

## A tool's output is pinned, and structure is carried only as text (P-24/B(b), ADR 0117)

**The output pin.** An allowlist entry may also pin the tool's `outputSchema`: an
object schema the operator reviewed, admitted on the input pin's rung and refused
field-exactly (`descriptor.tools[i].outputSchema`), or `null` for "reviewed: this
tool declares none". The key is optional, and admission always materializes it,
so absence is read as none. That is the strictest reading, not a hole: a server
that advertises any output schema for a tool pinned to none is a mismatch. The
listing reads an advertised `outputSchema` as optional and never null (present
and `null`, an array or a scalar is `PROTOCOL_VIOLATION`), and the port compares
it with the pin by the same value equality before any `tools/call` is sent; a
difference is `SCHEMA_MISMATCH` at `server.tools.outputSchema`, judged after the
input schema, with the connection kept.

**Structured content.** A result's `structuredContent` is never carried as a
field of its own: the caller still receives text blocks and nothing else. It is
admitted only when some text block of the same result parses to a JSON value
equal to it — the mirror the revision asks servers to send — and then the text
block is the carriage and nothing is lost. A result whose `structuredContent`
no text block carries is refused as `RESULT_NOT_CARRIED`, with the counts it
arrived with and the connection kept, because a peer that omits a SHOULD has
violated nothing and dropping the value silently would hand the caller a
shortened answer it could not recognize as shortened. A `structuredContent` that
is not a JSON object, or its absence under a pinned output schema (a MUST the
revision puts on the server), is `PROTOCOL_VIOLATION` at
`server.result.structuredContent`. Two consequences of carrying it only as text:
structured content that serializes past the 4 KiB block ceiling can never be
carried, and one nested deeper than `TOOL_SCHEMA_DEPTH_MAX` never compares
equal, so both are refused rather than truncated. An image, audio or resource
block is the same class as the unmirrored case and is still refused as
`PROTOCOL_VIOLATION`; moving it to the new word is a later cut.

**What is not done.** The plane **never validates `structuredContent` against
`outputSchema`**: there is no JSON-Schema validator in this package, as there is
none for arguments. That is a declared deviation from the revision, which says a
client SHOULD validate; the pin binds the allow decision to the output interface
the operator reviewed, and the mirror guarantees nothing is dropped.

`TOOL_MCP_PROTOCOL_VERSION` records the revision the client speaks and now also
compares: `initialize` refuses a server that agrees a different revision, or
none. It records what was built against, not what was interoperated with.

## Credentials are unrepresentable, by shape

There is no `env` input on a server descriptor and no secret, token, key or
`secretRef` member anywhere in the type. A tool server that needs a credential
cannot be described here at all — refused by the absence of a field rather than
by a scan. A tool server child receives exactly `HOME`, `LC_ALL` and `PATH`,
built from the ambient environment and never inherited from it.

## The receipt is bounded, scalar and clockless

Ten members, every one a scalar, pinned member by member by the architecture
fence. No arguments, no result, no content, no text. No timestamp and no
duration, which is what makes a receipt a pure function of the call and lets a
drill assert it by equality. No argument digest, because the only canonical
serializer in this repository lives in the ledger and importing it here would
put this package one import away from appending.

A refusal gets a receipt too: the refused calls are the ones an auditor most
needs to see, and a refusal that left no record would make the allowlist
unfalsifiable in operation.

**The transport is resolved, never asserted.** A receipt names the admitted
server's transport wherever one was resolved, and `UNRESOLVED` on the two paths
that refuse before an admitted server exists — a dead session whose `serverId`
nobody admitted, and a `serverId` nobody admitted at all. `UNRESOLVED` is not a
transport this package speaks: it is absent from `TOOL_TRANSPORT_KINDS`, no
admission can emit it, and no connection can be opened on it. Naming a real
transport on those paths would be a receipt asserting a fact about a server that
does not exist, which is exactly what the receipt was built to make impossible.

**A receipt is persisted and projected, and neither is done here.** Since V2-B4b
stage 2 `@acp/runtime`'s recorder writes one to the ledger as nine named
scalars, and since stage 3C it does so through a production door — both of them,
after stage 3D. The event stream projects a `TOOL_CALL_RECORDED` row as its
payload **key names** and a byte size, never a value. What this package does is
unchanged by any of that: it returns the receipt to its caller and stops. The
distinction is worth keeping precisely because the persistence exists now — this
package owns the receipt's shape and its bounds, and owns nothing about where it
is later written or how it is later read.

## Names are bounded by one grammar, and it is not this package's

`serverId` and every allowlisted tool name are judged at admission against
`BOUNDED_IDENTIFIER`, declared once in `@acp/contracts`: at most 120 characters
of letters, digits, dot, underscore, colon and hyphen, beginning with a letter
or a digit. A name with a space, a slash, a quote, a brace or a newline in it is
not a name, and `admitToolServer` refuses it as `SERVER_NOT_ADMITTED` at
`descriptor.serverId` or `descriptor.tools` — before the transport is read,
before a URL is parsed, before the command is stat-ed, and therefore before any
child exists.

The grammar is shared rather than declared here because `@acp/runtime`'s durable
recorder already enforced exactly it: a name this package admitted but that one
refused would be a call the plane could make and could not write down. One
constant, imported by both, is what makes that disagreement unrepresentable.

**What this covers, and what it does not.** Admission governs the *configured*
side: the descriptors an operator writes. The values a caller supplies on a
request — `ToolCallRequest`'s own `serverId` and `toolName` — are still raw
strings at this stage, and typing them is the obligation of the door that will
accept a request from outside this package. Until that door lands, a refusal
built from a caller-supplied name is not guaranteed to be recordable, and this
package does not claim otherwise.

## Public surface

The barrel is closed — no `export *` — and the fence pins the set by equality
in both directions, against `TOOLS_PUBLIC_EXPORTS` and against the table below,
so a name can neither appear nor disappear on one side alone.

The codec, the client and the stdio transport are deliberately absent from it.
They are how the port keeps its promises, not promises of their own, and this
package's own suites reach them by relative path exactly as the provider edge
does with its fake. A transport on a public surface is eventually opened by
somebody outside the port, and the port is where the allowlist, the liveness
join and the receipt live.

| Export | Kind |
| --- | --- |
| `TOOL_TRANSPORT_KINDS` | the transports this package speaks |
| `TOOL_TRANSPORT_UNRESOLVED` | the transport a receipt names when no server was resolved |
| `ToolTransportKind` | its member type |
| `ToolTransportUnresolved` | its literal type |
| `TOOL_REFUSALS` | every way a call can be refused |
| `ToolRefusal` | its member type |
| `TOOL_WRITE_ROLES` | the closed set of roles that may drive a writing tool |
| `ToolWriteRole` | its member type |
| `holdsToolWriteAuthority` | the membership test the port decides by |
| `ToolAllowlistEntry` | one permitted tool, whether it writes, its pinned `inputSchema` and its optional `outputSchema` pin |
| `ToolServerDescriptor` | untrusted, config-shaped server input |
| `ToolCallRequest` | one call, as the plane's caller states it |
| `TOOL_ARGUMENTS_BYTES_MAX` | the argument ceiling |
| `TOOL_RESULT_BYTES_MAX` | the result ceiling |
| `TOOL_FRAME_BYTES_MAX` | the wire frame ceiling |
| `TOOL_CONTENT_STRING_MAX` | the per-block content ceiling |
| `TOOL_CALL_TIMEOUT_MS` | how long one call may stay unanswered |
| `TOOL_LIST_PAGES_MAX` | the most pages one listing may take |
| `TOOL_LIST_TOOLS_MAX` | the most tools one listing may carry |
| `TOOL_CURSOR_BYTES_MAX` | the largest cursor a listing may be handed |
| `TOOL_LIST_DEADLINE_MS` | one listing's deadline, read between pages |
| `TOOL_SCHEMA_BYTES_MAX` | the largest pin an allowlist entry may carry |
| `TOOL_SCHEMA_DEPTH_MAX` | the deepest pin, and the depth past which schemas never compare equal |
| `TOOL_SERVER_LIFETIME_MS` | the child's hard backstop |
| `TOOL_SERVER_ENV_KEYS` | the whole environment a tool server child receives |
| `TOOL_HTTP_REQUEST_TIMEOUT_MS` | how long one loopback request may stay unanswered |
| `TOOL_HTTP_STREAM_BYTES_MAX` | the most bytes one response body may carry |
| `TOOL_HTTP_STREAM_EVENTS_MAX` | the most events one response may carry |
| `TOOL_HTTP_CLOSE_TIMEOUT_MS` | how long a best-effort session teardown may take |
| `MCP_PROTOCOL_RECORD` | what this client implements of the revision it names |
| `TOOL_MCP_PROTOCOL_VERSION` | the revision this client was built against |
| `TOOL_MCP_CLIENT_NAME` | what the plane calls itself in `initialize` |
| `admitToolServer` | the only producer of an admitted server |
| `admitToolServers` | a whole operator document, admitted all or nothing |
| `AdmittedToolServer` | a server the plane has decided it may talk to |
| `ToolAdmissionOutcome` | admitted, or refused field-exactly |
| `ToolDocumentOutcome` | the document's verdict, or the first refusal and where |
| `openToolOperation` | the one composition site for the protocol port |
| `ToolOperationScope` | one open operation: its id, its call, its close |
| `ToolOperationInput` | the scope id and the servers it may reach |
| `openToolDiscovery` | the discovery scope, composed at the same site: it lists and never calls |
| `ToolDiscoveryScope` | one open discovery: its listing and its close, no `callTool` |
| `ToolDiscoveryInput` | the servers it may reach |
| `ToolCallReceipt` | the bounded record of one call |
| `ToolCallOutcomeName` | `COMPLETED` or `REFUSED` |
| `SessionLiveness` | the liveness predicate, read and never pushed |
| `ToolProtocolPortInput` | the servers and the liveness join |
| `ToolCallOutcome` | content plus a receipt, or a refusal plus a receipt |
| `ToolListingOutcome` | the allowlist entries advertised under their pins, or the first mismatch and the tool it names |
| `ToolProtocolPort` | the port itself |
| `createToolProtocolPort` | its constructor |

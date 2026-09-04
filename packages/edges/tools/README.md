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
longer only in its suites — and the caller is the gateway's tool-call route.

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

## One transport, and it is the one that is implemented

`TOOL_TRANSPORT_KINDS` is exactly `["STDIO"]`.

MCP defines two standard transports: **stdio** — newline-delimited JSON-RPC on
a spawned child's stdin/stdout — and **Streamable HTTP**. This package
implements the first and only the first. A one-member union reads oddly beside
a union that could hold two, and that is deliberate: a member nothing can
produce is a vocabulary entry pretending to be a guarantee.

A loopback Streamable HTTP leg is later work, gated on its own protocol record.
Until it lands, a URL-bearing descriptor is representable input and is
**refused** — never made unrepresentable by a narrow type, because a refusal
that is a fact about a TypeScript declaration is not a fact about running code.
The refusal parses the URL and judges it field by field (`protocol`,
`credentials`, `hostname`, `port`), so the mechanism the later stage widens
already exists and is already exercised. `localhost` is refused with everything
else: resolving a name means DNS, and a name that resolves on-box today is a
remote server tomorrow.

## What conformance is claimed

**None that was measured against a third party.** The client is hand-rolled
against the published protocol — this repository already hand-rolls two
provider wire protocols the same way, and this package adds no dependency
either — and it is drilled against a fake MCP server this repository owns. No
handshake with a real third-party MCP server has been performed here, and none
is claimed. `TOOL_MCP_PROTOCOL_VERSION` records the revision the client speaks;
it records what was built against, not what was interoperated with.

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

**Persisting a receipt into the ledger, and projecting it through the event
stream, are not done here and are not claimed here.** This stage returns the
receipt to its caller and stops.

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
| `ToolTransportKind` | its member type |
| `TOOL_REFUSALS` | every way a call can be refused |
| `ToolRefusal` | its member type |
| `TOOL_WRITE_ROLES` | the closed set of roles that may drive a writing tool |
| `ToolWriteRole` | its member type |
| `holdsToolWriteAuthority` | the membership test the port decides by |
| `ToolAllowlistEntry` | one permitted tool, and whether it writes |
| `ToolServerDescriptor` | untrusted, config-shaped server input |
| `ToolCallRequest` | one call, as the plane's caller states it |
| `TOOL_ARGUMENTS_BYTES_MAX` | the argument ceiling |
| `TOOL_RESULT_BYTES_MAX` | the result ceiling |
| `TOOL_FRAME_BYTES_MAX` | the wire frame ceiling |
| `TOOL_CONTENT_STRING_MAX` | the per-block content ceiling |
| `TOOL_CALL_TIMEOUT_MS` | how long one call may stay unanswered |
| `TOOL_SERVER_LIFETIME_MS` | the child's hard backstop |
| `TOOL_SERVER_ENV_KEYS` | the whole environment a tool server child receives |
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
| `ToolCallReceipt` | the bounded record of one call |
| `ToolCallOutcomeName` | `COMPLETED` or `REFUSED` |
| `SessionLiveness` | the liveness predicate, read and never pushed |
| `ToolProtocolPortInput` | the servers and the liveness join |
| `ToolCallOutcome` | content plus a receipt, or a refusal plus a receipt |
| `ToolListingOutcome` | the allowlist intersected with the advertisement |
| `ToolProtocolPort` | the port itself |
| `createToolProtocolPort` | its constructor |

# ADR 0109 — A tool is called only under the schema it was allowed with

- Status: accepted (P-24, first cut, recorded 2026-09-24).
- Supersedes: none.
- Superseded-by: none.

## Context

Requirement J4 says a tool "se autoriza por schema versionado", and B7 binds a
tool call to a known interface. Until this cut the tools edge
(`packages/edges/tools`, ADR 0069) did neither:
- `listTools()` sent one `tools/list` with `{}`, read only `tools[].name`, never
  followed `nextCursor` and never read `inputSchema`; the record said
  `LIST_PAGINATION: "UNFOLLOWED"`;
- `callTool` never discovered: any allowlisted name was called, whatever the server
  now said the tool was;
- the allowlist entry was `{name, writes}`, with no schema at all.

The MCP revision this client speaks (`2025-06-18`, cited, not vendored) gives a tool
no version. It requires an `inputSchema` whose `type` is `"object"` on every tool,
pages `tools/list` with an opaque `nextCursor`, and lets a server announce a change
with `notifications/tools/list_changed`, an optional capability.

This cut is fixtures only: a stdio fake and a scripted loopback peer, both this
repository's. No real MCP server, no Claude CLI MCP configuration, and no
`READ_ONLY`/`workspaceMode` vocabulary (P-17's) are touched.

## Decision

### One — the pin is a value, compared by value (decision 161)

`ToolAllowlistEntry` gains a **required** `inputSchema`, never defaulted: the
interface the operator reviewed. Admission refuses a pin that is absent, `null`, an
array or not an object; whose `type` is not `"object"` (no conformant server could
match it, Fable C2); deeper than `TOOL_SCHEMA_DEPTH_MAX` (32); or larger than
`TOOL_SCHEMA_BYTES_MAX` (16 KiB) serialized. The admitted pin is a frozen copy.

The port compares the schema a server **advertises** with the pin by
`jsonEqual`, declared once in `tools/src/schema-equality` (the edge imports no
`node:crypto`, and a digest would need a second canonicalizer):
- objects are equal when their own keys are the same set and each value is equal,
  in any key order; a `__proto__` key a parse created is ordinary data;
- arrays are ordered;
- numbers are `===` after parse, so `1` ≡ `1.0` ≡ `1e0` and **`0` ≡ `-0`** (C1);
- strings, booleans and `null` are exact;
- a value past the depth bound on either side is **not equal**, and nothing throws.

**What the pin is (C3).** The plane compares the advertised schema with the
pinned one. It **never validates a call's `arguments` against either**: there is no
JSON-Schema validator in the edge, and none is added. J4's "authorized by a versioned
schema" means the operator's allow decision is bound to the interface they reviewed,
not that a call's arguments are checked. **What the comparison does not check**, and
what it costs:
- (i) array order matters: `required: ["a","b"]` and `["b","a"]` differ although a
  validator would read them alike;
- (ii) integers beyond 2^53 and `1e400` collapse identically on both sides;
- (iii) `$ref` is compared as a literal, never resolved;
- (iv) any added or changed key **inside** `inputSchema` — `description`, `title`,
  `$schema`, `additionalProperties`, `default` — is a mismatch. The cost is a re-pin,
  and that is the design: a changed schema is a new version;
- (v) the Tool's other fields — `title`, `annotations`, `outputSchema` — are not read.
  `annotations` are untrusted hints; `writes` stays the operator's.

**Version and re-pin.** In this revision the pin **is** the version, and the
upgrade path is a re-pin. **Who re-pins (DT ruling): the operator who authors the
allowlist document; a re-pin is a reviewed change to that document, never
automatic** — the plane never rewrites a pin from what a server advertises.
"Several accepted pins per tool" is named as a later decision, not taken.

The format change is **breaking** for operator documents: an entry without a pin is
refused. There are none outside tests, and nothing is in operational use before P9.

### Two — the listing is followed, and every page is bounded (decision 162)

`client.listTools()` follows `nextCursor` (`params: {cursor}` after the first page)
and returns `{name, inputSchema}[]`. The rules, each with its source:
- `nextCursor` absent ends the listing;
- `null` is `PROTOCOL_VIOLATION`, consistent with the reference SDK shapes
  (TypeScript `nextCursor?: string`, optional and not nullable; Python serializes
  with `exclude_none`); the live-conformance cut decides any widening, recorded;
- a non-string is `PROTOCOL_VIOLATION`, and so is `""` — **the plane's rule**: the
  revision types it as a string, and the plane refuses an empty cursor;
- a cursor over `TOOL_CURSOR_BYTES_MAX` (1 KiB) is `RESULT_UNBOUNDED`;
- a repeated cursor (a cycle) is `PROTOCOL_VIOLATION`;
- a name advertised twice across pages is `PROTOCOL_VIOLATION` — **the plane's
  rule**: the revision does not forbid it, but the allowlist is keyed by name;
- an advertised tool with no object `inputSchema` is `PROTOCOL_VIOLATION`;
- a page past `TOOL_LIST_PAGES_MAX` (16) and a tool past `TOOL_LIST_TOOLS_MAX` (256)
  are `RESULT_UNBOUNDED`, refused and never truncated; the page past the bound is
  never asked for.

**Which bound binds what.** A page's **bytes** are bound by the existing frame bound
(`TOOL_FRAME_BYTES_MAX`, 128 KiB) before any listing bound applies — a page of eight
16 KiB schemas is refused as a frame (`PROTOCOL_VIOLATION`, connection dropped) — so
`TOOL_LIST_TOOLS_MAX × TOOL_SCHEMA_BYTES_MAX` is unreachable in one page. The
listing's **count** is bound by pages and tools, across pages; its **shape** by
cursor bytes and schema depth.

**The deadline (C4).** One listing-level `setTimeout(TOOL_LIST_DEADLINE_MS)` (60 s),
armed when the listing starts, sets a flag, and the flag is read **between pages**,
after a page's response and before the next request. It never aborts a request in
flight, so the stream stays at a known offset: an expired listing is
`RESULT_UNBOUNDED` with the **connection kept**. No clock is read; the timer is
`unref`'d and cleared at the end. Each page keeps its own `TOOL_CALL_TIMEOUT_MS`, so
the worst case is `TOOL_LIST_DEADLINE_MS + TOOL_CALL_TIMEOUT_MS`.

### Three — discovery before the call, and the two windows (decision 162, C5)

The port keeps a per-connection listing cache, and the client an invalidation flag
that a `notifications/tools/list_changed` sets as it arrives (a flag, not a new
reader). `port.callTool` keeps steps 1–5 (liveness, admitted server, allowlist,
write authority, argument ceiling), then:
1. connect;
2. obtain the listing: the cached one, unless a change invalidated it;
3. **read the flag again after obtaining the listing and before sending** — a
   **guard** (C8, below); if set, re-list, once; a second change there is
   `RESULT_UNBOUNDED`;
4. require the tool advertised **and** `jsonEqual(advertised.inputSchema, pin)`,
   else `SCHEMA_MISMATCH`;
5. only then `tools/call`.

A change announced **while a listing is being assembled** restarts that listing,
once; a second is `RESULT_UNBOUNDED` — it cannot be bounded.

`SCHEMA_MISMATCH` records counts 0/0 and keeps the connection: the server never
receives `tools/call`. A listing's `PROTOCOL_VIOLATION` drops the connection, as
every violation does; its `RESULT_UNBOUNDED` keeps it.

**Window A (list → call) is a precondition, not a transaction.** MCP has no "call
with expected schema". The guarantee, as written, holds on both legs: *no `tools/call`
is sent on a connection whose last listing did not advertise the pinned schema.* The
next call on the connection re-lists. Where a change can land, per leg (Fable C8):
- a change announced in the same read as the listing's last page is consumed by the
  **client**, which restarts the listing once before `listTools` returns;
- **on stdio**, frames arrive from an I/O callback, and the chain from the last page
  to the call's `write` (`listAllPages → listTools → trustedListing → mismatchOf →
  callTool → request`) is microtasks only: nothing can arrive in between. Window A on
  stdio is exactly **after the call frame is written**;
- **on loopback**, the SSE body is read with `await reader.read()`, so an event in a
  later chunk is delivered by a promise continuation that can interleave with the
  port's chain. Only there can the port's step-3 re-check fire, and only by
  nondeterministic microtask interleaving. The re-check is a **guard**; no
  deterministic row reaches it.

The verifier measured window A in action: with a fake that sent `list_changed` in a
separate write just after a one-page listing, the CLI door happened to read both
together and re-listed, while the API door read the listing, checked and called before
the notification arrived. The two answers diverged by scheduler timing, not by a door
difference, and each is what the guarantee allows.

**Window B (no notification).** `listChanged` is optional; a server that changes a
tool without notifying leaves the cache stale for the connection's life. At the doors
today one scope is one operation is one call, so B collapses into A. The cut that
composes the tool port into the daemon, with long-lived connections, must choose
"re-list per call" or "trust the notification"; the P-24 row carries it, and if the
daemon composition is assigned elsewhere, the row moves with it.

`port.listTools` returns the allowlist entries advertised under an equal schema; an
allowlisted tool advertised under another schema **refuses the listing** with
`SCHEMA_MISMATCH` rather than being dropped. It has no production caller until the
daemon composes the port: a tested surface without a consumer, stated.

### Four — one word, one `at` grammar, and the record (decision 161, C7)

`SCHEMA_MISMATCH` joins `TOOL_REFUSALS`, sorted between `RESULT_UNSAFE` and
`SERVER_NOT_ADMITTED` (10 → **11**). Its `at` is `server.tools` when the tool is not
advertised and `server.tools.inputSchema` when the schema differs.

**A measured deviation from the map.** The map named the tool in the path
(`server.tools.<name>.inputSchema`). A bounded name can be 120 characters, and the
protocol's `at` is at most 120 (`protocol/schemas:2743`): the named form overflows for
any name over 95 characters. The request already names the tool, so the path does
not; the contract suite asserts every new path fits.

**The admission's `at` convention, one grammar, indexed (C7).** Array-level defects
(not an array, empty) stay `descriptor.tools`. An entry that is not an object is
`descriptor.tools[i]`; a field defect is `descriptor.tools[i].<field>` (`name`,
`writes`, `inputSchema`); a duplicate name is `descriptor.tools[i].name`. At document
level `admitToolServers` yields `servers[k].tools[i].<field>`. The fixtures that
asserted the unindexed path are re-pinned.

`MCP_PROTOCOL_RECORD`: `LIST_PAGINATION` becomes `"followed; bounded by pages, tools,
cursor bytes and a listing deadline; a repeated cursor refused"`, and three keys join —
`TOOL_SCHEMA`, `LIST_CHANGED` and `OUTPUT_SCHEMA: "NOT_READ"` — each with its row in
L-B4B-17's concordance table and its README marker.

**No version moves, and three proofs say so.** `CONTRACT_VERSION`, the event types and
`TOOL_CALL_RECORDED`'s nine keys, `MIGRATIONS`, `API_CONTRACT_VERSION`,
`CONTRACTS_SCHEMA_EXPORTS` and `RUNTIME_PUBLIC_EXPORTS` do not move: the runtime
recorder admits any vocabulary word by grammar, the protocol types `refusal` by the
same grammar, and no ledger CHECK names a tool word. (1) At both doors the durable
`TOOL_CALL_RECORDED` row carries `refusal: "SCHEMA_MISMATCH"`, and the gateway's 200
body parses under the existing response schema — in the door suites of this cut;
(2) the recorder still refuses a word past its grammar (41 characters); (3) no source
outside `packages/edges/tools` and no document outside this write-set names a member
of `TOOL_REFUSALS` as a case, key or table entry. Proofs (2) and (3) are the
verifier's to run at this cut's head, as the map sets them.

### Five — the laws (decision 163)

- **L-P24-1, "the tool listing is asked in one place, and every page is bounded"**:
  over `tools/src`, the `"tools/list"` literal appears only in `client/index.ts`, once,
  inside `listAllPages`, whose body names `TOOL_LIST_PAGES_MAX`, `TOOL_LIST_TOOLS_MAX`,
  `TOOL_CURSOR_BYTES_MAX` and `nextCursor`; the file arms `TOOL_LIST_DEADLINE_MS`. It
  checks the site, not the behaviour, which the client suite carries.
- **L-P24-2, "a pinned schema is compared in one place, by value"**: `jsonEqual` is
  declared only in `schema-equality`, the port compares through it, and no other file
  compares two schemas (`===`/`!==` between two `inputSchema` operands, a deep-equality
  call, or a serialized schema compared). A shape check of one schema is not a
  comparison.
- **L-B4B-17**: three new concordance rows.

Stated limits: text-level matchers. The method name built from pieces or spelled in
single quotes or as a template, a listing loop reaching `request` without the
double-quoted literal, a comparison split over two lines, a one-line comparison through
an alias of an `inputSchema` value, loose `==` over serialized schemas, or a helper under
another name that walks two schemas is not seen. `PATH_SCOPED_LAWS` 159 →
**161**.

### Six — the doors, end to end (decision 164)

No door source moves: both doors pass the operator's document through
`admitToolServers` and render a refusal by grammar. Each door gets its own e2e with its
own stdio fake and a real ledger, and parity (CLI = API) is asserted row by row:

| Row | Scenario | Both doors |
| --- | --- | --- |
| E1 | pin equal to the advertisement, page 1 | `COMPLETED`; fake log: one listing, one call |
| E2 | tool on page 3 of 3 | three listings, then one call; `COMPLETED` |
| E3 | one nested key differs | `SCHEMA_MISMATCH` at `server.tools.inputSchema`, counts 0/0, no call, a durable row |
| E4 | allowlisted, not advertised | `SCHEMA_MISMATCH` at `server.tools`, no call |
| E5 | cursor cycle | `PROTOCOL_VIOLATION` at `server.tools.nextCursor`, the child reaped |
| E6 | a document with an unpinned tool | CLI: the shared admission refuses at `servers[0].tools[0].inputSchema`, `EXIT_USAGE`, no child; API: `DOCUMENT_NOT_ADMITTED`, `503 TOOL_SERVERS_UNCONFIGURED`, the path not forwarded, no child |
| E7 | a `list_changed` between the listing and the call | two listings, one call; `COMPLETED` |
| E8 | pages = `TOOL_LIST_PAGES_MAX + 1` | `RESULT_UNBOUNDED` at `server.tools`, counts 0/0, a durable row — the first listing bound to reach a door |

The loopback leg runs E1, E2, E3 and the mid-listing restart in its own suite.

**The fixture's timing, stated (C8).** The fakes write a `list_changed` in the same
write as the listing page it follows, so the client reads the two together: **E7
measures the client's restart-once**, not the port's re-check, and "two listings, one
call" is what that restart produces. The port's re-check (§Three, step 3) is a guard,
unreachable on stdio by construction and reachable on loopback only by microtask
interleaving; no row reaches it deterministically, and none claims to.

## Why the alternatives were not chosen

**A digest of the schema instead of the value.** The edge may not import
`node:crypto`, and a digest needs a canonical serialization; the contracts'
canonicalizer is not this package's, and a second one is the drift L-P24-2 exists to
prevent. A value comparison needs neither, and a digest would hide nothing more.

**Validating the arguments against the schema.** A JSON-Schema validator is a
dependency and a language, and J4 asks that the allow decision be bound to a reviewed
interface, not that the plane become a validator. Stated, rather than implied.

**`PROTOCOL_VIOLATION` for an expired listing.** A peer that answers every page
inside its timeout has violated nothing, and the word drops the connection. The house
word for "past a bound, refused, never truncated" is `RESULT_UNBOUNDED`, and the
connection is kept (C4).

**A discovery verb at the doors.** A new entrypoint needs its own e2e and parity at
both doors; this cut exposes none, and the P-24 row carries it as a later cut.

## Consequences

- A tool is called only on a connection whose last listing advertised it under a
  schema JSON-equal to the operator's pin; a changed interface is a refusal, not a
  surprise, and a re-pin is the operator's reviewed act.
- Every operator document needs a pin per tool; an unpinned entry is refused.
- Pins: `TOOL_REFUSALS` 11, `TOOLS_PUBLIC_EXPORTS` +6 (the six bounds),
  `MCP_PROTOCOL_RECORD` +3 keys, L-B4B-17 +3 rows, `PATH_SCOPED_LAWS` 161. No contract,
  migration or API version moves.
- Owner rows, carried by the P-24 packet row: (a) a discovery verb at the doors;
  (b) `outputSchema`/`structuredContent`; (c) window B's freshness choice at daemon
  composition; (d) the real profile and its owner permissions; (e) "several accepted
  pins per tool", only if the owner wants it.

## Not in this record

- A real MCP server, the owner's tool profile and every permission it needs (servers,
  binaries, scope, write roles, credentials, live conformance and vendoring, model
  exposure, spend, network egress, raw frame capture, revision acceptance, what
  results may carry into a prompt): a later real-profile cut, with the owner.
- Exposing tools to a model session (the Claude CLI's `--strict-mcp-config`): A2's
  file family, a separate decision.
- `READ_ONLY`/`workspaceMode`: P-17.

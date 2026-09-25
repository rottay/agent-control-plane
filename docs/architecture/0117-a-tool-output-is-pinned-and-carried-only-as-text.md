# ADR 0117 — A tool's output interface is pinned, and structured content is admitted only when its text carries it

- Status: accepted (P-24, cut B(b), recorded 2026-09-25).
- Supersedes: none.
- Superseded-by: none.
- Amends: ADR 0109 §One (v), by reference. ADR 0109's text is not edited: `outputSchema`
  is read from this record on; `title` and `annotations` stay unread.

## Context

ADR 0109 pinned a tool's **input** interface and named the output as an owner row of
P-24: "(b) `outputSchema`/`structuredContent`", recorded as `OUTPUT_SCHEMA: "NOT_READ"`.
Measured at `1b8e19e`, that gap had two consequences:
- the listing read `name` and `inputSchema` and ignored `outputSchema`, so a server could
  change a tool's **output** interface and the call still completed — a "schema alterado"
  that produces success, against integrations row 6 and requirement J4;
- `callTool` read `content` and `isError` and ignored `structuredContent`, so a result
  whose structured value was not also present in its text reached the caller
  **shortened**, silently — the class the image-block refusal exists to prevent
  (contracts §4.1: what cannot be represented is refused, never dropped).

The MCP revision this client speaks (`2025-06-18`, cited, not vendored) makes
`Tool.outputSchema` optional, a JSON Schema object of `type: "object"` when present, and
`CallToolResult.structuredContent` an optional JSON object. A server that declares an
`outputSchema` **MUST** return conforming `structuredContent`; a client **SHOULD**
validate it; a server returning `structuredContent` **SHOULD** also return the serialized
JSON in a text block, for backwards compatibility; and `structuredContent` may appear on
a tool that declares no `outputSchema`.

This cut is fixtures only — the stdio fake and the scripted loopback peer of this
repository. No real server, no spend, none of the twelve owner permissions of the P-24
map. It was briefed read-only (brief v1), pre-audited by Kimi K3 with the owner's order
of 2026-09-25 while Fable was over its usage limit, and the pre-audit's corrections were
adopted as the DT's rulings; **Fable's audit of this cut is pending**, never simulated.

## Decision

### One — the output pin (decision 204)

`ToolAllowlistEntry` gains `outputSchema?: Readonly<Record<string, unknown>> | null`. The
admission takes it on the input pin's rung, after `inputSchema` and before the
duplicate-name check: an object whose `type` is `"object"`, at most
`TOOL_SCHEMA_DEPTH_MAX` containers deep and `TOOL_SCHEMA_BYTES_MAX` bytes serialized,
kept as a frozen copy; anything else is `SERVER_NOT_ADMITTED` at
`descriptor.tools[i].outputSchema` (`servers[k].tools[i].outputSchema` for a document).
**The admission always materializes the key**: absent and `null` both become `null`,
"the operator reviewed a tool that declares no output schema".

**Why this default is not the one ADR 0109 forbade.** No default was safe for
`inputSchema`, because any value the plane chose would have stood in for a review. Here
absence takes the strictest value there is: a tool pinned to none mismatches any server
that advertises an output schema, so a document written before this cut fails closed,
and loosening it is the operator's reviewed re-pin. Every existing document and fixture
stays byte-identical.

The listing reads an advertised `outputSchema` as **optional and never null**: absent is
none, and `AdvertisedTool` then leaves the key **absent** rather than `null` — a disclosed
representation deviation from the admission's materialized `null`: materializing it
changed the `stdio` suite, outside this write-set, and the comparison reads absent as
`null` either way; an object is carried as parsed; present and `null`, an array or a scalar is
`PROTOCOL_VIOLATION` at `server.tools` — the reading `nextCursor: null` already has
(decision 162). The advertised `type` is not judged at the listing: a non-object type can
never equal an admitted pin, so the comparison refuses it.

`mismatchOf` gains a third answer, in order: `server.tools` (not advertised),
`server.tools.inputSchema` (input differs), **`server.tools.outputSchema`** (output
differs, `jsonEqual(advertised ?? null, pinned ?? null)`, where `null` equals only
`null`). Input is judged first, so a tool whose two schemas both differ has one answer.
The refusal is `SCHEMA_MISMATCH`, counts 0/0, no `tools/call` sent, connection kept.
`port.listTools` refuses the listing on **any** schema mismatch of an allowlisted tool,
input or output; a tool not advertised is still simply not listed.

### Two — the structured result and the mirror rule (decision 205)

`callTool` keeps its order — result bytes (`RESULT_UNBOUNDED`), `isError`
(`RESULT_IS_ERROR`, content discarded whole, a structured error included), the content
array, text-only blocks and the per-block bound — and judges structured content **last**:
- absent: the result completes, `structured: false`;
- present and not a JSON object (an array, `null`, a scalar): `PROTOCOL_VIOLATION` at
  `server.result.structuredContent`, with the counts that arrived, connection dropped;
- present and an object: **carried** iff at least one text block parses (`JSON.parse`) to
  a value `jsonEqual` to it — any block, since the revision names no position, and a
  block that does not parse is simply not a mirror; otherwise **`RESULT_NOT_CARRIED`** at
  `server.result.structuredContent`, with the counts that arrived, **connection kept**.

`ToolCallResult` gains `structured: boolean` (client-internal, not exported). The port,
which holds the entry, applies the pin-relative rule after the call succeeds and before
the privacy guard: an entry whose `outputSchema` is not `null` and a result with no
structured content is `PROTOCOL_VIOLATION` at `server.result.structuredContent` with its
counts, and the connection is dropped, as every violation drops it. The privacy guard
then runs as before over the **whole** raw result, so a credential shape inside
structured content is `RESULT_UNSAFE`.

**No new carriage.** `content: readonly string[]` stays the only thing a caller
receives. A carried structured value reaches the caller as the text block that already
held it, so nothing is lost; no runtime, protocol, gateway or CLI source moves.

**What is not checked, and what it costs.**
- **No validation (a declared deviation).** The plane never validates `structuredContent`
  against `outputSchema`: there is no JSON-Schema validator in the edge, as ADR 0109 (C3)
  ruled for arguments. The revision says a client SHOULD validate; this client does not,
  and says so here, in the README and in the record. The pin binds the allow decision to
  the reviewed output interface; the mirror guarantees nothing is dropped.
- **4 KiB.** A mirror is a text block, bound by `TOOL_CONTENT_STRING_MAX`: structured
  content that serializes past 4 KiB can never be carried. Mirrored, the block bound
  fires first (`RESULT_UNBOUNDED` at `server.result`); unmirrored, the mirror rule does.
- **Depth.** A value deeper than `TOOL_SCHEMA_DEPTH_MAX` (32 containers) never compares
  equal, so it is `RESULT_NOT_CARRIED` even when mirrored.
- **Array order** is inherited from `jsonEqual`: a mirror that reorders an array carries
  another value.
- **Numbers, to IEEE double precision.** "Nothing is lost" holds only up to a double:
  the mirror is compared after `JSON.parse`, so a mirror whose number differs from the
  structured value only past 2^53, or past the double range (`1e400` against `1e401`),
  is accepted, and the text the caller receives then states a different number than
  `structuredContent` did. Inherited from `jsonEqual`, whose docblock declares it.
- `JSON.parse` of a block is bounded by the block's 4 KiB. No constant is added, so
  `TOOLS_PUBLIC_EXPORTS` does not move.

### Three — the words, the `at` paths and the record (decision 205)

**`RESULT_NOT_CARRIED`** joins `TOOL_REFUSALS`, sorted between `RESULT_IS_ERROR` and
`RESULT_UNBOUNDED` (11 → **12**). Kimi's pre-audit held P-24/A's C4 as law here: a
`PROTOCOL_VIOLATION` names a peer that broke the protocol and drops its connection, and a
peer that omits a SHOULD — the mirror — has broken nothing. So the unmirrored case gets a
decline word and keeps its connection, while the two MUST breaches (a non-object value;
its absence under a pinned output schema) stay `PROTOCOL_VIOLATION`. An image, audio or
resource block is the same class as the unmirrored case — a conformant result this client
does not carry — and still refuses as `PROTOCOL_VIOLATION` at `server.result`, the known
misnaming the P-24/A record already carried; moving it to the new word changes shipped
behaviour and is **a later cut, named on the P-24 row**.

The new paths — `server.tools.outputSchema` (25 characters) and
`server.result.structuredContent` (31) — fit the protocol's 120-character `at`, and the
contract suite measures both.

The §16 translation table (contracts) gains two rows and extends one:
- `SCHEMA_MISMATCH` → `PRECONDITION_FAILED`, `NONE`: the caller's request is fine, the
  reviewed interface changed, and the answer is the operator's re-pin (ADR 0109 minted the
  word without a row; this cut widens its reach and pays the row);
- `RESULT_NOT_CARRIED` → `CAPABILITY_UNSUPPORTED`, `NONE`: the tool answered and the
  answer is conformant; this client lacks the capability to carry it whole, and the row
  names that capability;
- the "violación de protocolo" row's note names a non-object structured value and its
  absence under a pinned output schema.

`MCP_PROTOCOL_RECORD`: `OUTPUT_SCHEMA` becomes `"pinned per tool by value, absent read as
none; SCHEMA_MISMATCH before any tools/call; never validated against"`, and
`STRUCTURED_CONTENT` joins (19 → **20** keys): `"carried only as the text block that holds
it JSON-equal, else RESULT_NOT_CARRIED; required under a pinned output schema; never a
field of its own"`, each with its README marker.

**No version moves, and three proofs say so.** `CONTRACT_VERSION` (2.10.0),
`API_CONTRACT_VERSION` (0.23.0), `MIGRATIONS` (27), the event types and
`TOOL_CALL_RECORDED`'s keys, `CONTRACTS_SCHEMA_EXPORTS`, `RUNTIME_PUBLIC_EXPORTS`,
`TOOLS_PUBLIC_EXPORTS` and the receipt's ten members do not move: the recorder admits a
vocabulary word by grammar, the protocol types `refusal` by the same grammar and `at` as
`z.string().min(1).max(120)`, and no ledger CHECK names a tool word. (1) At both doors
the durable `TOOL_CALL_RECORDED` row carries F2–F4's word, and the API's 200 body parses
under the unchanged `ToolCallExecuteResponse` — in the door suites of this cut; (2) the
recorder still refuses a word past its grammar (unchanged row); (3) `structuredContent`
appears in no source outside the client (L-P24B-1), `outputSchema` in no source outside
`packages/edges/tools/src`, and no document outside this write-set names a
`TOOL_REFUSALS` member as a case, key or table entry. Proofs (2) and (3) are the
verifier's to run at this cut's head.

### Four — the laws (decision 206)

- **L-P24B-1, "structured content is read in one place, compared by value, and carried
  nowhere"** (new, path-scoped): over every `packages/*/*/src` `.ts`/`.tsx` file, tracked
  or in the write-set under that same path filter (so a test or fixture naming the field
  is out of scope), comments stripped, the identifier `structuredContent` appears only in
  `tools/src/client/index.ts`, only inside the `callTool` body, which names it and calls
  `jsonEqual(`. The `at` path's last segment, spelled after `server.result.`, is a path
  and not a read, and is not counted. `PATH_SCOPED_LAWS` 170 → **171**.
- **L-P24-2, widened in place**: the comparison matcher covers `outputSchema` as well as
  `inputSchema`; no count moves.
- **L-B4B-17**: one concordance row, `STRUCTURED_CONTENT` → `structuredContent`.

Stated limits: text-level matchers. The field reached through a computed key built from
pieces, through a destructuring alias whose line does not name it, or through a
whole-result serialization is not seen; a `jsonEqual(` call present in the body but not
applied to the field passes. The exempt path spelling is itself such a channel: a key
derived from the string `"server.result.structuredContent"` (its `.slice(14)`, say) is
preceded by `server.result.` and so is not counted, in any source. The client suite's
rows are the behaviour.

### Five — the doors, end to end (decision 207)

No door source moves, so no new-entrypoint e2e is owed; the rows are owed by §Three's
proof (1) and by decision 164's parity rule. Each door runs them with its own P-24 fake
(now with per-tool `outputSchemas` and a verbatim call result) and a real ledger, and the
parity suite asserts CLI = API on the whole response document and on the fake's log:

| Row | Scenario | Both doors |
| --- | --- | --- |
| F1 | output pin equal to the advertisement; result mirrored | `COMPLETED`; `content` is the mirror text; log `list null`, `call docs.search` |
| F2 | advertised `outputSchema` differs by one nested key | `SCHEMA_MISMATCH` at `server.tools.outputSchema`; counts 0/0; log `list null`; a durable row |
| F3 | pinned none; unmirrored `structuredContent` | `RESULT_NOT_CARRIED` at `server.result.structuredContent`; counts as received; list and call; a durable row with those counts |
| F4 | output pin; result with no `structuredContent` | `PROTOCOL_VIOLATION` at `server.result.structuredContent`; counts as received |
| F5 | a document whose output pin is `"x"` | CLI: the shared admission at `servers[0].tools[0].outputSchema`, `EXIT_USAGE`, no child; API: `DOCUMENT_NOT_ADMITTED`, `503 TOOL_SERVERS_UNCONFIGURED`, the path not forwarded, no child |

The door suites resolve `@acp/tools` to its built `dist`, so a door row judges the edge
source only after `tsc --build`: `pnpm check` builds before it tests, and any partial
re-run of these rows must build first, or it passes against the previous build.

E1–E8 stay green unchanged: the default fakes advertise no `outputSchema` and return no
`structuredContent`, and an absent pin is none. At the doors one operation is one call,
so "connection kept" (F3) is observable only in the edge suites, where a second call
reuses the same child.

## Why the alternatives were not chosen

**Carry `structuredContent` to the caller as a field** (through runtime, protocol,
gateway and CLI, API 0.24.0). The natural next step, but a surface change with no
consumer today — no model exposure, no daemon composition. The P-24 row carries it as
residual (f), only if a consumer or the owner asks.

**Validate against the schema.** A validator is a dependency and a language; the pin
binds the allow decision to a reviewed interface, and that is what J4 asks. Declared.

**Refuse every result that carries `structuredContent`.** Honest, and useless: every
tool with an output schema would become uncallable.

**Synthesize a text block from an unmirrored value.** The caller would receive a block it
cannot tell from the server's — a provenance lie.

**`PROTOCOL_VIOLATION` for the unmirrored case** (the brief's recommendation). One word
for the image and the unmirrored case, but it would name a SHOULD as a violation and drop
the connection of a peer that broke nothing; the pre-audit held P-24/A C4 as law.

**Require the key, like `inputSchema`.** Re-pins every fixture entry (about ninety
sites by a grep estimate, not a measured edit set) and every operator document for no
safety gain: absence already takes the strictest value.

## Consequences

- A tool is called only on a connection whose last listing advertised its output
  interface as pinned; a changed output schema is a refusal before any call, and a
  re-pin is the operator's reviewed act.
- A structured result is never shortened silently: carried as its text, or declined
  whole with its counts.
- Pins that move: `TOOL_REFUSALS` 12; `MCP_PROTOCOL_RECORD` 20 keys; L-B4B-17 20 rows;
  `PATH_SCOPED_LAWS` 171; the ADR corpus 117; one more epoch-frozen record (243). No
  contract, migration, API version, public export or receipt member moves.

## Not in this record

- (f) Carrying structured content as a typed field, and into a model prompt (map item
  12, P-24 (d)).
- One word for "a conformant result this client does not carry" covering image, audio
  and resource blocks as well — a later cut on the P-24 row.
- `title` and `annotations`, still unread (ADR 0109 (v)).
- The discovery verb at the doors (P-24 (a)); window B at daemon composition (P-24 (c));
  the real profile and its permissions (P-24 (d)); several pins per tool (P-24 (e));
  `READ_ONLY`/`workspaceMode` (P-17).
- Fable's audit of this cut, pending its quota.

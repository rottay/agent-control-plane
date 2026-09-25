/**
 * The tool protocol vocabulary — `@acp/tools` (V2-B4b stage 1).
 *
 * Everything closed and everything bounded, in one file, so that "what may a
 * tool call be" has exactly one answer to read. Nothing here performs I/O and
 * nothing here reads an environment; the admission is the only module that
 * does either, and it is the only producer of an `AdmittedToolServer`.
 */

import type { WorkerIdentityString, WorkerRole } from "@acp/contracts";

/**
 * The transports this package speaks. Exactly two, and each is honest.
 *
 * MCP defines two standard transports: **stdio** — newline-delimited JSON-RPC
 * on a spawned child's stdin/stdout — and **Streamable HTTP**. Stage 1 shipped
 * the first alone and promised that "the member arrives with the transport
 * rather than before it": a member nothing can produce is the vacuity this
 * repository refuses, so the union stayed at one until the second leg existed.
 *
 * **V2-B4b S4-1 keeps that promise.** `HTTP_LOOPBACK` arrives with its
 * transport (`src/http-loopback/index.ts`), its admitted leg (the parsed-URL
 * branch `admission/index.ts` has carried since stage 1, whose refusal finally
 * has an admitted sibling), and its drills. Every member of this union has an
 * admission that can emit it and a connection that can speak it.
 *
 * The name is `HTTP_LOOPBACK` rather than `STREAMABLE_HTTP`, `HTTP` or
 * `LOOPBACK` deliberately: those three are pinned as **refused** transport
 * strings by the admission suite, and the union widens by adding a member
 * without deleting a negative. It also says the bound in the name — this leg
 * reaches `127.0.0.1` and `::1` and nothing else.
 */
export const TOOL_TRANSPORT_KINDS = ["STDIO", "HTTP_LOOPBACK"] as const;
export type ToolTransportKind = (typeof TOOL_TRANSPORT_KINDS)[number];

/**
 * The transport a receipt names when no server was resolved.
 *
 * Deliberately **not** a member of {@link TOOL_TRANSPORT_KINDS}: no admission
 * can emit it, no connection can speak it, and the union's "every member has a
 * producer" law stays honest. It is a receipt coordinate, not a transport.
 *
 * The port refuses two calls before an admitted server exists — a dead session
 * whose `serverId` nobody admitted, and a `serverId` nobody admitted at all —
 * and both still earn a receipt, because a refusal that left no record would
 * make the allowlist unfalsifiable in operation. Naming a transport there
 * would be asserting a fact about a server that does not exist, which is the
 * class of error this receipt was built to make impossible.
 *
 * A screaming-snake word rather than `null`, and the reason is downstream:
 * `@acp/runtime`'s recorder admits any word matching its vocabulary grammar
 * and refuses a null outright, so the word crosses the stratum boundary the
 * null could not — with no change to any contract.
 */
export const TOOL_TRANSPORT_UNRESOLVED = "UNRESOLVED" as const;
export type ToolTransportUnresolved = typeof TOOL_TRANSPORT_UNRESOLVED;

/**
 * Every way a tool call can be refused. Closed, sorted, and each member has a
 * producer in this package — a refusal nothing can emit is a vocabulary entry
 * pretending to be a guarantee.
 *
 * Producer per member, in order: the argument ceiling; an identity outside
 * `TOOL_WRITE_ROLES` against a writing tool; a malformed, oversized, unmatched
 * or absent JSON-RPC frame; a result the server marked as an error; structured
 * content no text block carries; the result ceiling; the privacy guard over a
 * result; the listing's pins; a `serverId` outside the admitted set; the
 * liveness join; the per-server tool allowlist; the descriptor admission.
 *
 * `RESULT_IS_ERROR` (P-11) is the refusal for a fact the other nine cannot
 * name: the transport answered, the frame was well-formed, and the result
 * itself says the tool failed. It is a refusal — not a third outcome word and
 * not a success — for the reason §16.2 of the audited contracts gives: a
 * marked-error result is classified there as a refusal with retry `NONE`.
 * When P-07 brings the effect outcome vocabulary, the §16 translation layer
 * maps `REFUSED`/`RESULT_IS_ERROR` to `FAILED`; this package does not mint
 * that word ahead of its owner.
 *
 * `SCHEMA_MISMATCH` (P-24, ADR 0109) is the port's refusal when the listing this
 * connection last saw does not advertise the tool (`at: "server.tools"`), or
 * advertises it with an `inputSchema` that is not JSON-equal to the one the
 * operator pinned (`at: "server.tools.inputSchema"`), or with an `outputSchema`
 * that is not JSON-equal to the output pin (`at: "server.tools.outputSchema"`,
 * P-24/B(b), ADR 0117). It is decided before any `tools/call` is sent.
 *
 * `RESULT_NOT_CARRIED` (P-24/B(b), ADR 0117) is the client's refusal for a
 * result that is conformant and that this plane cannot carry whole: it holds
 * structured content that no text block of the same result carries by JSON
 * value (`at: "server.result.structuredContent"`). The revision asks a server to
 * mirror structured content in a text block, but as a SHOULD, so a peer that
 * omits the mirror has violated nothing: the result is declined rather than
 * dropped, its counts are kept, and the connection survives. A structured
 * value that is not a JSON object, or its absence under a pinned output schema,
 * breaks a MUST and stays `PROTOCOL_VIOLATION`. An image, audio or resource
 * block is the same class as the unmirrored case and still refuses as
 * `PROTOCOL_VIOLATION` at `server.result`; moving it to this word is a later
 * cut, named on the P-24 row.
 */
export const TOOL_REFUSALS = [
  "ARGUMENTS_UNBOUNDED",
  "IDENTITY_FORBIDS_WRITE",
  "PROTOCOL_VIOLATION",
  "RESULT_IS_ERROR",
  "RESULT_NOT_CARRIED",
  "RESULT_UNBOUNDED",
  "RESULT_UNSAFE",
  "SCHEMA_MISMATCH",
  "SERVER_NOT_ADMITTED",
  "SESSION_NOT_LIVE",
  "TOOL_NOT_ALLOWED",
  "TRANSPORT_REFUSED",
] as const;
export type ToolRefusal = (typeof TOOL_REFUSALS)[number];

/**
 * The roles that may drive a tool declared `writes: true`. A closed allowlist,
 * never a single-role comparison.
 *
 * `WORKER_ROLES` holds five names. `AGENTS.md` puts `reviewer` and
 * `consultant` under structural read-only, and a verifier is by construction
 * not the writer — so refusing only one of the three would leave the other two
 * driving a writing tool. Stated as a subset, widening it is a decision
 * somebody makes on purpose and a reviewer sees; stated as `!== "reviewer"`,
 * widening it is what happens when a sixth role is added and nobody looks
 * here.
 *
 * The fence asserts both halves: that this is a subset of `WORKER_ROLES`, and
 * that the port decides by membership in it rather than by comparing to a
 * literal.
 */
export const TOOL_WRITE_ROLES = ["implementer"] as const;
export type ToolWriteRole = (typeof TOOL_WRITE_ROLES)[number];

/** Does this role hold write authority over a tool? Membership, not equality. */
export function holdsToolWriteAuthority(role: WorkerRole): boolean {
  return (TOOL_WRITE_ROLES as readonly string[]).includes(role);
}

/**
 * One tool a server is permitted to be asked for, whether it writes, and the
 * interface the operator allowed it under (P-24, ADR 0109).
 *
 * `inputSchema` is **required and never defaulted**: it is the value the operator
 * reviewed, and the port calls the tool only on a connection whose last listing
 * advertised a JSON-equal schema. It is a pin on the interface, not a validator of
 * the call: the plane never checks `arguments` against it. There is no tool
 * version in the MCP revision this client speaks, so the pin is the version and a
 * changed schema is a re-pin — a reviewed change to the operator's document, never
 * something the plane rewrites from what a server advertises.
 *
 * `outputSchema` (P-24/B(b), ADR 0117) pins the tool's **output** interface the
 * same way: an object schema the operator reviewed, or `null` for "reviewed: this
 * tool declares no output schema". The key is optional in a document and the
 * admission **always materializes it**, absence as `null`. That is not the default
 * ADR 0109 forbade for `inputSchema`: there no value was safe, here absence takes
 * the strictest value there is, so a server that advertises any output schema for
 * a tool pinned to none is a mismatch. Like the input pin it is compared, never
 * used to validate: the plane checks no structured result against it.
 */
export interface ToolAllowlistEntry {
  readonly name: string;
  readonly writes: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>> | null;
}

/**
 * Config-shaped input: untrusted, and deliberately wider than what is admitted.
 *
 * `transport` is `string` rather than `ToolTransportKind`, and `url` exists at
 * all, on purpose. Typed narrowly, a remote server could not be *expressed*,
 * "remote MCP is refused" would be true only of a type, and the certification
 * negative would be unwritable. A remote descriptor must reach the admission
 * to be refused there, because that is what makes the refusal a fact about
 * running code.
 *
 * **Credentials are unrepresentable by shape.** There is no `env` input and no
 * secret, token, key or `secretRef` member anywhere in this type. A tool server
 * that needs a credential cannot be described here at all — refused by the
 * absence of a field, which is the same law the provider edge's API client
 * holds and which the fence pins the same way. A credentialed server is a
 * later decision with a secret-manager story, not a field somebody adds while
 * wiring one.
 */
export interface ToolServerDescriptor {
  readonly serverId: string;
  readonly transport: string;
  /** STDIO: an absolute path to an executable this user owns. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** Present only on remote-shaped input. Always refused in this stage. */
  readonly url?: string;
  readonly tools: readonly ToolAllowlistEntry[];
}

/**
 * The ceilings, in one place.
 *
 * Every one of them is a refusal rather than a truncation. A silently
 * shortened tool result is a wrong answer wearing a right answer's shape, and
 * the caller cannot tell the two apart.
 */
export const TOOL_ARGUMENTS_BYTES_MAX = 8_192;
export const TOOL_RESULT_BYTES_MAX = 65_536;
export const TOOL_FRAME_BYTES_MAX = 131_072;
export const TOOL_CONTENT_STRING_MAX = 4_096;
export const TOOL_CALL_TIMEOUT_MS = 30_000;

/**
 * The listing's bounds (P-24, ADR 0109), each a refusal and never a truncation.
 *
 * Which bound binds what: a page's **bytes** are bound by the frame ceiling
 * ({@link TOOL_FRAME_BYTES_MAX}) before any of these applies, so a listing's
 * **count** is bound across pages by pages and tools, and its **shape** by the
 * cursor's bytes and the schema's depth. `TOOL_SCHEMA_BYTES_MAX` binds the
 * operator's pin at admission; an advertised schema is bound by its frame.
 */
export const TOOL_LIST_PAGES_MAX = 16;
export const TOOL_LIST_TOOLS_MAX = 256;
export const TOOL_CURSOR_BYTES_MAX = 1_024;
export const TOOL_SCHEMA_BYTES_MAX = 16_384;
export const TOOL_SCHEMA_DEPTH_MAX = 32;

/**
 * The whole listing's deadline, read **between pages** and never mid-request.
 *
 * One timer, armed when a listing starts, sets a flag; the flag is read after a
 * page's response and before the next request, so the stream is always at a known
 * offset and an expired listing is `RESULT_UNBOUNDED` with the connection kept.
 * Each page keeps its own {@link TOOL_CALL_TIMEOUT_MS}, so the worst case is this
 * deadline plus one page's timeout. No clock is read.
 */
export const TOOL_LIST_DEADLINE_MS = 60_000;

/**
 * The hard lifetime of a tool server child, passed to `spawn` as its `timeout`.
 *
 * A tool server outlives a single call by design — the connection is reused
 * for as long as its execution session is live — so this is a backstop against
 * a child that is never reaped by any other path, not a per-call bound. The
 * stdio transport takes it as an argument rather than reading it directly so
 * that the backstop can be *observed* in a test at a small value; a ceiling no
 * test ever reaches is a number, not a bound.
 */
export const TOOL_SERVER_LIFETIME_MS = 300_000;

/**
 * The whole environment a tool server child receives.
 *
 * Three variables, read from the ambient environment and nothing else. No
 * inheritance, so nothing a caller happens to be holding travels into a tool
 * server, and the set is pinned by the fence so a fourth cannot be added while
 * wiring a server that wants one.
 */
export const TOOL_SERVER_ENV_KEYS = ["HOME", "LC_ALL", "PATH"] as const;

/** MCP revision this client speaks, sent in `initialize`. */
export const TOOL_MCP_PROTOCOL_VERSION = "2025-06-18";

/** What the plane calls itself when it introduces itself to a server. */
export const TOOL_MCP_CLIENT_NAME = "acp-tools";

// ---------------------------------------------------------------------------
// The loopback Streamable HTTP leg (V2-B4b S4-1)
// ---------------------------------------------------------------------------

/**
 * How long one request may stay unanswered before it is abandoned.
 *
 * Matches the stdio call timeout in intent rather than in number: a transport
 * that could hang forever would make every ceiling below it decorative.
 */
export const TOOL_HTTP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The most bytes one response body may carry, streamed or not.
 *
 * Counted **as they are decoded** and aborted at the boundary, never after —
 * the same law `createToolFrameReader` holds for stdio, where the bound is on
 * the unterminated buffer rather than only on completed frames. It sits at or
 * above {@link TOOL_FRAME_BYTES_MAX} so a frame the reader would accept is
 * never cut off by the transport beneath it.
 */
export const TOOL_HTTP_STREAM_BYTES_MAX = 524_288;

/** The most server-sent events one response may carry before it is refused. */
export const TOOL_HTTP_STREAM_EVENTS_MAX = 64;

/**
 * How long a best-effort session teardown may take.
 *
 * Short on purpose: `close()` must not be able to hold a caller open, and a
 * teardown that fails is not an error — the session is being abandoned either
 * way.
 */
export const TOOL_HTTP_CLOSE_TIMEOUT_MS = 2_000;

/**
 * What this client actually implements of the MCP revision it names.
 *
 * In the `CODEX_PROTOCOL_RECORD` idiom, and for the same reason: a capability
 * claim a reader cannot check is decoration. **Every field that reads
 * `UNKNOWN` or `NONE` corresponds to a refusal or an absence in the code, never
 * to a guess** — and the fence asserts that this record and the README cannot
 * disagree.
 *
 * `SPEC_MANIFEST_DIGEST` is `NONE` because this leg was built under the
 * citation gate rather than the vendoring gate: the revision was cited, its
 * bytes were not placed on disk, so there is nothing to digest and nothing to
 * assert the constants against. That is the honest reading of what was
 * authorized, and it is why the README carries the uncited qualifier beside it.
 */
export const MCP_PROTOCOL_RECORD = Object.freeze({
  REVISION: TOOL_MCP_PROTOCOL_VERSION,
  TRANSPORT: "streamable-http",
  /** No bytes were vendored, so there is nothing to digest. */
  SPEC_MANIFEST_DIGEST: "NONE",
  SPEC_CITATION: "2025-06-18; modelcontextprotocol.io/specification/2025-06-18; retrieved 2026-09-04",
  /** No third-party server is contacted anywhere in this repository. */
  LIVE_CONFORMANCE: "NONE",
  /** The drills substitute the platform fetch; no socket is opened. */
  SOCKET_EXERCISED: "NONE",
  VERSION_NEGOTIATION: "checked",
  SESSION_HEADER: "mcp-session-id, echoed when issued",
  SERVER_INITIATED_STREAM: "NOT_OPENED",
  RESUMPTION: "NONE",
  BATCHING: "REFUSED",
  ORIGIN_HEADER: "NOT_SENT",
  REDIRECTS: "manual; 3xx refused as TRANSPORT_REFUSED",
  LIST_PAGINATION:
    "followed; bounded by pages, tools, cursor bytes and a listing deadline; a repeated cursor refused",
  TOOL_SCHEMA: "pinned per tool by value; JSON-equal or SCHEMA_MISMATCH before any tools/call; arguments never validated",
  LIST_CHANGED:
    "invalidates the cached listing; a change during a listing restarts it once; a guard re-checks before send; a change after the last listing this connection saw is not seen",
  OUTPUT_SCHEMA:
    "pinned per tool by value, absent read as none; SCHEMA_MISMATCH before any tools/call; never validated against",
  STRUCTURED_CONTENT:
    "carried only as the text block that holds it JSON-equal, else RESULT_NOT_CARRIED; required under a pinned output schema; never a field of its own",
  IS_ERROR_RESULT: "refused as RESULT_IS_ERROR; error content discarded whole",
  CONTENT_BLOCKS: "text only; every other kind refused",
} as const);

/**
 * A tool call, as the plane's own caller states it.
 *
 * `identity` is the control-plane worker identity, not a credential: it is the
 * grammar `<provider>/<model>/<role>/<instance>`, and it is what the write
 * decision reads a role out of.
 */
export interface ToolCallRequest {
  readonly sessionId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly identity: WorkerIdentityString;
  readonly arguments: Readonly<Record<string, unknown>>;
}

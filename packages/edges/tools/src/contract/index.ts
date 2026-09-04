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
 * The transports this package speaks. Exactly one, and it is honest.
 *
 * MCP defines two standard transports: **stdio** — newline-delimited JSON-RPC
 * on a spawned child's stdin/stdout — and **Streamable HTTP**. This stage
 * implements the first and only the first. A one-member union reads oddly
 * beside a union that could hold two, and that is the point: a second member
 * nothing can produce is exactly the vacuity this repository refuses
 * elsewhere, so the member arrives with the transport rather than before it.
 *
 * A loopback Streamable HTTP leg is a later stage's work, gated on its own
 * protocol record and on the parsed-URL admission this stage already builds
 * (see `admission/index.ts`). Until that lands, a URL-bearing descriptor is
 * representable input and is refused — never unrepresentable, which would make
 * the refusal a fact about a TypeScript type rather than about running code.
 */
export const TOOL_TRANSPORT_KINDS = ["STDIO"] as const;
export type ToolTransportKind = (typeof TOOL_TRANSPORT_KINDS)[number];

/**
 * Every way a tool call can be refused. Closed, sorted, and each member has a
 * producer in this package — a refusal nothing can emit is a vocabulary entry
 * pretending to be a guarantee.
 *
 * Producer per member, in order: the argument ceiling; an identity outside
 * `TOOL_WRITE_ROLES` against a writing tool; a malformed, oversized, unmatched
 * or absent JSON-RPC frame; the result ceiling; the privacy guard over a
 * result; a `serverId` outside the admitted set; the liveness join; the
 * per-server tool allowlist; the descriptor admission.
 */
export const TOOL_REFUSALS = [
  "ARGUMENTS_UNBOUNDED",
  "IDENTITY_FORBIDS_WRITE",
  "PROTOCOL_VIOLATION",
  "RESULT_UNBOUNDED",
  "RESULT_UNSAFE",
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

/** One tool a server is permitted to be asked for, and whether it writes. */
export interface ToolAllowlistEntry {
  readonly name: string;
  readonly writes: boolean;
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

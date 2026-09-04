/**
 * `@acp/tools` — the tool protocol edge (V2-B4b stage 1).
 *
 * A closed barrel. No `export *`: a surface that widens by itself is a surface
 * nobody decided on, and the fence pins this one by equality in both
 * directions against `TOOLS_PUBLIC_EXPORTS` and against the README's table.
 *
 * The codec, the client and the stdio transport are deliberately **not** here.
 * They are how the port keeps its promises, not promises of their own; this
 * package's own suites reach them by relative path, exactly as the provider
 * edge does with its fake. A transport on the public surface would eventually
 * be opened by somebody outside the port, and the port is where the allowlist,
 * the liveness join and the receipt live.
 */

export {
  TOOL_ARGUMENTS_BYTES_MAX,
  TOOL_CALL_TIMEOUT_MS,
  TOOL_CONTENT_STRING_MAX,
  TOOL_FRAME_BYTES_MAX,
  TOOL_MCP_CLIENT_NAME,
  TOOL_MCP_PROTOCOL_VERSION,
  TOOL_REFUSALS,
  TOOL_RESULT_BYTES_MAX,
  TOOL_SERVER_ENV_KEYS,
  TOOL_SERVER_LIFETIME_MS,
  TOOL_TRANSPORT_KINDS,
  TOOL_WRITE_ROLES,
  holdsToolWriteAuthority,
} from "./contract/index.js";
export type {
  ToolAllowlistEntry,
  ToolCallRequest,
  ToolRefusal,
  ToolServerDescriptor,
  ToolTransportKind,
  ToolWriteRole,
} from "./contract/index.js";

export { admitToolServer } from "./admission/index.js";
export type { AdmittedToolServer, ToolAdmissionOutcome } from "./admission/index.js";

export type { ToolCallOutcomeName, ToolCallReceipt } from "./receipt/index.js";

export { createToolProtocolPort } from "./port/index.js";
export type {
  SessionLiveness,
  ToolCallOutcome,
  ToolListingOutcome,
  ToolProtocolPort,
  ToolProtocolPortInput,
} from "./port/index.js";

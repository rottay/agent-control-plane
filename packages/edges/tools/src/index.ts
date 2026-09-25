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
  TOOL_CURSOR_BYTES_MAX,
  TOOL_FRAME_BYTES_MAX,
  TOOL_HTTP_CLOSE_TIMEOUT_MS,
  TOOL_HTTP_REQUEST_TIMEOUT_MS,
  TOOL_HTTP_STREAM_BYTES_MAX,
  TOOL_HTTP_STREAM_EVENTS_MAX,
  TOOL_LIST_DEADLINE_MS,
  TOOL_LIST_PAGES_MAX,
  TOOL_LIST_TOOLS_MAX,
  TOOL_SCHEMA_BYTES_MAX,
  TOOL_SCHEMA_DEPTH_MAX,
  MCP_PROTOCOL_RECORD,
  TOOL_MCP_CLIENT_NAME,
  TOOL_MCP_PROTOCOL_VERSION,
  TOOL_REFUSALS,
  TOOL_RESULT_BYTES_MAX,
  TOOL_SERVER_ENV_KEYS,
  TOOL_SERVER_LIFETIME_MS,
  TOOL_TRANSPORT_KINDS,
  TOOL_TRANSPORT_UNRESOLVED,
  TOOL_WRITE_ROLES,
  holdsToolWriteAuthority,
} from "./contract/index.js";
export type {
  ToolAllowlistEntry,
  ToolCallRequest,
  ToolRefusal,
  ToolServerDescriptor,
  ToolTransportKind,
  ToolTransportUnresolved,
  ToolWriteRole,
} from "./contract/index.js";

export { admitToolServer, admitToolServers } from "./admission/index.js";
export type {
  AdmittedToolServer,
  ToolAdmissionOutcome,
  ToolDocumentOutcome,
} from "./admission/index.js";

export type { ToolCallOutcomeName, ToolCallReceipt } from "./receipt/index.js";

// V2-B4b stage 3C: the operation scope. The one composition site for the
// protocol port outside this package's own suites, and the seam where "ok
// agrees with the receipt" is enforced.
export { openToolDiscovery, openToolOperation } from "./operation/index.js";
export type {
  ToolDiscoveryInput,
  ToolDiscoveryScope,
  ToolOperationInput,
  ToolOperationScope,
} from "./operation/index.js";

export { createToolProtocolPort } from "./port/index.js";
export type {
  SessionLiveness,
  ToolCallOutcome,
  ToolListingOutcome,
  ToolProtocolPort,
  ToolProtocolPortInput,
} from "./port/index.js";

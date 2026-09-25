import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  ToolDiscoveryResponse,
  toolServerToolsPath,
} from "@acp/protocol";
import { openToolDiscovery } from "@acp/tools";
import type { ToolListingOutcome } from "@acp/tools";

import { ApiRouteError } from "../errors/index.js";
import type { ToolServersLoadOutcome } from "../tool-calls/index.js";

/**
 * The discovery door (P-24/B(a), ADR 0118): which of one admitted server's
 * allowlisted tools it serves under their pins.
 *
 * **A query, and it records nothing.** The composition catalogue names the
 * operation `acp.tools / LIST | ToolProtocolPort.listTools | ninguno; sólo
 * consulta`, and "consultas no crean efectos ficticios": so this module opens no
 * ledger, reads no ledger and appends to none, and the route answers the same
 * whether or not this process has a ledger at all. What it does is start a child
 * through the tool edge's discovery scope — the one composition site — list once,
 * and reap it in a `finally` before the answer is sent.
 *
 * **Guarded because it is not free.** The route is a private read: it starts a
 * process and it describes the operator's tool document, so it is registered
 * through `registerPrivateGet` and the bearer is checked before the path
 * parameter is read and before any child exists. `503 TOOL_SERVERS_UNCONFIGURED`
 * is answered before any child too, and names no path.
 *
 * **A port refusal is not an error.** The request was valid and the plane
 * answered it truthfully about the peer, so every word the port answers —
 * `SERVER_NOT_ADMITTED` included, the tool-call door's rule — is a 200 with
 * `outcome: "REFUSED"`, its `at`, and on `SCHEMA_MISMATCH` the allowlist entry it
 * names. Mapping the words onto status codes would be a second vocabulary for
 * the same twelve words.
 *
 * **The answer is projected, and sorted here.** The port answers allowlist order;
 * the door answers `{name, writes}` sorted by name, so two producers over one
 * advertisement print the same bytes whatever order an operator wrote. No
 * schema byte and no transport kind crosses: they were not asked for.
 */

/**
 * Validate the path parameter, or raise `400 BAD_REQUEST` at `serverId`.
 *
 * By the builder's own grammar, so the door and the route table cannot disagree
 * about which ids exist: the precedent `parseEffectIdParam` set. The value is
 * never echoed.
 */
export function parseServerIdParam(raw: string): string {
  try {
    toolServerToolsPath(raw);
  } catch {
    throw new ApiRouteError("BAD_REQUEST", "serverId must be a bounded identifier", "serverId");
  }
  return raw;
}

/**
 * Project the port's listing onto the wire answer both doors print.
 *
 * The CLI door states the same projection in its own package, because neither
 * door may name the other; the schema's refinements (sorted, counted, `toolName`
 * exactly on a mismatch) hold both to one shape, and the parity rows compare the
 * two producers' bytes.
 */
function discoveryDocument(serverId: string, listed: ToolListingOutcome): ToolDiscoveryResponse {
  if (listed.ok) {
    const tools = listed.tools
      .map((tool) => ({ name: tool.name, writes: tool.writes }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return ToolDiscoveryResponse.parse({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      serverId,
      outcome: "COMPLETED",
      refusal: null,
      at: null,
      toolName: null,
      tools,
      count: tools.length,
    });
  }
  return ToolDiscoveryResponse.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    serverId,
    outcome: "REFUSED",
    refusal: listed.refusal,
    at: listed.at,
    toolName: listed.refusal === "SCHEMA_MISMATCH" ? (listed.toolName ?? null) : null,
    tools: [],
    count: 0,
  });
}

interface ToolDiscoveryDependencies {
  readonly servers: ToolServersLoadOutcome;
  readonly serverId: string;
}

/**
 * Ask one admitted server what it serves, and answer with nothing recorded.
 *
 * The scope is opened only after the document is known to be admitted, listed
 * once, and closed in a `finally`, so a throw on the way out still reaps the
 * child — and the child is gone before the caller reads the answer.
 */
export async function discoverTools(dependencies: ToolDiscoveryDependencies): Promise<ToolDiscoveryResponse> {
  const { servers, serverId } = dependencies;
  if (!servers.ok) {
    throw new ApiRouteError(
      "TOOL_SERVERS_UNCONFIGURED",
      "this server was started without an admitted tool document, so no tool server can be asked",
    );
  }
  const scope = openToolDiscovery({ servers: servers.servers });
  let listed: ToolListingOutcome;
  try {
    listed = await scope.listTools(serverId);
  } finally {
    await scope.close();
  }
  return discoveryDocument(serverId, listed);
}

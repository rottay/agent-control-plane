import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  ToolDiscoveryResponse,
  toolServerToolsPath,
} from "@acp/protocol";
import { admitToolServers, openToolDiscovery } from "@acp/tools";
import type { ToolListingOutcome } from "@acp/tools";

import { ToolCallRefused, readOperatorDocument } from "../tool-call/index.js";

/**
 * The CLI's discovery door (P-24/B(a), ADR 0118): `acp tool-servers`.
 *
 * Which of one admitted server's allowlisted tools it serves under their pins —
 * the same question `GET /api/v1/tool-servers/:serverId/tools` answers, and the
 * same document. It is deliberately **not** an HTTP client of the gateway: two
 * independent producers over one operator document and one peer is what makes
 * the parity rows evidence rather than a tautology.
 *
 * **The one verb that opens no ledger, and refuses to be handed one.** A
 * discovery records nothing — the composition catalogue names it "sólo
 * consulta", and "consultas no crean efectos ficticios" — so the answer is not
 * a fact in any ledger. The command module branches to this verb above the
 * `--database` law, and refuses `--database` for it rather than accepting a
 * flag it would silently ignore.
 *
 * **Operator authority is the owning uid.** The tool-servers document names
 * commands the plane will execute, so it is read through the tool-call verb's
 * ladder with the bearer file's `0600` rule (`secret: true`), and admitted all
 * or nothing by the tool edge. `--server` is judged by the route builder's own
 * grammar, so the two doors cannot disagree about which ids exist.
 *
 * **A port refusal is a success of this verb.** The request was valid and the
 * plane answered it truthfully about the peer, so every word the port answers
 * prints `outcome: "REFUSED"` and exits `EXIT_OK` — the CLI's analogue of the
 * API's 200. Only a request that never reached a listing exits non-zero.
 *
 * The child is started through the tool edge's discovery scope, the one
 * composition site, listed once and reaped in a `finally` before anything is
 * printed.
 */

export interface ToolDiscoveryVerbInput {
  readonly toolServersPath: string;
  readonly serverId: string;
}

export interface ToolDiscoveryVerbResult {
  readonly document: ToolDiscoveryResponse;
}

/**
 * Project the port's listing onto the document both doors print.
 *
 * Stated here and in the gateway's door, because neither door may name the
 * other; the schema's refinements (sorted by name, counted, `toolName` exactly
 * on a mismatch) hold both to one shape, and the parity rows compare the bytes.
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

/** Ask one admitted server what it serves, and return the document to print. */
export async function runToolDiscoveryVerb(input: ToolDiscoveryVerbInput): Promise<ToolDiscoveryVerbResult> {
  // The server id first: it costs no file read, and an out-of-grammar id is a
  // usage failure whatever the document says. The value is never echoed.
  if (input.serverId === "") {
    throw new ToolCallRefused("BAD_REQUEST", "--server is required", "server");
  }
  try {
    toolServerToolsPath(input.serverId);
  } catch {
    throw new ToolCallRefused("BAD_REQUEST", "--server must be a bounded identifier", "server");
  }

  const rawServers = readOperatorDocument({
    path: input.toolServersPath,
    at: "tool-servers",
    secret: true,
  });
  const admitted = admitToolServers(rawServers);
  if (!admitted.ok) {
    throw new ToolCallRefused("BAD_REQUEST", "the tool-servers document was not admitted", "tool-servers");
  }

  const scope = openToolDiscovery({ servers: admitted.servers });
  let listed: ToolListingOutcome;
  try {
    listed = await scope.listTools(input.serverId);
  } finally {
    // Close drops liveness and then reaps by pid, so the child is gone before
    // this verb returns anything.
    await scope.close();
  }
  return { document: discoveryDocument(input.serverId, listed) };
}

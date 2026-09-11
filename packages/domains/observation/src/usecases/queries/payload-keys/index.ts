/**
 * The payload-keys query.
 *
 * The use-case surface over the read model: a door asks here, never at the
 * model directly, so the read model stays owned by the model layer and the
 * query boundary is the single place a future shaping decision — a filter, a
 * different caller's needs — lands. Today the query is an honest delegate:
 * everything it returns, the projection computed.
 */

import { MAX_PAYLOAD_KEYS, payloadKeys as projectPayloadKeys } from "../../../model/read-model/index.js";

export { MAX_PAYLOAD_KEYS };

/**
 * The key names of one event payload, in canonical order, bounded by
 * `MAX_PAYLOAD_KEYS`. See the read model for what "canonical" fixes.
 */
export function payloadKeys(payload: Readonly<Record<string, unknown>>): string[] {
  return projectPayloadKeys(payload);
}

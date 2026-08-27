import { type TimelineItem } from "@acp/api-contracts";

export type ChainLinkStatus = "linked" | "gap" | "anomaly";

/**
 * Check hash-chain continuity across whatever timeline items are actually in
 * memory (one page, one task's recent events, one worker's recent events).
 *
 * This can only verify a link when both the item and its immediate
 * predecessor by sequence are present in the same set — a filtered view or a
 * page boundary routinely leaves that predecessor out, and that is an
 * ordinary gap, not tamper evidence. An `anomaly` is the one case worth a
 * reader's attention: the predecessor is present, and its digest does not
 * match what this event claims came before it.
 */
export function verifyChainLinkage(
  items: readonly TimelineItem[],
): ReadonlyMap<number, ChainLinkStatus> {
  const bySequence = new Map<number, TimelineItem>();
  for (const item of items) {
    bySequence.set(item.sequence, item);
  }

  const result = new Map<number, ChainLinkStatus>();
  for (const item of items) {
    const previous = bySequence.get(item.sequence - 1);
    if (previous === undefined) {
      result.set(item.sequence, "gap");
      continue;
    }
    result.set(item.sequence, previous.eventSha256 === item.previousSha256 ? "linked" : "anomaly");
  }
  return result;
}

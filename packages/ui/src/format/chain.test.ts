import { type TimelineItem } from "@acp/api-contracts";
import { describe, expect, it } from "vitest";

import { verifyChainLinkage } from "./chain.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_WRONG = "d".repeat(64);

function item(overrides: Partial<TimelineItem> & Pick<TimelineItem, "sequence" | "previousSha256" | "eventSha256">): TimelineItem {
  return {
    eventId: "00000000-0000-4000-8000-00000000000" + String(overrides.sequence % 10),
    taskId: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    transitionId: "t-1",
    type: "TASK_STATE_CHANGED",
    fromState: null,
    toState: "RUNNING",
    emittedBy: "claude/opus/implementer/01",
    occurredAt: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.100Z",
    payloadByteSize: 0,
    payloadKeys: [],
    ...overrides,
  };
}

describe("verifyChainLinkage", () => {
  it("marks the first item on a page as a gap, not an anomaly", () => {
    const items = [item({ sequence: 5, previousSha256: SHA_A, eventSha256: SHA_B })];
    const linkage = verifyChainLinkage(items);
    expect(linkage.get(5)).toBe("gap");
  });

  it("marks a contiguous, correctly linked pair as linked", () => {
    const items = [
      item({ sequence: 1, previousSha256: SHA_A, eventSha256: SHA_B }),
      item({ sequence: 2, previousSha256: SHA_B, eventSha256: SHA_C }),
    ];
    const linkage = verifyChainLinkage(items);
    expect(linkage.get(1)).toBe("gap");
    expect(linkage.get(2)).toBe("linked");
  });

  it("flags a contiguous pair whose digest does not match as an anomaly", () => {
    const items = [
      item({ sequence: 1, previousSha256: SHA_A, eventSha256: SHA_B }),
      item({ sequence: 2, previousSha256: SHA_WRONG, eventSha256: SHA_C }),
    ];
    const linkage = verifyChainLinkage(items);
    expect(linkage.get(2)).toBe("anomaly");
  });

  it("treats a filtered-out predecessor as a gap rather than an anomaly", () => {
    const items = [
      item({ sequence: 1, previousSha256: SHA_A, eventSha256: SHA_B }),
      item({ sequence: 3, previousSha256: SHA_C, eventSha256: SHA_WRONG }),
    ];
    const linkage = verifyChainLinkage(items);
    expect(linkage.get(3)).toBe("gap");
  });
});

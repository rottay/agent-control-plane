import { type TimelineItem } from "@acp/api-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TimelineList } from "../../../src/components/timeline-list/index.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const ITEMS: readonly TimelineItem[] = [
  {
    sequence: 1,
    eventId: "00000000-0000-4000-8000-000000000001",
    taskId: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    transitionId: "t-1",
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "claude/opus/coordinator/01",
    occurredAt: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.050Z",
    previousSha256: SHA_A,
    eventSha256: SHA_B,
    payloadByteSize: 12,
    payloadKeys: ["reason"],
  },
];

describe("TimelineList", () => {
  it("renders the event type, transition and chain status as text", () => {
    const html = renderToStaticMarkup(<TimelineList caption="Timeline" items={ITEMS} />);
    expect(html).toContain("Task discovered");
    expect(html).toContain("Discovered");
    expect(html).toContain("Not on this page");
  });

  it("links to the task and the worker by default", () => {
    const html = renderToStaticMarkup(<TimelineList caption="Timeline" items={ITEMS} />);
    expect(html).toContain('href="#/tasks/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('href="#/workers/claude/opus/coordinator/01"');
  });

  it("omits the task column when showTaskColumn is false", () => {
    const html = renderToStaticMarkup(<TimelineList caption="Timeline" items={ITEMS} showTaskColumn={false} />);
    expect(html).not.toContain('href="#/tasks/');
  });

  it("omits the worker column when showWorkerColumn is false", () => {
    const html = renderToStaticMarkup(<TimelineList caption="Timeline" items={ITEMS} showWorkerColumn={false} />);
    expect(html).not.toContain('href="#/workers/');
  });
});

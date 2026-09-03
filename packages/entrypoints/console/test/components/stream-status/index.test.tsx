import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  IDLE_STREAM_SNAPSHOT,
  type StreamConnectionState,
  type StreamSnapshot,
} from "../../../src/api/stream/index.js";
import { StreamStatus } from "../../../src/components/stream-status/index.js";

/**
 * The five states are rendered, and the banner quotes nothing (V2-B3b).
 *
 * The states are enumerated from the type rather than listed by hand, so a
 * sixth state added later fails here instead of arriving silent — which is the
 * one thing a connection-status component must never be.
 */
const STATES: readonly StreamConnectionState[] = [
  "connecting",
  "live",
  "recovering",
  "degraded",
  "disconnected",
];

function snapshot(overrides: Partial<StreamSnapshot> = {}): StreamSnapshot {
  return { ...IDLE_STREAM_SNAPSHOT, ...overrides };
}

describe("StreamStatus", () => {
  it("renders visible text and an announced live region for every state", () => {
    for (const state of STATES) {
      const html = renderToStaticMarkup(
        <StreamStatus status={snapshot({ state })} label="the timeline" />,
      );
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('data-stream-state="' + state + '"');
      // Not merely a class: a state a sighted operator cannot read is a silent
      // state with a colour on it.
      expect(html).toMatch(/>[A-Z][a-z]+</);
    }
  });

  it("gives each state its own heading word, so two states never read the same", () => {
    const headings = new Set(
      STATES.map((state) => {
        const html = renderToStaticMarkup(
          <StreamStatus status={snapshot({ state })} label="the timeline" />,
        );
        return /stream-status__heading">([^<]+)</.exec(html)?.[1] ?? "";
      }),
    );
    expect(headings.size).toBe(STATES.length);
  });

  it("says where the applied cursor is when it is live", () => {
    const html = renderToStaticMarkup(
      <StreamStatus status={snapshot({ state: "live", lastApplied: 42 })} label="the timeline" />,
    );
    expect(html).toContain("through sequence 42");
  });

  it("renders the reconciler's own detail when there is one", () => {
    const html = renderToStaticMarkup(
      <StreamStatus
        status={snapshot({ state: "degraded", detail: "The live tail has stopped; reload to start a new one." })}
        label="the timeline"
      />,
    );
    expect(html).toContain("The live tail has stopped");
  });

  it("counts replayed frames it dropped, and says nothing when it dropped none", () => {
    const none = renderToStaticMarkup(
      <StreamStatus status={snapshot({ state: "live" })} label="the timeline" />,
    );
    expect(none).not.toContain("dropped");

    const some = renderToStaticMarkup(
      <StreamStatus status={snapshot({ state: "live", droppedFrames: 3 })} label="the timeline" />,
    );
    expect(some).toContain("3 replayed frames dropped");

    const one = renderToStaticMarkup(
      <StreamStatus status={snapshot({ state: "live", droppedFrames: 1 })} label="the timeline" />,
    );
    expect(one).toContain("1 replayed frame dropped");
  });

  it("renders no ledger identity, no path and no credential", () => {
    // `databaseId` is a redacted digest and is still not shown: this component
    // has no reason to name the ledger, and a field that is never rendered
    // cannot be widened into one that is.
    const html = renderToStaticMarkup(
      <StreamStatus
        status={snapshot({ state: "live", databaseId: "f".repeat(64), lastApplied: 3 })}
        label="the timeline"
      />,
    );
    expect(html).not.toContain("f".repeat(64));
    expect(html).not.toContain("Bearer");
    expect(html).not.toContain("/Users/");
    expect(html).not.toContain("/api/v1");
  });
});

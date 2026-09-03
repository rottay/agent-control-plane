// @vitest-environment jsdom
/**
 * The hook's own drill (V2-B3b).
 *
 * Narrow on purpose. Reconciliation is proved against schema-real frames in
 * `test/api/stream`; what is left to prove here is only what React owns — that
 * a render observes the store rather than a copy of it, that a mount opens
 * exactly one connection, and that an unmount takes the listeners, the source
 * and the timer with it. Under jsdom, because an effect that never fires would
 * make every claim below vacuously true.
 */

import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  STREAM_CHANNEL_BY_EVENT_TYPE,
  StreamFrame,
  type TimelineItem,
} from "@acp/protocol";
import { act, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useEventStream } from "../../../src/hooks/use-event-stream/index.js";
import { cleanupMountedRoots, renderIntoDocument } from "../../live-dom/index.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const DATABASE_A = "1".repeat(64);
const DATABASE_B = "2".repeat(64);

function item(sequence: number): TimelineItem {
  return {
    sequence,
    eventId: "00000000-0000-4000-8000-" + String(sequence).padStart(12, "0"),
    taskId: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    transitionId: "t-" + String(sequence),
    type: "TASK_DISCOVERED",
    fromState: null,
    toState: "DISCOVERED",
    emittedBy: "claude/opus/coordinator/01",
    occurredAt: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.050Z",
    correlationId: null,
    causationId: null,
    previousSha256: SHA_A,
    eventSha256: SHA_B,
    payloadByteSize: 12,
    payloadKeys: ["reason"],
  };
}

/** Every frame here is serialized by the contract, never written by hand. */
function frameData(value: unknown): string {
  return JSON.stringify(StreamFrame.parse(value));
}

function helloFrame(databaseId: string, headSequence: number): string {
  return frameData({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    kind: "hello",
    database: { id: databaseId, label: "acp.db", pathRedacted: true },
    headSequence,
  });
}

function eventFrame(row: TimelineItem): string {
  return frameData({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    kind: "event",
    channel: STREAM_CHANNEL_BY_EVENT_TYPE[row.type],
    item: row,
  });
}

interface FakeSource {
  readonly url: string;
  readonly listeners: Map<string, ((event: Event) => void)[]>;
  closes: number;
  deliver(type: string, data: string): void;
  fire(type: string): void;
  listenerCount(): number;
}

const opened: FakeSource[] = [];

function installFakeEventSource(): void {
  class Fake {
    public readyState = 0;
    public readonly listeners = new Map<string, ((event: Event) => void)[]>();
    public closes = 0;

    public readonly url: string;

    public constructor(url: string) {
      this.url = url;
      opened.push(this as unknown as FakeSource);
    }

    public addEventListener(type: string, listener: (event: Event) => void): void {
      const existing = this.listeners.get(type) ?? [];
      existing.push(listener);
      this.listeners.set(type, existing);
    }

    public removeEventListener(type: string, listener: (event: Event) => void): void {
      const existing = this.listeners.get(type) ?? [];
      this.listeners.set(
        type,
        existing.filter((candidate) => candidate !== listener),
      );
    }

    public close(): void {
      this.closes += 1;
      this.readyState = 2;
    }

    public deliver(type: string, data: string): void {
      act(() => {
        for (const listener of this.listeners.get(type) ?? []) listener({ type, data } as unknown as Event);
      });
    }

    public fire(type: string): void {
      act(() => {
        for (const listener of this.listeners.get(type) ?? []) listener({ type } as unknown as Event);
      });
    }

    public listenerCount(): number {
      let total = 0;
      for (const listeners of this.listeners.values()) total += listeners.length;
      return total;
    }
  }
  vi.stubGlobal("EventSource", Fake);
}

function only(): FakeSource {
  const source = opened.at(-1);
  if (source === undefined) throw new Error("expected a source to have been opened");
  return source;
}

interface ProbeProps {
  readonly onChange?: (() => void) | undefined;
}

function Probe(props: ProbeProps): ReactElement {
  const stream = useEventStream({ onDatabaseChanged: props.onChange });
  return createElement(
    "p",
    { "data-state": stream.state, "data-applied": String(stream.lastApplied) },
    "rows " + String(stream.items.length),
  );
}

afterEach(() => {
  cleanupMountedRoots();
  vi.unstubAllGlobals();
  opened.length = 0;
});

describe("useEventStream", () => {
  it("renders a connecting state on a server render, where no effect ever runs", () => {
    // `renderToStaticMarkup` has no commit phase, so the hook must have a
    // server snapshot to answer with — a fresh object per call would be an
    // infinite loop rather than a first render.
    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toContain('data-state="connecting"');
    expect(opened).toHaveLength(0);
  });

  it("opens exactly one connection per mount, at the contract's route", () => {
    installFakeEventSource();
    renderIntoDocument(createElement(Probe));

    expect(opened).toHaveLength(1);
    expect(only().url).toBe("/api/v1/events/stream");
  });

  it("re-renders from the store, not from a copy of it", () => {
    installFakeEventSource();
    const mounted = renderIntoDocument(createElement(Probe));
    const source = only();

    source.fire("open");
    source.deliver("acp.hello", helloFrame(DATABASE_A, 4));
    source.deliver("acp.event", eventFrame(item(5)));

    const paragraph = mounted.container.querySelector("p");
    expect(paragraph?.getAttribute("data-state")).toBe("live");
    expect(paragraph?.getAttribute("data-applied")).toBe("5");
    expect(paragraph?.textContent).toBe("rows 1");
  });

  it("tells the view to refetch when the stream names a different ledger", () => {
    installFakeEventSource();
    let refetched = 0;
    renderIntoDocument(
      createElement(Probe, {
        onChange: () => {
          refetched += 1;
        },
      }),
    );
    const source = only();

    source.deliver("acp.hello", helloFrame(DATABASE_A, 0));
    source.deliver("acp.event", eventFrame(item(1)));
    expect(refetched).toBe(0);

    source.deliver("acp.hello", helloFrame(DATABASE_B, 9));
    expect(refetched).toBe(1);
  });

  it("closes the source and removes every listener on unmount", () => {
    installFakeEventSource();
    const mounted = renderIntoDocument(createElement(Probe));
    const source = only();
    expect(source.listenerCount()).toBeGreaterThan(0);

    mounted.unmount();

    expect(source.closes).toBe(1);
    expect(source.listenerCount()).toBe(0);
    // The negative that matters: a connection that outlived its view would keep
    // delivering into a store nothing renders.
    expect(() => {
      source.deliver("acp.hello", helloFrame(DATABASE_A, 1));
    }).not.toThrow();
    expect(opened).toHaveLength(1);
  });

  it("degrades visibly rather than throwing where the browser has no EventSource", () => {
    // jsdom is exactly that browser, which is why no stand-in is installed here.
    const mounted = renderIntoDocument(createElement(Probe));
    const paragraph = mounted.container.querySelector("p");
    expect(paragraph?.getAttribute("data-state")).toBe("degraded");
    expect(opened).toHaveLength(0);
  });
});

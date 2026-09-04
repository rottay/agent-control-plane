// @vitest-environment jsdom
/**
 * The harness's own drill (P8-9-2, C6).
 *
 * A harness that reports "no accessibility violations" is worthless until it
 * has been shown to report one. Every claim this file makes about the harness
 * is paired with the negative case: an inaccessible fixture axe must flag, a
 * guard that must throw, a key press a real listener must observe. The
 * standing failing-fixture law, applied to the tool before the tool is used as
 * evidence.
 */

import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  STREAM_CHANNEL_BY_EVENT_TYPE,
  StreamFrame,
  type TimelineItem,
} from "@acp/protocol";
import { act, useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setSessionBearerToken } from "../../src/api/client/index.js";
import { type Route } from "../../src/routing/hash-route/index.js";
import { EventsView } from "../../src/views/events-view/index.js";
import {
  AXE_EXCLUDED_RULES,
  AXE_TAGS,
  HARNESS_INJECTS_STYLESHEET,
  assertDomEnvironment,
  auditAccessibility,
  cleanupMountedRoots,
  countSelectorJoin,
  fakeFetch,
  pressKey,
  renderIntoDocument,
  selectorJoin,
  settle,
  type FakeFetchCall,
  type Mounted,
} from "./index.js";

afterEach(() => {
  cleanupMountedRoots();
});

describe("the docblock guard", () => {
  // Asserted on the function, not on importing this file: this file runs under
  // jsdom, so importing the harness here can only ever succeed. The guard is
  // what would run in a file that forgot the docblock.
  it("throws a named sentence when there is no document", () => {
    expect(() => {
      assertDomEnvironment(undefined);
    }).toThrowError(/no document/);
    expect(() => {
      assertDomEnvironment(undefined);
    }).toThrowError(/@vitest-environment jsdom/);
  });

  it("passes when a document is present, which is why this file runs at all", () => {
    expect(() => {
      assertDomEnvironment(document);
    }).not.toThrow();
    expect(typeof document).toBe("object");
  });
});

describe("rendering into a real document", () => {
  it("attaches the tree to the body, where focus and axe can see it", () => {
    const mounted = renderIntoDocument(<button type="button">Press</button>);

    expect(mounted.container.isConnected).toBe(true);
    expect(document.body.contains(mounted.container)).toBe(true);
    expect(mounted.container.querySelector("button")?.textContent).toBe("Press");
  });

  it("runs effects, which static rendering never does", () => {
    // The load-bearing difference from `renderToStaticMarkup`: an effect that
    // never fires would make every mount-behaviour assertion in the battery
    // vacuously true.
    function Effectful(): React.JSX.Element {
      const [ran, setRan] = useState(false);
      useEffect(() => {
        setRan(true);
      }, []);
      return <p>{ran ? "effect ran" : "effect did not run"}</p>;
    }

    const mounted = renderIntoDocument(<Effectful />);
    expect(mounted.container.textContent).toBe("effect ran");
  });

  it("unmounts idempotently and leaves nothing in the body", () => {
    const mounted = renderIntoDocument(<p>gone</p>);
    const { container } = mounted;

    mounted.unmount();
    expect(container.isConnected).toBe(false);
    // A second unmount is a no-op, so an explicit unmount and the afterEach
    // sweep compose without error.
    expect(() => {
      mounted.unmount();
    }).not.toThrow();
  });
});

describe("the axe runner discriminates", () => {
  // The whole point of the drill: an inaccessible fixture the runner MUST
  // flag. If this passes clean, the harness proves nothing and the battery
  // built on it would be theatre.
  it("flags a deliberately inaccessible fixture", async () => {
    const mounted = renderIntoDocument(
      <div>
        {/* An image with no alternative text: a WCAG 1.1.1 failure, structural,
            needing no layout or stylesheet to detect. */}
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
      </div>,
    );

    const audit = await auditAccessibility(mounted.container);

    expect(audit.violationIds).toContain("image-alt");
    const violation = audit.violations.find((candidate) => candidate.id === "image-alt");
    expect(violation?.nodes.length).toBeGreaterThan(0);
  });

  it("flags a second, different failure class — a control with no accessible name", async () => {
    const mounted = renderIntoDocument(
      <div>
        <input type="text" />
      </div>,
    );

    const audit = await auditAccessibility(mounted.container);
    expect(audit.violationIds.length).toBeGreaterThan(0);
  });

  it("passes an accessible fixture clean under the pinned ruleset", async () => {
    const mounted = renderIntoDocument(
      <main>
        <h1>Accounts</h1>
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" />
        <label htmlFor="operator-token">Operator token</label>
        <input id="operator-token" type="password" />
        <button type="button">Arm</button>
      </main>,
    );

    const audit = await auditAccessibility(mounted.container);
    expect(audit.violationIds).toEqual([]);
  });

  it("pins the ruleset and names every exclusion with its reason", () => {
    expect([...AXE_TAGS]).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
    // Excluded rules are named, not merely absent, and each carries why jsdom
    // cannot measure it. `color-contrast` is the floor of that list.
    expect(Object.keys(AXE_EXCLUDED_RULES)).toContain("color-contrast");
    for (const [rule, reason] of Object.entries(AXE_EXCLUDED_RULES)) {
      expect(rule.length).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(20);
    }
    // Recorded decision, asserted so it cannot drift silently: no stylesheet
    // injection, because it would look like contrast evidence without being any.
    expect(HARNESS_INJECTS_STYLESHEET).toBe(false);
  });

  it("does not report the excluded rules even on a fixture that would trip them", async () => {
    const mounted = renderIntoDocument(
      <p style={{ color: "#eeeeee", backgroundColor: "#ffffff" }}>barely visible</p>,
    );

    const audit = await auditAccessibility(mounted.container);
    expect(audit.violationIds).not.toContain("color-contrast");
  });
});

describe("the keyboard dispatcher is observed by a real listener", () => {
  it("delivers the key to a listener above the target, bubbling", () => {
    // Observed by an actual React handler rather than a spy on the harness:
    // a dispatcher that satisfied only itself would be circular.
    function Listening(): React.JSX.Element {
      const [seen, setSeen] = useState<string[]>([]);
      return (
        <div
          onKeyDown={(event) => {
            setSeen((previous) => [...previous, event.key]);
          }}
        >
          <button type="button">inner</button>
          <output>{seen.join(",")}</output>
        </div>
      );
    }

    const mounted = renderIntoDocument(<Listening />);
    const inner = mounted.container.querySelector("button");
    if (inner === null) throw new Error("expected the inner button");

    pressKey(inner, "Escape");
    pressKey(inner, "Enter");

    // Dispatched on the button, handled on the parent: the event bubbled.
    expect(mounted.container.querySelector("output")?.textContent).toBe("Escape,Enter");
  });

  it("carries modifiers, so shift-Tab is distinguishable from Tab", () => {
    function Listening(): React.JSX.Element {
      const [seen, setSeen] = useState<string[]>([]);
      return (
        <div
          onKeyDown={(event) => {
            setSeen((previous) => [...previous, event.key + ":" + String(event.shiftKey)]);
          }}
        >
          <button type="button">inner</button>
          <output>{seen.join(",")}</output>
        </div>
      );
    }

    const mounted = renderIntoDocument(<Listening />);
    const inner = mounted.container.querySelector("button");
    if (inner === null) throw new Error("expected the inner button");

    pressKey(inner, "Tab");
    pressKey(inner, "Tab", { shiftKey: true });

    expect(mounted.container.querySelector("output")?.textContent).toBe("Tab:false,Tab:true");
  });
});

describe("the browser APIs the battery will lean on (N4)", () => {
  // Verified once, here, rather than discovered per suite: these are the jsdom
  // capabilities the dialog surfaces depend on, and knowing now which are real
  // keeps a later suite from asserting something jsdom fakes.
  it("moves focus and reports the active element", () => {
    const mounted = renderIntoDocument(
      <div>
        <button type="button" id="first">
          first
        </button>
        <button type="button" id="second">
          second
        </button>
      </div>,
    );

    const second = mounted.container.querySelector<HTMLButtonElement>("#second");
    if (second === null) throw new Error("expected the second button");

    second.focus();
    expect(document.activeElement).toBe(second);
  });

  it("returns focus to where a caller saved it, which is how dialogs restore", () => {
    function Restoring(): React.JSX.Element {
      const opener = useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button type="button" ref={opener} id="opener">
            open
          </button>
          <button
            type="button"
            id="closer"
            onClick={() => {
              opener.current?.focus();
            }}
          >
            close
          </button>
        </div>
      );
    }

    const mounted = renderIntoDocument(<Restoring />);
    const closer = mounted.container.querySelector<HTMLButtonElement>("#closer");
    const opener = mounted.container.querySelector<HTMLButtonElement>("#opener");
    if (closer === null || opener === null) throw new Error("expected both buttons");

    closer.focus();
    expect(document.activeElement).toBe(closer);
    closer.click();
    expect(document.activeElement).toBe(opener);
  });

  it("supports the inert-adjacent attributes a focus scope sets", () => {
    const mounted = renderIntoDocument(<div aria-hidden="true">behind the dialog</div>);
    const hidden = mounted.container.querySelector("div[aria-hidden]");
    expect(hidden?.getAttribute("aria-hidden")).toBe("true");
  });

  it("lets a scroll lock read and write body style, which is all Radix needs", () => {
    // Not a claim that jsdom scrolls — it does not. The claim is narrower and
    // true: the property a scroll lock sets and restores is readable, so a
    // later suite can assert the lock was released.
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    expect(document.body.style.overflow).toBe("hidden");
    document.body.style.overflow = before;
    expect(document.body.style.overflow).toBe(before);
  });
});

describe("the selector-join (C1)", () => {
  it("finds the hooks a media query selects, and counts them", () => {
    // The shape the battery consumes: `components.css` hides
    // `[data-priority="tertiary"]` under 48rem and `"secondary"` under 34rem.
    // jsdom cannot resize, but it can prove the attributes the rules select
    // are still rendered — a rename would silently disable the rule otherwise.
    const mounted = renderIntoDocument(
      <table className="data-table">
        <tbody>
          <tr>
            <td data-priority="primary">always</td>
            <td data-priority="secondary">narrow drops this</td>
            <td data-priority="tertiary">narrower drops this</td>
          </tr>
        </tbody>
      </table>,
    );

    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="tertiary"]')).toBe(1);
    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="secondary"]')).toBe(1);
    expect(selectorJoin(mounted.container, "[data-priority]").length).toBe(3);
  });

  it("returns zero when the hook is absent, which is the failure it exists to catch", () => {
    const mounted = renderIntoDocument(
      <table className="data-table">
        <tbody>
          <tr>
            <td>renamed away</td>
          </tr>
        </tbody>
      </table>,
    );

    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="tertiary"]')).toBe(0);
  });
});

/**
 * The live event stream, in a mounted view (V2-B3b).
 *
 * The battery above proves the harness; this proves the surface. Everything
 * here is asserted on the real `EventsView`, mounted, with the real reconciler
 * behind it and frames built by the real `StreamFrame` schema — so what is
 * measured is what a browser would put on the screen, not what a component
 * returns in isolation.
 *
 * **The stated limit, unchanged from the packet's own account.** No test here
 * drives a real browser `EventSource` against the real route. The server's
 * framing is proven end to end in B3a's gateway suite over a live socket; the
 * client's reconciliation is proven against schema-real frames; the join
 * between them is owed, alongside the standing pixel-level evidence gap. jsdom
 * does not implement `EventSource` at all, which is why a stand-in is
 * installed below rather than the real thing being exercised.
 */

const STREAM_SHA_A = "a".repeat(64);
const STREAM_SHA_B = "b".repeat(64);
const STREAM_DATABASE = "1".repeat(64);
const STREAM_TASK = "11111111-1111-4111-8111-111111111111";

function streamItem(sequence: number): TimelineItem {
  return {
    sequence,
    eventId: "00000000-0000-4000-8000-" + String(sequence).padStart(12, "0"),
    taskId: STREAM_TASK,
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
    previousSha256: STREAM_SHA_A,
    eventSha256: STREAM_SHA_B,
    payloadByteSize: 12,
    payloadKeys: ["reason"],
  };
}

/** Serialized by the contract. Nothing in this file hand-writes a frame. */
function streamFrameData(value: unknown): string {
  return JSON.stringify(StreamFrame.parse(value));
}

/**
 * `resumedFrom` is required and nullable since V2-B3c, so this fixture states
 * it. `null` is a live open, which is what these frames are.
 */
function streamHello(headSequence: number, databaseId = STREAM_DATABASE): string {
  return streamFrameData({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    kind: "hello",
    database: { id: databaseId, label: "acp.db", pathRedacted: true },
    headSequence,
    resumedFrom: null,
  });
}

function streamEvent(row: TimelineItem): string {
  return streamFrameData({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    kind: "event",
    channel: STREAM_CHANNEL_BY_EVENT_TYPE[row.type],
    item: row,
  });
}

function streamResync(): string {
  return streamFrameData({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    kind: "resync",
    reason: "ANCHOR_AHEAD_OF_HEAD",
  });
}

interface MountedSource {
  readyState: number;
  closes: number;
  readonly listeners: Map<string, ((event: Event) => void)[]>;
  deliver(type: string, data: string): void;
  fire(type: string): void;
  listenerCount(): number;
}

const mountedSources: MountedSource[] = [];

function installStreamSource(): void {
  class Fake {
    public readyState = 1;
    public closes = 0;
    public readonly listeners = new Map<string, ((event: Event) => void)[]>();

    public readonly url: string;

    public constructor(url: string) {
      this.url = url;
      mountedSources.push(this as unknown as MountedSource);
    }

    public addEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    public removeEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
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

function source(): MountedSource {
  const latest = mountedSources.at(-1);
  if (latest === undefined) throw new Error("expected the view to have opened a stream");
  return latest;
}

/** The paged read the view makes on mount, plus whatever a recovery asks for. */
function eventsResponder(rows: readonly TimelineItem[]) {
  return (call: FakeFetchCall): { status: number; body: unknown } => {
    const cursor = Number(new URL(call.url, "http://localhost").searchParams.get("cursor") ?? "0");
    const items = rows.filter((row) => row.sequence > cursor);
    return {
      status: 200,
      body: {
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        items,
        page: { nextCursor: null, hasMore: false, limit: 200, returned: items.length },
      },
    };
  };
}

function eventsRoute(): Route {
  return { view: "events", taskId: null, workerIdentity: null, initiativeId: null, query: {}, raw: "" };
}

async function mountEventsView(rows: readonly TimelineItem[] = []): Promise<Mounted> {
  vi.stubGlobal("fetch", fakeFetch(eventsResponder(rows)).fetch);
  installStreamSource();
  const mounted = renderIntoDocument(
    <EventsView
      route={eventsRoute()}
      navigate={() => {
        // navigation is not exercised by the stream battery
      }}
    />,
  );
  await settle();
  return mounted;
}

function statusText(container: HTMLElement): string {
  return container.querySelector("[data-stream-state]")?.textContent ?? "";
}

/** The sequence column of the live section only, in rendered order. */
function liveSequences(container: HTMLElement): readonly string[] {
  const live = container.querySelector(".stream-live");
  if (live === null) return [];
  // The sequence is the first cell of every body row — `TimelineList` declares
  // it first and `DataTable` renders columns in declaration order.
  return [...live.querySelectorAll("tbody tr")].map((row) => row.querySelector("td")?.textContent ?? "");
}

function statusState(container: HTMLElement): string {
  return container.querySelector("[data-stream-state]")?.getAttribute("data-stream-state") ?? "";
}

afterEach(() => {
  mountedSources.length = 0;
  setSessionBearerToken(null);
});

describe("the live stream renders every state it can be in", () => {
  it("announces connecting, then live, and applies rows into the visible timeline", async () => {
    const mounted = await mountEventsView();
    expect(statusState(mounted.container)).toBe("connecting");
    expect(statusText(mounted.container)).toContain("Connecting");

    source().fire("open");
    source().deliver("acp.hello", streamHello(10));
    expect(statusState(mounted.container)).toBe("live");

    source().deliver("acp.event", streamEvent(streamItem(11)));
    source().deliver("acp.event", streamEvent(streamItem(12)));

    expect(statusState(mounted.container)).toBe("live");
    expect(statusText(mounted.container)).toContain("through sequence 12");
    expect(mounted.container.textContent).toContain("Live since this page opened");
    expect(liveSequences(mounted.container)).toEqual(["11", "12"]);
    expect(mounted.container.querySelector(".stream-live")?.textContent).toContain("Task discovered");
  });

  it("shows recovering while a gap is open, then lands the held row in order", async () => {
    const mounted = await mountEventsView([streamItem(11), streamItem(12), streamItem(13)]);
    source().fire("open");
    source().deliver("acp.hello", streamHello(10));
    source().deliver("acp.event", streamEvent(streamItem(13)));

    // Visible, not silent: the operator is told the view is behind before the
    // recovery finishes, and the gapped row is not on screen yet.
    expect(statusState(mounted.container)).toBe("recovering");
    expect(statusText(mounted.container)).toContain("gap");

    await settle();
    await settle();

    expect(statusState(mounted.container)).toBe("live");
    // Read from the live section alone, not from the whole page: the paged
    // table below it holds the same rows, and an assertion that could not tell
    // them apart would pass whether or not the recovery worked.
    expect(liveSequences(mounted.container)).toEqual(["11", "12", "13"]);
  });

  it("shows disconnected while the browser retries, without clearing what it already applied", async () => {
    const mounted = await mountEventsView();
    source().fire("open");
    source().deliver("acp.hello", streamHello(0));
    source().deliver("acp.event", streamEvent(streamItem(1)));

    source().readyState = 0;
    source().fire("error");

    expect(statusState(mounted.container)).toBe("disconnected");
    expect(statusText(mounted.container)).toContain("retrying");
    // A truthful reading already on screen is not thrown away because the
    // transport hiccuped — the same rule the paged resource follows.
    expect(mounted.container.textContent).toContain("Live since this page opened");
  });

  it("shows degraded and discards the live rows when the server refuses the anchor", async () => {
    const mounted = await mountEventsView();
    source().fire("open");
    source().deliver("acp.hello", streamHello(0));
    source().deliver("acp.event", streamEvent(streamItem(1)));
    expect(mounted.container.textContent).toContain("Live since this page opened");

    source().deliver("acp.resync", streamResync());

    expect(statusState(mounted.container)).toBe("degraded");
    expect(statusText(mounted.container)).toContain("ANCHOR_AHEAD_OF_HEAD");
    expect(mounted.container.textContent).not.toContain("Live since this page opened");
    // Not a reconnect loop: the connection closed itself.
    expect(source().closes).toBe(1);
  });

  it("shows degraded where the browser has no EventSource at all", async () => {
    // No stand-in installed: jsdom is exactly that browser.
    vi.stubGlobal("fetch", fakeFetch(eventsResponder([])).fetch);
    const mounted = renderIntoDocument(
      <EventsView
        route={eventsRoute()}
        navigate={() => {
          // not exercised
        }}
      />,
    );
    await settle();

    expect(statusState(mounted.container)).toBe("degraded");
    expect(statusText(mounted.container)).toContain("no server-sent event support");
  });
});

/**
 * A fetch stand-in that can hold the recovery's page open (postaudit blocker 1).
 *
 * The view's own mount read carries no `cursor`; a recovery's does. Answering
 * the first immediately and holding the second is what lets a drill stage "the
 * stream died while the gap was being filled" on a real mounted view.
 */
interface EventsGate {
  readonly fetch: typeof globalThis.fetch;
  pending(): number;
  release(rows: readonly TimelineItem[]): void;
}

function deferredEventsFetch(): EventsGate {
  const waiting: ((rows: readonly TimelineItem[]) => void)[] = [];
  const json = (items: readonly TimelineItem[]): Response =>
    new Response(
      JSON.stringify({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        items,
        page: { nextCursor: null, hasMore: false, limit: 200, returned: items.length },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const impl = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("cursor=")) return Promise.resolve(json([]));
    return new Promise<Response>((resolve) => {
      waiting.push((rows) => {
        resolve(json(rows));
      });
    });
  }) as typeof globalThis.fetch;

  return {
    fetch: impl,
    pending: () => waiting.length,
    release(rows) {
      const resolve = waiting.shift();
      if (resolve === undefined) throw new Error("no backfill request is outstanding");
      resolve(rows);
    },
  };
}

describe("a recovery that outlives its connection (postaudit blocker 1)", () => {
  it("never renders Live over a source that died while the gap was being filled", async () => {
    const gate = deferredEventsFetch();
    vi.stubGlobal("fetch", gate.fetch);
    installStreamSource();
    const mounted = renderIntoDocument(
      <EventsView
        route={eventsRoute()}
        navigate={() => {
          // not exercised
        }}
      />,
    );
    await settle();

    source().fire("open");
    source().deliver("acp.hello", streamHello(10));
    source().deliver("acp.event", streamEvent(streamItem(13)));
    expect(statusState(mounted.container)).toBe("recovering");
    expect(gate.pending()).toBe(1);

    // The stream dies fatally — a server restart, a proxy reaping a long-lived
    // connection — while the page is in flight. `readyState` is CLOSED, so the
    // browser will not retry and no listener will fire again.
    source().readyState = 2;
    source().fire("error");
    expect(statusState(mounted.container)).toBe("disconnected");

    // The events route is unaffected and closes the gap.
    await act(async () => {
      gate.release([streamItem(11), streamItem(12)]);
      await Promise.resolve();
    });
    await settle();
    await settle();

    // The rows are true and are on screen, in order.
    expect(liveSequences(mounted.container)).toEqual(["11", "12", "13"]);
    // And the banner still tells the truth about the connection. This is the
    // exact screen the blocker described: before the fix it read
    // `data-stream-state="live"` over a CLOSED source with no armed timer left
    // to correct it, and nothing but a reload would ever have moved it.
    expect(statusState(mounted.container)).toBe("disconnected");
    expect(statusText(mounted.container)).toContain("Disconnected");
    expect(statusText(mounted.container)).not.toContain("Live");
  });
});

describe("the live stream's privacy boundary, measured on the DOM", () => {
  it("puts no bearer token, absolute path or ledger digest on the screen", async () => {
    setSessionBearerToken("s3cret-write-token");
    const mounted = await mountEventsView();
    source().fire("open");
    source().deliver("acp.hello", streamHello(0));
    source().deliver("acp.event", streamEvent(streamItem(1)));

    const rendered = mounted.container.innerHTML;
    expect(rendered).not.toContain("s3cret-write-token");
    expect(rendered).not.toContain("Bearer");
    expect(rendered).not.toContain("/Users/");
    expect(rendered).not.toContain(STREAM_DATABASE);
  });

  it("refuses a frame that tried to carry a payload, so no value can reach the DOM", async () => {
    // The negative that makes the claim non-vacuous. `TimelineItem` is strict,
    // so a server that widened the frame with an actual payload cannot get it
    // past the parser — and the scope says so rather than rendering what it
    // could understand and discarding what it could not.
    const mounted = await mountEventsView();
    source().fire("open");
    source().deliver("acp.hello", streamHello(0));
    source().deliver(
      "acp.event",
      JSON.stringify({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        kind: "event",
        channel: "lifecycle",
        item: { ...streamItem(1), payload: { secret: "PAYLOAD-VALUE-THAT-MUST-NOT-RENDER" } },
      }),
    );

    expect(mounted.container.innerHTML).not.toContain("PAYLOAD-VALUE-THAT-MUST-NOT-RENDER");
    expect(statusState(mounted.container)).toBe("degraded");
    expect(statusText(mounted.container)).toContain("stream contract");
  });

  it("refuses a hello whose database label was widened into a path", async () => {
    const mounted = await mountEventsView();
    source().fire("open");
    source().deliver(
      "acp.hello",
      JSON.stringify({
        apiContractVersion: API_CONTRACT_VERSION,
        ledgerContractVersion: LEDGER_CONTRACT_VERSION,
        kind: "hello",
        database: { id: STREAM_DATABASE, label: "/Users/someone/acp.db", pathRedacted: true },
        headSequence: 0,
        // Stated even though this frame is deliberately hand-written and
        // invalid: without it the client would refuse for the WRONG reason — a
        // missing required key rather than the widened label — and this test
        // would pass while measuring nothing.
        resumedFrom: null,
      }),
    );

    expect(mounted.container.innerHTML).not.toContain("/Users/someone");
    expect(statusState(mounted.container)).toBe("degraded");
  });
});

describe("the live stream cleans up after itself", () => {
  it("closes the source and drops every listener when the view unmounts", async () => {
    const mounted = await mountEventsView();
    source().fire("open");
    expect(source().listenerCount()).toBeGreaterThan(0);

    mounted.unmount();

    expect(source().closes).toBe(1);
    expect(source().listenerCount()).toBe(0);
    expect(mountedSources).toHaveLength(1);
  });
});

import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  STREAM_CHANNEL_BY_EVENT_TYPE,
  StreamFrame,
  type EventPageResponse,
  type TimelineItem,
} from "@acp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ApiResult } from "../../../src/api/client/index.js";
import {
  IDLE_STREAM_SNAPSHOT,
  STREAM_FRAME_EVENTS,
  STREAM_LIVENESS_TIMEOUT_MS,
  STREAM_MAX_RETAINED_ITEMS,
  createStreamStore,
  eventStreamConstructor,
  isEventStreamSupported,
  openEventStream,
  parseStreamFrame,
  type StreamStore,
} from "../../../src/api/stream/index.js";

/**
 * The reconciliation drills (V2-B3b).
 *
 * **Every frame in this file is built by the real `StreamFrame` schema.** Not
 * one is hand-written JSON: `frameData` parses the object through the exported
 * contract and serializes what comes back, so a drill cannot pass against a
 * shape the server could never write, and a contract change that this client
 * would mishandle fails here rather than in a browser. That is the difference
 * between proving the reconciler and proving a fixture.
 *
 * The negatives are the point of the file. A duplicate must change nothing; a
 * gap must not be applied optimistically; a bounded backfill must give up
 * visibly rather than loop; a resync must not restart; a different ledger must
 * clear the cache; and an absent `EventSource` must produce a rendered state
 * rather than a thrown module.
 */

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";
const DATABASE_A = "1".repeat(64);
const DATABASE_B = "2".repeat(64);

function item(sequence: number, overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    sequence,
    eventId: "00000000-0000-4000-8000-" + String(sequence).padStart(12, "0"),
    taskId: TASK_A,
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
    ...overrides,
  };
}

/** Serialize through the contract. The one frame factory this file has. */
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

function resyncFrame(): string {
  return frameData({
    apiContractVersion: API_CONTRACT_VERSION,
    ledgerContractVersion: LEDGER_CONTRACT_VERSION,
    kind: "resync",
    reason: "ANCHOR_AHEAD_OF_HEAD",
  });
}

function page(rows: readonly TimelineItem[], hasMore = false): ApiResult<EventPageResponse> {
  const last = rows.at(-1);
  return {
    kind: "ok",
    data: {
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      items: [...rows],
      page: {
        nextCursor: hasMore && last !== undefined ? String(last.sequence) : null,
        hasMore,
        limit: 200,
        returned: rows.length,
      },
    },
  };
}

interface Recorder {
  readonly store: StreamStore;
  readonly cursors: number[];
}

/** A store whose gap-filling door is a recorded fake, not a network. */
function storeWith(
  responder: (cursor: number) => ApiResult<EventPageResponse>,
  options: { readonly onDatabaseChanged?: () => void; readonly maxBackfillPages?: number } = {},
): Recorder {
  const cursors: number[] = [];
  const store = createStreamStore({
    loadPage: (cursor) => {
      cursors.push(cursor);
      return Promise.resolve(responder(cursor));
    },
    onDatabaseChanged: options.onDatabaseChanged,
    maxBackfillPages: options.maxBackfillPages,
  });
  return { store, cursors };
}

interface Deferred {
  readonly store: StreamStore;
  readonly cursors: number[];
  /** How many page requests are outstanding. */
  pending(): number;
  /** Answer the oldest outstanding page request. */
  release(result: ApiResult<EventPageResponse>): void;
}

/**
 * A store whose gap-filling door can be held open.
 *
 * The blocker-1 and blocker-2 races both live in the window between asking the
 * `events` route for a page and receiving it, so a drill that cannot hold that
 * window open cannot reach them at all. This is what makes "the transport died
 * while a page was in flight" an event a test can actually stage.
 */
function deferredStore(
  options: { readonly onDatabaseChanged?: () => void } = {},
): Deferred {
  const cursors: number[] = [];
  const waiting: ((result: ApiResult<EventPageResponse>) => void)[] = [];
  const store = createStreamStore({
    loadPage: (cursor) => {
      cursors.push(cursor);
      return new Promise<ApiResult<EventPageResponse>>((resolve) => {
        waiting.push(resolve);
      });
    },
    onDatabaseChanged: options.onDatabaseChanged,
  });
  return {
    store,
    cursors,
    pending: () => waiting.length,
    release(result) {
      const resolve = waiting.shift();
      if (resolve === undefined) throw new Error("no page request is outstanding");
      resolve(result);
    },
  };
}

/** Let the backfill's promise chain run to completion. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    await Promise.resolve();
  }
}

function sequences(store: StreamStore): readonly number[] {
  return store.getSnapshot().items.map((row) => row.sequence);
}

// ---------------------------------------------------------------------------

describe("parseStreamFrame", () => {
  it("accepts a frame the contract produced", () => {
    const parsed = parseStreamFrame(helloFrame(DATABASE_A, 7));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frame.kind).toBe("hello");
    }
  });

  it("refuses ad-hoc JSON that merely looks like a frame", () => {
    // The negative that makes requirement 2 non-vacuous: a body with the right
    // discriminator and nothing else must not become a rendered event.
    const parsed = parseStreamFrame(JSON.stringify({ kind: "event", item: { sequence: 1 } }));
    expect(parsed.ok).toBe(false);
  });

  it("refuses a body that is not JSON at all", () => {
    expect(parseStreamFrame(": heartbeat").ok).toBe(false);
    expect(parseStreamFrame("").ok).toBe(false);
  });

  it("refuses a frame carrying a credential-shaped payload key", () => {
    // The contract's own guards run on the way in, not only on the way out.
    const smuggled = JSON.stringify({
      apiContractVersion: API_CONTRACT_VERSION,
      ledgerContractVersion: LEDGER_CONTRACT_VERSION,
      kind: "event",
      channel: "lifecycle",
      item: { ...item(1), payloadKeys: ["apiKey"] },
    });
    expect(parseStreamFrame(smuggled).ok).toBe(false);
  });
});

describe("the anchor", () => {
  it("takes its baseline from hello and applies the next sequence only", () => {
    const { store } = storeWith(() => page([]));
    store.acceptFrame(helloFrame(DATABASE_A, 10));
    expect(store.getSnapshot().lastApplied).toBe(10);
    expect(store.getSnapshot().databaseId).toBe(DATABASE_A);
    expect(store.getSnapshot().items).toHaveLength(0);

    store.acceptFrame(eventFrame(item(11)));
    expect(sequences(store)).toEqual([11]);
    expect(store.getSnapshot().state).toBe("live");
  });

  it("refuses to anchor a cache to a ledger that never named itself", () => {
    // Identity before data: an event frame with no hello means this client
    // cannot know which ledger the rows belong to, so it holds none of them.
    const { store } = storeWith(() => page([]));
    store.acceptFrame(eventFrame(item(1)));
    const snapshot = store.getSnapshot();
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.halted).toBe(true);
  });
});

describe("the duplicate arm", () => {
  it("drops a replayed frame and changes nothing else", () => {
    const { store, cursors } = storeWith(() => page([]));
    store.acceptFrame(helloFrame(DATABASE_A, 4));
    store.acceptFrame(eventFrame(item(5)));
    const applied = store.getSnapshot();

    store.acceptFrame(eventFrame(item(5)));
    store.acceptFrame(eventFrame(item(3)));
    store.acceptFrame(eventFrame(item(4)));

    const after = store.getSnapshot();
    expect(after.items).toEqual(applied.items);
    expect(after.lastApplied).toBe(5);
    expect(after.droppedFrames).toBe(3);
    expect(after.state).toBe("live");
    // The duplicate arm must not reach for the gap-filling authority.
    expect(cursors).toEqual([]);
  });

  it("survives a reconnect that replays the tail without duplicating a row", () => {
    // What a native reconnect looks like from here: the browser resends its
    // last id, the server replays after it, and an overlap — if the server ever
    // replayed inclusively — lands on the drop arm rather than in the list.
    const { store } = storeWith(() => page([]));
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    for (const sequence of [1, 2, 3]) store.acceptFrame(eventFrame(item(sequence)));
    for (const sequence of [2, 3, 4, 5]) store.acceptFrame(eventFrame(item(sequence)));

    expect(sequences(store)).toEqual([1, 2, 3, 4, 5]);
    expect(store.getSnapshot().droppedFrames).toBe(2);
  });
});

describe("the gap arm", () => {
  it("holds a gapped frame, recovers from the events route, then lands it in order", async () => {
    const { store, cursors } = storeWith((cursor) => page([item(cursor + 1), item(cursor + 2)]));
    store.acceptFrame(helloFrame(DATABASE_A, 10));
    store.acceptFrame(eventFrame(item(13)));

    // Held, not applied: the optimistic apply this packet forbids would have
    // put 13 in the list with 11 and 12 missing behind it.
    const gapped = store.getSnapshot();
    expect(gapped.items).toHaveLength(0);
    expect(gapped.heldSequences).toEqual([13]);
    expect(gapped.state).toBe("recovering");

    await settle();

    expect(cursors).toEqual([10]);
    expect(sequences(store)).toEqual([11, 12, 13]);
    expect(store.getSnapshot().heldSequences).toEqual([]);
    expect(store.getSnapshot().state).toBe("live");
    expect(store.getSnapshot().backfillPages).toBe(1);
  });

  it("pages the events route more than once when one page cannot close the gap", async () => {
    const { store, cursors } = storeWith((cursor) => page([item(cursor + 1)], true));
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    store.acceptFrame(eventFrame(item(4)));
    await settle();

    expect(cursors).toEqual([0, 1, 2]);
    expect(sequences(store)).toEqual([1, 2, 3, 4]);
    expect(store.getSnapshot().state).toBe("live");
  });

  it("gives up visibly when the gap outlasts the page budget, and does not loop", async () => {
    const { store, cursors } = storeWith((cursor) => page([item(cursor + 1)], true), {
      maxBackfillPages: 3,
    });
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    store.acceptFrame(eventFrame(item(500)));
    await settle();

    expect(cursors).toEqual([0, 1, 2]);
    const snapshot = store.getSnapshot();
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.halted).toBe(true);
    expect(snapshot.detail).toContain("did not close within 3 pages");
    // What the recovery did manage to fill stays: those rows arrived in order
    // and are true. What never lands is the gapped frame — 500 is not in the
    // list, and the list is contiguous rather than a tail with a hole in it.
    expect(sequences(store)).toEqual([1, 2, 3]);
    expect(snapshot.heldSequences).toEqual([]);
  });

  it("stops when the events route cannot see a row the stream reported", async () => {
    const { store, cursors } = storeWith(() => page([]));
    store.acceptFrame(helloFrame(DATABASE_A, 5));
    store.acceptFrame(eventFrame(item(9)));
    await settle();

    expect(cursors).toEqual([5]);
    expect(store.getSnapshot().state).toBe("degraded");
    expect(store.getSnapshot().detail).toContain("returned no row after sequence 5");
  });

  it("stops when the events route itself fails, naming the classified outcome", async () => {
    const { store } = storeWith(() => ({
      kind: "api-error",
      status: 503,
      code: "LEDGER_UNAVAILABLE",
      message: "the ledger could not be opened",
      detail: null,
    }));
    store.acceptFrame(helloFrame(DATABASE_A, 5));
    store.acceptFrame(eventFrame(item(9)));
    await settle();

    const snapshot = store.getSnapshot();
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.detail).toContain("LEDGER_UNAVAILABLE");
    expect(snapshot.items).toHaveLength(0);
  });

  it("fills the rows a reconnection without an anchor skipped past", async () => {
    // The browser had no id to send — this scope had only ever seen a hello —
    // so the server said hello again from a head that had moved.
    const { store, cursors } = storeWith((cursor) => page([item(cursor + 1), item(cursor + 2)]));
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    store.acceptFrame(helloFrame(DATABASE_A, 2));
    await settle();

    expect(cursors).toEqual([0]);
    expect(sequences(store)).toEqual([1, 2]);
    expect(store.getSnapshot().state).toBe("live");
  });
});

describe("the recovery is transport-aware (postaudit blocker 1)", () => {
  /**
   * The hole this closes: filling a gap is evidence that the `events` route
   * answered, and no evidence at all about the stream. The recovery tail used
   * to assign `live` unconditionally, so a source that died while a page was
   * in flight left the banner reading "Live" over a closed connection with no
   * armed timer to correct it — a permanent, silent, stale screen, which is the
   * one outcome this packet exists to make impossible.
   */
  it("keeps disconnected when the source dies fatally mid-backfill", async () => {
    const deferred = deferredStore();
    deferred.store.acceptFrame(helloFrame(DATABASE_A, 10));
    deferred.store.acceptFrame(eventFrame(item(13)));
    expect(deferred.store.getSnapshot().state).toBe("recovering");
    expect(deferred.pending()).toBe(1);

    // The stream route dies under a server restart while the page is in flight.
    deferred.store.noteDisconnected(false);
    expect(deferred.store.getSnapshot().state).toBe("disconnected");
    expect(deferred.store.getSnapshot().connected).toBe(false);

    // The REST route is unaffected and closes the gap.
    deferred.release(page([item(11), item(12)]));
    await settle();

    // The rows are true and are applied, in order.
    expect(sequences(deferred.store)).toEqual([11, 12, 13]);
    expect(deferred.store.getSnapshot().heldSequences).toEqual([]);
    // But the banner may not claim a stream this scope has no evidence for.
    expect(deferred.store.getSnapshot().state).toBe("disconnected");
    expect(deferred.store.getSnapshot().connected).toBe(false);
    expect(deferred.store.getSnapshot().detail).toContain("not being retried");
  });

  it("keeps disconnected while the browser's own retry is pending mid-backfill", async () => {
    // The commoner and correlated case: the same hiccup that drops the
    // connection is what opened the gap being filled.
    const deferred = deferredStore();
    deferred.store.acceptFrame(helloFrame(DATABASE_A, 10));
    deferred.store.acceptFrame(eventFrame(item(13)));
    deferred.store.noteDisconnected(true);

    deferred.release(page([item(11), item(12)]));
    await settle();

    expect(sequences(deferred.store)).toEqual([11, 12, 13]);
    expect(deferred.store.getSnapshot().state).toBe("disconnected");
    expect(deferred.store.getSnapshot().detail).toContain("retrying");
  });

  it("reaches live on the identical walk when the transport does NOT drop", async () => {
    // The positive control, without which the two drills above would pass for
    // the wrong reason — a scope that never reaches `live` at all would satisfy
    // them. Same frames, same page, no disconnect.
    const deferred = deferredStore();
    deferred.store.acceptFrame(helloFrame(DATABASE_A, 10));
    deferred.store.acceptFrame(eventFrame(item(13)));

    deferred.release(page([item(11), item(12)]));
    await settle();

    expect(sequences(deferred.store)).toEqual([11, 12, 13]);
    expect(deferred.store.getSnapshot().state).toBe("live");
    expect(deferred.store.getSnapshot().connected).toBe(true);
  });

  it("keeps the liveness degrade when a backfill completes into a silent stream", async () => {
    // Same class: the events route answering says nothing about a stream that
    // has been quiet past its deadline.
    const deferred = deferredStore();
    deferred.store.acceptFrame(helloFrame(DATABASE_A, 10));
    deferred.store.acceptFrame(eventFrame(item(13)));
    deferred.store.noteLivenessOverdue();
    expect(deferred.store.getSnapshot().state).toBe("degraded");

    deferred.release(page([item(11), item(12)]));
    await settle();

    expect(sequences(deferred.store)).toEqual([11, 12, 13]);
    expect(deferred.store.getSnapshot().state).toBe("degraded");
    expect(deferred.store.getSnapshot().detail).toContain("keep-alive");

    // And a delivered frame is what clears it, because a frame is the only
    // liveness evidence a browser is given.
    deferred.store.acceptFrame(eventFrame(item(14)));
    expect(deferred.store.getSnapshot().state).toBe("live");
  });

  it("recovers to live once the transport comes back", async () => {
    const deferred = deferredStore();
    deferred.store.acceptFrame(helloFrame(DATABASE_A, 10));
    deferred.store.acceptFrame(eventFrame(item(13)));
    deferred.store.noteDisconnected(true);
    deferred.release(page([item(11), item(12)]));
    await settle();
    expect(deferred.store.getSnapshot().state).toBe("disconnected");

    deferred.store.noteOpen();
    expect(deferred.store.getSnapshot().state).toBe("live");
    expect(deferred.store.getSnapshot().connected).toBe(true);
  });
});

describe("an aborted recovery releases the scope (postaudit blocker 2)", () => {
  /**
   * The hole this closes: the recovery used to be guarded by a bare flag that
   * could only fall in its own `finally`, which cannot run until the awaited
   * page settles. An abort therefore left it latched true, and a gap opened in
   * that window started no recovery at all — the held row was stranded and the
   * banner went on reading "Live" over an unfilled hole.
   */
  it("starts a new recovery for a gap that opens after a database change mid-backfill", async () => {
    let refetched = 0;
    const deferred = deferredStore({
      onDatabaseChanged: () => {
        refetched += 1;
      },
    });
    deferred.store.acceptFrame(helloFrame(DATABASE_A, 10));
    deferred.store.acceptFrame(eventFrame(item(13)));
    expect(deferred.cursors).toEqual([10]);
    expect(deferred.pending()).toBe(1);

    // The ledger changes underneath the recovery: the cache is discarded, the
    // scope re-anchors, and the in-flight page is aborted.
    deferred.store.acceptFrame(helloFrame(DATABASE_B, 100));
    expect(refetched).toBe(1);
    expect(deferred.store.getSnapshot().lastApplied).toBe(100);
    expect(deferred.store.getSnapshot().items).toHaveLength(0);
    expect(deferred.store.getSnapshot().heldSequences).toEqual([]);
    // The scope is released, so it is not stuck reporting a recovery that no
    // longer has anything to fill.
    expect(deferred.store.getSnapshot().state).toBe("live");

    // A gap on the NEW ledger. This is the frame the latched flag dropped.
    deferred.store.acceptFrame(eventFrame(item(104)));
    expect(deferred.store.getSnapshot().state).toBe("recovering");
    expect(deferred.cursors).toEqual([10, 100]);
    expect(deferred.pending()).toBe(2);

    // The abandoned page from the previous ledger lands late and must change
    // nothing at all — not the rows, not the cursor, not the page count.
    deferred.release(page([item(11), item(12)]));
    await settle();
    expect(deferred.store.getSnapshot().items).toHaveLength(0);
    expect(deferred.store.getSnapshot().lastApplied).toBe(100);
    expect(deferred.store.getSnapshot().backfillPages).toBe(0);
    expect(deferred.store.getSnapshot().state).toBe("recovering");

    // The new recovery closes its own gap, in order.
    deferred.release(page([item(101), item(102), item(103)]));
    await settle();
    expect(sequences(deferred.store)).toEqual([101, 102, 103, 104]);
    expect(deferred.store.getSnapshot().state).toBe("live");
    // Exactly one page is attributed to this scope: the abandoned one is not.
    expect(deferred.store.getSnapshot().backfillPages).toBe(1);
  });

  it("does not let an abandoned recovery clobber the one that replaced it", async () => {
    // The second half of the same race. The old loop's cleanup must only
    // release the scope it still owns, or it would free a recovery that is
    // legitimately in flight and let a third start on top of it.
    const deferred = deferredStore();
    deferred.store.acceptFrame(helloFrame(DATABASE_A, 10));
    deferred.store.acceptFrame(eventFrame(item(13)));
    deferred.store.acceptFrame(helloFrame(DATABASE_B, 100));
    deferred.store.acceptFrame(eventFrame(item(104)));
    expect(deferred.cursors).toEqual([10, 100]);

    // The old page settles while the new recovery is still open.
    deferred.release(page([item(11), item(12)]));
    await settle();

    // Still exactly one recovery: a further gapped frame must not open a third.
    deferred.store.acceptFrame(eventFrame(item(106)));
    await settle();
    expect(deferred.cursors).toEqual([10, 100]);
    expect(deferred.store.getSnapshot().state).toBe("recovering");
  });

  it("releases the scope on stop, so a later gap is still recoverable", async () => {
    const deferred = deferredStore();
    deferred.store.acceptFrame(helloFrame(DATABASE_A, 10));
    deferred.store.acceptFrame(eventFrame(item(13)));
    expect(deferred.cursors).toEqual([10]);

    deferred.store.stop();
    deferred.release(page([item(11), item(12)]));
    await settle();
    // Nothing from the aborted page was applied.
    expect(deferred.store.getSnapshot().items).toHaveLength(0);

    deferred.store.acceptFrame(eventFrame(item(14)));
    expect(deferred.cursors).toEqual([10, 10]);
  });
});

describe("ledger identity", () => {
  it("clears the scope and asks the view to refetch when the database changes", () => {
    let refetched = 0;
    const { store } = storeWith(() => page([]), {
      onDatabaseChanged: () => {
        refetched += 1;
      },
    });
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    store.acceptFrame(eventFrame(item(1)));
    store.acceptFrame(eventFrame(item(2)));
    expect(sequences(store)).toEqual([1, 2]);

    store.acceptFrame(helloFrame(DATABASE_B, 40));

    const snapshot = store.getSnapshot();
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.databaseId).toBe(DATABASE_B);
    expect(snapshot.lastApplied).toBe(40);
    expect(refetched).toBe(1);
  });

  it("refuses a head that moved backwards under the same database identity", () => {
    const { store } = storeWith(() => page([]));
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    store.acceptFrame(eventFrame(item(1)));
    store.acceptFrame(eventFrame(item(2)));

    store.acceptFrame(helloFrame(DATABASE_A, 1));

    expect(store.getSnapshot().state).toBe("degraded");
    expect(store.getSnapshot().detail).toContain("moved backwards");
  });
});

describe("resync", () => {
  it("enters degraded, discards the cache and never restarts on its own", () => {
    const { store, cursors } = storeWith(() => page([]));
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    store.acceptFrame(eventFrame(item(1)));

    store.acceptFrame(resyncFrame());

    const snapshot = store.getSnapshot();
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.halted).toBe(true);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.lastApplied).toBe(0);
    expect(snapshot.detail).toContain("ANCHOR_AHEAD_OF_HEAD");
    expect(cursors).toEqual([]);

    // A halted scope stays halted: a frame after a resync is not a restart.
    store.acceptFrame(helloFrame(DATABASE_A, 3));
    store.acceptFrame(eventFrame(item(4)));
    expect(store.getSnapshot().items).toHaveLength(0);
    expect(store.getSnapshot().state).toBe("degraded");
  });
});

describe("a frame the contract refuses", () => {
  it("halts the scope rather than rendering it or reading it again", () => {
    const { store } = storeWith(() => page([]));
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    store.acceptFrame(JSON.stringify({ kind: "event", item: { sequence: 1 } }));

    const snapshot = store.getSnapshot();
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.halted).toBe(true);
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.detail).toContain("stream contract");
  });
});

describe("bounds", () => {
  it("keeps a bounded tail rather than an unbounded archive", () => {
    const { store } = storeWith(() => page([]));
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    for (let sequence = 1; sequence <= STREAM_MAX_RETAINED_ITEMS + 25; sequence += 1) {
      store.acceptFrame(eventFrame(item(sequence)));
    }

    const snapshot = store.getSnapshot();
    expect(snapshot.items).toHaveLength(STREAM_MAX_RETAINED_ITEMS);
    expect(snapshot.items[0]?.sequence).toBe(26);
    // The cursor is not bounded by the display: dropping an old row does not
    // move where this scope got to.
    expect(snapshot.lastApplied).toBe(STREAM_MAX_RETAINED_ITEMS + 25);
  });
});

describe("privacy", () => {
  it("stores TimelineItem and nothing else", () => {
    const { store } = storeWith(() => page([]));
    store.acceptFrame(helloFrame(DATABASE_A, 0));
    store.acceptFrame(eventFrame(item(1, { taskId: TASK_B })));

    const stored = store.getSnapshot().items[0];
    expect(stored).toBeDefined();
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      [
        "attempt",
        "causationId",
        "correlationId",
        "emittedBy",
        "eventId",
        "eventSha256",
        "occurredAt",
        "payloadByteSize",
        "payloadKeys",
        "previousSha256",
        "recordedAt",
        "sequence",
        "taskId",
        "toState",
        "transitionId",
        "type",
        "fromState",
      ].sort(),
    );
    const serialized = JSON.stringify(store.getSnapshot());
    expect(serialized).not.toContain("payload\":{");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("/Users/");
  });
});

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

interface FakeSource {
  readyState: number;
  close(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  readonly listeners: Map<string, ((event: Event) => void)[]>;
  readonly closes: number[];
  deliver(type: string, data: string): void;
  fire(type: string): void;
}

const opened: { url: string; source: FakeSource }[] = [];

function installFakeEventSource(): void {
  class Fake {
    public readyState = 0;
    public readonly listeners = new Map<string, ((event: Event) => void)[]>();
    public readonly closes: number[] = [];

    public constructor(url: string) {
      opened.push({ url, source: this as unknown as FakeSource });
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
      this.closes.push(1);
      this.readyState = 2;
    }

    public deliver(type: string, data: string): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ type, data } as unknown as Event);
      }
    }

    public fire(type: string): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ type } as unknown as Event);
      }
    }
  }
  vi.stubGlobal("EventSource", Fake);
}

function lastOpened(): { url: string; source: FakeSource } {
  const entry = opened.at(-1);
  if (entry === undefined) throw new Error("expected a source to have been opened");
  return entry;
}

function listenerCount(source: FakeSource): number {
  let total = 0;
  for (const listeners of source.listeners.values()) total += listeners.length;
  return total;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  opened.length = 0;
});

describe("the constructor is read at call time", () => {
  it("reports no support when the global is absent, which is both test environments", () => {
    // Measured, not assumed: Node hides `EventSource` behind an experimental
    // flag and jsdom does not implement it, so this is the state a suite is
    // actually in before it stands anything in.
    expect(eventStreamConstructor()).toBeNull();
    expect(isEventStreamSupported()).toBe(false);
  });

  it("finds a stand-in installed after this module was loaded", () => {
    installFakeEventSource();
    expect(isEventStreamSupported()).toBe(true);
  });
});

describe("openEventStream", () => {
  it("renders a degraded state instead of throwing when there is no EventSource", () => {
    const { store } = storeWith(() => page([]));
    const connection = openEventStream({ store });

    const snapshot = store.getSnapshot();
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.detail).toContain("no server-sent event support");
    expect(() => {
      connection.close();
    }).not.toThrow();
  });

  it("renders a degraded state when the constructor refuses, without quoting the host", () => {
    function Refusing(): never {
      throw new Error("blocked by /Users/someone/policy.json");
    }
    vi.stubGlobal("EventSource", Refusing);
    const { store } = storeWith(() => page([]));
    openEventStream({ store });

    const snapshot = store.getSnapshot();
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.detail).toContain("refused to open");
    // The thrown text is host-supplied and could name anything at all.
    expect(snapshot.detail).not.toContain("/Users/");
  });

  it("opens the contract's own route, with no query, no filter and no credential", () => {
    installFakeEventSource();
    const { store } = storeWith(() => page([]));
    openEventStream({ store });

    expect(lastOpened().url).toBe("/api/v1/events/stream");
    expect(lastOpened().url).not.toContain("?");
    expect(lastOpened().url.toLowerCase()).not.toContain("token");
    expect(lastOpened().url.toLowerCase()).not.toContain("authorization");
  });

  it("listens for the three named frames and nothing else", () => {
    installFakeEventSource();
    const { store } = storeWith(() => page([]));
    openEventStream({ store });

    const { source } = lastOpened();
    expect([...source.listeners.keys()].sort()).toEqual(
      ["error", "open", ...STREAM_FRAME_EVENTS].sort(),
    );
    // `message` deliberately not among them: B3a names every frame it writes.
    expect(source.listeners.has("message")).toBe(false);
  });

  it("carries delivered frames into the store", () => {
    installFakeEventSource();
    const { store } = storeWith(() => page([]));
    openEventStream({ store });

    const { source } = lastOpened();
    source.fire("open");
    expect(store.getSnapshot().state).toBe("live");

    source.deliver("acp.hello", helloFrame(DATABASE_A, 3));
    source.deliver("acp.event", eventFrame(item(4)));
    expect(sequences(store)).toEqual([4]);
  });

  it("shows disconnected while the browser's own retry is pending, and live again after", () => {
    installFakeEventSource();
    const { store } = storeWith(() => page([]));
    openEventStream({ store });
    const { source } = lastOpened();

    source.fire("open");
    source.deliver("acp.hello", helloFrame(DATABASE_A, 0));
    expect(store.getSnapshot().state).toBe("live");

    source.readyState = 0;
    source.fire("error");
    expect(store.getSnapshot().state).toBe("disconnected");
    expect(store.getSnapshot().detail).toContain("retrying");

    source.deliver("acp.event", eventFrame(item(1)));
    expect(store.getSnapshot().state).toBe("live");
  });

  it("degrades when nothing has been delivered for twice the keep-alive period", () => {
    vi.useFakeTimers();
    installFakeEventSource();
    const { store } = storeWith(() => page([]));
    openEventStream({ store });
    const { source } = lastOpened();
    source.fire("open");
    source.deliver("acp.hello", helloFrame(DATABASE_A, 0));

    vi.advanceTimersByTime(STREAM_LIVENESS_TIMEOUT_MS - 1);
    expect(store.getSnapshot().state).toBe("live");

    vi.advanceTimersByTime(2);
    expect(store.getSnapshot().state).toBe("degraded");
    expect(store.getSnapshot().detail).toContain("keep-alive");

    source.deliver("acp.event", eventFrame(item(1)));
    expect(store.getSnapshot().state).toBe("live");
  });

  it("removes every listener, closes the source and clears the timer on close", () => {
    vi.useFakeTimers();
    installFakeEventSource();
    const { store } = storeWith(() => page([]));
    const connection = openEventStream({ store });
    const { source } = lastOpened();
    source.fire("open");

    expect(listenerCount(source)).toBe(2 + STREAM_FRAME_EVENTS.length);

    connection.close();

    expect(listenerCount(source)).toBe(0);
    expect(source.closes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    // Idempotent, and the state does not move after the connection is gone.
    connection.close();
    expect(source.closes).toHaveLength(1);
    vi.advanceTimersByTime(STREAM_LIVENESS_TIMEOUT_MS * 4);
    expect(store.getSnapshot().state).toBe("live");
  });

  it("closes itself when the scope halts, so a resync cannot become a reconnect loop", () => {
    installFakeEventSource();
    const { store } = storeWith(() => page([]));
    openEventStream({ store });
    const { source } = lastOpened();
    source.fire("open");
    source.deliver("acp.hello", helloFrame(DATABASE_A, 0));

    source.deliver("acp.resync", resyncFrame());

    expect(source.closes).toHaveLength(1);
    expect(listenerCount(source)).toBe(0);
    expect(store.getSnapshot().halted).toBe(true);
  });
});

describe("the idle snapshot", () => {
  it("is frozen and referentially stable, which is what useSyncExternalStore requires", () => {
    const { store } = storeWith(() => page([]));
    expect(store.getServerSnapshot()).toBe(IDLE_STREAM_SNAPSHOT);
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
    expect(IDLE_STREAM_SNAPSHOT.state).toBe("connecting");
    expect(Object.isFrozen(IDLE_STREAM_SNAPSHOT)).toBe(true);
  });

  it("returns the same live snapshot object until something actually changes", () => {
    const { store } = storeWith(() => page([]));
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);

    store.acceptFrame(helloFrame(DATABASE_A, 0));
    expect(store.getSnapshot()).not.toBe(first);
  });

  it("notifies subscribers and stops when they unsubscribe", () => {
    const { store } = storeWith(() => page([]));
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.acceptFrame(helloFrame(DATABASE_A, 0));
    expect(notifications).toBe(1);

    unsubscribe();
    store.acceptFrame(eventFrame(item(1)));
    expect(notifications).toBe(1);
  });
});

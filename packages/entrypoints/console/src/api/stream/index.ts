import {
  API_ROUTES,
  StreamFrame,
  type EventPageResponse,
  type TimelineItem,
} from "@acp/protocol";

import { type ApiResult } from "../client/index.js";

/**
 * The browser's end of the ledger stream (V2-B3b).
 *
 * B3a made the durable sequence a connection. This module is the only thing in
 * the console that reads it, and it holds one law that everything else here is
 * a consequence of: **the ledger's `sequence` is the only cursor, and this
 * module never invents one.** It has no counter, reads no clock for a
 * position, and increments nothing — `lastApplied` only ever takes the value
 * of a `sequence` that arrived on a frame or on a page of the `events` route.
 * A fence law is scoped to this directory to keep that true by mechanism.
 *
 * The consequences, stated where they are implemented:
 *
 * - **One scope, unfiltered.** The connection carries no query. A filtered
 *   stream would be a *subsequence* of the ledger — its ids are ordered but
 *   not adjacent — and "apply only the exact next sequence" is not a claim a
 *   client can make about a subsequence at all: it cannot tell "the next
 *   matching row" from "a matching row that was lost". So the console opens
 *   the whole tail once and each view selects from it for display. The cost is
 *   named rather than hidden: a browser filtering a task receives rows it will
 *   not show, bounded by `STREAM_MAX_RETAINED_ITEMS` and by the fact that a
 *   `TimelineItem` carries no payload.
 * - **The REST route is the gap-filling authority.** When a frame is not the
 *   next sequence it is *held*, never applied. The `events` route is paged
 *   from `lastApplied` until the missing rows arrive, and only then does the
 *   held frame land. One sequence authority, two transports.
 * - **Nothing here restarts silently.** A `resync`, a frame that does not
 *   satisfy the contract, a head that moved backwards, or a backfill that
 *   cannot close its gap inside its budget all end the connection in a
 *   *visible* `degraded` state. A stream that quietly re-anchored would
 *   present a fresh view as a resumed one, which is the exact failure B3a's
 *   own `resync` arm exists to refuse on the server side.
 * - **The browser-facing data is `TimelineItem` and nothing else.** Frames are
 *   parsed with the real exported `StreamFrame` schema before a field is read,
 *   so the contract's credential and transcript guards run on the way in here
 *   exactly as they run on the way out of the gateway. No payload value, no
 *   absolute path, no bearer token: `EventSource` cannot send a header, and
 *   the answer to that is a route that needs none, never a token smuggled into
 *   a query parameter.
 */

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * The server's keep-alive period, restated.
 *
 * Restated rather than imported, because the console may depend on
 * `@acp/protocol` alone and the constant lives in the gateway. The drift risk
 * is real and is the honest cost of that boundary: if the server's period
 * moves and this does not, the client's tolerance is wrong in one direction or
 * the other. It is stated here as a *tolerance*, not as a fact about the
 * server, which is why nothing below treats it as one.
 */
export const SERVER_HEARTBEAT_INTERVAL_MS = 15_000;

/** How many keep-alive periods of silence before liveness is unconfirmed. */
export const STREAM_LIVENESS_FACTOR = 2;

/**
 * Silence past which this client stops claiming the stream is live.
 *
 * **What this can and cannot mean.** B3a's keep-alive is an SSE *comment*, and
 * a comment is discarded by the parser before dispatch — no browser delivers
 * one to a listener. So a page has no way to observe the keep-alive at all,
 * and the only liveness evidence it has is a frame it was actually given.
 * `degraded` here therefore means "this browser cannot currently confirm the
 * stream is live", which on a quiet ledger is true and on a wedged connection
 * is also true. It does **not** claim the connection is broken, and the status
 * text says so in those words. The alternative — never degrading, and showing
 * a stale screen that looks live — is the one outcome the packet forbids.
 */
export const STREAM_LIVENESS_TIMEOUT_MS = SERVER_HEARTBEAT_INTERVAL_MS * STREAM_LIVENESS_FACTOR;

/**
 * How many pages of the `events` route one gap may cost.
 *
 * Bounded because an unbounded recovery loop is how a client turns a server
 * problem into a browser that never stops asking. When the budget runs out the
 * scope fails visibly rather than trying again.
 */
export const STREAM_MAX_BACKFILL_PAGES = 10;

/** Live rows kept in memory. A tail, not an archive; the paged route is the archive. */
export const STREAM_MAX_RETAINED_ITEMS = 200;

/**
 * Live rows a view shows at once.
 *
 * Smaller than what the scope retains, and declared once here rather than per
 * view: two views with two ceilings would be two answers to "how much of the
 * tail am I looking at", and an operator comparing two screens would have no
 * way to tell which one truncated.
 */
export const STREAM_VIEW_ITEMS = 25;

/**
 * Frames that may sit held while a gap is filled.
 *
 * A held frame is one this client refuses to apply out of order. If they pile
 * up past this, the gap is not closing and pretending otherwise would trade a
 * visible failure for unbounded memory.
 */
export const STREAM_MAX_HELD_FRAMES = 400;

// ---------------------------------------------------------------------------
// The five states
// ---------------------------------------------------------------------------

/**
 * What this connection is doing, said out loud.
 *
 * Every one of these is rendered. There is no sixth, silent state in which the
 * screen is stale and says nothing about it.
 */
export type StreamConnectionState =
  /** Opening, or reopening after the browser's own retry. */
  | "connecting"
  /** Connected, anchored, and applying rows in sequence order. */
  | "live"
  /** A gap is being filled from the `events` route; frames are held, not applied. */
  | "recovering"
  /** Connected or not, but this client will not claim the view is current. */
  | "degraded"
  /** The source closed and the browser's native retry is pending. */
  | "disconnected";

export interface StreamSnapshot {
  readonly state: StreamConnectionState;
  /** One closed sentence, or null. Never server-supplied free text — see `parseStreamFrame`. */
  readonly detail: string | null;
  /** The ledger this scope is anchored to, as its redacted digest. Never rendered. */
  readonly databaseId: string | null;
  /** The last sequence applied. Zero before a `hello` anchors the scope. */
  readonly lastApplied: number;
  /** Applied rows, ascending, newest-bounded. `TimelineItem` and nothing else. */
  readonly items: readonly TimelineItem[];
  /** Sequences held out of order, ascending. Non-empty means a gap is open. */
  readonly heldSequences: readonly number[];
  /** Frames dropped as already-applied. The reconnect arm's own counter. */
  readonly droppedFrames: number;
  /** Pages of the `events` route this scope has spent on gaps. */
  readonly backfillPages: number;
  /** Has this scope stopped for good? A halted scope does not reconnect by itself. */
  readonly halted: boolean;
  /**
   * Is the transport believed to be up?
   *
   * Exposed because it is the fact the rendered state is derived from, and a
   * drill that could not read it would be asserting the conclusion without the
   * premise. `live` and `recovering` are only ever claimed while this is true.
   */
  readonly connected: boolean;
}

const NO_ITEMS: readonly TimelineItem[] = Object.freeze([]);
const NO_SEQUENCES: readonly number[] = Object.freeze([]);

/**
 * The snapshot a render observes before any effect has run.
 *
 * Frozen and shared, because `useSyncExternalStore` requires a server snapshot
 * that is referentially stable — a fresh object per call is an infinite render
 * loop, not a fresh reading.
 */
export const IDLE_STREAM_SNAPSHOT: StreamSnapshot = Object.freeze({
  state: "connecting",
  detail: null,
  databaseId: null,
  lastApplied: 0,
  items: NO_ITEMS,
  heldSequences: NO_SEQUENCES,
  droppedFrames: 0,
  backfillPages: 0,
  halted: false,
  connected: false,
});

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export type ParsedStreamFrame =
  | { readonly ok: true; readonly frame: StreamFrame }
  | { readonly ok: false; readonly detail: string };

/**
 * Parse one frame body with the contract, never by hand.
 *
 * The detail is a closed sentence rather than the validator's own issue list,
 * and deliberately: this string is rendered in a live banner, and an issue
 * message carries a path into a body this client has just decided it does not
 * trust. The paged client renders issue text because it is answering a
 * developer about a response it fetched; this one is answering an operator
 * about a frame it refused.
 */
export function parseStreamFrame(data: string): ParsedStreamFrame {
  let body: unknown;
  try {
    body = JSON.parse(data);
  } catch {
    return { ok: false, detail: "a frame body was not valid JSON" };
  }
  const parsed = StreamFrame.safeParse(body);
  if (!parsed.success) {
    return { ok: false, detail: "a frame did not match the stream contract this build expects" };
  }
  return { ok: true, frame: parsed.data };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface StreamStoreOptions {
  /**
   * Page the `events` route after an exclusive sequence cursor.
   *
   * Injected rather than imported so the reconciliation can be driven without
   * a network, and so this module has exactly one door to the gap-filling
   * authority instead of reaching for `fetch` itself.
   */
  readonly loadPage: (cursor: number, signal: AbortSignal) => Promise<ApiResult<EventPageResponse>>;
  /** A `hello` named a different ledger: the view's own data is stale too. */
  readonly onDatabaseChanged?: (() => void) | undefined;
  /** Overridable for the drills; production takes the constant above. */
  readonly maxBackfillPages?: number | undefined;
}

export interface StreamStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => StreamSnapshot;
  readonly getServerSnapshot: () => StreamSnapshot;
  /** One frame body, as the wire delivered it. */
  readonly acceptFrame: (data: string) => void;
  readonly noteConnecting: () => void;
  readonly noteOpen: () => void;
  /** The source dropped; `retrying` says whether the browser will try again. */
  readonly noteDisconnected: (retrying: boolean) => void;
  /** No `EventSource` here at all, or the constructor refused. */
  readonly noteUnavailable: (detail: string) => void;
  /** The liveness deadline passed without a delivered frame. */
  readonly noteLivenessOverdue: () => void;
  /** Abandon any in-flight backfill. Called on close; safe to call twice. */
  readonly stop: () => void;
}

/**
 * Build one scope's reconciliation state.
 *
 * Everything the console knows about the stream lives in exactly one of these.
 * There is no second cache and no second cursor: the views read this snapshot
 * and select from it, and the only writer of `lastApplied` is `apply` below.
 */
export function createStreamStore(options: StreamStoreOptions): StreamStore {
  const maxBackfillPages = options.maxBackfillPages ?? STREAM_MAX_BACKFILL_PAGES;

  const listeners = new Set<() => void>();
  let cached: StreamSnapshot | null = null;

  let state: StreamConnectionState = "connecting";
  let detail: string | null = null;
  let databaseId: string | null = null;
  let anchored = false;
  let lastApplied = 0;
  let items: readonly TimelineItem[] = NO_ITEMS;
  const held = new Map<number, TimelineItem>();
  let backfillTarget = 0;
  let halted = false;
  let droppedFrames = 0;
  let backfillPages = 0;

  /**
   * Whether the transport is believed to be up, and whether it has gone quiet
   * past the deadline.
   *
   * These exist because the recovery path used to *assert* `live` at its tail
   * with nothing to assert it from. Filling a gap is evidence about the
   * `events` route; it is no evidence at all about the stream, and the two can
   * disagree — the same hiccup that drops a connection is often what opened
   * the gap being filled. So the state is derived from what is known rather
   * than assigned by whichever code path ran last.
   */
  let connected = false;
  let livenessOverdue = false;

  /**
   * The in-flight backfill's own controller, and the backfill's identity.
   *
   * The guard is the controller rather than a boolean, and that is the fix for
   * a real cancellation race: a bare `backfilling` flag can only fall in the
   * loop's `finally`, which cannot run until the awaited page settles, so an
   * abort left it latched true and the next gap started no recovery at all.
   * Clearing the controller at the abort site releases the scope immediately,
   * and because the `finally` only clears the controller it still owns, a
   * recovery started in that window cannot be clobbered by the one it replaced.
   */
  let controller: AbortController | null = null;

  function isBackfilling(): boolean {
    return controller !== null;
  }

  function emit(): void {
    cached = null;
    for (const listener of listeners) listener();
  }

  function build(): StreamSnapshot {
    return Object.freeze({
      state,
      detail,
      databaseId,
      lastApplied,
      items,
      heldSequences: Object.freeze([...held.keys()].sort((a, b) => a - b)),
      droppedFrames,
      backfillPages,
      halted,
      connected,
    });
  }

  /** Stop this scope, visibly. No retry, no re-anchor, no silent stale screen. */
  function halt(reason: string): void {
    if (halted) return;
    halted = true;
    state = "degraded";
    detail = reason;
    held.clear();
    controller?.abort();
    controller = null;
    emit();
  }

  /** Apply exactly one row, and only ever the one that follows `lastApplied`. */
  function apply(item: TimelineItem): void {
    const next = [...items, item];
    items = Object.freeze(
      next.length > STREAM_MAX_RETAINED_ITEMS ? next.slice(next.length - STREAM_MAX_RETAINED_ITEMS) : next,
    );
    lastApplied = item.sequence;
  }

  /** Apply every held frame that has become the next one. */
  function drain(): void {
    let next = held.get(lastApplied + 1);
    while (next !== undefined) {
      held.delete(next.sequence);
      apply(next);
      next = held.get(lastApplied + 1);
    }
  }

  function needsBackfill(): boolean {
    return held.size > 0 || lastApplied < backfillTarget;
  }

  /**
   * Close the gap from the `events` route, or fail where an operator can see it.
   *
   * The loop's own guard is what keeps it finite: each page must advance
   * `lastApplied`, and a page that does not — because the route answered with
   * an error, or returned nothing after a cursor the stream has already passed
   * — ends the scope rather than being tried again. A gap that survives the
   * page budget ends it too.
   */
  async function runBackfill(): Promise<void> {
    // The guard is the live controller, not a flag: see its declaration for
    // why a boolean could latch and silently drop the next recovery.
    if (isBackfilling() || halted) return;
    const signal = new AbortController();
    controller = signal;
    settle();
    emit();

    // Read through a closure rather than the variables directly: `halt`,
    // `stop` and `resetScope` are called from elsewhere, and a narrowed local
    // would let the compiler believe this loop can only be left by its own
    // condition. `controller !== signal` is the abandonment a reset performs:
    // it hands the scope to a different recovery, or to none.
    const abandoned = (): boolean => halted || signal.signal.aborted || controller !== signal;

    try {
      let pages = 0;
      while (!abandoned() && needsBackfill()) {
        if (pages >= maxBackfillPages) {
          halt(
            "A gap after sequence " +
              String(lastApplied) +
              " did not close within " +
              String(maxBackfillPages) +
              " pages of the events route. The live tail has stopped; reload to start a new one.",
          );
          return;
        }
        const before = lastApplied;
        const result = await options.loadPage(before, signal.signal);
        // Counted after the abandonment check, so a page this scope no longer
        // owns is not attributed to it.
        if (abandoned()) return;
        pages += 1;
        backfillPages += 1;

        if (result.kind !== "ok") {
          halt(
            "The events route could not fill a gap after sequence " +
              String(before) +
              " (" +
              (result.kind === "api-error" ? result.code : result.kind) +
              "). The live tail has stopped; reload to start a new one.",
          );
          return;
        }

        for (const item of result.data.items) {
          if (item.sequence <= lastApplied) continue;
          if (held.has(item.sequence)) continue;
          held.set(item.sequence, item);
        }
        drain();

        if (lastApplied === before) {
          halt(
            "The events route returned no row after sequence " +
              String(before) +
              ", so a gap the stream reported cannot be filled. The live tail has stopped; reload to start a new one.",
          );
          return;
        }
        emit();
      }

      // The recovery is over. Release the scope *before* deriving the state, so
      // `settle` does not read this backfill as still running — and derive it
      // rather than assign `live`, which is the whole of blocker 1: closing a
      // gap proves the `events` route answered, and proves nothing whatever
      // about the stream, which may have died while the page was in flight.
      const finished = !abandoned();
      if (controller === signal) controller = null;
      if (finished) {
        settle();
        emit();
      }
    } finally {
      if (controller === signal) controller = null;
    }
  }

  function startBackfill(): void {
    void runBackfill();
  }

  /**
   * Derive the rendered state from what this scope actually knows.
   *
   * Called wherever the state could change, and it is the **only** writer of
   * `live` and `recovering`. The two early returns are the point: each names a
   * fact that outranks "a gap closed", because neither is evidence about the
   * transport and `live` is a claim about the transport.
   */
  function settle(): void {
    if (halted) return;
    if (!connected) {
      // Whoever observed the transport already recorded the honest state —
      // `disconnected` while the browser retries, or `degraded` where there is
      // no stream at all. A recovery completing may not overwrite it.
      return;
    }
    if (livenessOverdue) {
      // The stream has been silent past its deadline. That the events route
      // answered says nothing about that silence.
      return;
    }
    state = isBackfilling() ? "recovering" : "live";
    detail = null;
  }

  function resetScope(nextDatabaseId: string, headSequence: number): void {
    databaseId = nextDatabaseId;
    anchored = true;
    lastApplied = headSequence;
    backfillTarget = headSequence;
    items = NO_ITEMS;
    held.clear();
    controller?.abort();
    controller = null;
  }

  function acceptHello(frame: Extract<StreamFrame, { kind: "hello" }>): void {
    if (!anchored) {
      // First connection. The tail starts at the head: history is the paged
      // route's job, and a live section that backfilled an entire ledger on
      // open would be doing that job badly and slowly.
      resetScope(frame.database.id, frame.headSequence);
      return;
    }
    if (frame.database.id !== databaseId) {
      // A different ledger behind the same URL. The server cannot enforce this
      // — `EventSource` sends no custom header, so it has nothing to compare —
      // which makes it a client law, and this is where the client keeps it.
      resetScope(frame.database.id, frame.headSequence);
      options.onDatabaseChanged?.();
      emit();
      return;
    }
    if (frame.headSequence < lastApplied) {
      halt(
        "The ledger head moved backwards, from sequence " +
          String(lastApplied) +
          " to " +
          String(frame.headSequence) +
          ". This browser is holding a position the ledger no longer has; reload to re-anchor.",
      );
      return;
    }
    if (frame.headSequence > lastApplied) {
      // A reconnection the browser made without an anchor — it had no id to
      // send, because this scope had never been given an event frame. The rows
      // in between are missing and are fetched, not skipped.
      backfillTarget = Math.max(backfillTarget, frame.headSequence);
      startBackfill();
    }
  }

  function acceptEvent(frame: Extract<StreamFrame, { kind: "event" }>): void {
    const item = frame.item;
    if (!anchored) {
      halt(
        "An event frame arrived before the stream said which ledger it is. " +
          "This browser will not anchor a cache to an unnamed ledger; reload to start a new tail.",
      );
      return;
    }
    if (item.sequence <= lastApplied || held.has(item.sequence)) {
      // The duplicate arm, and the one that fires on every native reconnect
      // that replays a row this scope already has.
      droppedFrames += 1;
      return;
    }
    if (held.size >= STREAM_MAX_HELD_FRAMES) {
      halt(
        "More than " +
          String(STREAM_MAX_HELD_FRAMES) +
          " frames are waiting on a gap that is not closing. The live tail has stopped; reload to start a new one.",
      );
      return;
    }
    held.set(item.sequence, item);
    drain();
    if (held.size > 0) {
      // Not the next sequence. Held, never applied optimistically.
      startBackfill();
    }
  }

  function acceptResync(frame: Extract<StreamFrame, { kind: "resync" }>): void {
    // The server has told this connection its anchor is unusable and closed.
    // Reconnecting would send the same anchor and get the same answer, so the
    // scope stops here rather than looping, and its cache goes with it: rows
    // read from a ledger this one is not are not rows about this one.
    items = NO_ITEMS;
    anchored = false;
    databaseId = null;
    lastApplied = 0;
    backfillTarget = 0;
    halt(
      "The server refused this browser's position in the ledger (" +
        frame.reason +
        "). The live tail has stopped and its rows were discarded; reload to start a new one.",
    );
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      cached ??= build();
      return cached;
    },
    getServerSnapshot() {
      return IDLE_STREAM_SNAPSHOT;
    },
    acceptFrame(data) {
      if (halted) return;
      const parsed = parseStreamFrame(data);
      if (!parsed.ok) {
        // A peer speaking a contract this build does not know will not start
        // making sense on the next frame, and a reconnect would re-read the
        // same stream. Stop, and say so.
        halt(
          parsed.detail.charAt(0).toUpperCase() +
            parsed.detail.slice(1) +
            ". The live tail has stopped; nothing from it was applied.",
        );
        return;
      }
      // A delivered frame is transport evidence, and the only kind a browser
      // gets: B3a's keep-alive is a stream comment, which no parser delivers.
      // Recorded *before* the handler runs and derived *after* it, so the state
      // reflects what the handler left behind rather than what was true when
      // the frame arrived — a reset that ends a recovery mid-frame included.
      connected = true;
      livenessOverdue = false;
      const frame = parsed.frame;
      if (frame.kind === "hello") acceptHello(frame);
      else if (frame.kind === "event") acceptEvent(frame);
      else acceptResync(frame);
      settle();
      emit();
    },
    noteConnecting() {
      if (halted) return;
      connected = false;
      livenessOverdue = false;
      state = "connecting";
      detail = null;
      emit();
    },
    noteOpen() {
      if (halted) return;
      connected = true;
      livenessOverdue = false;
      settle();
      emit();
    },
    noteDisconnected(retrying) {
      if (halted) return;
      // The one writer of the transport fact on the way down. A backfill that
      // completes after this must not talk over it.
      connected = false;
      state = "disconnected";
      detail = retrying
        ? "The connection dropped. The browser is retrying on its own; rows are not being applied meanwhile."
        : "The connection closed and is not being retried.";
      emit();
    },
    noteUnavailable(reason) {
      halted = true;
      connected = false;
      state = "degraded";
      detail = reason;
      emit();
    },
    noteLivenessOverdue() {
      if (halted || state === "disconnected") return;
      livenessOverdue = true;
      state = "degraded";
      detail =
        "No frame has arrived for over " +
        String(Math.round(STREAM_LIVENESS_TIMEOUT_MS / 1000)) +
        " seconds. The server's keep-alive is a stream comment, which a browser never delivers, so a quiet ledger and a stalled connection look the same from here. Rows below may not be current.";
      emit();
    },
    stop() {
      controller?.abort();
      controller = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/** The three named frames B3a writes. A heartbeat is a comment and arrives on none of them. */
export const STREAM_FRAME_EVENTS: readonly string[] = Object.freeze([
  "acp.hello",
  "acp.event",
  "acp.resync",
]);

/** The subset of the browser type this module uses, so a drill can stand in for it. */
export interface EventStreamLike {
  readonly readyState: number;
  close: () => void;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
}

export type EventStreamConstructorLike = new (url: string) => EventStreamLike;

/** `readyState` while the browser's own retry is pending. */
const READY_STATE_CONNECTING = 0;

/**
 * The constructor, read off `globalThis` **at call time**.
 *
 * At call time and not at module load, for a measured reason: neither test
 * environment has one — Node 22 hides it behind an experimental flag and the
 * DOM implementation the suites render into does not implement it at all — so
 * a module-scope capture would freeze `undefined`
 * into the module before a suite could stand anything in. Reading it here lets
 * a drill install a stand-in, and lets a browser that genuinely lacks the API
 * be answered with a rendered state instead of a thrown module.
 */
export function eventStreamConstructor(): EventStreamConstructorLike | null {
  const candidate = (globalThis as { EventSource?: unknown }).EventSource;
  return typeof candidate === "function" ? (candidate as EventStreamConstructorLike) : null;
}

/** Can this browser stream at all? */
export function isEventStreamSupported(): boolean {
  return eventStreamConstructor() !== null;
}

export interface EventStreamConnection {
  /** Idempotent: removes every listener, closes the source, clears the timer. */
  close: () => void;
}

export interface EventStreamOptions {
  readonly store: StreamStore;
  /** Defaults to the contract's own route. No query, and never a credential. */
  readonly url?: string | undefined;
  readonly livenessTimeoutMs?: number | undefined;
}

/**
 * Open the tail and wire it to one store.
 *
 * The three named frames get listeners; `message` deliberately does not,
 * because B3a names every frame it writes and an unnamed one would be
 * something this build does not know how to read.
 *
 * The connection watches its own store and closes itself when the scope halts.
 * That is what stops the two loops a naive client would run: a `resync` whose
 * reconnect earns another `resync`, and a contract mismatch re-read forever.
 */
export function openEventStream(options: EventStreamOptions): EventStreamConnection {
  const { store } = options;
  const url = options.url ?? API_ROUTES.eventStream;
  const livenessTimeoutMs = options.livenessTimeoutMs ?? STREAM_LIVENESS_TIMEOUT_MS;

  const constructor = eventStreamConstructor();
  if (constructor === null) {
    store.noteUnavailable(
      "This browser provides no server-sent event support, so there is no live tail. " +
        "The rows below are the page that was fetched, not a live view.",
    );
    return {
      close() {
        // Nothing was opened, and saying so is cheaper than a flag.
      },
    };
  }

  let source: EventStreamLike;
  try {
    source = new constructor(url);
  } catch {
    // The thrown value is deliberately not rendered: it is host-supplied text,
    // and this banner is one of the surfaces that must never carry any.
    store.noteUnavailable(
      "The browser refused to open the live event stream, so there is no live tail. " +
        "The rows below are the page that was fetched, not a live view.",
    );
    return {
      close() {
        // As above.
      },
    };
  }

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function disarm(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(): void {
    disarm();
    timer = setTimeout(() => {
      timer = null;
      store.noteLivenessOverdue();
    }, livenessTimeoutMs);
  }

  const onOpen = (): void => {
    store.noteOpen();
    arm();
  };

  const onError = (): void => {
    store.noteDisconnected(source.readyState === READY_STATE_CONNECTING);
    // The browser is retrying; the deadline is not a claim about a connection
    // that has already said it is gone.
    disarm();
  };

  const onFrame = (event: Event): void => {
    const data: unknown = (event as MessageEvent<unknown>).data;
    store.acceptFrame(typeof data === "string" ? data : "");
    arm();
  };

  const unsubscribe = store.subscribe(() => {
    if (store.getSnapshot().halted) close();
  });

  function close(): void {
    if (closed) return;
    closed = true;
    disarm();
    unsubscribe();
    source.removeEventListener("open", onOpen);
    source.removeEventListener("error", onError);
    for (const name of STREAM_FRAME_EVENTS) source.removeEventListener(name, onFrame);
    source.close();
    store.stop();
  }

  source.addEventListener("open", onOpen);
  source.addEventListener("error", onError);
  for (const name of STREAM_FRAME_EVENTS) source.addEventListener(name, onFrame);

  store.noteConnecting();
  arm();

  return { close };
}

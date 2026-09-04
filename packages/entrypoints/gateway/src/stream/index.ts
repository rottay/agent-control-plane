import {
  API_CONTRACT_VERSION,
  LEDGER_CONTRACT_VERSION,
  STREAM_CHANNEL_BY_EVENT_TYPE,
  StreamFrame,
  type LedgerDatabaseIdentity,
  type StreamQuery,
} from "@acp/protocol";
import type { Ledger } from "@acp/ledger";
import type { FastifyReply } from "fastify";

import {
  STREAM_HEARTBEAT_INTERVAL_MS,
  STREAM_MAX_CONNECTIONS,
  STREAM_POLL_INTERVAL_MS,
  STREAM_REPLAY_PAGE,
} from "../constants/index.js";
import { timelineItem } from "../mappers/index.js";

/**
 * The ledger sequence as a Server-Sent Events stream (V2-B3a).
 *
 * One law holds this module together, and everything else here is a
 * consequence of it: **the ledger's `sequence` is the only identity and the
 * only cursor.** This file mints nothing. It has no counter, reads no clock
 * for an identifier, and generates no id of its own — the `id:` line on the
 * wire is `String(record.sequence)` and there is no other expression that
 * produces one. A fence law is scoped to this directory to keep that true by
 * mechanism rather than by review.
 *
 * The consequences, stated where they are implemented:
 *
 * - **The tail is a poll, not a push.** The gateway opens the ledger
 *   read-only and the writer is a different process, so SQLite's `update_hook`
 *   cannot fire here. A push tail would need a broker, and a broker would be a
 *   second authority over ordering — precisely the thing the law forbids. So
 *   `#tail` asks `listEvents` again every `pollIntervalMs`. That is SSE
 *   transport over a polled read, and ADR 0017 says so in those words.
 * - **The queue is the ledger.** Nothing is buffered in memory. When a socket
 *   applies backpressure, the poll simply stops until `drain`; where the
 *   connection got to is its cursor, and the rows it has not sent are still in
 *   the database. An unbounded in-process queue is the usual way a stream turns
 *   a slow reader into a memory leak, and there is nowhere here for one to live.
 * - **Only an event frame gets an id.** `hello` and `resync` are written
 *   through `encodeControlFrame`, which has no id parameter to pass; a
 *   heartbeat is an SSE comment, which browsers never deliver to `onmessage`.
 *   A client's `Last-Event-ID` can therefore only ever hold a value that was a
 *   row's sequence.
 * - **The body is the redacted projection and nothing else.** Every frame is
 *   built through `timelineItem` — the same mapper the paged `events` route
 *   uses — and validated against `StreamFrame` before a byte is written, so the
 *   contract's credential and transcript guards run on the way out here exactly
 *   as they do on every other response.
 */

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * The reconnection delay a browser should use, sent once at open.
 *
 * A directive rather than a frame: it carries no `data:` and no `id:`, so it
 * is not delivered to a listener and cannot move a cursor.
 */
export const RETRY_DIRECTIVE = "retry: 3000\n\n";

/**
 * The keep-alive, as an SSE **comment**.
 *
 * A line beginning with `:` is discarded by every conforming parser before
 * dispatch. That is the entire reason a comment is used rather than a frame of
 * kind `heartbeat`: a keep-alive that could be delivered could also carry an
 * `id:` one day, and an id on a keep-alive is a cursor that advances past rows
 * nobody sent.
 */
export const HEARTBEAT_COMMENT = ": heartbeat\n\n";

/** The response headers, written once, at hijack. No `content-length`. */
export const STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/event-stream",
  "cache-control": "no-store",
  connection: "keep-alive",
  // Proxies that buffer a response defeat a stream silently — the client sees
  // nothing until the buffer fills, which looks exactly like a quiet ledger.
  "x-accel-buffering": "no",
});

/**
 * Encode one ledger row as a frame carrying its sequence as the SSE id.
 *
 * The `id:` line is `String(sequence)` and the caller passes the sequence of
 * the row the frame carries. There is no other source: no counter, no clock,
 * no random value, and the frame's own `item.sequence` is asserted equal to it
 * so the wire id and the body can never disagree.
 */
export function encodeEventFrame(frame: StreamFrame, sequence: number): string {
  if (frame.kind !== "event") {
    throw new Error("only an event frame carries an id");
  }
  if (frame.item.sequence !== sequence) {
    throw new Error("the id must be the sequence of the row the frame carries");
  }
  return (
    "id: " + String(sequence) + "\nevent: acp.event\ndata: " + JSON.stringify(frame) + "\n\n"
  );
}

/**
 * Encode a control frame — `hello` or `resync` — with **no** `id:` line.
 *
 * The absence is structural rather than remembered: this function takes no
 * sequence, so there is nothing here to write one from.
 */
export function encodeControlFrame(frame: StreamFrame): string {
  if (frame.kind === "event") {
    throw new Error("an event frame must be encoded with its sequence");
  }
  return "event: acp." + frame.kind + "\ndata: " + JSON.stringify(frame) + "\n\n";
}

// ---------------------------------------------------------------------------
// The anchor
// ---------------------------------------------------------------------------

/** Where a connection was told to resume from, once the header has been read. */
export type StreamAnchor =
  /** No usable header: serve from the current head after a `hello`. */
  | { readonly kind: "live" }
  /** A position this client claims to have reached. Exclusive, like every cursor here. */
  | { readonly kind: "at"; readonly sequence: number }
  /** Not a sequence at all. A `BAD_REQUEST`, answered before anything is hijacked. */
  | { readonly kind: "malformed" };

/**
 * The anchor grammar: a decimal non-negative integer, and nothing else.
 *
 * Deliberately not `Number()`, for the reason the query schemas already give:
 * `Number()` accepts `0x10`, `1e3`, `Infinity`, and leading whitespace, every
 * one of which would silently become a position the caller never wrote. The
 * bound on length is the other half — a two-hundred-digit string parses to a
 * float that is no longer an integer sequence.
 */
const ANCHOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const ANCHOR_MAX_DIGITS = 16;

/**
 * Read `Last-Event-ID` into an anchor.
 *
 * Absent, empty, or whitespace is `live` rather than an error: a browser
 * opening an `EventSource` for the first time sends no such header, and that is
 * the ordinary case rather than a mistake.
 */
export function parseStreamAnchor(raw: string | undefined): StreamAnchor {
  if (raw === undefined) return { kind: "live" };
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "live" };
  if (trimmed.length > ANCHOR_MAX_DIGITS) return { kind: "malformed" };
  if (!ANCHOR_PATTERN.test(trimmed)) return { kind: "malformed" };
  const sequence = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(sequence)) return { kind: "malformed" };
  return { kind: "at", sequence };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** Everything one connection needs, resolved by the route before the hijack. */
export interface StreamContext {
  readonly ledger: Ledger;
  readonly database: LedgerDatabaseIdentity;
  readonly filters: StreamQuery;
  readonly anchor: StreamAnchor;
}

export interface StreamRegistry {
  /** How many connections are open right now. */
  readonly size: number;
  /** The ceiling this registry was built with. */
  readonly capacity: number;
  /** Is the next connection the one too many? Asked before any hijack. */
  isFull(): boolean;
  /** Hijack the reply and serve until the client leaves or the registry drains. */
  serve(reply: FastifyReply, context: StreamContext): void;
  /** End every open stream and wait for its loop to settle. Idempotent. */
  drain(): Promise<void>;
}

export interface StreamRegistryOptions {
  /** How often the tail re-reads. Defaults to the constant; the drills shorten it. */
  readonly pollIntervalMs?: number | undefined;
  /** How often an idle connection writes its keep-alive comment. */
  readonly heartbeatIntervalMs?: number | undefined;
  /** The connection ceiling. Defaults to the constant. */
  readonly maxConnections?: number | undefined;
}

/**
 * One open stream.
 *
 * Written as a class rather than a closure because the registry has to be able
 * to reach into it at shutdown — ending the response and waking the sleep — and
 * a captured closure would have to expose the same two handles anyway, with
 * less to read.
 */
class StreamConnection {
  readonly #reply: FastifyReply;
  readonly #context: StreamContext;
  readonly #pollIntervalMs: number;
  readonly #heartbeatIntervalMs: number;

  /** Set once the client left, the registry drained, or the ledger went away. */
  #closed = false;
  /** Resolves the current sleep early, so a drain never waits out a poll interval. */
  #wake: (() => void) | null = null;
  /** The last instant anything was written, so the heartbeat is idle-triggered. */
  #lastWriteAt = 0;
  /** Exclusive: the highest sequence this connection has already sent. */
  #cursor = 0;

  constructor(
    reply: FastifyReply,
    context: StreamContext,
    pollIntervalMs: number,
    heartbeatIntervalMs: number,
  ) {
    this.#reply = reply;
    this.#context = context;
    this.#pollIntervalMs = pollIntervalMs;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
  }

  /** Run to completion. The returned promise settles when the connection is over. */
  async run(): Promise<void> {
    const raw = this.#reply.raw;
    // The client hanging up is the ordinary end of a stream, not a failure.
    raw.on("close", () => {
      this.#stop();
    });
    raw.on("error", () => {
      this.#stop();
    });

    this.#reply.hijack();
    raw.writeHead(200, { ...STREAM_HEADERS });
    await this.#write(RETRY_DIRECTIVE);

    try {
      const opened = await this.#open();
      if (opened) await this.#tail();
    } catch {
      // A ledger that closed under a live connection, or a socket that died
      // mid-write. Neither is worth an error frame: the response is already
      // hijacked, so there is no envelope to send, and the client's own
      // reconnect is the recovery path. Ending quietly is the honest answer.
    }
    this.#stop();
    if (!raw.writableEnded) raw.end();
  }

  /**
   * Serve the opening of the connection. Returns whether tailing should follow.
   *
   * The two anchored refusals are answered here and differ on purpose. A
   * malformed anchor never reaches this far — the route refuses it before the
   * hijack, as an ordinary `BAD_REQUEST`. An anchor ahead of the head reaches
   * here, gets one `resync` and a close, and **never a silent restart from
   * zero**: a client holding a position this ledger has never reached is
   * reading a different file or a rebuilt one, and replaying the whole history
   * at it would present a fresh stream as a resumed one.
   *
   * Both branches write a `hello` (V2-B3c). `ANCHOR_AHEAD_OF_HEAD` only ever
   * caught a *shorter* replacement ledger; a rebuilt or different ledger whose
   * head is at or beyond the anchor was served as a continuous resume by both
   * ends. Restating identity on every open is what closes that, and it is the
   * server's whole obligation here — the detection is the client's, because a
   * bare sequence is all this side is given.
   */
  async #open(): Promise<boolean> {
    const { anchor, database } = this.#context;
    const headSequence = this.#context.ledger.status().headSequence;

    if (anchor.kind === "at") {
      if (anchor.sequence > headSequence) {
        await this.#write(
          encodeControlFrame(
            StreamFrame.parse({
              apiContractVersion: API_CONTRACT_VERSION,
              ledgerContractVersion: LEDGER_CONTRACT_VERSION,
              kind: "resync",
              reason: "ANCHOR_AHEAD_OF_HEAD",
            }),
          ),
        );
        return false;
      }
      // Restate which ledger this is, BEFORE any replayed row (V2-B3c).
      //
      // This branch used to return here having said nothing about identity,
      // and that was the hole: a resumed connection is exactly the one whose
      // ledger a client cannot otherwise learn. `Last-Event-ID` is a bare
      // decimal sequence — L1 pins the only `id:` producer to
      // `String(sequence)`, and only the `event` arm gets one — so the server
      // is handed a number and cannot tell a resume of this ledger from a
      // resume of a different one. It does not try. It restates what it knows
      // about THIS connection and lets the client compare, which is the whole
      // design and is recorded in ADR 0028.
      //
      // Before the replay rather than after, because a client that learned the
      // ledger had changed only after applying rows from it would have already
      // mixed two ledgers in one scope. `encodeControlFrame` takes no sequence
      // and writes no `id:`, so this frame structurally cannot advance the
      // browser's cursor: restating identity costs nothing at the seam.
      await this.#write(
        encodeControlFrame(
          StreamFrame.parse({
            apiContractVersion: API_CONTRACT_VERSION,
            ledgerContractVersion: LEDGER_CONTRACT_VERSION,
            kind: "hello",
            database,
            headSequence,
            resumedFrom: anchor.sequence,
          }),
        ),
      );
      // Resume exactly where the client says it got to. The catch-up is the
      // ordinary tail loop with a cursor behind the head, so there is one
      // implementation of "send the rows after this one" rather than two that
      // could disagree at the seam between replay and live.
      this.#cursor = anchor.sequence;
      return true;
    }

    // The live open. `resumedFrom` is `null` and not absent: the field is
    // required, so "opened live" is a value a client reads rather than a key it
    // fails to find.
    await this.#write(
      encodeControlFrame(
        StreamFrame.parse({
          apiContractVersion: API_CONTRACT_VERSION,
          ledgerContractVersion: LEDGER_CONTRACT_VERSION,
          kind: "hello",
          database,
          headSequence,
          resumedFrom: null,
        }),
      ),
    );
    // Live from the head: history is the paged `events` route's job, and a
    // stream that backfilled an entire ledger on first connect would be doing
    // that job badly.
    this.#cursor = headSequence;
    return true;
  }

  /** Poll, emit, advance. The whole tail, and the whole replay. */
  async #tail(): Promise<void> {
    while (!this.#isClosed()) {
      const page = this.#context.ledger.listEvents({
        afterSequence: this.#cursor,
        limit: STREAM_REPLAY_PAGE,
        taskId: this.#context.filters.taskId,
        type: this.#context.filters.type,
        emittedBy: this.#context.filters.emittedBy,
        toState: this.#context.filters.toState,
      });

      for (const record of page.events) {
        if (this.#isClosed()) return;
        const item = timelineItem(record);
        const frame = StreamFrame.parse({
          apiContractVersion: API_CONTRACT_VERSION,
          ledgerContractVersion: LEDGER_CONTRACT_VERSION,
          kind: "event",
          channel: STREAM_CHANNEL_BY_EVENT_TYPE[item.type],
          item,
        });
        await this.#write(encodeEventFrame(frame, record.sequence));
        // The cursor advances to the row that was just sent, and only ever to
        // that. This is the single assignment that decides what "no gap, no
        // duplicate" means across a reconnect.
        this.#cursor = record.sequence;
      }

      // A backlog is drained without sleeping between pages: a client that
      // reconnects a thousand rows behind should not wait a poll interval per
      // page to catch up.
      if (page.hasMore) continue;
      if (this.#isClosed()) return;
      await this.#idle();
    }
  }

  /** Wait out one poll interval, writing the keep-alive if the line has gone quiet. */
  async #idle(): Promise<void> {
    if (Date.now() - this.#lastWriteAt >= this.#heartbeatIntervalMs) {
      await this.#write(HEARTBEAT_COMMENT);
    }
    await this.#sleep(this.#pollIntervalMs);
  }

  /**
   * Write, and stop until the socket asks for more.
   *
   * `write` returning false is the whole backpressure story: the poll pauses
   * here until `drain`, and because the cursor has not advanced past what was
   * sent, nothing is lost by waiting. There is no buffer to grow.
   */
  async #write(text: string): Promise<void> {
    if (this.#isClosed()) return;
    const raw = this.#reply.raw;
    if (raw.writableEnded || raw.destroyed) {
      this.#stop();
      return;
    }
    this.#lastWriteAt = Date.now();
    if (raw.write(text)) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        raw.off("drain", finish);
        this.#wake = null;
        resolve();
      };
      raw.once("drain", finish);
      // A drain that never arrives because the client vanished must not hold
      // the shutdown: the registry wakes this the same way it wakes a sleep.
      this.#wake = finish;
    });
  }

  /** Sleep, interruptibly. A drain resolves this at once rather than waiting it out. */
  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, ms);
      // A pending poll must never be the reason a process refuses to exit.
      timer.unref();
      this.#wake = (): void => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }

  /**
   * Is this connection over?
   *
   * A method rather than a bare field read, and deliberately: `#closed` is set
   * from a socket `close` event, which is invisible to the type checker's
   * control-flow analysis. Read as a field, every guard below narrows to
   * "always false" and the linter is right to say so — while the guard is
   * genuinely load-bearing at runtime. Reading through a call keeps the check
   * honest in both places at once.
   */
  #isClosed(): boolean {
    return this.#closed;
  }

  /** Mark the connection over and release whatever it is waiting on. */
  #stop(): void {
    this.#closed = true;
    const wake = this.#wake;
    this.#wake = null;
    if (wake !== null) wake();
  }

  /** End this connection from the outside, for shutdown. */
  close(): void {
    this.#stop();
    const raw = this.#reply.raw;
    if (!raw.writableEnded && !raw.destroyed) raw.end();
  }
}

/**
 * The open-connection registry, and the drain the shutdown path depends on.
 *
 * **This is not bookkeeping for its own sake.** Without it, `app.close()` has
 * two ways to go wrong and takes both: the ledger closes under a live handler,
 * which raises `LedgerClosedError` inside a response that has already been
 * hijacked and can no longer carry an error envelope; and the server waits on a
 * socket that is never going to become idle, so the close never resolves at
 * all. The registry exists so shutdown is an order — end the streams, then
 * close the ledger — rather than a race.
 */
export function createStreamRegistry(options: StreamRegistryOptions = {}): StreamRegistry {
  const connections = new Set<StreamConnection>();
  const running = new Set<Promise<void>>();
  const pollIntervalMs = options.pollIntervalMs ?? STREAM_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? STREAM_HEARTBEAT_INTERVAL_MS;
  const capacity = options.maxConnections ?? STREAM_MAX_CONNECTIONS;

  return {
    get size(): number {
      return connections.size;
    },
    capacity,
    isFull(): boolean {
      return connections.size >= capacity;
    },
    serve(reply: FastifyReply, context: StreamContext): void {
      const connection = new StreamConnection(
        reply,
        context,
        pollIntervalMs,
        heartbeatIntervalMs,
      );
      connections.add(connection);
      const task = connection.run().finally(() => {
        connections.delete(connection);
        running.delete(task);
      });
      running.add(task);
    },
    async drain(): Promise<void> {
      for (const connection of [...connections]) connection.close();
      await Promise.allSettled([...running]);
    },
  };
}

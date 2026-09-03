/**
 * Loopback. Not configurable, by design.
 *
 * The observation surface shows every task, worker and transition with no
 * authentication in front of it. A bind address is not a deployment
 * preference here: `0.0.0.0` would publish the whole control plane to the
 * local network. See `docs/architecture/0003-read-only-observation-plane.md`.
 */
export const SERVER_BIND_HOST = "127.0.0.1";

/** Default local port. The port is not a law; a caller may choose another. */
export const SERVER_DEFAULT_PORT = 7517;

/**
 * The event stream's four ceilings (V2-B3a).
 *
 * Every one of them exists because the stream is the plane's first response
 * that does not end on its own. A bounded body needs no budget; a connection
 * that lives until someone closes it needs four.
 *
 * **The tail is a poll, and the number says so.** This process opens the
 * ledger read-only and the writer is a different process, so SQLite's
 * `update_hook` cannot fire here — there is no push to subscribe to without
 * introducing a broker, which would be the second sequence authority the
 * design forbids. So the tail asks `listEvents` again every interval. ADR 0017
 * states this in those words rather than implying push semantics.
 */
export const STREAM_POLL_INTERVAL_MS = 250;

/**
 * How often an idle connection proves it is still there.
 *
 * Written as an SSE **comment** (`: heartbeat`), which browsers do not deliver
 * to `onmessage` and which therefore cannot advance `Last-Event-ID`. That is
 * the whole reason a comment is used instead of a frame: a keep-alive that
 * could move a client's cursor would be a keep-alive that loses events.
 */
export const STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Rows per catch-up read while a reconnecting client is behind the head.
 *
 * The replay is paged rather than slurped for the same reason every other read
 * here is: a client that reconnects against a ledger with a hundred thousand
 * rows must not make this process build a hundred thousand DTOs before it
 * writes the first byte.
 */
export const STREAM_REPLAY_PAGE = 200;

/**
 * How many streams this process will hold at once.
 *
 * Loopback and single-operator, so the number is small on purpose: it is a
 * fuse against a leaking reconnect loop, not a capacity plan. The ninth
 * connection is refused with `STREAM_CAPACITY` **before** anything is
 * hijacked, so the refusal arrives as an ordinary error envelope the caller
 * can read.
 */
export const STREAM_MAX_CONNECTIONS = 8;

import { createServer } from "node:http2";
import type { Http2Server, ServerHttp2Session } from "node:http2";

import { createEndpointHandler } from "@restatedev/restate-sdk";
import type { VirtualObjectDefinition } from "@restatedev/restate-sdk";

import { LOOPBACK_HOST, RUNTIME_SERVICE_PORT } from "@acp/runtime";

/**
 * The only file in this repository permitted to import `node:http2`.
 *
 * It exists because the SDK's own helpers cannot honour the ADR. In
 * `dist/endpoint/node_endpoint.js`, `NodeEndpoint.listen(port)` calls
 * `server.listen(actualPort)` with **no host argument**, so it binds every
 * interface, and `ServeOptions` has no host field anywhere to fix that with.
 * ADR 0004 pins `127.0.0.1:9080` and requires the drills to prove no
 * non-loopback listener exists, so `serve()` and `endpoint().listen()` are both
 * unusable here and the fence forbids them by pattern.
 *
 * The supported remedy is the documented one: build a handler and own the
 * server, which is the only way the bind address is ours to choose.
 */

export interface EndpointHandle {
  readonly server: Http2Server;
  readonly host: string;
  readonly port: number;
  /**
   * Shut the listener down within a bound.
   *
   * `http2.Server.close()` waits for every session to end, and Restate holds
   * persistent HTTP/2 sessions open, so an unbounded close never resolves and
   * whatever teardown follows it never runs. Sessions are therefore tracked and
   * destroyed explicitly, and the wait has a deadline: a listener that will not
   * die must not be able to strand a drill's remaining cleanup, because the
   * leaked-process assertion is part of what the drill proves.
   */
  close(deadlineMs?: number): Promise<{ readonly graceful: boolean }>;
}

export interface StartEndpointOptions {
  readonly services: readonly VirtualObjectDefinition<string, unknown>[];
  /** Defaults to the pinned service port. 0 asks the OS for a free one. */
  readonly port?: number | undefined;
}

/**
 * Bind the endpoint on loopback and assert that is what happened.
 *
 * `server.address()` is checked rather than trusted: it returns a string for a
 * unix socket and null when nothing is bound, and either would mean the pin was
 * not honoured. A wrong address here is the failure the whole assertion exists
 * to catch, so it throws rather than warns.
 */
export function startEndpoint(options: StartEndpointOptions): Promise<EndpointHandle> {
  const handler = createEndpointHandler({ services: [...options.services] });
  const server = createServer(handler);
  const port = options.port ?? RUNTIME_SERVICE_PORT;

  // Tracked so teardown can end them; Restate keeps them open indefinitely.
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });

  return new Promise<EndpointHandle>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({ host: LOOPBACK_HOST, port }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPromise(
          new Error("the endpoint did not bind a TCP address; refusing to serve"),
        );
        return;
      }
      if (address.address !== LOOPBACK_HOST) {
        server.close();
        rejectPromise(
          new Error(
            "the endpoint bound " + address.address + " rather than " + LOOPBACK_HOST,
          ),
        );
        return;
      }
      resolvePromise({
        server,
        host: address.address,
        port: address.port,
        close: (deadlineMs = 10_000) =>
          new Promise<{ graceful: boolean }>((done) => {
            let settled = false;
            const finish = (graceful: boolean): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              done({ graceful });
            };

            const timer = setTimeout(() => {
              for (const session of sessions) session.destroy();
              finish(false);
            }, deadlineMs);
            timer.unref();

            server.close(() => {
              finish(true);
            });
            // Destroy first, or `close` waits on sessions that never end.
            for (const session of sessions) session.destroy();
          }),
      });
    });
  });
}

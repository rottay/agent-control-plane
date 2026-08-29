import type { FastifyInstance } from "fastify";

import { buildServer } from "../build-server/index.js";
import { SERVER_BIND_HOST, SERVER_DEFAULT_PORT } from "../constants/index.js";

export interface StartServerOptions {
  /**
   * Path to the ledger database this process reads. Required: there is no
   * default and no environment variable fallback. The caller must say
   * explicitly which database this process observes.
   */
  readonly ledgerPath: string;
  readonly port?: number | undefined;
  /**
   * Present only so an unsafe bind is rejected loudly rather than silently
   * ignored. The only value this ever accepts is the loopback constant; it
   * is not a configuration knob.
   */
  readonly host?: string | undefined;
  readonly logger?: boolean | undefined;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the observation server. The only entrypoint in this package that
 * opens a socket.
 *
 * Never runs on import: a caller must build `StartServerOptions` and invoke
 * this explicitly, naming the ledger path itself. A bind host other than the
 * loopback constant is refused before a socket is ever opened; P1 has no
 * configuration path that reaches `0.0.0.0` or any other address.
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const host = options.host ?? SERVER_BIND_HOST;
  if (host !== SERVER_BIND_HOST) {
    throw new Error(
      "refusing to bind host " +
        JSON.stringify(host) +
        ": this plane may only bind " +
        SERVER_BIND_HOST +
        " in P1",
    );
  }
  const requestedPort = options.port ?? SERVER_DEFAULT_PORT;
  const app = buildServer({ ledgerPath: options.ledgerPath, logger: options.logger });
  await app.listen({ host, port: requestedPort });

  // The OS assigns the real port when `requestedPort` is 0; report that one,
  // never the request value, so a caller asking for an ephemeral port gets
  // back the port that is actually open.
  const address = app.server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : requestedPort;

  return {
    app,
    host,
    port,
    close: () => app.close(),
  };
}

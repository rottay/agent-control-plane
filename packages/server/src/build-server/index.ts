import Fastify, { type FastifyInstance } from "fastify";

import { classifyFastifyError, sendApiError } from "../errors/index.js";
import { openLedgerSource } from "../ledger-source/index.js";
import { registerRoutes } from "../routes/index.js";

export interface BuildServerOptions {
  /**
   * Path to the ledger database this application reads.
   *
   * Required; there is no default. The path is opened exactly once, here,
   * only through `openLedger(path, { readOnly: true })`: this function never
   * appends, rebuilds or migrates, and neither does anything it calls.
   */
  readonly ledgerPath: string;
  readonly logger?: boolean | undefined;
}

/**
 * Build the Fastify application. Does not listen.
 *
 * This is the testable seam the P1 lane packet asks for: a caller hands it a
 * path to a database it fully controls, disposable ledger in a test or a real
 * one at runtime, and gets back an application it can `.inject()` against or
 * `.listen()` on. Importing this module has no effect; calling this function
 * with a bad or missing path has no effect beyond building an application
 * whose routes truthfully report the ledger as unavailable.
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  // Fail-closed, both of the two independent ways Fastify can answer without
  // ever reaching a route handler this package wrote:
  //
  // - `setErrorHandler` catches an unparseable or oversized body, a body
  //   whose declared content type it rejected, and a schema failure — every
  //   case where Fastify still built a `FastifyRequest`/`FastifyReply` pair
  //   before failing.
  // - `frameworkErrors` catches the one case where it did not: a malformed
  //   URI component (`%zz`, an incomplete percent escape) that the router
  //   cannot even decode enough to build a request. Fastify answers this one
  //   through a wholly separate path (`onBadUrl`/`onInvalidUrl`, wired via the
  //   `frameworkErrors` constructor option), not through `setErrorHandler`,
  //   so both have to be set for every Fastify-raised failure to leave in the
  //   one `ApiError` envelope rather than Fastify's own default shape — which
  //   a strict reader cannot tell apart from a genuine contract mismatch.
  //
  // A handler wrapped by `guarded()` (routes/index.ts) never lets an exception
  // reach either path: it classifies everything itself and sends the
  // envelope directly. What reaches these two handlers is always Fastify's
  // own doing, never this package's route logic.
  const app = Fastify({
    logger: options.logger ?? false,
    frameworkErrors: (error, _request, reply) => {
      const classified = classifyFastifyError(error);
      sendApiError(reply, classified.code, classified.message, classified.detail);
    },
  });
  const source = openLedgerSource(options.ledgerPath);

  app.addHook("onClose", () => {
    if (source.kind === "open") {
      source.ledger.close();
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (reply.sent) return;
    const classified = classifyFastifyError(error);
    sendApiError(reply, classified.code, classified.message, classified.detail);
  });

  registerRoutes(app, source);
  return app;
}

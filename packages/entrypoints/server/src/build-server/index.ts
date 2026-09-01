import Fastify, { type FastifyInstance } from "fastify";

import { classifyFastifyError, sendApiError } from "../errors/index.js";
import { openLedgerSource } from "../ledger-source/index.js";
import { registerRoutes } from "../routes/index.js";
import {
  ROADMAP_CONTENT_MAX_BYTES,
  ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES,
} from "@acp/api-contracts";

export interface BuildServerOptions {
  /**
   * Path to the ledger database this application reads.
   *
   * Required; there is no default. The path is opened exactly once, here,
   * only through `openLedger(path, { readOnly: true })`: this function never
   * appends, rebuilds or migrates, and neither does anything it calls.
   */
  readonly ledgerPath: string;
  /**
   * Path to the owner's accounts file, when the operator wired one (P8-8F).
   *
   * Optional, and with **no default and no environment fallback**: the accounts
   * loader's standing law is that it takes the path from its caller, and this
   * server is that caller. Absent means the accounts route answers
   * `UNAVAILABLE(ACCOUNTS_FILE_UNCONFIGURED)` — a true statement about this
   * process, not an error.
   *
   * Operator wiring: the start invocation passes the path explicitly, exactly
   * as it passes `ledgerPath`. Nothing infers it from `$HOME` or a convention,
   * because a plane that guesses where secrets live is a plane that reads a
   * file nobody meant to give it.
   */
  readonly accountsFilePath?: string | undefined;
  /**
   * Path to the write bearer token file (P8-8G). Optional, no default and no
   * environment fallback, exactly like the other two paths.
   *
   * Absent is **not** "no authentication" — it is "no write can be
   * authorized", and every write answers 403. An unconfigured door is shut.
   */
  readonly writeBearerPath?: string | undefined;
  /**
   * The instant supplier the accounts read uses, when a caller wants to pin it
   * (P8-8G causal).
   *
   * Optional, defaulting to the real clock, so omitting it reproduces the
   * previous behaviour exactly — production passes nothing and reads
   * `new Date().toISOString()` as before.
   *
   * It exists because the accounts read compares the owner file's declared
   * reset against "now", and a suite that cannot hold "now" still has to
   * assert on the comparison's result. Before this seam the only way to do
   * that was a fixture instant far enough in the future to outlive the run —
   * which is a deadline, not a fixture, and it expired mid-cohort and turned a
   * `DECLARED` reset into `RESET_ALREADY_PASSED`. A pinned instant has no
   * expiry date.
   *
   * Deliberately **not** on the operator's start surface. Every other option
   * here (`accountsFilePath`, `writeBearerPath`) is operator configuration
   * with an operator's reason to exist; a production clock that can be frozen
   * from the command line is a footgun with no such reason. The bin exposes no
   * flag for it, and a drill asserts that it does not.
   */
  readonly now?: (() => string) | undefined;
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
    // Derived, never a second number (P8-8G A2). Fastify's default body limit
    // is exactly 1 MiB — the same figure as the document ceiling — so a
    // document *at* the ceiling was refused by the transport before the schema
    // ever saw it, and the plane advertised a limit it could not accept. The
    // allowance covers the JSON envelope around the document and nothing else:
    // a document one byte over the ceiling is still refused, by the schema,
    // which weighs the content itself.
    bodyLimit: ROADMAP_CONTENT_MAX_BYTES + ROADMAP_WRITE_ENVELOPE_ALLOWANCE_BYTES,
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

  registerRoutes(app, source, options.accountsFilePath, options.writeBearerPath, options.now);
  return app;
}

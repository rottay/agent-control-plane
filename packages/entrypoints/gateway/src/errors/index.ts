import { API_CONTRACT_VERSION, ApiError, type ApiErrorCode } from "@acp/protocol";
import type { FastifyReply } from "fastify";

/**
 * The one error shape this plane ever sends, and the HTTP status each closed
 * code answers with.
 *
 * The status is chosen once, here, so a route handler never has to decide it
 * inline: `BAD_REQUEST`/`NOT_FOUND`/`METHOD_NOT_ALLOWED` are the caller's
 * fault, `CONTRACT_VERSION_MISMATCH` and `LEDGER_UNAVAILABLE` mean this build
 * cannot currently serve this database, `LEDGER_INTEGRITY` means the database
 * answered but the answer failed a trust check, `WRITE_REFUSED` means a
 * well-formed write was refused by the decision that owns it, and `INTERNAL`
 * is reserved for anything this module did not deliberately classify.
 *
 * `WRITE_REFUSED` answers **409**, beside `CONTRACT_VERSION_MISMATCH` and
 * deliberately not merged into it. Both are conflicts, but they are conflicts
 * about different things: one says this build cannot serve this database, the
 * other says this request lost a race against the recorded state. Only the
 * second is worth retrying against a fresh head, and a caller can only know
 * that if the two carry different names.
 */
/**
 * The three meanings of 409 on this plane (P8-8G R1).
 *
 * `CONTRACT_VERSION_MISMATCH` — the caller and this build disagree about the
 * contract; retrying changes nothing until one of them moves.
 *
 * `WRITE_REFUSED` covers two situations a caller must tell apart, and the
 * refusal's own name in the body is what tells them:
 *
 *   - the decision refused a coherent request (`HEAD_MISMATCH` and its
 *     siblings) — the caller's view of the head is stale, and re-reading it
 *     and retrying is the correct response;
 *   - the request lost a **race** (`WRITE_CONFLICT`) — the request was right
 *     when it was made and another writer simply arrived first. Retrying is
 *     also correct here, and the retry will fold the moved head and get a
 *     clean `HEAD_MISMATCH` if it is now genuinely stale.
 *
 * Only the last two are worth distinguishing for retry, and both are
 * retryable — which is exactly why the third, a build that cannot serve the
 * caller at all, must not share their status.
 */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONTRACT_VERSION_MISMATCH: 409,
  WRITE_REFUSED: 409,
  // 401: a credential is required and was not presented, or was wrong.
  AUTH_REQUIRED: 401,
  // 403, not 401: no credential would work, because this process holds none.
  // A 401 invites a retry with better headers; there is no better header.
  WRITE_BEARER_UNCONFIGURED: 403,
  LEDGER_UNAVAILABLE: 503,
  LEDGER_INTEGRITY: 500,
  INTERNAL: 500,
};

/**
 * A deliberately raised route failure.
 *
 * Carries only a closed code, a short static message and an optional bounded
 * detail string that a handler wrote itself. It never carries a caught error's
 * `.message`: an upstream message may embed the ledger's absolute path (a
 * `LedgerOpenError` does exactly that), and this class exists so nothing here
 * can forward one by accident.
 */
export class ApiRouteError extends Error {
  readonly code: ApiErrorCode;
  readonly detail: string | null;

  constructor(code: ApiErrorCode, message: string, detail: string | null = null) {
    super(message);
    this.name = "ApiRouteError";
    this.code = code;
    this.detail = detail;
  }
}

/** Build and send the envelope for a deliberately classified failure. */
export function sendApiError(
  reply: FastifyReply,
  code: ApiErrorCode,
  message: string,
  detail: string | null = null,
): void {
  const body = ApiError.parse({
    apiContractVersion: API_CONTRACT_VERSION,
    error: { code, message, detail },
  });
  reply.code(STATUS_BY_CODE[code]).send(body);
}

/**
 * Classify an unexpected thrown value into the closed error set.
 *
 * This is the last line of defense, reached only when a handler let an
 * exception escape rather than classifying it itself. It never reads
 * `error.message` for anything other than a `LedgerError` subclass whose
 * message shape is already known to carry no path, and even then only through
 * the named branches below, never generically.
 */
export function classifyUnexpectedError(error: unknown): {
  readonly code: ApiErrorCode;
  readonly message: string;
} {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "LedgerIntegrityError":
      return {
        code: "LEDGER_INTEGRITY",
        message: "the ledger's stored data failed an integrity check",
      };
    case "LedgerMigrationError":
      return {
        code: "CONTRACT_VERSION_MISMATCH",
        message: "the ledger database schema does not match this build's contract",
      };
    case "LedgerOpenError":
    case "LedgerClosedError":
      return {
        code: "LEDGER_UNAVAILABLE",
        message: "the configured ledger database is not currently readable",
      };
    default:
      return { code: "INTERNAL", message: "an unexpected server error occurred" };
  }
}

function readErrorField(error: unknown, field: "statusCode" | "code"): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  if (!(field in error)) return undefined;
  return (error as Record<string, unknown>)[field];
}

/**
 * Classify an error Fastify itself raised, outside any route handler.
 *
 * A handler wrapped by `guarded()` never lets an exception reach Fastify's own
 * error pipeline: it classifies everything itself and sends the envelope
 * directly. What reaches `app.setErrorHandler` is therefore always something
 * Fastify raised on its own, before or around a handler, that no route ever
 * got a chance to shape: a malformed URI component the router could not
 * decode, an invalid or oversized body, a body whose declared content type it
 * could not parse, a schema validation failure. Fastify already marks every
 * one of these with a numeric `statusCode` in the 400s; this function trusts
 * that marker rather than enumerating Fastify's internal error codes, so it
 * keeps working if that internal set changes.
 *
 * `error.code` (a short, fixed identifier such as `FST_ERR_BAD_URL`, never
 * request content) is safe to surface as `detail`; `error.message` is not,
 * because Fastify's own messages sometimes echo back the malformed input, and
 * this boundary never forwards caller-supplied content in an error.
 */
export function classifyFastifyError(error: unknown): {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly detail: string | null;
} {
  const statusCode = readErrorField(error, "statusCode");
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    const code = readErrorField(error, "code");
    return {
      code: "BAD_REQUEST",
      message: "the request could not be parsed",
      detail: typeof code === "string" && code.length > 0 && code.length <= 100 ? code : null,
    };
  }
  const classified = classifyUnexpectedError(error);
  return { ...classified, detail: null };
}

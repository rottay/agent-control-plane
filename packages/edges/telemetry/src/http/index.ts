import type { AdmittedOtlpEndpoint } from "../admission/index.js";
import type { TelemetryExportRefusal } from "../contract/index.js";

/**
 * The only file in this package that reaches the network (V2-B5/R11).
 *
 * The fence pins that by exact path — every other file in this package, tests
 * included, fails on a `fetch(` — and it does not lift the builtin ban to do
 * it: `node:net`, `node:http`, `node:https`, `node:tls` and the rest stay
 * forbidden here as everywhere else, which is what makes "no socket library" a
 * property of the build rather than a promise. This leg uses the platform
 * global, exactly as every other network call in this repository does.
 *
 * **The target can only have come from the admission.** There is no URL literal
 * anywhere below — no scheme, no address, no path — and no URL is parsed. The
 * admitted string is posted verbatim. A transport that could assemble a target
 * could assemble a different one, and this file is where that would happen if
 * it could happen anywhere.
 *
 * **No credential can travel.** No authorization header by default, no cookie,
 * no `credentials`, no dispatcher, and the environment is never read. Node's
 * global fetch ignores proxy variables unless a dispatcher is installed, and
 * nothing here installs one. The admitted headers are the only headers besides
 * the content type, and the admission refuses the credential-shaped names
 * outright — so "we do not send one" is backed by "there is nothing here that
 * could".
 *
 * **Nothing thrown ever leaves.** Every rejection is caught and classified into
 * a {@link TelemetryExportRefusal}. That is restriction 3's first mechanism: a
 * collector falling over cannot affect routing, execution or recovery, because
 * there is no exception for it to propagate through.
 *
 * `redirect: "manual"` and not `"error"`: `"error"` rejects with a `TypeError`
 * indistinguishable from a connection failure, so a redirect away from the
 * admitted target would be classified generically and could never be asserted.
 * A redirect is how an endpoint sends this client somewhere else, and it is
 * refused visibly.
 */

/** Where in this leg a refusal was decided. A coordinate, never a clock read. */
const AT_REQUEST = "endpoint.request";
const AT_RESPONSE = "endpoint.response";

/** The success band. Everything else is a refusal, including a redirect. */
const STATUS_OK_MIN = 200;
const STATUS_OK_MAX = 299;
const STATUS_REDIRECT_MIN = 300;
const STATUS_REDIRECT_MAX = 399;

export type OtlpPostOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TelemetryExportRefusal; readonly at: string };

/**
 * How an abort announces itself, by name rather than by instance.
 *
 * `AbortSignal.timeout` rejects with a `DOMException` whose name is
 * `TimeoutError`; an externally aborted signal gives `AbortError`. Matching on
 * the name rather than on a constructor keeps this honest across realms, where
 * an `instanceof` check silently answers false.
 */
const ABORT_NAMES: readonly string[] = ["TimeoutError", "AbortError"];

function isAbort(error: unknown): boolean {
  return error instanceof Error && ABORT_NAMES.includes(error.name);
}

/**
 * Post one serialized batch to the admitted endpoint. One attempt, one outcome.
 *
 * No retry, and that is a decision: a retry loop would turn a dead collector
 * into a caller this edge holds open, and the whole point of the port above is
 * that a failed export is a returned value nobody has to wait for.
 */
export async function postOtlpBody(
  endpoint: AdmittedOtlpEndpoint,
  body: string,
): Promise<OtlpPostOutcome> {
  let response: Response;
  try {
    response = await fetch(endpoint.target, {
      method: "POST",
      headers: { ...endpoint.headers, "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
  } catch (error: unknown) {
    return { ok: false, reason: isAbort(error) ? "ENDPOINT_TIMEOUT" : "ENDPOINT_UNREACHABLE", at: AT_REQUEST };
  }

  const status = response.status;
  if (status >= STATUS_REDIRECT_MIN && status <= STATUS_REDIRECT_MAX) {
    return { ok: false, reason: "REDIRECT_REFUSED", at: AT_RESPONSE };
  }
  if (status < STATUS_OK_MIN || status > STATUS_OK_MAX) {
    return { ok: false, reason: "ENDPOINT_REJECTED", at: AT_RESPONSE };
  }
  return { ok: true };
}

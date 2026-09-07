import {
  OTLP_HEADERS_MAX,
  OTLP_HEADER_VALUE_MAX_BYTES,
  OTLP_SERVICE_NAME_DEFAULT,
  OTLP_SERVICE_NAME_MAX_LENGTH,
  OTLP_TIMEOUT_DEFAULT_MS,
  OTLP_TIMEOUT_MAX_MS,
} from "../contract/index.js";
import type { TelemetryAdmissionRefusal } from "../contract/index.js";

/**
 * The only file in this package that decides what may be talked to (V2-B5/R11).
 *
 * It is the only one permitted to parse a URL, the only one that names a
 * loopback address, and the only one that knows the traces path — the fence
 * pins all three by exact path, in the idiom the tool edge already holds.
 * Everything downstream receives an {@link AdmittedOtlpEndpoint} and a string
 * it did not build.
 *
 * **Loopback, plaintext, literal.** The candidate is admitted only when its
 * hostname is one of the two literal addresses that are this machine.
 * `localhost` is refused with every other name, and it is refused BY NAME
 * because it is the one a reviewer expects to pass: resolving a name means DNS,
 * and a name that resolves on-box today is a remote collector tomorrow. That
 * refusal is also why no `node:dns` ban would have been sufficient on its own —
 * a name is resolved by the network stack, importing nothing.
 *
 * **`https` is refused in R11, and the refusal is a decision.** A loopback TLS
 * endpoint needs a trust decision this package cannot make honestly, and
 * plaintext to a literal loopback address on this host is what the restriction
 * authorised. A remote host and TLS are a widening with their own argument,
 * their own law and their own record; this file is the one that would change,
 * which is the point of putting the decision here.
 *
 * **The target is joined once, here.** OTLP/HTTP names one path for traces, and
 * this is where the base and that path become one string. Downstream uses it
 * verbatim and can neither assemble a URL nor name a different one.
 */

declare const admittedBrand: unique symbol;

/** What an operator's config offers, before anything has judged it. */
export interface OtlpEndpointCandidate {
  /** The collector's base URL, scheme and authority. No path, query or hash. */
  readonly endpoint: string;
  /** Headers to send beside the content type. Bounded, and never a default. */
  readonly headers?: Readonly<Record<string, string>>;
  /** How long one request may take. Defaults, and is capped, by the contract. */
  readonly timeoutMs?: number;
  /** What the resource reports as `service.name`. */
  readonly serviceName?: string;
}

interface AdmittedOtlpEndpointFields {
  /** The final request target, verbatim. Nothing downstream may rebuild it. */
  readonly target: string;
  /** Exactly the headers admitted here, and never a credential by default. */
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly serviceName: string;
}

/**
 * An endpoint this package has judged. Branded, and the brand is the guarantee.
 *
 * The only way to obtain a value of this type is {@link admitOtlpEndpoint}, so
 * the transport below is structurally incapable of being handed a raw string.
 * Same doctrine as `TelemetryEvent` upstream: a type whose only mint site is a
 * gate cannot be produced by a caller who skipped the gate.
 */
export type AdmittedOtlpEndpoint = AdmittedOtlpEndpointFields & {
  readonly [admittedBrand]: true;
};

export type OtlpAdmissionOutcome =
  | { readonly ok: true; readonly endpoint: AdmittedOtlpEndpoint }
  | { readonly ok: false; readonly refusal: TelemetryAdmissionRefusal; readonly at: string };

/** The only two hostnames that are this machine, spelled as literals. */
const OTLP_LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1"];

/** The one path OTLP/HTTP names for trace export, joined exactly once. */
const OTLP_TRACES_PATH = "/v1/traces";

/** A header name in the token grammar: no separators, no whitespace, no colon. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** A header value with no control character and no line break to inject with. */
const HEADER_VALUE = /^[ -~]*$/;

/**
 * Headers this edge refuses to be configured with, whatever the operator meant.
 *
 * The transport carries no credential by construction — it builds no header of
 * its own beyond the content type — and this keeps the config path from being
 * the way one arrives anyway. If a collector ever requires an API key, it
 * enters through a named decision and the credential-guard laws apply to it;
 * it does not arrive because nothing stopped it.
 */
const OTLP_FORBIDDEN_HEADER_NAMES: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "content-type",
];

function refuse(refusal: TelemetryAdmissionRefusal, at: string): OtlpAdmissionOutcome {
  return { ok: false, refusal, at };
}

function admitHeaders(
  offered: Readonly<Record<string, string>>,
): { readonly ok: true; readonly headers: Readonly<Record<string, string>> } | { readonly ok: false } {
  const names = Object.keys(offered);
  if (names.length > OTLP_HEADERS_MAX) return { ok: false };
  const admitted: Record<string, string> = {};
  // Sorted, so two configs that name the same headers produce byte-identical
  // requests whatever order the object literal happened to carry them in.
  for (const name of [...names].sort()) {
    const value = offered[name];
    if (value === undefined) return { ok: false };
    if (!HEADER_NAME.test(name)) return { ok: false };
    if (OTLP_FORBIDDEN_HEADER_NAMES.includes(name.toLowerCase())) return { ok: false };
    if (!HEADER_VALUE.test(value)) return { ok: false };
    if (value.length > OTLP_HEADER_VALUE_MAX_BYTES) return { ok: false };
    admitted[name] = value;
  }
  return { ok: true, headers: Object.freeze(admitted) };
}

/**
 * Judge a candidate endpoint field by field, and say which way it went.
 *
 * Field-exact refusals rather than one verdict, for the reason the tool edge
 * gives: a caller told only "refused" cannot tell a typo from a policy, and a
 * test told only "refused" cannot assert which law fired.
 */
export function admitOtlpEndpoint(candidate: OtlpEndpointCandidate): OtlpAdmissionOutcome {
  let url: URL;
  try {
    url = new URL(candidate.endpoint);
  } catch {
    return refuse("ENDPOINT_MALFORMED", "endpoint");
  }

  if (url.protocol !== "http:") {
    return refuse("ENDPOINT_SCHEME_REFUSED", "endpoint.protocol");
  }
  if (url.username !== "" || url.password !== "") {
    return refuse("ENDPOINT_CREDENTIALED", "endpoint.credentials");
  }
  // `URL` brackets an IPv6 host; compare against the literal it wraps.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!OTLP_LOOPBACK_HOSTS.includes(hostname)) {
    return refuse("ENDPOINT_HOST_REFUSED", "endpoint.hostname");
  }
  if (url.port !== "") {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return refuse("ENDPOINT_HOST_REFUSED", "endpoint.port");
    }
  }
  // A base is an origin and nothing else. Admitting a path here would mean
  // deciding whether to join, replace or refuse it, and a join that argued with
  // its input is how a target stops being the one an operator wrote down.
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    return refuse("ENDPOINT_PATH_REFUSED", "endpoint.path");
  }

  const headers = admitHeaders(candidate.headers ?? {});
  if (!headers.ok) return refuse("ENDPOINT_HEADERS_REFUSED", "headers");

  const timeoutMs = candidate.timeoutMs ?? OTLP_TIMEOUT_DEFAULT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > OTLP_TIMEOUT_MAX_MS) {
    return refuse("ENDPOINT_TIMEOUT_REFUSED", "timeoutMs");
  }

  const serviceName = candidate.serviceName ?? OTLP_SERVICE_NAME_DEFAULT;
  // It reaches the resource attributes, so it is wire content and is bounded
  // like wire content. An unbounded string here would be a channel.
  if (
    serviceName === "" ||
    serviceName.length > OTLP_SERVICE_NAME_MAX_LENGTH ||
    !HEADER_VALUE.test(serviceName)
  ) {
    return refuse("ENDPOINT_SERVICE_NAME_REFUSED", "serviceName");
  }

  return {
    ok: true,
    endpoint: Object.freeze({
      target: url.origin + OTLP_TRACES_PATH,
      headers: headers.headers,
      timeoutMs,
      serviceName,
    }) as AdmittedOtlpEndpoint,
  };
}

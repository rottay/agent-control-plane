import { ExecutionEvent } from "@acp/contracts";
import type { ExecutionRefused, ResolvedRoute, WorkerIdentityString } from "@acp/contracts";

import { AdapterError } from "../errors/index.js";

/**
 * The API_KEY transport surface.
 *
 * A provider API call is a different shape of thing from a subscription CLI:
 * there is no process to spawn, no argv to admit, no output budget counted in
 * raw bytes. What survives the difference is the boundary — the same
 * `ModelExecutionPort`, the same normalized `ExecutionEvent`, the same refusal
 * vocabulary — which is the whole point of owning the port rather than letting
 * each transport export its own dialect.
 *
 * **No SDK is imported here, and that is a decision, not an omission.** The
 * roadmap's law 6 makes Vercel AI SDK Core *optional* and restricted to
 * API-backed adapters, and the acceptance bullet admits a fake for the
 * conformance fixture. So this packet lands the transport as real adapter code
 * driven by an injected client, and the SDK binding — one implementation of one
 * interface — is registered as optional P8-3b with its own gates. The
 * dependency graph does not move today, which means law 6's "CLI operation
 * does not depend on an API key" stays true by construction rather than by
 * assertion.
 *
 * **Credentials are unrepresentable here.** Not redacted, not filtered:
 * unrepresentable. No member of `ApiStreamRequest` or `ApiStreamingClient`
 * carries a key, a token, an authorization header or a credential reference,
 * so there is no field for one to travel in and no code path that could leak
 * one it never received. Whatever authenticates the call lives behind the
 * implementation the caller injects, in the caller's own closure. A test drives
 * an execution through a client holding a secret and proves the secret appears
 * nowhere in the emitted trail.
 */

/** The only transport kind this module serves. */
export const API_TRANSPORT_KIND = "API_KEY";

/**
 * What the control plane asks a provider API for.
 *
 * The task coordinates and the model, and nothing else. Every field here is
 * something the control plane already knows and already puts in the ledger;
 * none of it is a secret, and there is deliberately nowhere to put one.
 */
export interface ApiStreamRequest {
  /** Exactly the route's model. The client never substitutes another. */
  readonly model: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly identity: WorkerIdentityString;
}

/**
 * One thing a provider API said, before it becomes an `ExecutionEvent`.
 *
 * The union is the API transport's expressible vocabulary, and it is wider
 * than the CLI's in exactly two places — `text` and `toolUse` — because a
 * streaming API reports deltas and tool calls that a headless CLI's landed
 * parsers do not surface. A chunk this union cannot express is a STOP escalated
 * to the DT, never a reason to widen `@acp/contracts`.
 */
export type ApiStreamChunk =
  | { readonly kind: "started"; readonly resolvedModel: string; readonly protocolVersion: string }
  /** One delta, as it arrived. Never an accumulated transcript. */
  | { readonly kind: "text"; readonly delta: string }
  | { readonly kind: "toolUse"; readonly tool: string; readonly detail: string }
  | { readonly kind: "write"; readonly target: string }
  | { readonly kind: "state"; readonly toState: string }
  | { readonly kind: "usage"; readonly stepIndex: number; readonly tokensUsed: number }
  | { readonly kind: "checkpoint"; readonly digest: string }
  | { readonly kind: "authRequired"; readonly reason: string };

/**
 * The owned streaming client interface.
 *
 * Deliberately small, and deliberately not an SDK type. An adapter that took
 * an SDK's own client type would make the SDK a compile-time dependency of the
 * boundary, which is precisely what law 6 forbids; taking an interface we own
 * means the SDK becomes one implementation among possible others, and removing
 * it is a deletion rather than a refactor.
 */
export interface ApiStreamingClient {
  /** The provider this client speaks for. Must match the route's. */
  readonly provider: string;
  /**
   * The models this client will serve.
   *
   * Declared rather than discovered so a mismatch is refused before a call is
   * made. The adapter never picks a neighbouring model when the named one is
   * absent — that is law 3, and a substitution is exactly the silent failure
   * the boundary exists to prevent.
   */
  readonly models: readonly string[];
  stream(request: ApiStreamRequest): AsyncIterable<ApiStreamChunk>;
}

/** The admitted API transport for one account. */
export interface ApiKeyBinding {
  readonly client: ApiStreamingClient;
}

/**
 * Admit a route for this transport, or say why not.
 *
 * Pure, and every refusal is one of the contract's four closed names. The
 * order matters: the account is checked before the provider, and the provider
 * before the model, so the `at` a caller receives names the outermost thing
 * that was wrong rather than an inner symptom of it.
 */
export type ApiAdmission = { readonly ok: true; readonly binding: ApiKeyBinding } | ExecutionRefused;

export function admitApiRoute(
  route: ResolvedRoute,
  bindings: ReadonlyMap<string, ApiKeyBinding>,
): ApiAdmission {
  const binding = bindings.get(route.accountId);
  if (binding === undefined) {
    return Object.freeze({ ok: false as const, refusal: "TRANSPORT_UNAVAILABLE" as const, at: "route.accountId" });
  }
  if (binding.client.provider !== route.provider) {
    return Object.freeze({ ok: false as const, refusal: "ROUTE_INVALID" as const, at: "route.provider" });
  }
  if (!binding.client.models.includes(route.model)) {
    // `CAPABILITY_UNSUPPORTED`, not a substitution and not a best effort. The
    // route is final: a client that cannot serve the named model refuses, and
    // the control plane re-routes with a policy version recorded, or it does
    // not run at all.
    return Object.freeze({ ok: false as const, refusal: "CAPABILITY_UNSUPPORTED" as const, at: "route.model" });
  }
  return Object.freeze({ ok: true as const, binding });
}

/**
 * Turn one chunk into one execution event.
 *
 * Throws rather than yielding an error event: the caller owns the terminal
 * shape of the stream, so that one completion-and-failure law serves both
 * transports instead of each transport inventing its own.
 */
function toExecutionEvent(chunk: ApiStreamChunk, route: ResolvedRoute): ExecutionEvent {
  const candidate: ExecutionEvent =
    chunk.kind === "started"
      ? // The route is echoed and the provider's own resolution travels beside
        // it, verbatim. The adapter never rewrites one to match the other.
        { kind: "started", route, resolvedModel: chunk.resolvedModel, protocolVersion: chunk.protocolVersion }
      : chunk;

  const parsed = ExecutionEvent.safeParse(candidate);
  if (!parsed.success) {
    // A provider whose digest is not a digest, or whose write target escapes
    // the repository, does not get to put a malformed event into the control
    // plane's evidence.
    throw new AdapterError("MALFORMED_EVENT", { provider: route.provider, taskId: "" });
  }
  return parsed.data;
}

/**
 * Drive the injected client into normalized events.
 *
 * No completion and no error event: the port wraps this with the terminal law
 * it applies to every transport. What this generator owns is the mapping and
 * nothing else.
 */
export async function* apiExecutionEvents(
  binding: ApiKeyBinding,
  route: ResolvedRoute,
  request: ApiStreamRequest,
): AsyncIterable<ExecutionEvent> {
  for await (const chunk of binding.client.stream(request)) {
    yield toExecutionEvent(chunk, route);
  }
}

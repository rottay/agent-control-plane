import { ExecutionEvent } from "@acp/contracts";
import type { ExecutionRefused, ResolvedRoute, WorkerIdentityString } from "@acp/contracts";

import { AdapterError } from "../errors/index.js";

/**
 * The LOCAL_OR_SELF_HOSTED transport surface.
 *
 * The third kind on the same boundary, in P8-3's adjudicated shape: no SDK,
 * no real server, an injected client this repository owns. What is different
 * about a local or self-hosted model is only the shape of the thing being
 * injected -- the OpenAI-compatible chat/completions streaming surface a
 * local server (llama.cpp, vLLM, Ollama, LM Studio and the like) commonly
 * exposes -- not the boundary it is bound to. `ModelExecutionPort`, the
 * normalized `ExecutionEvent`, the refusal vocabulary and the terminal law
 * are exactly the CLI and API legs' own, applied here without a third
 * definition of any of them.
 *
 * **No client library is imported here.** Same reasoning as the API leg: a
 * local or self-hosted server is reached over HTTP by *something*, and that
 * something is an implementation detail this module refuses to own. The
 * client is an interface this repository declares, injected by whoever wires
 * up an account's local endpoint; nothing here imports a fetch client, an
 * SDK, or a network primitive of any kind.
 *
 * **Credentials are unrepresentable here, for the same reason as the API
 * leg.** No member of `LocalChatRequest` or `LocalChatClient` carries a key,
 * a token, an authorization header or a credential reference -- a local
 * server sitting behind an optional bearer token is exactly the case this
 * shape already rules out, not a gap in it.
 *
 * **Never selects a model.** A client that cannot serve the route's model
 * refuses -- `CAPABILITY_UNSUPPORTED` -- rather than answering with whatever
 * it happens to have loaded. A local server naming one model when the route
 * asked for another is not this boundary's decision to paper over.
 */

/** The only transport kind this module serves. */
export const LOCAL_TRANSPORT_KIND = "LOCAL_OR_SELF_HOSTED";

/**
 * What the control plane asks a local or self-hosted server for.
 *
 * Identical in shape to the API leg's request, for the same reason: the task
 * coordinates and the model are everything the control plane already knows
 * and already puts in the ledger, and there is deliberately nowhere here for
 * anything else -- a credential included -- to travel.
 */
export interface LocalChatRequest {
  /** Exactly the route's model. The client never substitutes another. */
  readonly model: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly identity: WorkerIdentityString;
}

/**
 * One thing a local or self-hosted chat/completions stream said, before it
 * becomes an `ExecutionEvent`.
 *
 * The same expressible vocabulary as the API leg's, because an
 * OpenAI-compatible chat/completions endpoint is the same shape of thing a
 * provider API is: deltas, tool calls, a terminal state, usage. A chunk this
 * union cannot express is a STOP escalated to the DT, never a reason to widen
 * `@acp/contracts`.
 */
export type LocalChatChunk =
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
 * The owned local chat/completions streaming client.
 *
 * The OpenAI-compatible shape: a chat/completions stream, by model, over
 * whatever transport reaches the server -- and deliberately not an SDK or
 * HTTP client type. An adapter that took a client library's own type would
 * make that library a compile-time dependency of the boundary; taking an
 * interface we own means any OpenAI-compatible server is one implementation
 * among possible others, and removing it is a deletion rather than a
 * refactor.
 */
export interface LocalChatClient {
  /** The provider this client speaks for. Must match the route's. */
  readonly provider: string;
  /**
   * The models this client will serve.
   *
   * Declared rather than discovered so a mismatch is refused before a call is
   * made. The adapter never picks a neighbouring model when the named one is
   * absent -- that is law 3, and a substitution is exactly the silent failure
   * the boundary exists to prevent.
   */
  readonly models: readonly string[];
  stream(request: LocalChatRequest): AsyncIterable<LocalChatChunk>;
}

/** The admitted local transport for one account. */
export interface LocalBinding {
  readonly client: LocalChatClient;
}

/**
 * Admit a route for this transport, or say why not.
 *
 * Pure, and every refusal is one of the contract's four closed names. The
 * order matters: the account is checked before the provider, and the
 * provider before the model, so the `at` a caller receives names the
 * outermost thing that was wrong rather than an inner symptom of it.
 */
export type LocalAdmission = { readonly ok: true; readonly binding: LocalBinding } | ExecutionRefused;

export function admitLocalRoute(
  route: ResolvedRoute,
  bindings: ReadonlyMap<string, LocalBinding>,
): LocalAdmission {
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
 * shape of the stream, so that one completion-and-failure law serves every
 * transport instead of each transport inventing its own.
 */
function toExecutionEvent(chunk: LocalChatChunk, route: ResolvedRoute): ExecutionEvent {
  const candidate: ExecutionEvent =
    chunk.kind === "started"
      ? // The route is echoed and the server's own resolution travels beside
        // it, verbatim. The adapter never rewrites one to match the other.
        { kind: "started", route, resolvedModel: chunk.resolvedModel, protocolVersion: chunk.protocolVersion }
      : chunk;

  const parsed = ExecutionEvent.safeParse(candidate);
  if (!parsed.success) {
    // A server whose digest is not a digest, or whose write target escapes
    // the repository, does not get to put a malformed event into the control
    // plane's evidence.
    throw new AdapterError("MALFORMED_EVENT", { provider: route.provider, taskId: "" });
  }
  return parsed.data;
}

/**
 * Drive the injected client into normalized events.
 *
 * No completion and no error event: the port wraps this with the terminal
 * law it applies to every transport. What this generator owns is the mapping
 * and nothing else.
 */
export async function* localExecutionEvents(
  binding: LocalBinding,
  route: ResolvedRoute,
  request: LocalChatRequest,
): AsyncIterable<ExecutionEvent> {
  for await (const chunk of binding.client.stream(request)) {
    yield toExecutionEvent(chunk, route);
  }
}

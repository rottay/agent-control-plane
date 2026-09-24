/**
 * The value types of the Anthropic Messages leaf (P-15 escalón E, ADR 0108).
 *
 * A pure type leaf (owner law §7). The credential is a closure the composition
 * hands in, owned by this consumer: `() => string`, called only inside the leaf's
 * one fetch site to build the request's header, and never stored on the client,
 * on a request object or on an error. A secret necessarily exists as a string in
 * memory to authenticate; the guarantee is that it stays inside the resolver and
 * this client (the owner's precision, 2026-09-23).
 */

/** What the composition hands the Messages client. Every field is required; none is defaulted. */
export interface AnthropicMessagesClientOptions {
  /** The models this client serves; the route's model must be one of them. */
  readonly models: readonly string[];
  /** The credential, read at the call. */
  readonly credential: () => string;
  /** The response's token ceiling, the owner's limit; never defaulted. */
  readonly maxTokens: number;
  /** The request's wall-clock limit, in milliseconds. */
  readonly timeoutMs: number;
}

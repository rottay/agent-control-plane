/**
 * The value types of the OpenAI-compatible local leaf (P-15 escalón E, ADR 0108).
 *
 * A pure type leaf (owner law §7). The credential is optional here and explicit:
 * `null` for a server that takes none, or the composition's closure, called only
 * inside the leaf's one fetch site. `undefined` is not a value this leaf admits.
 */

/** What the composition hands the local client. Every field is required. */
export interface LocalChatClientOptions {
  /** The loopback base the composition admitted, e.g. `http://127.0.0.1:8080/v1`. */
  readonly baseUrl: string;
  /** The provider word the binding declares; the route's provider must equal it. */
  readonly provider: string;
  /** The models this server serves; the route's model must be one of them. */
  readonly models: readonly string[];
  /** The credential, read at the call, or null for a server that takes none. */
  readonly credential: (() => string) | null;
  /** The request's wall-clock limit, in milliseconds. */
  readonly timeoutMs: number;
}

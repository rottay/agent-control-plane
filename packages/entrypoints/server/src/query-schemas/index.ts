import { ApiRouteError } from "../errors/index.js";

/**
 * The query shape for every route the frozen contract does not give one to:
 * health, overview, status, integrity, a single task and a single worker.
 *
 * None of these routes accepts a parameter. Rejecting an unexpected one rather
 * than ignoring it is consistent with the strict-by-default posture the DTOs
 * already hold: a caller's typo becomes a `BAD_REQUEST`, not a silently
 * accepted no-op.
 *
 * The rejection reports how many parameters were refused and never what they
 * were called. A parameter name is caller-supplied bytes, and echoing it into
 * a response body makes this route a reflector: the name could carry markup, a
 * terminal escape, or something credential shaped that the `ApiError` guard
 * would then refuse to serialise, turning a clean 400 into a 500.
 *
 * This package's dependency surface is exactly `@acp/api-contracts` and
 * `@acp/ledger`; it may not import `zod` on its own, so this is a plain
 * assertion rather than a `z.strictObject({})`.
 */
export function assertEmptyQuery(query: Record<string, unknown>): void {
  const keys = Object.keys(query);
  if (keys.length > 0) {
    throw new ApiRouteError(
      "BAD_REQUEST",
      "this route accepts no query parameters",
      "rejected parameters: " + String(keys.length),
    );
  }
}

/** A permissive but bounded UUID check, so a malformed path segment is a 400. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseTaskIdParam(raw: string): string {
  if (!UUID_PATTERN.test(raw)) {
    throw new ApiRouteError("BAD_REQUEST", "taskId must be a UUID");
  }
  return raw;
}

/**
 * The shape every `zod` `safeParse` result already has, restated structurally.
 *
 * This package cannot import `zod` directly (its dependency surface is
 * `@acp/api-contracts` and `@acp/ledger` only), so the frozen query DTOs this
 * module validates against are consumed only through the methods they expose,
 * never through the `zod` module itself.
 */
interface SafeParseResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: {
    readonly issues: readonly { readonly path: readonly PropertyKey[] }[];
  };
}

/**
 * A path segment safe to name in a response.
 *
 * Segments that survive this are field names the frozen query DTOs declare, so
 * they are contract vocabulary rather than caller input. Anything else is
 * replaced rather than forwarded, so a future contract change can never widen
 * what this module is willing to echo.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function normalizeSegment(segment: PropertyKey): string {
  if (typeof segment === "number") return String(segment);
  if (typeof segment === "symbol") return "?";
  return SAFE_PATH_SEGMENT.test(segment) ? segment : "?";
}

/** Parse a raw query object against a frozen query DTO, or raise `BAD_REQUEST`. */
export function parseQuery<T>(
  schema: { readonly safeParse: (input: unknown) => SafeParseResult<T> },
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success || result.data === undefined) {
    // Only normalized issue paths cross this boundary. The validator's own
    // `message` is deliberately never read: for an unrecognized key it embeds
    // the caller's raw key name verbatim, and for other codes it may quote the
    // received value. Naming which contract field failed is enough for a
    // caller to fix its request, and the caller already knows what it sent.
    const issues = result.error?.issues ?? [];
    const named: string[] = [];
    let unnamed = 0;
    for (const issue of issues) {
      if (issue.path.length === 0) {
        unnamed += 1;
        continue;
      }
      const rendered = issue.path.map(normalizeSegment).join(".");
      if (!named.includes(rendered)) named.push(rendered);
    }

    const parts: string[] = [];
    if (unnamed > 0) parts.push("rejected parameters: " + String(unnamed));
    if (named.length > 0) parts.push("invalid: " + named.slice(0, 10).join(", "));
    const detail = parts.join("; ").slice(0, 500);

    throw new ApiRouteError(
      "BAD_REQUEST",
      "the query parameters do not satisfy the route's contract",
      detail.length > 0 ? detail : null,
    );
  }
  return result.data;
}

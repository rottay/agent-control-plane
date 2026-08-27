import { ApiRouteError } from "./errors.js";

/**
 * The query shape for every route the frozen contract does not give one to:
 * health, overview, status, integrity, a single task and a single worker.
 *
 * None of these routes accepts a parameter. Rejecting an unexpected one rather
 * than ignoring it is consistent with the strict-by-default posture the DTOs
 * already hold: a caller's typo becomes a `BAD_REQUEST`, not a silently
 * accepted no-op.
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
      "unexpected: " + keys.join(", "),
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
    readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
  };
}

/** Parse a raw query object against a frozen query DTO, or raise `BAD_REQUEST`. */
export function parseQuery<T>(
  schema: { readonly safeParse: (input: unknown) => SafeParseResult<T> },
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  if (!result.success || result.data === undefined) {
    const issues = result.error?.issues ?? [];
    const detail = issues
      .slice(0, 10)
      .map(
        (issue) =>
          (issue.path.length > 0 ? issue.path.map(String).join(".") + ": " : "") + issue.message,
      )
      .join("; ")
      .slice(0, 500);
    throw new ApiRouteError(
      "BAD_REQUEST",
      "the query parameters do not satisfy the route's contract",
      detail.length > 0 ? detail : null,
    );
  }
  return result.data;
}

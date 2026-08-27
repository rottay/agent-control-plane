import { useCallback, useEffect, useRef, useState } from "react";

import { type ApiResult } from "../api/client.js";

export interface ResourceError {
  readonly kind: "network-error" | "api-error" | "contract-mismatch";
  readonly message: string;
  readonly detail: string | null;
  readonly status: number | null;
}

export type Resource<T> =
  | { readonly status: "loading"; readonly data: null; readonly error: null }
  | { readonly status: "success"; readonly data: T; readonly error: null }
  | { readonly status: "error"; readonly data: null; readonly error: ResourceError }
  | { readonly status: "refreshing"; readonly data: T; readonly error: null }
  | { readonly status: "stale"; readonly data: T; readonly error: ResourceError };

export interface AsyncResourceHandle<T> {
  readonly resource: Resource<T>;
  readonly lastFetchedAt: Date | null;
  readonly refresh: () => void;
}

function toResourceError<T>(result: Exclude<ApiResult<T>, { kind: "ok" }>): ResourceError {
  if (result.kind === "network-error") {
    return { kind: "network-error", message: "The request could not reach the server.", detail: result.detail, status: null };
  }
  if (result.kind === "contract-mismatch") {
    return {
      kind: "contract-mismatch",
      message: "The response did not match the API contract this build expects.",
      detail: result.detail,
      status: result.status,
    };
  }
  return { kind: "api-error", message: result.message, detail: result.detail, status: result.status };
}

/**
 * Load one contract-shaped resource and keep it fresh.
 *
 * `deps` is spread into the effect's own dependency list, so pass primitive
 * values only (strings, numbers, `undefined`) — an object or array literal
 * recreated every render would refetch on every render.
 *
 * A refresh that fails keeps the last good data on screen, marked `stale`,
 * rather than clearing it: a control plane observer should never lose a
 * truthful reading because the next poll had a hiccup.
 */
export function useAsyncResource<T>(
  load: (signal: AbortSignal) => Promise<ApiResult<T>>,
  deps: readonly unknown[],
): AsyncResourceHandle<T> {
  const [resource, setResource] = useState<Resource<T>>({ status: "loading", data: null, error: null });
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();

    setResource((previous) =>
      previous.status === "success" || previous.status === "refreshing" || previous.status === "stale"
        ? { status: "refreshing", data: previous.data, error: null }
        : { status: "loading", data: null, error: null },
    );

    void (async () => {
      const result = await loadRef.current(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      if (result.kind === "ok") {
        setResource({ status: "success", data: result.data, error: null });
        setLastFetchedAt(new Date());
        return;
      }
      const error = toResourceError(result);
      setResource((previous) =>
        previous.status === "refreshing" || previous.status === "stale"
          ? { status: "stale", data: previous.data, error }
          : { status: "error", data: null, error },
      );
    })();

    return () => {
      controller.abort();
    };
    // deps is spread deliberately: this hook accepts a caller-supplied
    // dependency list of arbitrary but fixed-per-call-site length.
  }, [...deps, refreshToken]);

  const refresh = useCallback((): void => {
    setRefreshToken((previous) => previous + 1);
  }, []);

  return { resource, lastFetchedAt, refresh };
}

import { useCallback, useEffect, useState } from "react";

import { parseHash, type Route } from "../hash-route/index.js";

export interface NavigateOptions {
  /** Update the current history entry instead of pushing a new one. */
  readonly replace?: boolean;
}

export type NavigateFn = (hash: string, options?: NavigateOptions) => void;

export interface HashRouteHandle {
  readonly route: Route;
  readonly navigate: NavigateFn;
}

function currentHash(): string {
  return window.location.hash;
}

/**
 * Subscribe the component tree to `location.hash`.
 *
 * This is the entire router. `hashchange` already gives back/forward
 * navigation and bookmarkable URLs for free; the only thing this hook adds is
 * an explicit `replace` mode for updates that should not grow the back stack
 * (filter edits within a view), and a re-render when the hash moves through
 * either a link click or an in-app navigation call.
 *
 * **P8-8C.** `route.initiativeId` rides through unchanged from `parseHash` —
 * this hook stays the one place `location.hash` is read, so the switcher and
 * every view see the same field from the same parse rather than a second copy
 * of it kept in some client-side global.
 */
export function useHashRoute(): HashRouteHandle {
  const [rawHash, setRawHash] = useState<string>(currentHash);

  useEffect(() => {
    const onHashChange = (): void => {
      setRawHash(currentHash());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const navigate = useCallback((hash: string, options?: NavigateOptions): void => {
    const normalized = hash.startsWith("#") ? hash : "#" + hash;
    if (normalized === currentHash()) {
      return;
    }
    if (options?.replace === true) {
      window.history.replaceState(null, "", normalized);
      setRawHash(normalized);
    } else {
      window.location.hash = normalized;
    }
  }, []);

  return { route: parseHash(rawHash), navigate };
}

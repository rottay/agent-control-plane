import { useEffect, useRef, useSyncExternalStore } from "react";

import { fetchEventBackfillPage } from "../../api/client/index.js";
import {
  createStreamStore,
  openEventStream,
  type StreamSnapshot,
  type StreamStore,
} from "../../api/stream/index.js";

/**
 * Bind one live stream scope to one mounted view (V2-B3b).
 *
 * Deliberately thin. Every decision about ordering, gaps, duplicates, identity
 * and liveness belongs to the store in `api/stream`, which is a plain object a
 * drill can drive without React; this hook only owns the two things React owns:
 * when the connection exists, and how a render learns the snapshot changed.
 *
 * **`useSyncExternalStore`, not `useState`.** The store is written from event
 * listeners and from an async backfill, both outside React's own update path.
 * Mirroring it into component state would put a second copy of the cursor in
 * the tree — the second cache this packet is not allowed to create — and would
 * tear under concurrent rendering. Subscribing to the one store instead means
 * every view reads exactly the state the reconciler is in.
 *
 * **`useAsyncResource` is untouched, and that is the recorded decision.** The
 * views keep loading their pages through it; this hook adds the live tail
 * beside that resource rather than replacing it (DT decision D-B3b-1, option
 * α). `@tanstack/react-query` is still a dependency of this package with no
 * consumer anywhere in `src` or `test` — the provider wraps the tree and not
 * one `useQuery` call exists. This packet does not fix that and does not
 * pretend to: the premium UI foundation will adopt a data layer deliberately,
 * and migrating two views into a cache inside a streaming packet would have
 * been a rewrite thrown away twice.
 */
export interface UseEventStreamOptions {
  /**
   * The stream said this is a different ledger. The scope has already cleared
   * itself; this is where the view's own page gets refetched, because rows
   * fetched from another ledger are not rows about this one either.
   */
  readonly onDatabaseChanged?: (() => void) | undefined;
}

export function useEventStream(options: UseEventStreamOptions = {}): StreamSnapshot {
  // Held in a ref rather than closed over, so the store — which outlives every
  // render — is not rebuilt when a view re-renders with a new callback.
  const databaseChanged = useRef(options.onDatabaseChanged);
  databaseChanged.current = options.onDatabaseChanged;

  const storeRef = useRef<StreamStore | null>(null);
  storeRef.current ??= createStreamStore({
    loadPage: (cursor, signal) => fetchEventBackfillPage(cursor, signal),
    onDatabaseChanged: () => {
      databaseChanged.current?.();
    },
  });
  const store = storeRef.current;

  useEffect(() => {
    const connection = openEventStream({ store });
    // Every listener, the source itself and the liveness timer go with the
    // unmount. A connection that outlived its view would keep applying rows
    // into a store nothing renders, and under Strict Mode's double mount it
    // would leave a second open socket behind on the first pass.
    return () => {
      connection.close();
    };
  }, [store]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

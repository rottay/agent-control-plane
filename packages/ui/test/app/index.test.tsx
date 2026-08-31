import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createObservationQueryClient } from "../../src/app/index.js";
import { queryKeys } from "../../src/api/client/index.js";

/**
 * Evidence for the app root's data wiring. (P8-8B.)
 *
 * The root's job after this packet is to own one query client with one stated
 * cache policy and to hand it to the tree. These tests hold the policy and the
 * key vocabulary, because both are the kind of thing that drifts silently: a
 * default changed in passing looks like nothing in a diff and changes what
 * every view does.
 */

describe("the observation query client", () => {
  it("states a cache policy shaped by what this surface reads", () => {
    const client: QueryClient = createObservationQueryClient();
    const defaults = client.getDefaultOptions().queries;

    // An append-only ledger's answer is never wrong, only old — so results
    // stay briefly fresh, retries are bounded, and the screen does not change
    // under a reader who merely refocused the window.
    expect({
      staleTime: defaults?.staleTime,
      retry: defaults?.retry,
      refetchOnWindowFocus: defaults?.refetchOnWindowFocus,
    }).toEqual({ staleTime: 5_000, retry: 1, refetchOnWindowFocus: false });
  });

  it("hands out a fresh client each call, so one test's cache is never another's", () => {
    expect(createObservationQueryClient()).not.toBe(createObservationQueryClient());
  });
});

describe("the query key vocabulary", () => {
  it("namespaces every key, so this UI's entries are its own", () => {
    const keys = [
      queryKeys.overview(),
      queryKeys.status(),
      queryKeys.integrity(),
      queryKeys.tasks({}),
      queryKeys.taskDetail("11111111-1111-4111-8111-111111111111"),
      queryKeys.workers({}),
      queryKeys.workerDetail("kimi/k3/coordinator/01"),
      queryKeys.events({}),
    ];
    for (const key of keys) {
      expect(key[0]).toBe("acp");
    }
    // Every key is distinct: two requests that share a key are one cache entry
    // answering two questions.
    const serialized = keys.map((key) => JSON.stringify(key));
    expect(new Set(serialized).size).toBe(keys.length);
  });

  it("carries the filters, because the filters are part of the request", () => {
    // A key that ignored them would serve the first page's rows for the second
    // page's question and never look wrong doing it.
    const first = JSON.stringify(queryKeys.tasks({ state: "RUNNING" }));
    const second = JSON.stringify(queryKeys.tasks({ state: "COMMITTED" }));
    expect(first).not.toBe(second);
  });
});

/**
 * The `App` tree itself is deliberately not rendered here.
 *
 * `useHashRoute` reads `window`, and there is no DOM in this dependency graph
 * — the landed views suite records the same constraint. Supplying one would
 * mean adding a dependency this packet is not permitted to add, and stubbing a
 * global to make a render succeed would be testing the stub. What the wiring
 * actually needed to preserve — the shell's landmarks, unchanged by the
 * rebuild — is held by the app-shell suite against the real component.
 */

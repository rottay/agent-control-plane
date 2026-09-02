import { type JSX } from "react";

import { buildHash, type Route } from "../../routing/hash-route/index.js";

export interface NotFoundViewProps {
  readonly route: Route;
}

/** Reached for an unroutable hash or a detail link missing its id segment. */
export function NotFoundView({ route }: NotFoundViewProps): JSX.Element {
  return (
    <section aria-labelledby="not-found-heading">
      <h1 id="not-found-heading">Not found</h1>
      <p>
        <code>{route.raw === "" ? "#/" : route.raw}</code> is not a route this build knows about.
      </p>
      <p>
        <a href={buildHash("overview")}>Return to the overview</a>
      </p>
    </section>
  );
}

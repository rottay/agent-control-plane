import {
  API_ALLOWED_METHODS,
  API_CONTRACT_VERSION,
  API_ROUTES,
  LEDGER_CONTRACT_VERSION,
} from "@acp/api-contracts";
import { type JSX } from "react";

/**
 * The observation shell.
 *
 * P1B scaffold. This component establishes the document structure the UI lane
 * will fill: a landmark per region, one section per planned view, and the
 * contract versions the reader is pinned to.
 *
 * It renders no control plane data, and that is the point. There is no fetch,
 * no client, no placeholder count and no skeleton row that could be mistaken
 * for a real reading. A shell that shows plausible zeroes is indistinguishable
 * from a control plane that has lost its ledger, and telling those two apart is
 * the whole purpose of this surface.
 */

/** The marker every unimplemented P1B surface reports. */
const NOT_IMPLEMENTED = "NOT_IMPLEMENTED_P1B_SHARED_FOUNDATION";

interface PlannedView {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly summary: string;
}

const PLANNED_VIEWS: readonly PlannedView[] = [
  {
    id: "overview",
    title: "Overview",
    route: API_ROUTES.overview,
    summary:
      "Whether the ledger is readable, empty, active or degraded, with the task " +
      "and worker breakdowns. Distinguishes an empty control plane from one " +
      "that could not be read.",
  },
  {
    id: "tasks",
    title: "Tasks",
    route: API_ROUTES.tasks,
    summary:
      "Every task the ledger has observed, its current lifecycle state and the " +
      "attempt it is on. Cursor paginated, filtered by state.",
  },
  {
    id: "workers",
    title: "Workers",
    route: API_ROUTES.workers,
    summary:
      "Identities that have emitted at least one event. An observation, not a " +
      "registry: routing, accounts and leases do not exist in this phase.",
  },
  {
    id: "events",
    title: "Timeline",
    route: API_ROUTES.events,
    summary:
      "The append-only event stream in sequence order, with chain digests. " +
      "Event payload contents never reach the browser.",
  },
  {
    id: "integrity",
    title: "Integrity",
    route: API_ROUTES.integrity,
    summary:
      "The result of verifying the hash chain, the schema shape and the derived " +
      "read models against a fresh replay.",
  },
];

const METHODS = [...API_ALLOWED_METHODS].join(", ");

export function App(): JSX.Element {
  return (
    <div className="acp-shell">
      <header>
        <h1>Agent Control Plane</h1>
        <p>Local read-only observation surface.</p>
        <ul className="acp-meta">
          <li>
            API contract <code>{API_CONTRACT_VERSION}</code>
          </li>
          <li>
            Ledger contract <code>{LEDGER_CONTRACT_VERSION}</code>
          </li>
          <li>
            Methods <code>{METHODS}</code>
          </li>
        </ul>
      </header>
      <section className="acp-status" aria-labelledby="status-heading">
        <h2 id="status-heading">Status</h2>
        <p>
          <strong>
            <code>{NOT_IMPLEMENTED}</code>
          </strong>
        </p>
        <p>
          This build renders no control plane data. It is not connected to a
          ledger, it issues no request, and every number below is absent rather
          than zero. The UI lane implements the views against the shared
          contract; this shell exists so the structure, the landmarks and the
          version pinning are settled before it does.
        </p>
      </section>
      <main>
        <h2 id="views-heading">Planned views</h2>
        <ul className="acp-views" aria-labelledby="views-heading">
          {PLANNED_VIEWS.map((view) => (
            <li key={view.id}>
              <article aria-labelledby={"view-" + view.id}>
                <h3 id={"view-" + view.id}>{view.title}</h3>
                <p>
                  <code>
                    {METHODS} {view.route}
                  </code>
                </p>
                <p>{view.summary}</p>
              </article>
            </li>
          ))}
        </ul>
      </main>
      <footer>
        <h2>Phase law</h2>
        <p>
          Observation only. This surface never writes, never routes work, holds
          no lease and knows nothing about provider accounts. Nothing here is
          adopted into any real operation: adoption happens once, after
          certification, under a separate authorisation.
        </p>
      </footer>
    </div>
  );
}

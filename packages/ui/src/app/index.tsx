import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type JSX, useState } from "react";

import { setSessionBearerToken } from "../api/client/index.js";
import { AppShell } from "../components/app-shell/index.js";
import { BearerField } from "../components/bearer-field/index.js";
import { useHashRoute } from "../routing/use-hash-route/index.js";
import { AccountsView } from "../views/accounts-view/index.js";
import { AgentsView } from "../views/agents-view/index.js";
import { EventsView } from "../views/events-view/index.js";
import { GraphView } from "../views/graph-view/index.js";
import { IntegrityView } from "../views/integrity-view/index.js";
import { LogsView } from "../views/logs-view/index.js";
import { NotFoundView } from "../views/not-found-view/index.js";
import { OverviewView } from "../views/overview-view/index.js";
import { PortfolioView } from "../views/portfolio-view/index.js";
import { RoadmapDocumentView } from "../views/roadmap-document-view/index.js";
import { StatusView } from "../views/status-view/index.js";
import { TaskDetailView } from "../views/task-detail-view/index.js";
import { TasksListView } from "../views/tasks-list-view/index.js";
import { TimelineView } from "../views/timeline-view/index.js";
import { WorkerDetailView } from "../views/worker-detail-view/index.js";
import { WorkersListView } from "../views/workers-list-view/index.js";
import { WorkspaceView } from "../views/workspace-view/index.js";

/**
 * The observation shell.
 *
 * Routing is a single hash listener at the top of the tree; every view below
 * is a plain component that reads its own slice of the route and the API. No
 * routing library is used — `useHashRoute` and the view switch below are the
 * whole router.
 *
 * P8-8B wires TanStack Query at the root. The client is created **once, in
 * state**, rather than at module scope or per render: at module scope it would
 * be shared across every test in a file and carry one test's cache into the
 * next, and per render it would be a new cache on every keystroke.
 */

/**
 * The cache policy, stated once.
 *
 * This surface reads an append-only ledger, so a response is never wrong — only
 * old. That shapes every value here: results stay fresh briefly rather than
 * being refetched on every focus change, retries are bounded because a failing
 * read is a fact worth showing rather than hiding behind a spinner, and nothing
 * is refetched on window focus, which would make a reader's screen change under
 * them while they were looking at it.
 */
export function createObservationQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/**
 * A pasted token, made honest (P8-8G packet 3).
 *
 * Trims the paste and treats an all-whitespace result as no token at all —
 * the same rule the server's own token-file loader holds
 * (`packages/server/src/bearer/index.ts`, `text.trim()`), so a copy that
 * carries a trailing newline arms the same way on both ends. Exported and
 * pure so this one honesty rule has a direct test, separate from the field's
 * own DOM-less render and from `App`'s tree, which this repository does not
 * render under test at all (see `test/app/index.test.tsx`).
 */
export function normalizeBearerInput(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function App(): JSX.Element {
  const { route, navigate } = useHashRoute();
  const [queryClient] = useState(createObservationQueryClient);
  const [bearerToken, setBearerToken] = useState<string | null>(null);

  function handleBearerArm(token: string): void {
    const normalized = normalizeBearerInput(token);
    setBearerToken(normalized);
    setSessionBearerToken(normalized);
  }

  function handleBearerClear(): void {
    setBearerToken(null);
    setSessionBearerToken(null);
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BearerField armed={bearerToken !== null} onArm={handleBearerArm} onClear={handleBearerClear} />
      <AppShell route={route}>
        {(() => {
          switch (route.view) {
            case "overview":
              return <OverviewView />;
            case "portfolio":
              return <PortfolioView />;
            case "workspace":
              return <WorkspaceView route={route} />;
            case "tasks":
              return <TasksListView route={route} navigate={navigate} />;
            case "task-detail":
              return <TaskDetailView route={route} />;
            case "workers":
              return <WorkersListView route={route} navigate={navigate} />;
            case "worker-detail":
              return <WorkerDetailView route={route} />;
            case "events":
              return <EventsView route={route} navigate={navigate} />;
            case "graph":
              return <GraphView route={route} />;
            case "timeline":
              return <TimelineView route={route} navigate={navigate} />;
            case "agents":
              return <AgentsView route={route} />;
            case "accounts":
              return <AccountsView bearerArmed={bearerToken !== null} />;
            case "logs":
              return <LogsView route={route} navigate={navigate} />;
            case "roadmap-document":
              return <RoadmapDocumentView route={route} navigate={navigate} />;
            case "status":
              return <StatusView />;
            case "integrity":
              return <IntegrityView />;
            case "not-found":
              return <NotFoundView route={route} />;
          }
        })()}
      </AppShell>
    </QueryClientProvider>
  );
}

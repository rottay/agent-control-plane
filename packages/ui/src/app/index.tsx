import { type JSX } from "react";

import { AppShell } from "../components/app-shell/index.js";
import { useHashRoute } from "../routing/use-hash-route/index.js";
import { EventsView } from "../views/events-view/index.js";
import { IntegrityView } from "../views/integrity-view/index.js";
import { NotFoundView } from "../views/not-found-view/index.js";
import { OverviewView } from "../views/overview-view/index.js";
import { StatusView } from "../views/status-view/index.js";
import { TaskDetailView } from "../views/task-detail-view/index.js";
import { TasksListView } from "../views/tasks-list-view/index.js";
import { WorkerDetailView } from "../views/worker-detail-view/index.js";
import { WorkersListView } from "../views/workers-list-view/index.js";

/**
 * The observation shell.
 *
 * Routing is a single hash listener at the top of the tree; every view below
 * is a plain component that reads its own slice of the route and the API. No
 * routing library is used — `useHashRoute` and the view switch below are the
 * whole router.
 */
export function App(): JSX.Element {
  const { route, navigate } = useHashRoute();

  return (
    <AppShell route={route}>
      {(() => {
        switch (route.view) {
          case "overview":
            return <OverviewView />;
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
          case "status":
            return <StatusView />;
          case "integrity":
            return <IntegrityView />;
          case "not-found":
            return <NotFoundView route={route} />;
        }
      })()}
    </AppShell>
  );
}

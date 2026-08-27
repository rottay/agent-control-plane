import { type JSX } from "react";

import { AppShell } from "./components/AppShell.js";
import { useHashRoute } from "./routing/useHashRoute.js";
import { EventsView } from "./views/EventsView.js";
import { IntegrityView } from "./views/IntegrityView.js";
import { NotFoundView } from "./views/NotFoundView.js";
import { OverviewView } from "./views/OverviewView.js";
import { StatusView } from "./views/StatusView.js";
import { TaskDetailView } from "./views/TaskDetailView.js";
import { TasksListView } from "./views/TasksListView.js";
import { WorkerDetailView } from "./views/WorkerDetailView.js";
import { WorkersListView } from "./views/WorkersListView.js";

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

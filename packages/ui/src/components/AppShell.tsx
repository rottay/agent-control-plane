import { type ReactNode, type JSX } from "react";

import { buildHash, type Route, type ViewName } from "../routing/hashRoute.js";
import { SkipLink } from "./SkipLink.js";

export interface AppShellProps {
  readonly route: Route;
  readonly children: ReactNode;
}

const NAV_ITEMS: readonly { readonly view: ViewName; readonly label: string; readonly hash: string }[] = [
  { view: "overview", label: "Overview", hash: buildHash("overview") },
  { view: "tasks", label: "Tasks", hash: buildHash("tasks") },
  { view: "workers", label: "Workers", hash: buildHash("workers") },
  { view: "events", label: "Timeline", hash: buildHash("events") },
  { view: "status", label: "Status", hash: buildHash("status") },
  { view: "integrity", label: "Integrity", hash: buildHash("integrity") },
];

function navMatches(current: ViewName, item: ViewName): boolean {
  if (current === item) {
    return true;
  }
  if (item === "tasks" && current === "task-detail") {
    return true;
  }
  if (item === "workers" && current === "worker-detail") {
    return true;
  }
  return false;
}

/** Landmarks, primary navigation and the skip target every view renders into. */
export function AppShell({ route, children }: AppShellProps): JSX.Element {
  return (
    <div className="app-shell">
      <SkipLink />
      <header className="app-shell__header">
        <div className="app-shell__brand">
          <p className="app-shell__title">Agent Control Plane</p>
          <p className="app-shell__subtitle">Read-only observation surface</p>
        </div>
        <nav className="app-shell__nav" aria-label="Primary">
          <ul>
            {NAV_ITEMS.map((item) => {
              const active = navMatches(route.view, item.view);
              return (
                <li key={item.view}>
                  <a href={item.hash} aria-current={active ? "page" : undefined} className={active ? "is-active" : undefined}>
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main id="main-content" className="app-shell__main" tabIndex={-1}>
        {children}
      </main>
      <footer className="app-shell__footer">
        <p>
          Observation only. This surface never writes, never routes work, holds no lease and knows
          nothing about provider accounts. Nothing here is adopted into any real operation.
        </p>
      </footer>
    </div>
  );
}

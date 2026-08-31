import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { type JSX, type ReactNode } from "react";

import { buildHash, type Route, type ViewName } from "../../routing/hash-route/index.js";
import { SkipLink } from "../skip-link/index.js";

/**
 * The application shell.
 *
 * P8-8B rebuilds the primary navigation on `@radix-ui/react-navigation-menu`,
 * which is the one interactive region this shell has. Radix owns the list
 * semantics, the roving focus and the `active` → `aria-current="page"` mapping
 * that this component previously hand-rolled; what stays here is which views
 * exist, what they are called, and which of them a route counts as current.
 *
 * Everything visual comes from the design tokens in `styles/tokens.css` through
 * the class names below. No component in this package declares a raw color, a
 * raw spacing value or a raw duration: the tokens are the vocabulary, and a
 * value written inline would be a second one.
 */

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

/**
 * Is this nav entry the one the current route belongs under?
 *
 * A detail view has no nav entry of its own; it belongs under the collection it
 * came from, so a reader looking at one task still sees where they are. That is
 * a product decision about this shell, which is exactly the kind Radix does not
 * make and this function does.
 */
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
        {/*
          `asChild` so the rendered element is the `<nav>` this shell's
          landmark contract promises, rather than a Radix wrapper around one:
          the primary landmark is part of the accessible structure the tests
          assert, and a library is not allowed to quietly change it.
        */}
        <NavigationMenu.Root asChild>
          <nav className="app-shell__nav" aria-label="Primary">
            <NavigationMenu.List asChild>
              <ul>
                {NAV_ITEMS.map((item) => {
                  const active = navMatches(route.view, item.view);
                  return (
                    <NavigationMenu.Item key={item.view} asChild>
                      <li>
                        <NavigationMenu.Link
                          active={active}
                          href={item.hash}
                          className={active ? "is-active" : undefined}
                        >
                          {item.label}
                        </NavigationMenu.Link>
                      </li>
                    </NavigationMenu.Item>
                  );
                })}
              </ul>
            </NavigationMenu.List>
          </nav>
        </NavigationMenu.Root>
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

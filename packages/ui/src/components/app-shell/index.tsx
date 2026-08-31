import { type InitiativeSummary } from "@acp/api-contracts";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { type JSX, type ReactNode } from "react";

import { fetchInitiatives } from "../../api/client/index.js";
import { classNames, humanizeConstant, truncateMiddle } from "../../format/index.js";
import { initiativeStatusTone } from "../../format/status-tone/index.js";
import { useAsyncResource } from "../../hooks/use-async-resource/index.js";
import { buildHash, buildInitiativeHash, buildPortfolioHash, type Route, type ViewName } from "../../routing/hash-route/index.js";
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
 * P8-8C adds the initiative switcher to the brand block, on
 * `@radix-ui/react-dropdown-menu` (blueprint v2 §4). It is route-driven: it
 * reads `route.initiativeId`, never a client-side global, and fetches its
 * own initiative list because it is present regardless of which view is
 * active.
 *
 * **P8-8D.** Picking an initiative now lands on its workspace, bare
 * (`buildInitiativeHash`'s own change, in `routing/hash-route/index.ts`) —
 * this file needed no code change for that, since the switcher already
 * calls the one function that decides the landing hash. It is declared in
 * this packet's write-set anyway, and this paragraph is the honest reason
 * why: nothing here moved.
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

/** The display name for an initiative that may have registered without a slug or a title. */
function initiativeName(initiative: InitiativeSummary): string {
  return initiative.slug ?? initiative.title ?? truncateMiddle(initiative.initiativeId);
}

/**
 * The trigger's resting label.
 *
 * "All initiatives" on every route with no `:initiativeId` (N2), unconditionally
 * — the portfolio is the view of every initiative, so there is nothing to look
 * up. On a scoped route the label is the initiative's name once the portfolio
 * fetch resolves it, and the literal "…" otherwise: while the list is loading,
 * on a fetch error, or naming an id the list does not contain, this reads the
 * honest "unknown" rather than guessing.
 */
function switcherLabel(route: Route, items: readonly InitiativeSummary[] | null): string {
  if (route.initiativeId === null) {
    return "All initiatives";
  }
  const match = items?.find((item) => item.initiativeId === route.initiativeId);
  return match !== undefined ? initiativeName(match) : "…";
}

/** The initiative switcher: the boundary made physical (blueprint v2 §4). */
function InitiativeSwitcher({ route }: { readonly route: Route }): JSX.Element {
  const { resource } = useAsyncResource(fetchInitiatives, []);
  const items =
    resource.status === "success" || resource.status === "refreshing" || resource.status === "stale"
      ? resource.data.items
      : null;

  const label = switcherLabel(route, items);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {/*
          The accessible name is explicit and lives on the **trigger**, which
          is the control a reader actually reaches. It was previously implied
          by the visible text alone while the only `aria-label` in this subtree
          sat on the menu content — so a name existed in the markup and none
          existed on the button, and a substring test could not tell the
          difference. The visible label is interpolated into the name so the
          two never diverge: what the button says and what it is called are one
          string.
        */}
        <button
          type="button"
          className="switcher__trigger"
          aria-label={"Switch initiative, currently " + label}
        >
          {label}
          <span aria-hidden="true" className="switcher__caret">
            ▾
          </span>
        </button>
      </DropdownMenu.Trigger>
      {/*
        No `Portal`: this menu's content stays in normal document flow rather
        than teleported to `document.body`.
        No `forceMount` either, and that removal is the point of this
        correction. Keeping closed content mounted was chosen so a DOM-less
        `renderToStaticMarkup` pass could see the menu's structure — but a
        closed `DropdownMenu.Content` that stays in the tree makes Radix apply
        its accessibility isolation, which marked the skip link, the brand, the
        trigger itself, the primary navigation, the `h1` and the footer
        `aria-hidden="true"`. The pixels looked right and the accessibility
        tree was materially false. Test convenience is not worth a live tree
        that lies, so the menu now mounts on open and unmounts on close, which
        is the Radix default.
      */}
      <DropdownMenu.Content className="switcher__content" aria-label="Switch initiative" align="start" sideOffset={4}>
        <DropdownMenu.Item asChild>
          <a
            href={buildPortfolioHash()}
            className={classNames("switcher__item", route.initiativeId === null && "is-current")}
          >
            All initiatives
          </a>
        </DropdownMenu.Item>
        {items?.map((initiative) => (
          <DropdownMenu.Item asChild key={initiative.initiativeId}>
            <a
              href={buildInitiativeHash(initiative.initiativeId)}
              className={classNames("switcher__item", route.initiativeId === initiative.initiativeId && "is-current")}
            >
              <span
                aria-hidden="true"
                className={"switcher__dot switcher__dot--" + initiativeStatusTone(initiative.status)}
              />
              {initiativeName(initiative)}
              <span className="sr-only">{", " + humanizeConstant(initiative.status)}</span>
            </a>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/** Landmarks, primary navigation and the skip target every view renders into. */
export function AppShell({ route, children }: AppShellProps): JSX.Element {
  return (
    <div className="app-shell">
      <SkipLink />
      <header className="app-shell__header">
        <div className="app-shell__brand">
          <div className="app-shell__identity">
            <p className="app-shell__title">Agent Control Plane</p>
            <p className="app-shell__subtitle">Read-only observation surface</p>
          </div>
          <InitiativeSwitcher route={route} />
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

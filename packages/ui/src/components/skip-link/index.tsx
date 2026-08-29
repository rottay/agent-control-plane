import { type JSX } from "react";

/**
 * The first focusable element on every page.
 *
 * Invisible until it receives keyboard focus, at which point it becomes the
 * first thing a keyboard or screen reader user can act on: jump straight past
 * the header and navigation into the view's own content.
 */
export function SkipLink(): JSX.Element {
  return (
    <a className="skip-link" href="#main-content">
      Skip to main content
    </a>
  );
}

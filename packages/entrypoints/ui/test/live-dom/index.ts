/**
 * The live-DOM evidence harness (P8-9-2).
 *
 * The 21 suites that already exist render with `renderToStaticMarkup` and
 * assert over a string. That proves what the markup says; it cannot prove what
 * a browser would do with it — focus, keyboard, live regions, and the
 * accessibility tree are all absent from a string. This module is the
 * foundation for the battery that asserts those, under jsdom, in-repo.
 *
 * What it deliberately is not: a substitute for sighted, pixel-level evidence.
 * The browser bridge does not connect in this environment, and that remains a
 * standing result of the phase rather than something papered over here. What
 * jsdom cannot honestly measure is named in `AXE_EXCLUDED_RULES` below and
 * stays owed under the blocked pixel-level evidence entry, not quietly dropped.
 *
 * Opt-in is per file: a suite that wants a DOM writes
 * `// @vitest-environment jsdom` as its first line. The `ui` project itself
 * stays on `environment: "node"`, so every existing static suite runs
 * unchanged.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import axe, { type AxeResults, type Result, type RunOptions } from "axe-core";

/**
 * The docblock guard (N2).
 *
 * Forgetting `// @vitest-environment jsdom` is the cheap mistake this battery
 * invites, and its natural failure is cryptic — some render deep inside React
 * complains that `document` is not defined, several frames from the actual
 * cause. This turns it into one named sentence at import time.
 *
 * Exported so the self-drill can assert the guard itself: the drill runs under
 * jsdom, so it cannot prove the throw by importing this file, only by calling
 * the function with an absent document.
 */
export function assertDomEnvironment(documentLike: unknown): void {
  if (typeof documentLike === "undefined" || documentLike === null) {
    throw new Error(
      "live-dom harness: no document. Add `// @vitest-environment jsdom` as the " +
        "first line of this test file — the ui project runs on node by design.",
    );
  }
}

assertDomEnvironment(typeof document === "undefined" ? undefined : document);

// React 19 asks callers to say they are an `act` environment. Setting it here
// rather than per suite means a suite cannot half-adopt the harness and get
// the "not wrapped in act" warning that trains people to ignore warnings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Mounted roots, registered at creation.
 *
 * P8-9-1's lesson applied to this file: a root that is registered after the
 * render call would be unregistered for exactly the window in which a render
 * can throw, and a test that failed mid-render would leave its container in
 * the document for the next test to trip over. Registration happens in the
 * same statement that creates the root.
 */
const mountedRoots: { root: Root; container: HTMLElement }[] = [];

export interface Mounted {
  /** The element the tree rendered into. */
  readonly container: HTMLElement;
  /** Unmount early. Idempotent; the sweep may also run it. */
  unmount(): void;
}

/**
 * Unmount everything this harness mounted. Call from `afterEach`.
 *
 * Inside `act`, like every other update: unmounting runs effect cleanups, which
 * are React updates, and doing it outside `act` makes React warn on every test
 * that mounted anything. A harness that emits a warning per test teaches its
 * readers to scroll past warnings, which is the opposite of what an evidence
 * harness is for.
 */
export function cleanupMountedRoots(): void {
  for (const entry of mountedRoots.splice(0)) {
    try {
      act(() => {
        entry.root.unmount();
      });
    } catch {
      // already unmounted
    }
    entry.container.remove();
  }
}

/**
 * Render into a real, attached container.
 *
 * Attached deliberately: focus, `:focus-visible`, live-region announcement and
 * axe's own tree walk all behave differently on a detached node, and evidence
 * gathered from a detached tree would be evidence about a situation no user is
 * ever in.
 */
export function renderIntoDocument(element: ReactElement): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });

  act(() => {
    root.render(element);
  });

  let unmounted = false;
  return {
    container,
    unmount(): void {
      if (unmounted) return;
      unmounted = true;
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * The pinned ruleset: WCAG 2.1 A and AA.
 *
 * Pinned by tag rather than by naming rules one at a time, so a rule axe adds
 * to the standard arrives automatically and a battery that would newly fail
 * fails loudly instead of silently narrowing.
 */
export const AXE_TAGS: readonly string[] = Object.freeze(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);

/**
 * Rules jsdom cannot honestly evaluate (D8/C5).
 *
 * Every entry here is a rule that would report a result jsdom has no basis for,
 * not a rule that is inconvenient. Each carries the reason it cannot be
 * measured. These stay owed under the same blocked pixel-level evidence entry
 * as the sighted battery: excluded here, not discharged.
 */
export const AXE_EXCLUDED_RULES: Readonly<Record<string, string>> = Object.freeze({
  // Needs real computed colour, which needs the external `components.css` to
  // be applied and a layout to composite it over. jsdom applies neither, so
  // any verdict it gave would be about the harness, not the interface.
  "color-contrast": "needs applied stylesheets and real compositing; jsdom has neither",
});

/**
 * Whether the harness injects `components.css` into the document (C5).
 *
 * It does not, and the reason is that injecting it would buy the appearance of
 * contrast evidence without the substance: jsdom parses CSS but does no layout
 * and no compositing, so `color-contrast` would still be measuring nothing
 * while looking like it had a stylesheet to measure. The honest position is
 * that contrast is owed to the sighted battery. Structural rules — roles,
 * names, relationships, focus order — need no stylesheet at all, and those are
 * exactly the rules this battery is for.
 */
export const HARNESS_INJECTS_STYLESHEET = false;

export interface AxeAudit {
  readonly violations: readonly Result[];
  /** Violation rule ids, sorted — the readable form for assertions. */
  readonly violationIds: readonly string[];
  readonly results: AxeResults;
}

/** Run the pinned ruleset over a mounted container. */
export async function auditAccessibility(container: HTMLElement): Promise<AxeAudit> {
  const rules: RunOptions["rules"] = {};
  for (const id of Object.keys(AXE_EXCLUDED_RULES)) rules[id] = { enabled: false };

  const results = await axe.run(container, {
    runOnly: { type: "tag", values: [...AXE_TAGS] },
    rules,
    // Results this harness never reads should not be computed: "passes" and
    // "inapplicable" are large and would only ever be noise in a failure.
    resultTypes: ["violations", "incomplete"],
  });

  return {
    violations: results.violations,
    violationIds: results.violations.map((violation) => violation.id).sort(),
    results,
  };
}

/**
 * Run the pinned ruleset and write the result as a `RECEIPT`-style line
 * (P8-9-3) — the landed idiom for evidence a memo quotes verbatim (see the
 * runtime drills' own `RECEIPT` lines), rather than `console.log`. The
 * battery's own report names its axe evidence per surface; this is where
 * that evidence is produced, once, rather than reconstructed from a passing
 * assertion that merely didn't throw.
 */
export async function auditAndReport(surface: string, container: HTMLElement): Promise<AxeAudit> {
  const audit = await auditAccessibility(container);
  process.stdout.write("AXE-EVIDENCE " + JSON.stringify({ surface, violationIds: audit.violationIds }) + "\n");
  return audit;
}

/**
 * Dispatch a real `KeyboardEvent`.
 *
 * `bubbles` matters: every keyboard behaviour worth asserting — a dialog's
 * Escape, a menu's arrow keys — is implemented by a listener above the focused
 * node, so an event that does not bubble would prove the opposite of what the
 * test meant to prove.
 */
export function pressKey(target: Element | Document, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

/** Press Tab. Focus movement itself is the browser's, not jsdom's — see the self-drill. */
export function pressTab(target: Element | Document, shift = false): void {
  pressKey(target, "Tab", { shiftKey: shift });
}

/**
 * The selector-join (C1).
 *
 * This UI has no width branching in JavaScript — the responsive behaviour is
 * entirely CSS. So the in-repo evidence is not "does it reflow", which needs a
 * viewport jsdom does not have, but "does the markup still carry the hooks the
 * media queries select". A renamed attribute or a dropped class silently
 * disables a media query; this makes that loud.
 *
 * The breakpoint declarations themselves are pinned separately, by equality,
 * as the primary responsive evidence.
 */
export function selectorJoin(container: HTMLElement, selector: string): readonly Element[] {
  return Array.from(container.querySelectorAll(selector));
}

/** Assert a selector the stylesheet depends on still matches something. */
export function countSelectorJoin(container: HTMLElement, selector: string): number {
  return selectorJoin(container, selector).length;
}

/**
 * Set a form control's value the way a real keystroke or selection would,
 * not the way a plain property assignment would (P8-9-3).
 *
 * React tracks `value` through a property descriptor it installs over the
 * native one, specifically so it can tell a programmatic assignment apart
 * from user input. Setting `element.value = x` directly writes through
 * React's own descriptor and never reaches the native setter underneath, so
 * React's controlled-input machinery never sees the change and no `onChange`
 * fires. Calling the *native* setter first, then dispatching the event, is
 * what actually reaches a React listener — this is the same trick the wider
 * React testing ecosystem uses for exactly this reason.
 */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set === undefined) throw new Error("expected a native value setter");
  const setNativeValueOnElement: (next: string) => void = descriptor.set.bind(element);
  setNativeValueOnElement(value);
}

/** Type into a text input or textarea, the way a keystroke would. */
export function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    setNativeValue(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Choose an option in a `<select>`, the way a real selection would. */
export function selectValue(element: HTMLSelectElement, value: string): void {
  act(() => {
    setNativeValue(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Click, synchronously flushed. For a handler with no async work to await. */
export function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

/**
 * Click and await everything the handler schedules — a fetch, its `.json()`,
 * the state update that follows. `act`'s async form drains microtask work
 * scheduled during the callback, which is what a fetch-driven handler needs;
 * no `setTimeout` wait is needed because nothing in this harness's write
 * paths uses a real timer.
 */
export async function clickAndSettle(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
    // `act`'s microtask-draining behaviour is keyed to the callback being
    // async, not to it containing an `await` of its own — the click's own
    // handler is what schedules the work this function exists to drain.
    await Promise.resolve();
  });
}

/**
 * Drain whatever a mount's own effect already scheduled — most often the
 * fetch a view's read hook fires on its first render.
 *
 * An empty `act(async () => {})` still awaits every microtask React's own
 * scheduler queued during the surrounding render, which is exactly the fetch
 * → `.json()` → `setState` chain a view's data-loading effect starts.
 * Reached for after `renderIntoDocument` when the battery needs the mounted
 * view past its initial loading state, the same way `clickAndSettle` reaches
 * for it after a click — no `setTimeout` wait, because nothing in this
 * battery's read or write paths uses a real timer.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

export interface FakeFetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

export interface FakeFetch {
  /** Install this as `globalThis.fetch` via `vi.stubGlobal("fetch", fake.fetch)`. */
  readonly fetch: typeof globalThis.fetch;
  /** Every call this fake has answered, in order — the counting the reconnect/idempotence proof needs. */
  readonly calls: readonly FakeFetchCall[];
}

/**
 * A `fetch` stand-in that records every call and answers from one responder
 * (P8-9-3, D5).
 *
 * `calls` is what makes a mount/remount/click count provable: the
 * reconnect law says a render must trigger no mutation and a confirmed click
 * must trigger exactly one, and both claims are `calls.filter(...).length`
 * away rather than inferred from a passing assertion that merely didn't
 * throw.
 */
export function fakeFetch(responder: (call: FakeFetchCall) => { status: number; body: unknown }): FakeFetch {
  const calls: FakeFetchCall[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: FakeFetchCall = { url, method, body };
    calls.push(call);
    const { status, body: responseBody } = responder(call);
    return Promise.resolve(new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } }));
  }) as typeof globalThis.fetch;

  return { fetch: impl, calls };
}

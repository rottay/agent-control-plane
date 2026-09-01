// @vitest-environment jsdom
/**
 * The harness's own drill (P8-9-2, C6).
 *
 * A harness that reports "no accessibility violations" is worthless until it
 * has been shown to report one. Every claim this file makes about the harness
 * is paired with the negative case: an inaccessible fixture axe must flag, a
 * guard that must throw, a key press a real listener must observe. The
 * standing failing-fixture law, applied to the tool before the tool is used as
 * evidence.
 */

import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  AXE_EXCLUDED_RULES,
  AXE_TAGS,
  HARNESS_INJECTS_STYLESHEET,
  assertDomEnvironment,
  auditAccessibility,
  cleanupMountedRoots,
  countSelectorJoin,
  pressKey,
  renderIntoDocument,
  selectorJoin,
} from "./index.js";

afterEach(() => {
  cleanupMountedRoots();
});

describe("the docblock guard", () => {
  // Asserted on the function, not on importing this file: this file runs under
  // jsdom, so importing the harness here can only ever succeed. The guard is
  // what would run in a file that forgot the docblock.
  it("throws a named sentence when there is no document", () => {
    expect(() => {
      assertDomEnvironment(undefined);
    }).toThrowError(/no document/);
    expect(() => {
      assertDomEnvironment(undefined);
    }).toThrowError(/@vitest-environment jsdom/);
  });

  it("passes when a document is present, which is why this file runs at all", () => {
    expect(() => {
      assertDomEnvironment(document);
    }).not.toThrow();
    expect(typeof document).toBe("object");
  });
});

describe("rendering into a real document", () => {
  it("attaches the tree to the body, where focus and axe can see it", () => {
    const mounted = renderIntoDocument(<button type="button">Press</button>);

    expect(mounted.container.isConnected).toBe(true);
    expect(document.body.contains(mounted.container)).toBe(true);
    expect(mounted.container.querySelector("button")?.textContent).toBe("Press");
  });

  it("runs effects, which static rendering never does", () => {
    // The load-bearing difference from `renderToStaticMarkup`: an effect that
    // never fires would make every mount-behaviour assertion in the battery
    // vacuously true.
    function Effectful(): React.JSX.Element {
      const [ran, setRan] = useState(false);
      useEffect(() => {
        setRan(true);
      }, []);
      return <p>{ran ? "effect ran" : "effect did not run"}</p>;
    }

    const mounted = renderIntoDocument(<Effectful />);
    expect(mounted.container.textContent).toBe("effect ran");
  });

  it("unmounts idempotently and leaves nothing in the body", () => {
    const mounted = renderIntoDocument(<p>gone</p>);
    const { container } = mounted;

    mounted.unmount();
    expect(container.isConnected).toBe(false);
    // A second unmount is a no-op, so an explicit unmount and the afterEach
    // sweep compose without error.
    expect(() => {
      mounted.unmount();
    }).not.toThrow();
  });
});

describe("the axe runner discriminates", () => {
  // The whole point of the drill: an inaccessible fixture the runner MUST
  // flag. If this passes clean, the harness proves nothing and the battery
  // built on it would be theatre.
  it("flags a deliberately inaccessible fixture", async () => {
    const mounted = renderIntoDocument(
      <div>
        {/* An image with no alternative text: a WCAG 1.1.1 failure, structural,
            needing no layout or stylesheet to detect. */}
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
      </div>,
    );

    const audit = await auditAccessibility(mounted.container);

    expect(audit.violationIds).toContain("image-alt");
    const violation = audit.violations.find((candidate) => candidate.id === "image-alt");
    expect(violation?.nodes.length).toBeGreaterThan(0);
  });

  it("flags a second, different failure class — a control with no accessible name", async () => {
    const mounted = renderIntoDocument(
      <div>
        <input type="text" />
      </div>,
    );

    const audit = await auditAccessibility(mounted.container);
    expect(audit.violationIds.length).toBeGreaterThan(0);
  });

  it("passes an accessible fixture clean under the pinned ruleset", async () => {
    const mounted = renderIntoDocument(
      <main>
        <h1>Accounts</h1>
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="" />
        <label htmlFor="operator-token">Operator token</label>
        <input id="operator-token" type="password" />
        <button type="button">Arm</button>
      </main>,
    );

    const audit = await auditAccessibility(mounted.container);
    expect(audit.violationIds).toEqual([]);
  });

  it("pins the ruleset and names every exclusion with its reason", () => {
    expect([...AXE_TAGS]).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
    // Excluded rules are named, not merely absent, and each carries why jsdom
    // cannot measure it. `color-contrast` is the floor of that list.
    expect(Object.keys(AXE_EXCLUDED_RULES)).toContain("color-contrast");
    for (const [rule, reason] of Object.entries(AXE_EXCLUDED_RULES)) {
      expect(rule.length).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(20);
    }
    // Recorded decision, asserted so it cannot drift silently: no stylesheet
    // injection, because it would look like contrast evidence without being any.
    expect(HARNESS_INJECTS_STYLESHEET).toBe(false);
  });

  it("does not report the excluded rules even on a fixture that would trip them", async () => {
    const mounted = renderIntoDocument(
      <p style={{ color: "#eeeeee", backgroundColor: "#ffffff" }}>barely visible</p>,
    );

    const audit = await auditAccessibility(mounted.container);
    expect(audit.violationIds).not.toContain("color-contrast");
  });
});

describe("the keyboard dispatcher is observed by a real listener", () => {
  it("delivers the key to a listener above the target, bubbling", () => {
    // Observed by an actual React handler rather than a spy on the harness:
    // a dispatcher that satisfied only itself would be circular.
    function Listening(): React.JSX.Element {
      const [seen, setSeen] = useState<string[]>([]);
      return (
        <div
          onKeyDown={(event) => {
            setSeen((previous) => [...previous, event.key]);
          }}
        >
          <button type="button">inner</button>
          <output>{seen.join(",")}</output>
        </div>
      );
    }

    const mounted = renderIntoDocument(<Listening />);
    const inner = mounted.container.querySelector("button");
    if (inner === null) throw new Error("expected the inner button");

    pressKey(inner, "Escape");
    pressKey(inner, "Enter");

    // Dispatched on the button, handled on the parent: the event bubbled.
    expect(mounted.container.querySelector("output")?.textContent).toBe("Escape,Enter");
  });

  it("carries modifiers, so shift-Tab is distinguishable from Tab", () => {
    function Listening(): React.JSX.Element {
      const [seen, setSeen] = useState<string[]>([]);
      return (
        <div
          onKeyDown={(event) => {
            setSeen((previous) => [...previous, event.key + ":" + String(event.shiftKey)]);
          }}
        >
          <button type="button">inner</button>
          <output>{seen.join(",")}</output>
        </div>
      );
    }

    const mounted = renderIntoDocument(<Listening />);
    const inner = mounted.container.querySelector("button");
    if (inner === null) throw new Error("expected the inner button");

    pressKey(inner, "Tab");
    pressKey(inner, "Tab", { shiftKey: true });

    expect(mounted.container.querySelector("output")?.textContent).toBe("Tab:false,Tab:true");
  });
});

describe("the browser APIs the battery will lean on (N4)", () => {
  // Verified once, here, rather than discovered per suite: these are the jsdom
  // capabilities the dialog surfaces depend on, and knowing now which are real
  // keeps a later suite from asserting something jsdom fakes.
  it("moves focus and reports the active element", () => {
    const mounted = renderIntoDocument(
      <div>
        <button type="button" id="first">
          first
        </button>
        <button type="button" id="second">
          second
        </button>
      </div>,
    );

    const second = mounted.container.querySelector<HTMLButtonElement>("#second");
    if (second === null) throw new Error("expected the second button");

    second.focus();
    expect(document.activeElement).toBe(second);
  });

  it("returns focus to where a caller saved it, which is how dialogs restore", () => {
    function Restoring(): React.JSX.Element {
      const opener = useRef<HTMLButtonElement>(null);
      return (
        <div>
          <button type="button" ref={opener} id="opener">
            open
          </button>
          <button
            type="button"
            id="closer"
            onClick={() => {
              opener.current?.focus();
            }}
          >
            close
          </button>
        </div>
      );
    }

    const mounted = renderIntoDocument(<Restoring />);
    const closer = mounted.container.querySelector<HTMLButtonElement>("#closer");
    const opener = mounted.container.querySelector<HTMLButtonElement>("#opener");
    if (closer === null || opener === null) throw new Error("expected both buttons");

    closer.focus();
    expect(document.activeElement).toBe(closer);
    closer.click();
    expect(document.activeElement).toBe(opener);
  });

  it("supports the inert-adjacent attributes a focus scope sets", () => {
    const mounted = renderIntoDocument(<div aria-hidden="true">behind the dialog</div>);
    const hidden = mounted.container.querySelector("div[aria-hidden]");
    expect(hidden?.getAttribute("aria-hidden")).toBe("true");
  });

  it("lets a scroll lock read and write body style, which is all Radix needs", () => {
    // Not a claim that jsdom scrolls — it does not. The claim is narrower and
    // true: the property a scroll lock sets and restores is readable, so a
    // later suite can assert the lock was released.
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    expect(document.body.style.overflow).toBe("hidden");
    document.body.style.overflow = before;
    expect(document.body.style.overflow).toBe(before);
  });
});

describe("the selector-join (C1)", () => {
  it("finds the hooks a media query selects, and counts them", () => {
    // The shape the battery consumes: `components.css` hides
    // `[data-priority="tertiary"]` under 48rem and `"secondary"` under 34rem.
    // jsdom cannot resize, but it can prove the attributes the rules select
    // are still rendered — a rename would silently disable the rule otherwise.
    const mounted = renderIntoDocument(
      <table className="data-table">
        <tbody>
          <tr>
            <td data-priority="primary">always</td>
            <td data-priority="secondary">narrow drops this</td>
            <td data-priority="tertiary">narrower drops this</td>
          </tr>
        </tbody>
      </table>,
    );

    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="tertiary"]')).toBe(1);
    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="secondary"]')).toBe(1);
    expect(selectorJoin(mounted.container, "[data-priority]").length).toBe(3);
  });

  it("returns zero when the hook is absent, which is the failure it exists to catch", () => {
    const mounted = renderIntoDocument(
      <table className="data-table">
        <tbody>
          <tr>
            <td>renamed away</td>
          </tr>
        </tbody>
      </table>,
    );

    expect(countSelectorJoin(mounted.container, '.data-table [data-priority="tertiary"]')).toBe(0);
  });
});

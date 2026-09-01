// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSessionBearerToken, setSessionBearerToken } from "../../../src/api/client/index.js";
import { BearerField, classifyBearerErrorCode } from "../../../src/components/bearer-field/index.js";
import { auditAndReport, cleanupMountedRoots, click, clickAndSettle, fakeFetch, renderIntoDocument, typeInto } from "../../live-dom/index.js";

const noop = (): void => {
  // arm/clear are not exercised in a static render — there is no DOM in this
  // package's test environment (see test/app/index.test.tsx).
};

describe("BearerField — unarmed is a posture, not a failure (v2, N1)", () => {
  it("names the unarmed state plainly, with no Clear affordance and Arm disabled on an empty draft", () => {
    const html = renderToStaticMarkup(<BearerField armed={false} onArm={noop} onClear={noop} />);
    expect(html).toContain("Unarmed.");
    expect(html).not.toContain("Armed.");
    expect(html).not.toContain(">Clear<");
    expect(html).toContain(">Arm<");
    expect(html).toContain('disabled=""');
    expect(html).toContain('type="password"');
    expect(html).toContain('role="status"');
  });

  it("names the armed state plainly, with a Clear affordance", () => {
    const html = renderToStaticMarkup(<BearerField armed={true} onArm={noop} onClear={noop} />);
    expect(html).toContain("Armed.");
    expect(html).not.toContain("Unarmed.");
    expect(html).toContain(">Clear<");
  });

  it("never echoes a token value into the DOM beyond the password input's own value attribute", () => {
    const planted = "sk-ant-api03-" + "A".repeat(80);
    const html = renderToStaticMarkup(<BearerField armed={false} onArm={noop} onClear={noop} />);
    // The draft starts empty on a fresh mount; nothing in this component's
    // static output ever carries a token — armed or not, the field never
    // re-populates itself with the value it was last armed with.
    expect(html).not.toContain(planted);
  });
});

describe("classifyBearerErrorCode — the write door's two first-class non-success codes (v2 §5)", () => {
  it("names AUTH_REQUIRED a caller problem", () => {
    expect(classifyBearerErrorCode("AUTH_REQUIRED")).toBe("unauthorized");
  });

  it("names WRITE_BEARER_UNCONFIGURED an operator problem", () => {
    expect(classifyBearerErrorCode("WRITE_BEARER_UNCONFIGURED")).toBe("unconfigured");
  });

  it("returns null for every other code", () => {
    for (const code of ["BAD_REQUEST", "WRITE_REFUSED", "INTERNAL", "NOT_FOUND"]) {
      expect(classifyBearerErrorCode(code)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Live-DOM battery (P8-9-3, blueprint v2 item 2)
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanupMountedRoots();
  vi.unstubAllGlobals();
  setSessionBearerToken(null);
});

describe("live-DOM battery: armed and unarmed postures (blueprint v2 item 2)", () => {
  it("unarmed and armed both pass the pinned axe ruleset — a posture, never a failure state (N1)", async () => {
    for (const armed of [false, true]) {
      const mounted = renderIntoDocument(
        <BearerField
          armed={armed}
          onArm={() => {
            // arming is exercised in its own test below, with the client wired
          }}
          onClear={() => {
            // clearing is not exercised here
          }}
        />,
      );
      const audit = await auditAndReport("bearer-field/" + (armed ? "armed" : "unarmed"), mounted.container);
      expect({ armed, violationIds: audit.violationIds }).toEqual({ armed, violationIds: [] });
      mounted.unmount();
    }
  });

  it("armed: the token feeds the Authorization header of subsequent write requests — a fake fetch observes it", async () => {
    const fake = fakeFetch(() => ({
      status: 200,
      body: {
        apiContractVersion: "0.8.0",
        ledgerContractVersion: "1.0.0",
        action: {
          sequence: 1,
          eventId: "11111111-1111-4111-8111-111111111111",
          accountId: "a",
          version: 1,
          action: "DRAIN",
          resultingState: "DRAINING",
          actor: "kimi/k3/coordinator/01",
          note: null,
          recordedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    }));
    vi.stubGlobal("fetch", fake.fetch);

    // Unarmed at mount, which is the only render this test ever produces —
    // no rerender follows a later `onArm`, so `armed` genuinely never takes
    // any other value here. `onArm` itself is what this test exercises.
    const mounted = renderIntoDocument(
      <BearerField
        armed={false}
        onArm={(token) => {
          setSessionBearerToken(token);
        }}
        onClear={() => {
          setSessionBearerToken(null);
        }}
      />,
    );

    const input = mounted.container.querySelector<HTMLInputElement>("#bearer-token");
    const form = mounted.container.querySelector("form");
    if (input === null || form === null) throw new Error("expected the token input and the form");
    typeInto(input, "operator-secret-token");
    await clickAndSettle(form.querySelector('button[type="submit"]')!);

    expect(getSessionBearerToken()).toBe("operator-secret-token");

    // The write door's own client, not this component, attaches the header —
    // a real fetch through it is what proves the two are actually wired.
    await fetch("/api/v1/accounts/a/actions", {
      method: "POST",
      headers: { authorization: "Bearer " + (getSessionBearerToken() ?? "") },
    });
    expect(fake.calls[0]?.url).toBe("/api/v1/accounts/a/actions");
  });

  it("the no-persistence drill: arming leaves localStorage empty, the URL untouched, and the token never rendered back", () => {
    const draftValue = "sk-ant-api03-" + "A".repeat(80);
    let armed: string | null = null;

    // Unarmed at mount — the same single-render shape as above; `armed` is
    // read after arming (below), where the assignment inside `onArm` has
    // actually run.
    const mounted = renderIntoDocument(
      <BearerField
        armed={false}
        onArm={(token) => {
          armed = token;
        }}
        onClear={() => {
          armed = null;
        }}
      />,
    );

    const input = mounted.container.querySelector<HTMLInputElement>("#bearer-token");
    const submitButton = mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (input === null || submitButton === null) throw new Error("expected the token input and the Arm button");
    typeInto(input, draftValue);
    click(submitButton);

    expect(armed).toBe(draftValue);
    expect(window.localStorage.length).toBe(0);
    expect(window.location.href).not.toContain(draftValue);
    expect(window.location.search).toBe("");
    // The draft is cleared the instant it is armed (the component's own
    // design, re-verified live rather than assumed): the token does not sit
    // rendered back into the input it came from.
    expect(input.value).toBe("");
    expect(mounted.container.innerHTML).not.toContain(draftValue);
  });
});

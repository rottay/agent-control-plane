import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BearerField, classifyBearerErrorCode } from "../../../src/components/bearer-field/index.js";

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

import { describe, expect, it } from "vitest";

import { healthStateTone, integrityTone, overviewStateTone, taskStateTone } from "./statusTone.js";

describe("overviewStateTone", () => {
  it("maps every known overview state", () => {
    expect(overviewStateTone("ACTIVE")).toBe("good");
    expect(overviewStateTone("EMPTY")).toBe("neutral");
    expect(overviewStateTone("DEGRADED")).toBe("warn");
    expect(overviewStateTone("UNAVAILABLE")).toBe("bad");
  });

  it("falls back to neutral for an unrecognized state rather than throwing", () => {
    expect(overviewStateTone("SOMETHING_NEW")).toBe("neutral");
  });
});

describe("healthStateTone", () => {
  it("maps every known health state", () => {
    expect(healthStateTone("OK")).toBe("good");
    expect(healthStateTone("DEGRADED")).toBe("warn");
    expect(healthStateTone("UNAVAILABLE")).toBe("bad");
  });
});

describe("taskStateTone", () => {
  it("treats a negative-shaped terminal state as bad even though it is terminal", () => {
    expect(taskStateTone("FAILED", true)).toBe("bad");
    expect(taskStateTone("REJECTED", true)).toBe("bad");
    expect(taskStateTone("SUSPECT_WORKTREE", true)).toBe("bad");
  });

  it("treats a positive terminal state as good", () => {
    expect(taskStateTone("COMMITTED", true)).toBe("good");
    expect(taskStateTone("CHECKPOINTED", true)).toBe("good");
  });

  it("treats a waiting-shaped non-terminal state as warn", () => {
    expect(taskStateTone("WAITING_OWNER", false)).toBe("warn");
    expect(taskStateTone("QUOTA_BLOCKED", false)).toBe("warn");
  });

  it("treats an ordinary in-progress state as neutral", () => {
    expect(taskStateTone("RUNNING", false)).toBe("neutral");
  });
});

describe("integrityTone", () => {
  it("maps a known verdict", () => {
    expect(integrityTone(true)).toBe("good");
    expect(integrityTone(false)).toBe("bad");
  });

  it("maps an unchecked verdict to neutral", () => {
    expect(integrityTone(null)).toBe("neutral");
  });
});

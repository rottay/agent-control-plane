import { describe, expect, it } from "vitest";

import { WORKER_ROLES } from "@acp/contracts";

import {
  TOOL_ARGUMENTS_BYTES_MAX,
  TOOL_CALL_TIMEOUT_MS,
  TOOL_CONTENT_STRING_MAX,
  TOOL_FRAME_BYTES_MAX,
  TOOL_REFUSALS,
  TOOL_RESULT_BYTES_MAX,
  TOOL_SERVER_ENV_KEYS,
  TOOL_TRANSPORT_KINDS,
  TOOL_WRITE_ROLES,
  holdsToolWriteAuthority,
} from "../../src/contract/index.js";

describe("the tool vocabulary is closed and honest", () => {
  it("names exactly one transport, and it is the one that is implemented", () => {
    // A second member nothing can produce would be the vacuity this repository
    // refuses elsewhere. The member arrives with the transport.
    expect([...TOOL_TRANSPORT_KINDS]).toEqual(["STDIO"]);
  });

  it("keeps the refusals sorted, distinct and non-empty", () => {
    expect([...TOOL_REFUSALS]).toEqual([...TOOL_REFUSALS].slice().sort());
    expect(new Set(TOOL_REFUSALS).size).toBe(TOOL_REFUSALS.length);
    expect(TOOL_REFUSALS.length).toBe(9);
  });

  it("keeps the environment allowlist at three variables", () => {
    expect([...TOOL_SERVER_ENV_KEYS]).toEqual(["HOME", "LC_ALL", "PATH"]);
  });

  it("orders the ceilings the way the protocol nests them", () => {
    // A content block cannot exceed a result, and a result cannot exceed a
    // frame — a ceiling ordering that inverted would leave the inner bound
    // unreachable and the outer one doing all the work.
    expect(TOOL_CONTENT_STRING_MAX).toBeLessThan(TOOL_RESULT_BYTES_MAX);
    expect(TOOL_RESULT_BYTES_MAX).toBeLessThan(TOOL_FRAME_BYTES_MAX);
    expect(TOOL_ARGUMENTS_BYTES_MAX).toBeLessThan(TOOL_RESULT_BYTES_MAX);
    expect(TOOL_CALL_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("write authority is a closed subset of the control plane roles", () => {
  it("is a subset of WORKER_ROLES", () => {
    for (const role of TOOL_WRITE_ROLES) {
      expect(WORKER_ROLES).toContain(role);
    }
    expect(TOOL_WRITE_ROLES.length).toBeLessThan(WORKER_ROLES.length);
  });

  it("admits the implementer and refuses every other role", () => {
    // Both directions, over the whole role vocabulary. A test that only
    // asserted the refusals would pass against a predicate that refuses
    // everything, which is the failure that looks most like success.
    expect(holdsToolWriteAuthority("implementer")).toBe(true);
    for (const role of WORKER_ROLES) {
      if (role === "implementer") continue;
      expect(holdsToolWriteAuthority(role)).toBe(false);
    }
  });
});

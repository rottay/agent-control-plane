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
  TOOL_TRANSPORT_UNRESOLVED,
  TOOL_WRITE_ROLES,
  holdsToolWriteAuthority,
} from "../../src/contract/index.js";
import { admitToolServer } from "../../src/admission/index.js";

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

describe("the unresolved word is a receipt coordinate, not a transport (V2-B4b S4-0)", () => {
  it("is absent from the transport union, which does not move", () => {
    // The pin above still reads exactly ["STDIO"]; this packet widens no union.
    // That is the point: a kind an admission could emit but no connection could
    // speak would be the mirror of the vacuity this repository refuses.
    expect((TOOL_TRANSPORT_KINDS as readonly string[]).includes(TOOL_TRANSPORT_UNRESOLVED)).toBe(
      false,
    );
  });

  it("matches the recorder's vocabulary grammar, which is why it is a word", () => {
    // `@acp/runtime`'s recorder calls requireVocabularyWord on `transport` and
    // refuses a null outright, so a screaming-snake word crosses the stratum
    // boundary a null could not. The pattern is restated here rather than
    // imported: that package is forbidden to this one by name, and a
    // cross-package recordability drill belongs in its own suite.
    expect(TOOL_TRANSPORT_UNRESOLVED).toMatch(/^[A-Z][A-Z0-9_]{0,39}$/);
  });

  it("is refused as a declared transport, because it is not one", () => {
    const outcome = admitToolServer({
      serverId: "docs",
      transport: TOOL_TRANSPORT_UNRESOLVED as unknown as "STDIO",
      command: "/bin/true",
      tools: [{ name: "docs.search", writes: false }],
    });
    expect(outcome).toEqual({
      ok: false,
      refusal: "TRANSPORT_REFUSED",
      at: "descriptor.transport",
    });
  });
});
